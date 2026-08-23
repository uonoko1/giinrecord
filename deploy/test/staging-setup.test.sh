#!/usr/bin/env bash
# Tests for deploy/staging-setup.sh (Issue #127). No root, no docker, no nginx, no certbot: every path is rooted at a
# temp dir through STAGING_SETUP_PREFIX, and the external commands are stubs on PATH that only record their arguments.
#   bash deploy/test/staging-setup.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../staging-setup.sh"
PASS=0; FAIL=0

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"; mkdir -p "$BIN"
for cmd in docker certbot git getent install curl ss; do
  cat > "$BIN/$cmd" <<STUB
#!/usr/bin/env bash
echo "$cmd \$*" >> "\$STUB_LOG"
if [ -n "\${STUB_HANDLER:-}" ]; then "\$STUB_HANDLER" "$cmd" "\$@"; fi
STUB
  chmod +x "$BIN/$cmd"
done

fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_eq() { [[ "$2" == "$1" ]] || fail "$3: expected [$1] got [$2]"; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in: $1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "$3: expected NOT to contain [$2] in: $1"; }
assert_order() { # assert_order <log> <first> <second> <msg>
  local a b
  a=$(grep -n -F -- "$2" <<<"$1" | head -1 | cut -d: -f1 || true); b=$(grep -n -F -- "$3" <<<"$1" | head -1 | cut -d: -f1 || true)
  [[ -n "$a" && -n "$b" && "$a" -lt "$b" ]] || fail "$4: expected [$2] before [$3]"
}

# fresh <name> → P (prefix), LOG, and a fake /opt/gikailog checkout whose vps-setup.sh only records its arguments
fresh() {
  P="$TMP/$1"; mkdir -p "$P"; LOG="$P/stub.log"; : > "$LOG"
  export STAGING_SETUP_PREFIX="$P" STUB_LOG="$LOG"
  mkdir -p "$P/opt/gikailog/.git" "$P/opt/gikailog/deploy"
  : > "$P/opt/gikailog/deploy/docker-compose.yml"
  # shellcheck disable=SC2016  # the stub expands $* / $STUB_LOG when it runs, not here
  printf '#!/usr/bin/env bash\necho "vps-setup.sh $*" >> "$STUB_LOG"\n' > "$P/opt/gikailog/deploy/vps-setup.sh"
}
run_setup() {
  PATH="$BIN:$PATH" bash "$SCRIPT" "$@" > "$P/out" 2>&1
}
docker_present() { # handler: `command -v docker` is satisfied by the stub; getent resolves the domain only when asked
  cat > "$P/handler" <<'H'
#!/usr/bin/env bash
if [[ "$1" == "getent" ]]; then [[ "${DNS_OK:-}" == 1 ]] || exit 2; fi
# ss -tln → the listening sockets the test wants to simulate (none by default)
if [[ "$1" == "ss" ]]; then printf '%b' "${SS_OUT:-}"; fi
# docker compose ps -q <service> → non-empty when OUR container is running
if [[ "$1 $2" == "docker compose" && "$*" == *" ps -q "* ]]; then [[ "${OWN_CONTAINER:-}" == 1 ]] && echo "abc123"; exit 0; fi
H
  chmod +x "$P/handler"; export STUB_HANDLER="$P/handler"
}

test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

t_syntax() { bash -n "$SCRIPT" || fail "bash -n"; }

t_happy_path_order() {
  fresh happy; docker_present
  DNS_OK=1 run_setup || fail "exit $? $(cat "$P/out")"
  local log; log=$(cat "$LOG")
  assert_contains "$log" "git -C $P/opt/gikailog pull -q --ff-only" "repo updated (compose + site.conf)"
  assert_contains "$log" "install -d -o ubuntu -g deploygroup -m 2775 $P/var/www/gikailog/staging" "staging web root for the deploy user"
  assert_contains "$log" "docker compose -f $P/opt/gikailog/deploy/docker-compose.yml up -d --wait --force-recreate" "both containers recreated (bind-mounted site.conf: inode changes on git pull)"
  assert_contains "$log" "vps-setup.sh staging.gikailog.jp 8083" "host proxy block for staging on port 8083"
  assert_contains "$log" "certbot certonly --nginx -d staging.gikailog.jp" "TLS for the staging hostname only, certonly (no conf editing by certbot)"
  assert_not_contains "$log" "www.staging" "no www for staging"
  assert_not_contains "$log" "--redirect" "redirect comes from the template, not certbot"
  assert_order "$log" "ss -tln" "docker compose -f" "port check before the container is started"
  assert_order "$log" "docker compose -f" "vps-setup.sh" "container before host proxy (no 502 window)"
  assert_order "$log" "vps-setup.sh" "certbot" "bootstrap proxy block before certbot (challenge on :80)"
  assert_order "$(tac <<<"$log")" "vps-setup.sh staging.gikailog.jp 8083" "certbot" "vps-setup.sh again after certbot: TLS + redirect blocks"
  [[ $(grep -c "vps-setup.sh staging.gikailog.jp 8083" <<<"$log" || true) -eq 2 ]] || fail "vps-setup.sh runs before and after certbot"
}

t_custom_domain() {
  fresh domain; docker_present
  DNS_OK=1 run_setup staging.example.test || fail "exit $? $(cat "$P/out")"
  assert_contains "$(cat "$LOG")" "vps-setup.sh staging.example.test 8083" "domain argument honoured"
  assert_contains "$(cat "$LOG")" "certbot certonly --nginx -d staging.example.test" "certbot for that domain"
}

