#!/usr/bin/env bash
# Tests for deploy/monitor/setup.sh (Issue #135). No root: every path is rooted at a temp dir through
# MONITOR_SETUP_PREFIX; install/chown still run for real inside that prefix (as the current user).
#   bash deploy/test/monitor-setup.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../monitor/setup.sh"
PASS=0; FAIL=0
ME=$(id -un)

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_eq() { [[ "$2" == "$1" ]] || fail "$3: expected [$1] got [$2]"; }
assert_exists() { [[ -e "$1" ]] || fail "$2: expected $1 to exist"; }
assert_missing() { [[ ! -e "$1" ]] || fail "$2: expected $1 to NOT exist"; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in: $1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "$3: expected NOT to contain [$2] in: $1"; }

fresh() {
  P="$TMP/$1"; mkdir -p "$P/etc/cron.d" "$P/var/log" "$P/home/$ME"
  export MONITOR_SETUP_PREFIX="$P" MONITOR_OWNER="$ME"
}
run_setup() { bash "$SCRIPT" "$@" > "$P/out" 2>&1; }

test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

t_syntax() { bash -n "$SCRIPT" || fail "bash -n"; }

t_installs_everything() {
  fresh all
  run_setup || fail "exit $? $(cat "$P/out")"
  assert_exists "$P/usr/local/lib/gikailog-monitor/health.sh" "health.sh installed from the checkout"
  assert_eq "755" "$(stat -c %a "$P/usr/local/lib/gikailog-monitor/health.sh")" "health.sh mode"
  assert_exists "$P/etc/gikailog" "token dir"
  assert_eq "700" "$(stat -c %a "$P/etc/gikailog")" "token dir is private"
  assert_missing "$P/etc/gikailog/monitor.token" "no token is invented"
  assert_exists "$P/var/log/gikailog-monitor.log" "log file"
  assert_eq "600" "$(stat -c %a "$P/var/log/gikailog-monitor.log")" "log is root-only"
  assert_exists "$P/var/lib/gikailog-monitor" "state dir"
  assert_eq "700" "$(stat -c %a "$P/var/lib/gikailog-monitor")" "state dir is root-only"
  assert_exists "$P/home/$ME/monitor" "latest.json dir for the deploy user"
  assert_eq "700" "$(stat -c %a "$P/home/$ME/monitor")" "latest dir mode"
  local cron; cron=$(cat "$P/etc/cron.d/gikailog-monitor")
  assert_contains "$cron" "*/5 * * * * root" "every 5 minutes as root"
  assert_contains "$cron" "/usr/local/lib/gikailog-monitor/health.sh" "runs the root-owned copy, not the checkout"
  assert_contains "$cron" ">> /var/log/gikailog-monitor.log" "cron output to the log"
  assert_not_contains "$cron" "$P" "cron lines are real paths, not the test prefix"
  assert_eq "644" "$(stat -c %a "$P/etc/cron.d/gikailog-monitor")" "cron.d mode"
  assert_contains "$(cat "$P/out")" "monitor.token" "operator is told how to place the token"
}

t_idempotent() {
  fresh twice
  run_setup || fail "first: $(cat "$P/out")"
  echo "keep" > "$P/etc/gikailog/monitor.token"; chmod 600 "$P/etc/gikailog/monitor.token"
  run_setup || fail "second: $(cat "$P/out")"
  assert_eq "keep" "$(cat "$P/etc/gikailog/monitor.token")" "existing token untouched"
  assert_eq "1" "$(grep -c health.sh "$P/etc/cron.d/gikailog-monitor")" "cron line not duplicated"
}

t_refuses_symlinked_latest_dir() {
  fresh symlink
  mkdir -p "$P/elsewhere"; ln -s "$P/elsewhere" "$P/home/$ME/monitor"
  run_setup && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "symlink" "says why"
  assert_missing "$P/etc/cron.d/gikailog-monitor" "no cron installed on refusal"
}

t_warns_when_token_missing() {
  fresh notoken
  run_setup || fail "exit $?"
  assert_contains "$(cat "$P/out")" "fail soft" "explains the script fails soft without the token"
}

t_no_secrets_in_cron_or_output() {
  fresh secrets
  echo "github_pat_TESTONLY" > "$P/etc/gikailog/monitor.token" 2>/dev/null || { mkdir -p "$P/etc/gikailog"; echo "github_pat_TESTONLY" > "$P/etc/gikailog/monitor.token"; }
  run_setup || fail "exit $?"
  assert_not_contains "$(cat "$P/out")$(cat "$P/etc/cron.d/gikailog-monitor")" "github_pat_TESTONLY" "token value never printed"
}

test_case "setup.sh: bash -n" t_syntax
test_case "setup: health.sh を root 所有で配置、token dir 700、log 600、state 700、cron.d（5 分、root）" t_installs_everything
test_case "setup: 2 回走らせても token を消さず cron を重複させない" t_idempotent
test_case "setup: latest.json の置き場がシンボリックリンクなら中止" t_refuses_symlinked_latest_dir
test_case "setup: token が無くても成功し、fail soft を説明する" t_warns_when_token_missing
test_case "setup: token の値を出力にも cron にも出さない" t_no_secrets_in_cron_or_output

echo; echo "passed: $PASS  failed: $FAIL"
[[ $FAIL == 0 ]]
