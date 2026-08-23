#!/usr/bin/env bash
# Tests for the rename migration in deploy/go-live.sh (Issue #119). No root, no docker, no nginx:
# every path is rooted at a temp dir through GO_LIVE_PREFIX and the external commands are stubs on PATH
# that only record their arguments.
#   bash deploy/test/go-live.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../go-live.sh"
PASS=0; FAIL=0

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"; mkdir -p "$BIN"
for cmd in docker nginx systemctl; do
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
assert_missing() { [[ ! -e "$1" && ! -L "$1" ]] || fail "$2: expected $1 to NOT exist"; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in: $1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "$3: expected NOT to contain [$2] in: $1"; }

# fresh <name> → sets P (prefix) and LOG; nothing is run yet
fresh() {
  P="$TMP/$1"; mkdir -p "$P"; LOG="$P/stub.log"; : > "$LOG"
  export GO_LIVE_PREFIX="$P" STUB_LOG="$LOG"
}
run_migrate() {
  PATH="$BIN:$PATH" GO_LIVE_NO_MAIN=1 bash -c 'set -euo pipefail; source "$1"; migrate_legacy' _ "$SCRIPT" > "$P/out" 2>&1
}
old_layout() {
  mkdir -p "$P/opt/seiji-kiroku/.git" "$P/var/www/seiji-kiroku/site" "$P/etc/nginx/sites-available" \
    "$P/etc/nginx/sites-enabled" "$P/etc/nginx/conf.d" "$P/etc/cron.d" "$P/usr/local/lib/seiji-kiroku-analytics"
  echo "server { root /var/www/seiji-kiroku/site; }" > "$P/etc/nginx/sites-available/seiji-kiroku.conf"
  ln -s "$P/etc/nginx/sites-available/seiji-kiroku.conf" "$P/etc/nginx/sites-enabled/seiji-kiroku.conf"
  echo "log_format noip '...';" > "$P/etc/nginx/conf.d/seiji-kiroku-noip-log.conf"
  echo "10 0 * * * root /usr/local/lib/seiji-kiroku-analytics/daily.sh" > "$P/etc/cron.d/seiji-kiroku-analytics"
  echo "#!/bin/sh" > "$P/usr/local/lib/seiji-kiroku-analytics/daily.sh"
  echo "x" > "$P/var/www/seiji-kiroku/site/index.html"
}

test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

t_syntax() {
  bash -n "$SCRIPT" || fail "bash -n"
}

t_moves_old_dirs() {
  fresh moves; old_layout
  run_migrate || fail "exit $? $(cat "$P/out")"
  assert_exists "$P/opt/gikailog/.git" "repo moved"
  assert_missing "$P/opt/seiji-kiroku" "old repo gone"
  assert_exists "$P/var/www/gikailog/site/index.html" "site moved with content"
  assert_missing "$P/var/www/seiji-kiroku" "old site gone"
  assert_exists "$P/usr/local/lib/gikailog-analytics/daily.sh" "analytics tools moved"
  assert_missing "$P/usr/local/lib/seiji-kiroku-analytics" "old analytics tools gone"
}

t_removes_old_nginx_and_cron() {
  fresh nginx; old_layout
  run_migrate || fail "exit $? $(cat "$P/out")"
  assert_missing "$P/etc/nginx/sites-enabled/seiji-kiroku.conf" "old enabled symlink removed"
  assert_missing "$P/etc/nginx/sites-available/seiji-kiroku.conf" "old available conf removed"
  assert_missing "$P/etc/nginx/conf.d/seiji-kiroku-noip-log.conf" "old log_format removed (would duplicate noip)"
  assert_missing "$P/etc/cron.d/seiji-kiroku-analytics" "old cron removed"
  # nginx is NOT reloaded here: the new server block is written (and nginx -t'd) by vps-setup.sh right after.
  assert_not_contains "$(cat "$LOG")" "systemctl" "no nginx reload during migration"
}

t_removes_old_compose_project() {
  fresh compose; old_layout
  cat > "$P/handler" <<'H'
#!/usr/bin/env bash
# docker network ls ... → pretend the old project's network exists
if [[ "$1 $2 $3" == "docker network ls" ]]; then echo "seiji-kiroku_default"; fi
H
  chmod +x "$P/handler"
  STUB_HANDLER="$P/handler" run_migrate || fail "exit $? $(cat "$P/out")"
  assert_contains "$(cat "$LOG")" "docker compose -p seiji-kiroku down --remove-orphans" "old compose project torn down"
}

t_no_compose_teardown_when_absent() {
  fresh nocompose; old_layout
  run_migrate || fail "exit $? $(cat "$P/out")"
  assert_not_contains "$(cat "$LOG")" "docker compose -p seiji-kiroku down" "nothing to tear down"
}

t_idempotent_on_fresh_host() {
  fresh none; mkdir -p "$P/etc/nginx/sites-enabled"
  run_migrate || fail "exit $? $(cat "$P/out")"
  assert_missing "$P/opt/gikailog" "nothing invented"
  assert_missing "$P/var/www/gikailog" "nothing invented"
  assert_not_contains "$(cat "$LOG")" "docker compose" "no compose teardown"
}

t_idempotent_second_run() {
  fresh twice; old_layout
  run_migrate || fail "first run: $(cat "$P/out")"
  : > "$LOG"
  run_migrate || fail "second run: $(cat "$P/out")"
  assert_exists "$P/var/www/gikailog/site/index.html" "site still there"
  assert_not_contains "$(cat "$LOG")" "docker compose" "second run tears nothing down"
}

t_keeps_both_when_new_path_already_exists() {
  fresh both; old_layout
  mkdir -p "$P/var/www/gikailog/site"; echo "new" > "$P/var/www/gikailog/site/index.html"
  run_migrate || fail "exit $? $(cat "$P/out")"
  assert_eq "new" "$(cat "$P/var/www/gikailog/site/index.html")" "new path untouched"
  assert_exists "$P/var/www/seiji-kiroku/site/index.html" "old path left for a human (not merged, not deleted)"
  assert_contains "$(cat "$P/out")" "/var/www/seiji-kiroku" "operator is told about the leftover"
}

test_case "go-live.sh: bash -n" t_syntax
test_case "移行: /opt, /var/www, /usr/local/lib の旧ディレクトリを新名へ mv" t_moves_old_dirs
test_case "移行: 旧 nginx conf（sites-enabled/available, conf.d log_format）と旧 cron を削除、reload はしない" t_removes_old_nginx_and_cron
test_case "移行: 旧 compose project (seiji-kiroku) が残っていれば down --remove-orphans" t_removes_old_compose_project
test_case "移行: 旧 compose project が無ければ docker を触らない" t_no_compose_teardown_when_absent
test_case "移行: 旧パスが無い新規ホストでは何もしない" t_idempotent_on_fresh_host
test_case "移行: 2 回目は何もしない（冪等）" t_idempotent_second_run
test_case "移行: 新旧両方ある場合は上書きせず旧を残して警告" t_keeps_both_when_new_path_already_exists

echo; echo "passed: $PASS  failed: $FAIL"
[[ $FAIL == 0 ]]
