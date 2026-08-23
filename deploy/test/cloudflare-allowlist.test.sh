#!/usr/bin/env bash
# Tests for deploy/cloudflare-allowlist.sh (Issue #163): the nginx allow-list snippet generated from Cloudflare's
# published ranges. No network, no root: curl / nginx / systemctl are stubs on PATH, every path is rooted at a
# temp dir through CF_ALLOWLIST_PREFIX. Fixture ranges are RFC1918 / documentation addresses only (no public IP
# literal may be committed, scripts/ci/forbidden-patterns.sh).
#   bash deploy/test/cloudflare-allowlist.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../cloudflare-allowlist.sh"
PASS=0; FAIL=0

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"; mkdir -p "$BIN"
for cmd in curl nginx systemctl; do
  cat > "$BIN/$cmd" <<STUB
#!/usr/bin/env bash
echo "$cmd \$*" >> "\$STUB_LOG"
"\$STUB_HANDLER" "$cmd" "\$@"
STUB
  chmod +x "$BIN/$cmd"
done

# Handler: curl answers ips-v4 / ips-v6 from H_V4 / H_V6 (printf %b strings); H_CURL_EXIT makes curl fail;
# H_NGINX_EXIT makes `nginx -t` fail.
cat > "$TMP/handler" <<'H'
#!/usr/bin/env bash
cmd=$1; shift
case "$cmd" in
  curl)
    [ -n "${H_CURL_EXIT:-}" ] && exit "$H_CURL_EXIT"
    url=${*: -1}; out=/dev/stdout
    for ((i=1;i<=$#;i++)); do [[ "${!i}" == "-o" ]] && { j=$((i+1)); out=${!j}; }; done
    case "$url" in
      https://www.cloudflare.com/ips-v4) printf '%b' "${H_V4-10.0.0.0/8\n192.168.0.0/16\n}" > "$out" ;;
      https://www.cloudflare.com/ips-v6) printf '%b' "${H_V6-2001:db8::/32\n2001:db8:1::/48\n}" > "$out" ;;
      *) echo "unexpected url $url" >&2; exit 1 ;;
    esac ;;
  nginx) if [[ "${1:-}" == -t ]]; then exit "${H_NGINX_EXIT:-0}"; fi ;;
  systemctl) ;;
esac
H
chmod +x "$TMP/handler"

fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_eq() { [[ "$2" == "$1" ]] || fail "$3: expected [$1] got [$2]"; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in: $1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "$3: expected NOT to contain [$2] in: $1"; }
test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

fresh() {
  P="$TMP/$1"; mkdir -p "$P/etc/nginx/snippets" "$P/etc/cron.d" "$P/usr/local/lib"
  LOG="$P/stub.log"; : > "$LOG"
  export CF_ALLOWLIST_PREFIX="$P" STUB_LOG="$LOG" STUB_HANDLER="$TMP/handler"
  unset H_V4 H_V6 H_CURL_EXIT H_NGINX_EXIT
  SNIPPET="$P/etc/nginx/snippets/gikailog-cloudflare-allow.conf"
}
run_it() { PATH="$BIN:$PATH" bash "$SCRIPT" "$@" > "$P/out" 2>&1; }

t_syntax() { bash -n "$SCRIPT" || fail "bash -n"; }

t_generates_snippet() {
  fresh gen
  run_it || fail "exit $? $(cat "$P/out")"
  [[ -f "$SNIPPET" ]] || { fail "snippet written"; return; }
  local c; c=$(cat "$SNIPPET")
  assert_contains "$c" "allow 10.0.0.0/8;" "v4 range"
  assert_contains "$c" "allow 192.168.0.0/16;" "second v4 range"
  assert_contains "$c" "allow 2001:db8::/32;" "v6 range"
  assert_contains "$c" "allow 2001:db8:1::/48;" "second v6 range"
  assert_eq "deny all;" "$(grep -v '^#' "$SNIPPET" | tail -1)" "deny all is the last directive"
  assert_eq "4" "$(grep -c '^allow ' "$SNIPPET")" "exactly the fetched ranges"
  assert_contains "$(cat "$LOG")" "nginx -t" "config tested"
  assert_contains "$(cat "$LOG")" "systemctl reload nginx" "reloaded"
  assert_eq "-rw-r--r--" "$(stat -c %A "$SNIPPET")" "snippet is world-readable like other nginx confs (no secret in it)"
  [[ -z "$(find "$P/etc/nginx/snippets" -name '*.tmp*')" ]] || fail "no temp file left next to the snippet"
  assert_contains "$(cat "$LOG")" "https://www.cloudflare.com/ips-v4" "fetched v4"
  assert_contains "$(cat "$LOG")" "https://www.cloudflare.com/ips-v6" "fetched v6"
}

t_rerun_is_noop() {
  fresh twice
  run_it || fail "first: $(cat "$P/out")"
  local before; before=$(cat "$SNIPPET")
  : > "$LOG"
  run_it || fail "second: $(cat "$P/out")"
  assert_eq "$before" "$(cat "$SNIPPET")" "same snippet"
  assert_not_contains "$(cat "$LOG")" "systemctl reload" "unchanged snippet → no reload"
}

