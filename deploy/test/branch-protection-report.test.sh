#!/usr/bin/env bash
# Tests for deploy/monitor/branch-protection-report.sh (Issue #540): which Issue is opened or closed for each exit
# code of branch-protection.sh.
#
# Why this file exists: this logic used to be an inline `run:` block in branch-protection.yml, and NOTHING checked
# it. A review mutated it five ways — swapping the two Issue titles, making rc=2 report the "weak" title, deleting
# the `set +e`, dropping the rc=2 branch, and making rc=0 close only one Issue — and the suite stayed at
# 19 passed for every one (#546 review). Each mutation reproduces a failure this PR was written to fix.
#
# No network and no real gh: branch-protection.sh and report.sh are replaced through GUARD_CMD / REPORT_CMD, and
# every report.sh call is appended to $ACTIONS as one line "<status> <title>".
#   bash deploy/test/branch-protection-report.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../monitor/branch-protection-report.sh"
PASS=0; FAIL=0

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

WEAK="[monitor] repo: main の保護設定"
UNREADABLE="[monitor] repo: main の保護設定を読めない"

# Stub guard: exits with $G_RC and prints $G_OUT.
cat > "$TMP/guard" <<'STUB'
#!/usr/bin/env bash
echo "${G_OUT:-guard says something}"
exit "${G_RC:-0}"
STUB
# Stub report.sh: records "<status> <title>" and fails when the title is listed in $R_FAIL_FOR.
cat > "$TMP/report" <<'STUB'
#!/usr/bin/env bash
title=$1; status=$2
echo "$status $title" >> "$ACTIONS"
if [ -n "${R_FAIL_FOR:-}" ] && [ "$title" = "$R_FAIL_FOR" ]; then echo "stub: report.sh failing on purpose" >&2; exit 1; fi
STUB
chmod +x "$TMP/guard" "$TMP/report"

fail() { echo "    x $1"; CURRENT_FAILED=1; }

fresh() {
  P="$TMP/$1"; mkdir -p "$P"; ACTIONS="$P/actions"; : > "$ACTIONS"
  export ACTIONS RUNNER_TEMP="$P"
  unset G_RC G_OUT R_FAIL_FOR
}
# Runs the reporter the way the workflow does: the default shell there is `bash -e`, and the whole point of the
# `set +e` inside is to survive that. Running it without -e would hide the very bug this guards against.
run_report() {
  RC=0
  GUARD_CMD="bash $TMP/guard" REPORT_CMD="bash $TMP/report" \
    bash -e "$SCRIPT" uonoko1/giinrecord main https://example/run > "$P/out" 2> "$P/err" || RC=$?
  OUT=$(cat "$P/out")
}
# The exact set of report.sh calls, order-insensitive, as "status title" lines.
assert_actions() {
  local want got
  want=$(printf '%s\n' "$@" | sort)
  got=$(sort "$ACTIONS")
  [[ "$want" == "$got" ]] || fail "report.sh の呼ばれ方が違う
    期待: $(echo "$want" | tr '\n' '|')
    実際: $(echo "$got" | tr '\n' '|')"
}

test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

t_syntax() { bash -n "$SCRIPT" || fail "bash -n"; }

# rc=0: read successfully and intact. BOTH Issues are closed — "unreadable" is disproved by having read it.
t_rc0_closes_both() {
  fresh rc0
  G_RC=0 run_report
  [[ $RC == 0 ]] || fail "expected exit 0, got $RC"
  assert_actions "ok $WEAK" "ok $UNREADABLE"
}

# rc=1: read successfully and WEAK. The weak Issue opens; the unreadable one is closed, because reading succeeded.
# Leaving it open would keep a wrong Issue alongside the right one — #540 with the two sides swapped.
t_rc1_opens_weak_and_closes_unreadable() {
  fresh rc1
  G_RC=1 G_OUT="enforce_admins が false" run_report
  [[ $RC == 1 ]] || fail "expected exit 1, got $RC"
  assert_actions "fail $WEAK" "ok $UNREADABLE"
}

