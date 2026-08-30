#!/usr/bin/env bash
# Tests for deploy/monitor/health.sh (Issue #135). No root, no docker, no nginx, no network: paths are rooted at a
# temp dir through env vars, and docker/systemctl/df/curl are stubs on PATH that record their arguments and answer
# from STUB_HANDLER.
#   bash deploy/test/monitor-health.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../monitor/health.sh"
PASS=0; FAIL=0
ME=$(id -un)

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"; mkdir -p "$BIN"
for cmd in docker systemctl df curl; do
  cat > "$BIN/$cmd" <<STUB
#!/usr/bin/env bash
echo "$cmd \$*" >> "\$STUB_LOG"
if [ -n "\${STUB_HANDLER:-}" ]; then "\$STUB_HANDLER" "$cmd" "\$@"; fi
STUB
  chmod +x "$BIN/$cmd"
done

fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_eq() { [[ "$2" == "$1" ]] || fail "$3: expected [$1] got [$2]"; }
assert_exists() { [[ -e "$1" ]] || fail "$2: expected $1 to exist"; }
assert_missing() { [[ ! -e "$1" ]] || fail "$2: expected $1 to NOT exist"; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in: $1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "$3: expected NOT to contain [$2] in: $1"; }

# Default handler: everything healthy. Individual tests override pieces through env vars read by the handler.
cat > "$TMP/handler" <<'H'
#!/usr/bin/env bash
cmd=$1; shift
case "$cmd" in
  docker)   # docker inspect -f {{.State.Health.Status}} <name>
    name=${*: -1}
    case "$name" in
      giinrecord-web-1)         echo "${H_WEB-healthy}" ;;
      giinrecord-web-staging-1) echo "${H_STAGING-healthy}" ;;
      *) echo "Error: No such object: $name" >&2; exit 1 ;;
    esac ;;
  systemctl) echo "${H_NGINX:-active}"; [ "${H_NGINX:-active}" = active ] ;;
  df) printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 100 %s 0 %s%% /\n' "${H_DISK:-40}" "${H_DISK:-40}" ;;
  curl)
    # record the body sent to the API (-d @file) and the URL; answer from H_API_* env
    url=${*: -1}
    body=""; out=/dev/stdout
    for ((i=1;i<=$#;i++)); do
      [[ "${!i}" == "-d" ]] && { j=$((i+1)); body=${!j}; }
      [[ "${!i}" == "-o" ]] && { j=$((i+1)); out=${!j}; }
    done
    [ -n "$body" ] && cat "${body#@}" >> "$STUB_LOG.api" && echo >> "$STUB_LOG.api"
    echo "$url" >> "$STUB_LOG.urls"
    if [[ "$url" == *"/issues?"* ]]; then echo "${H_API_LIST:-[]}" > "$out"; else echo "${H_API_RESP:-{\"number\": 42}}" > "$out"; fi
    printf '200' ;;
esac
H
chmod +x "$TMP/handler"

# fresh <name> → P (prefix), LOG, a site dir with a fresh meta.json, an empty state dir
fresh() {
  P="$TMP/$1"; mkdir -p "$P"; LOG="$P/stub.log"; : > "$LOG"; rm -f "$LOG.api" "$LOG.urls"
  mkdir -p "$P/site/data" "$P/staging/data" "$P/state" "$P/home"
  touch "$P/site/data/meta.json" "$P/staging/data/meta.json"
  export STUB_LOG="$LOG" STUB_HANDLER="$TMP/handler"
  export MONITOR_LOG="$P/monitor.log" MONITOR_STATE_DIR="$P/state" MONITOR_TOKEN_FILE="$P/token" \
    MONITOR_SITE_DIR="$P/site" MONITOR_STAGING_DIR="$P/staging" MONITOR_LATEST_DIR="$P/home/monitor" \
    MONITOR_REPO="example/repo" MONITOR_OWNER="$ME"
  unset H_WEB H_STAGING H_NGINX H_DISK H_API_LIST H_API_RESP
}
run_health() { PATH="$BIN:$PATH" bash "$SCRIPT" > "$P/out" 2>&1; }
with_token() { echo "github_pat_TESTONLY" > "$P/token"; chmod 600 "$P/token"; }

test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

t_syntax() { bash -n "$SCRIPT" || fail "bash -n"; }

t_all_ok() {
  fresh ok
  run_health || fail "exit $? $(cat "$P/out")"
  assert_contains "$(cat "$P/monitor.log")" " OK" "log line"
  assert_exists "$P/home/monitor/latest.json" "latest.json written"
  assert_eq "600" "$(stat -c %a "$P/home/monitor/latest.json")" "latest.json mode"
  assert_contains "$(cat "$P/home/monitor/latest.json")" '"ok": true' "latest.json ok"
  assert_contains "$(cat "$LOG")" "docker inspect" "containers checked"
  assert_contains "$(cat "$LOG")" "systemctl is-active nginx" "nginx checked"
  assert_not_contains "$(cat "$LOG")" "curl" "nothing reported when all is fine and no issue is open"
}

t_detects_each_failure() {
  fresh fails
  H_WEB=unhealthy H_NGINX=inactive H_DISK=91 run_health && fail "expected non-zero exit on failures"
  local log; log=$(cat "$P/monitor.log")
  assert_contains "$log" "container-web" "unhealthy web container"
  assert_contains "$log" "nginx" "nginx inactive"
  assert_contains "$log" "disk" "disk over threshold"
  assert_contains "$(cat "$P/home/monitor/latest.json")" '"ok": false' "latest.json not ok"
}

t_missing_container_is_a_failure() {
  fresh missing; rm -rf "$P/site"   # also: site dir missing
  H_STAGING="" run_health && fail "expected non-zero"
  assert_contains "$(cat "$P/monitor.log")" "container-web-staging" "missing staging container"
  assert_contains "$(cat "$P/monitor.log")" "site-production" "missing site dir"
}

t_stale_site_dir() {
  fresh stale
  touch -d "3 days ago" "$P/site/data/meta.json"
  run_health && fail "expected non-zero"
  assert_contains "$(cat "$P/monitor.log")" "site-production" "stale production data"
  assert_not_contains "$(cat "$P/monitor.log")" "site-staging" "staging still fresh"
}

t_no_token_fails_soft() {
  fresh notoken
  H_WEB=unhealthy run_health && fail "expected non-zero"
  assert_not_contains "$(cat "$LOG")" "curl" "no API call without token"
  assert_contains "$(cat "$P/out")$(cat "$P/monitor.log")" "token" "operator is told the token is absent"
}

t_reports_after_two_consecutive_failures_once() {
  fresh twice; with_token
  H_WEB=unhealthy run_health || true
  assert_not_contains "$(cat "$LOG")" "curl" "first failure: not reported yet"
  H_WEB=unhealthy run_health || true
  assert_contains "$(cat "$LOG.urls")" "/repos/example/repo/issues" "second failure: reported"
  local api; api=$(cat "$LOG.api")
  assert_contains "$api" '"title": "[monitor] vps: container-web"' "issue title"
  assert_contains "$api" '"labels": ["monitor"]' "label monitor"
  assert_not_contains "$api" "$P" "no local paths in the body"
  assert_exists "$P/state/issue.container-web" "issue number remembered"
  assert_eq "42" "$(cat "$P/state/issue.container-web")" "issue number"
  : > "$LOG"; rm -f "$LOG.urls" "$LOG.api"
  H_WEB=unhealthy run_health || true
  assert_not_contains "$(cat "$LOG")" "curl" "third failure: no duplicate issue"
}

t_dedups_by_title_when_state_lost() {
  fresh dedup; with_token
  H_WEB=unhealthy run_health || true
  H_API_LIST='[{"number": 7, "title": "[monitor] vps: container-web"}]' H_WEB=unhealthy run_health || true
  local urls; urls=$(cat "$LOG.urls")
  assert_contains "$urls" "/issues?" "open issues listed"
  assert_eq "1" "$(wc -l < "$LOG.urls" | tr -d ' ')" "no create call when an open issue with the same title exists"
  assert_eq "7" "$(cat "$P/state/issue.container-web")" "existing issue adopted"
}

t_closes_on_recovery() {
  fresh recover; with_token
  echo 42 > "$P/state/issue.container-web"; echo 2 > "$P/state/fails.container-web"
  run_health || fail "exit $? $(cat "$P/out")"
  local urls; urls=$(cat "$LOG.urls")
  assert_contains "$urls" "/repos/example/repo/issues/42/comments" "recovery comment"
  assert_contains "$urls" "/repos/example/repo/issues/42" "issue patched"
  assert_contains "$(cat "$LOG.api")" '"state": "closed"' "closed"
  assert_missing "$P/state/issue.container-web" "state cleared"
  assert_missing "$P/state/fails.container-web" "failure counter cleared"
}

t_curl_failure_does_not_abort() {
  fresh curlfail; with_token
  cat > "$P/badhandler" <<'H'
#!/usr/bin/env bash
case "$1" in docker) echo unhealthy ;; systemctl) echo active ;; df) printf 'x\n/ 1 1 1 10%% /\n' ;; curl) exit 7 ;; esac
H
  chmod +x "$P/badhandler"
  echo 1 > "$P/state/fails.container-web"
  STUB_HANDLER="$P/badhandler" run_health && fail "expected non-zero"
  assert_contains "$(cat "$P/monitor.log")" "container-web" "failure still logged"
  assert_missing "$P/state/issue.container-web" "no bogus issue number stored"
}