t_rejects_bad_cidr() {
  fresh badcidr
  local bad
  for bad in "10.0.0.0/8; deny all" "10.0.0.0" "10.0.0.0/33" "256.1.1.1/8" "<html>" "allow 10.0.0.0/8" "10.0.0.0/8 #x" "2001:db8::/129" "2001:zz::/32" "10.0.0.0/8\r"; do
    : > "$LOG"; rm -f "$SNIPPET"
    if H_V4="${bad}\n" run_it; then fail "accepted [$bad]"; fi
    [[ ! -e "$SNIPPET" ]] || fail "snippet written for [$bad]"
    assert_not_contains "$(cat "$LOG")" "systemctl" "no reload for [$bad]"
  done
  assert_contains "$(cat "$P/out")" "invalid" "operator is told"
}

t_rejects_empty_list() {
  fresh empty
  if H_V4="" run_it; then fail "an empty v4 list must be rejected (would deny Cloudflare itself)"; fi
  [[ ! -e "$SNIPPET" ]] || fail "nothing written"
  fresh empty6
  if H_V6="" run_it; then fail "an empty v6 list must be rejected"; fi
  [[ ! -e "$SNIPPET" ]] || fail "nothing written"
}

t_keeps_old_snippet_when_fetch_fails() {
  fresh down
  run_it || fail "first: $(cat "$P/out")"
  local before; before=$(cat "$SNIPPET"); : > "$LOG"
  if H_CURL_EXIT=7 run_it; then fail "curl failure must exit non-zero"; fi
  assert_eq "$before" "$(cat "$SNIPPET")" "previous snippet kept"
  assert_not_contains "$(cat "$LOG")" "systemctl" "no reload"
}

t_restores_on_nginx_t_failure() {
  fresh broken
  run_it || fail "first: $(cat "$P/out")"
  local before; before=$(cat "$SNIPPET"); : > "$LOG"
  if H_V4="172.16.0.0/12\n" H_NGINX_EXIT=1 run_it; then fail "nginx -t failure must exit 1"; fi
  assert_eq "$before" "$(cat "$SNIPPET")" "previous snippet restored"
  assert_not_contains "$(cat "$LOG")" "systemctl" "no reload on a broken config"
  assert_contains "$(cat "$P/out")" "nginx -t failed" "operator is told"
}

t_first_install_with_broken_config_leaves_no_snippet() {
  fresh broken0
  if H_NGINX_EXIT=1 run_it; then fail "must exit 1"; fi
  [[ ! -e "$SNIPPET" ]] || fail "no snippet left behind when there was none before"
  assert_not_contains "$(cat "$LOG")" "systemctl" "no reload"
}

t_install_cron() {
  fresh cron
  run_it --install-cron || fail "exit $? $(cat "$P/out")"
  local cron="$P/etc/cron.d/gikailog-cloudflare-allowlist" lib="$P/usr/local/lib/gikailog-cloudflare-allowlist.sh"
  [[ -f "$cron" ]] || { fail "cron file"; return; }
  [[ -f "$lib" && -x "$lib" ]] || { fail "script copied to a root-owned location for the cron"; return; }
  assert_eq "-rwxr-xr-x" "$(stat -c %A "$lib")" "lib mode 755"
  assert_eq "-rw-r--r--" "$(stat -c %A "$cron")" "cron mode 644"
  local c; c=$(cat "$cron")
  assert_contains "$c" " root " "runs as root"
  assert_contains "$c" "/usr/local/lib/gikailog-cloudflare-allowlist.sh" "runs the installed copy, not the repo checkout"
  [[ "$(grep -v '^#' "$cron" | grep -c ' root ')" == 1 ]] || fail "exactly one job"
  grep -v '^#' "$cron" | grep ' root ' | grep -qE '^[0-9]+ [0-9]+ \* \* [0-9]' || fail "weekly schedule (day-of-week set)"
  [[ -f "$SNIPPET" ]] || fail "snippet generated on install too"
  cmp -s "$SCRIPT" "$lib" || fail "installed copy is the script itself"
}

t_rejects_unknown_arg() {
  fresh arg
  if run_it --bogus; then fail "unknown option accepted"; fi
  [[ ! -e "$SNIPPET" ]] || fail "nothing written"
}

t_shellcheck() {
  command -v shellcheck >/dev/null || return 0
  shellcheck "$SCRIPT" || fail "shellcheck"
}

test_case "cloudflare-allowlist.sh: bash -n" t_syntax
test_case "ips-v4/v6 から allow … ; deny all; の snippet を原子的に書き、nginx -t → reload" t_generates_snippet
test_case "2 回目は同じ snippet、変化が無ければ reload しない（冪等）" t_rerun_is_noop
test_case "CIDR 以外の行（nginx 構文の注入・不正なマスク・HTML・CR）があれば何も書かない" t_rejects_bad_cidr
test_case "空のリストは拒否（Cloudflare 自身を deny してしまう）" t_rejects_empty_list
test_case "取得に失敗したら前の snippet を残し reload しない" t_keeps_old_snippet_when_fetch_fails
test_case "nginx -t が落ちれば前の snippet に戻し reload しない" t_restores_on_nginx_t_failure
test_case "初回で nginx -t が落ちれば snippet を残さない" t_first_install_with_broken_config_leaves_no_snippet
test_case "--install-cron: /usr/local/lib に root 所有でコピーし /etc/cron.d に週次の root cron" t_install_cron
test_case "不明な引数は拒否" t_rejects_unknown_arg
test_case "shellcheck" t_shellcheck

echo; echo "passed: $PASS  failed: $FAIL"
[[ $FAIL == 0 ]]