# rc=2: could not read. The unreadable Issue opens; the weak one is NOT touched in either direction, because its
# subject was never determined this run.
t_rc2_opens_unreadable_and_leaves_weak_alone() {
  fresh rc2
  G_RC=2 G_OUT="保護設定を読めなかった" run_report
  [[ $RC == 1 ]] || fail "expected exit 1 (the run must go red), got $RC"
  assert_actions "fail $UNREADABLE"
}

# The bodies must not be mixed up: this is the #540 mistake itself (an Issue that said the protection was weak
# while it was merely unreadable). Pinning the title alone is not enough — the text has to match the outcome.
t_bodies_match_the_outcome() {
  fresh bodies
  G_RC=1 G_OUT="enforce_admins が false" run_report
  local weak_body; weak_body=$(cat "$P/branch-protection-body.md")
  [[ "$weak_body" == *"弱まっている"* ]] || fail "rc=1 の本文が「弱まっている」と言っていない: $weak_body"
  [[ "$weak_body" != *"判定できていない"* ]] || fail "rc=1 の本文が「判定できていない」と言っている"

  fresh bodies2
  G_RC=2 G_OUT="読めなかった" run_report
  local un_body; un_body=$(cat "$P/branch-protection-body.md")
  [[ "$un_body" == *"判定できていない"* ]] || fail "rc=2 の本文が「判定できていない」と言っていない: $un_body"
  [[ "$un_body" != *"弱まっている"* ]] || fail "rc=2 の本文が「弱まっている」と言っている（#540 の再発）"
}

# An unexpected exit code (jq dying with 5, say) must still open an Issue. Reporting nothing would turn the run red
# with no explanation anywhere. "No verdict was reached" is exactly what the unreadable Issue means.
t_unexpected_rc_reports_unreadable() {
  fresh rc5
  G_RC=5 G_OUT="想定外" run_report
  [[ $RC == 1 ]] || fail "expected exit 1, got $RC"
  assert_actions "fail $UNREADABLE"
  [[ "$OUT" == *"想定外の終了コード 5"* ]] || fail "想定外だったことを述べていない: $OUT"
}

# A failing report.sh must fail the step. With `set +e` left on, a failed FIRST call was swallowed because the
# second one returned 0 and the step took its status — the monitoring would silently stop closing an Issue while
# every run stayed green (#546 review).
t_first_report_failure_is_not_swallowed() {
  fresh reportfail
  G_RC=0 R_FAIL_FOR="$WEAK" run_report
  [[ $RC != 0 ]] || fail "1本目の report.sh が失敗したのに step が 0 で終わった（失敗が飲まれている）"
}

t_second_report_failure_is_not_swallowed() {
  fresh reportfail2
  G_RC=0 R_FAIL_FOR="$UNREADABLE" run_report
  [[ $RC != 0 ]] || fail "2本目の report.sh が失敗したのに step が 0 で終わった"
}

# The guard's exit code is a VALUE here. Under `bash -e` (the workflow's default shell) a non-zero command
# substitution ends the step where it stands: measured as exit 2 with no Issue opened at all (run 33987618134).
# Every case above runs under `bash -e`, so deleting the `set +e` breaks them; this one names the reason.
t_survives_errexit() {
  fresh errexit
  G_RC=2 run_report
  [[ -s "$ACTIONS" ]] || fail "bash -e のもとで report.sh が1回も呼ばれていない（set +e が効いていない）"
}

echo "== deploy/monitor/branch-protection-report.sh =="
test_case "syntax"                                        t_syntax
test_case "rc=0: 両方の Issue を閉じる"                     t_rc0_closes_both
test_case "rc=1: 弱いを開き、読めないを閉じる"               t_rc1_opens_weak_and_closes_unreadable
test_case "rc=2: 読めないを開き、弱いには触らない"            t_rc2_opens_unreadable_and_leaves_weak_alone
test_case "本文が結果と一致している（取り違えない）"          t_bodies_match_the_outcome
test_case "想定外の終了コードでも Issue を開く"              t_unexpected_rc_reports_unreadable
test_case "1本目の report.sh の失敗を飲まない"               t_first_report_failure_is_not_swallowed
test_case "2本目の report.sh の失敗を飲まない"               t_second_report_failure_is_not_swallowed
test_case "bash -e のもとでも case に入る（set +e）"         t_survives_errexit

echo "-- $PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]