t_refuses_symlinked_latest_dir() {
  fresh symlink
  mkdir -p "$P/elsewhere"; ln -s "$P/elsewhere" "$P/home/monitor"
  run_health && fail "expected non-zero"
  assert_missing "$P/elsewhere/latest.json" "nothing written through the symlink"
}

test_case "health.sh: bash -n" t_syntax
test_case "正常: OK をログし latest.json（600）を書き、API は呼ばない" t_all_ok
test_case "異常: コンテナ unhealthy・nginx inactive・ディスク>85% をそれぞれ検出" t_detects_each_failure
test_case "異常: コンテナ不在・rsync 先不在も異常" t_missing_container_is_a_failure
test_case "異常: rsync 先の meta.json が 48 時間より古い" t_stale_site_dir
test_case "トークン無し: 通知せず fail soft（ログに記録）" t_no_token_fails_soft
test_case "通知: 2 回連続で初めて Issue 作成、3 回目は重複させない" t_reports_after_two_consecutive_failures_once
test_case "通知: 状態ファイルが無くても同名の open Issue があれば作らない" t_dedups_by_title_when_state_lost
test_case "復旧: コメントして close、状態を消す" t_closes_on_recovery
test_case "通知失敗: curl が失敗しても監視は続く" t_curl_failure_does_not_abort
test_case "latest.json: 置き場がシンボリックリンクなら書かない" t_refuses_symlinked_latest_dir

echo; echo "passed: $PASS  failed: $FAIL"
[[ $FAIL == 0 ]]