t_rejects_non_staging_domain() {
  local d
  for d in gikailog.jp www.gikailog.jp stg.example.test; do
    fresh "reject-$d"; docker_present
    if DNS_OK=1 run_setup "$d"; then fail "$d must be rejected"; fi
    assert_contains "$(cat "$P/out")" "staging." "$d: message names the rule"
    assert_contains "$(cat "$P/out")" "usage" "$d: usage shown"
    assert_eq "" "$(cat "$LOG")" "$d: nothing run (no pull, no compose, no vps-setup, no certbot)"
  done
}

t_skips_certbot_without_dns() {
  fresh nodns; docker_present
  run_setup || fail "exit $? $(cat "$P/out")"
  assert_not_contains "$(cat "$LOG")" "certbot" "certbot not attempted before DNS resolves"
  assert_contains "$(cat "$P/out")" "certbot certonly --nginx -d staging.gikailog.jp" "operator is told the command to run later"
}

t_skips_certbot_when_cert_exists() {
  fresh hascert; docker_present
  mkdir -p "$P/etc/letsencrypt/live/staging.gikailog.jp"; : > "$P/etc/letsencrypt/live/staging.gikailog.jp/fullchain.pem"
  DNS_OK=1 run_setup || fail "exit $? $(cat "$P/out")"
  assert_not_contains "$(cat "$LOG")" "certbot" "no second certificate (-0001) when one exists"
  assert_contains "$(cat "$P/out")" "certificate" "operator is told it was skipped"
}

t_refuses_when_port_taken_by_someone_else() {
  fresh busy; docker_present
  if SS_OUT='LISTEN 0 511 127.0.0.1:8083 0.0.0.0:*\n' DNS_OK=1 run_setup; then fail "must refuse: 127.0.0.1:8083 is taken by another process"; fi
  assert_contains "$(cat "$P/out")" "8083" "message names the port"
  assert_not_contains "$(cat "$LOG")" "up -d" "container not started"
  assert_not_contains "$(cat "$LOG")" "vps-setup.sh" "host nginx untouched"
}

t_port_taken_by_own_container_is_fine() {
  fresh own; docker_present
  SS_OUT='LISTEN 0 511 127.0.0.1:8083 0.0.0.0:*\n' OWN_CONTAINER=1 DNS_OK=1 run_setup || fail "exit $? $(cat "$P/out")"
  assert_contains "$(cat "$LOG")" "docker compose -f $P/opt/gikailog/deploy/docker-compose.yml up -d --wait --force-recreate" "re-run converges"
}

t_requires_production_setup_first() {
  fresh nodocker
  rm -rf "$P/opt/gikailog"
  if PATH="$TMP/empty:/usr/bin:/bin" bash "$SCRIPT" > "$P/out" 2>&1; then fail "should fail without docker / repo"; fi
  assert_contains "$(cat "$P/out")" "go-live.sh" "points at the production setup"
  assert_not_contains "$(cat "$LOG")" "certbot" "nothing else attempted"
}

t_never_touches_production_paths() {
  fresh prod; docker_present
  DNS_OK=1 run_setup || fail "exit $? $(cat "$P/out")"
  local log; log=$(cat "$LOG")
  assert_not_contains "$log" "/var/www/gikailog/site" "production web root untouched"
  assert_not_contains "$log" "8081" "production port not reconfigured"
  assert_not_contains "$log" "gpasswd" "no group changes"
}

t_idempotent_second_run() {
  fresh twice; docker_present
  DNS_OK=1 run_setup || fail "first: $(cat "$P/out")"
  : > "$LOG"
  DNS_OK=1 run_setup || fail "second: $(cat "$P/out")"
  assert_contains "$(cat "$LOG")" "docker compose -f $P/opt/gikailog/deploy/docker-compose.yml up -d --wait --force-recreate" "second run still converges"
}

test_case "staging-setup.sh: bash -n" t_syntax
test_case "引数検証 → pull → web root → ss → compose up --force-recreate → vps-setup.sh → certbot certonly → vps-setup.sh の順" t_happy_path_order
test_case "ドメイン引数で上書きできる（staging.* に限る）" t_custom_domain
test_case "staging. で始まらないドメインは何もせず拒否する（本番 conf を壊さない、#141）" t_rejects_non_staging_domain
test_case "DNS が引けなければ certbot は実行せずコマンドを案内する" t_skips_certbot_without_dns
test_case "証明書が既にあれば certbot を実行しない（-0001 を作らない）" t_skips_certbot_when_cert_exists
test_case "127.0.0.1:8083 が他プロセスに使われていれば起動前に止まる（ss -tln）" t_refuses_when_port_taken_by_someone_else
test_case "8083 を使っているのが自分のコンテナなら続行する" t_port_taken_by_own_container_is_fine
test_case "docker も /opt/gikailog も無ければ go-live.sh を案内して失敗する" t_requires_production_setup_first
test_case "production のパス・ポート・グループには触れない" t_never_touches_production_paths
test_case "2 回目も同じことをして失敗しない（冪等）" t_idempotent_second_run

echo; echo "passed: $PASS  failed: $FAIL"
[[ $FAIL == 0 ]]
