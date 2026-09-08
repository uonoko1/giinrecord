#!/usr/bin/env bash
# Tests for deploy/monitor/environment-protection-report.sh (Issue #661): which Issue is opened or closed for each
# exit code of environment-protection.sh.
#
# Why this file exists: the same logic for branch protection used to be an inline `run:` block, and NOTHING checked
# it. A review mutated it five ways — swapping the two Issue titles, making rc=2 report the "weak" title, deleting
# the `set +e`, dropping the rc=2 branch, and making rc=0 close only one Issue — and the suite stayed at 19 passed
# for every one (#546 review). Each mutation reproduces a failure that work was written to fix.
#
# No network and no real gh: environment-protection.sh and report.sh are replaced through GUARD_CMD / REPORT_CMD,
# and every report.sh call is appended to $ACTIONS as one line "<status> <title>".
#   bash deploy/test/environment-protection-report.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../monitor/environment-protection-report.sh"
PASS=0; FAIL=0

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

DRIFT="[monitor] repo: Environment の保護設定"
UNREADABLE="[monitor] repo: Environment の保護設定を読めない"

# Stub guard: exits with $G_RC and prints $G_OUT.
cat > "$TMP/guard" <<'STUB'
#!/usr/bin/env bash
echo "${G_OUT:-guard says something}"
exit "${G_RC:-0}"
STUB
# Stub report.sh: records "<status> <title>" and fails when the title is listed in $R_FAIL_FOR.
cat > "$TMP/report" <<'STUB'
#!/usr/bin/env bash
title=$1; status=$2; body=${3:-}
echo "$status $title" >> "$ACTIONS"
[ -z "$body" ] || cp "$body" "$BODY_COPY"
if [ -n "${R_FAIL_FOR:-}" ] && [ "$title" = "$R_FAIL_FOR" ]; then echo "stub: report.sh failing on purpose" >&2; exit 1; fi
STUB
chmod +x "$TMP/guard" "$TMP/report"

fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_contains()     { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in: $1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "$3: expected NOT to contain [$2] in: $1"; }

fresh() {
  P="$TMP/$1"; mkdir -p "$P"; ACTIONS="$P/actions"; : > "$ACTIONS"
  BODY_COPY="$P/body.md"; : > "$BODY_COPY"
  export ACTIONS BODY_COPY RUNNER_TEMP="$P"
  unset G_RC G_OUT R_FAIL_FOR
}
# Runs the reporter the way the workflow does: the default shell there is `bash -e`, and the whole point of the
# `set +e` inside is to survive that. Running it without -e would hide the very bug this guards against.
run_report() {
  RC=0
  GUARD_CMD="bash $TMP/guard" REPORT_CMD="bash $TMP/report" \
    bash -e "$SCRIPT" uonoko1/giinrecord https://example/run > "$P/out" 2> "$P/err" || RC=$?
  OUT=$(cat "$P/out"); BODY=$(cat "$BODY_COPY")
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

# rc=0: read successfully and as intended. BOTH Issues are closed — "unreadable" is disproved by having read it.
t_rc0_closes_both() {
  fresh rc0
  G_RC=0 run_report
  [[ $RC == 0 ]] || fail "expected exit 0, got $RC"
  assert_actions "ok $DRIFT" "ok $UNREADABLE"
}

# rc=1: read successfully and DRIFTED. The drift Issue opens; the unreadable one is closed, because reading
# succeeded. Leaving it open would keep a wrong Issue alongside the right one — #540 with the two sides swapped.
t_rc1_opens_drift_closes_unreadable() {
  fresh rc1
  G_RC=1 G_OUT="fail environment-protection: production にルールが付いた" run_report
  [[ $RC == 1 ]] || fail "expected exit 1, got $RC"
  assert_actions "fail $DRIFT" "ok $UNREADABLE"
  assert_contains "$BODY" "production にルールが付いた" "the guard's output is quoted into the Issue body"
  assert_contains "$BODY" "https://example/run" "the run URL is in the body"
}

# rc=2: NOTHING is known about the settings. The unreadable Issue opens and the drift Issue is LEFT ALONE —
# closing it would say "the settings are fine" on a run that never read them, and opening it would say they
# drifted when that was never determined (#540 is exactly that wrong claim).
t_rc2_opens_unreadable_only() {
  fresh rc2
  G_RC=2 G_OUT="fail environment-protection: 読めなかった" run_report
  [[ $RC == 1 ]] || fail "expected exit 1 (the run must go red), got $RC"
  assert_actions "fail $UNREADABLE"
  assert_not_contains "$BODY" "食い違っている" "the unreadable body must not claim the settings drifted"
  assert_contains "$BODY" "判定できていない" "the unreadable body says no verdict was reached"
}

# An unexpected exit code (jq exiting 5, the guard crashing) means no verdict was reached, which is what the
# unreadable Issue says. Reporting nothing would be worse: the run would go red with no explanation anywhere.
t_unexpected_rc_treated_as_unreadable() {
  local rc
  for rc in 3 5 127; do
    fresh "unexpected_$rc"
    G_RC=$rc run_report
    [[ $RC == 1 ]] || fail "expected exit 1 for guard rc=$rc, got $RC"
    assert_actions "fail $UNREADABLE"
    assert_contains "$OUT" "想定外の終了コード $rc" "warns that the exit code was unexpected"
  done
}

# The two titles must stay DIFFERENT. Swapping them was one of the mutations that #546's review slipped past an
# unguarded inline block; a drift Issue titled "could not read" is unactionable in both directions.
t_titles_are_distinct() {
  [[ "$DRIFT" != "$UNREADABLE" ]] || fail "the two Issue titles are identical"
  # -F: the titles start with `[monitor]`, which a basic regex reads as a character class matching one of
  # `m o n i t r`. Without -F this grep matched nothing and the assertion failed for a reason that had nothing
  # to do with the script (WORKING_AGREEMENT: 言語の構造は、その言語の実装に解かせる).
  grep -qF "DRIFT_TITLE=\"$DRIFT\"" "$SCRIPT" || fail "drift title in the script does not match the expected one"
  grep -qF "UNREADABLE_TITLE=\"$UNREADABLE\"" "$SCRIPT" || fail "unreadable title in the script does not match"
}

# The guard's exit code is used as a VALUE. Under the workflow's `bash -e`, a non-zero command substitution ends
# the step on the spot — measured on the branch-protection equivalent: it exited 2 without opening a single Issue
# (run 33987618134). This is the `set +e` in the script; without it, rc=1 and rc=2 open nothing at all.
t_survives_bash_e() {
  local rc
  for rc in 1 2; do
    fresh "bashe_$rc"
    G_RC=$rc run_report
    [[ $(wc -l < "$ACTIONS") -ge 1 ]] || fail "guard rc=$rc opened no Issue at all (set +e missing?)"
  done
}

# A failing report.sh must fail the run. Swallowing it leaves the monitoring silently not monitoring: the check
# ran, found a problem, could not record it anywhere, and the run stayed green (#546 review).
t_report_failure_is_not_swallowed() {
  fresh reportfail
  G_RC=1 R_FAIL_FOR="$DRIFT" run_report
  [[ $RC != 0 ]] || fail "a failing report.sh must make the run red, got $RC"
  assert_contains "$OUT" "::error::" "says which report.sh call failed"
}

# …in the ok path too. rc=0 closes two Issues; if the first close fails, the run must not be green.
t_report_failure_on_ok_path() {
  fresh reportfail_ok
  G_RC=0 R_FAIL_FOR="$UNREADABLE" run_report
  [[ $RC != 0 ]] || fail "a failing close must make the run red, got $RC"
}

echo "== deploy/monitor/environment-protection-report.sh =="
test_case "syntax"                                          t_syntax
test_case "rc=0（意図どおり）: 両方の Issue を閉じる"          t_rc0_closes_both
test_case "rc=1（食い違い）: 食い違いを開き、読めないは閉じる"  t_rc1_opens_drift_closes_unreadable
test_case "rc=2（読めない）: 読めないだけを開き、他は触らない"  t_rc2_opens_unreadable_only
test_case "想定外の終了コードは読めない扱い（3通り）"          t_unexpected_rc_treated_as_unreadable
test_case "2つの Issue タイトルは別物"                       t_titles_are_distinct
test_case "bash -e の下でも rc を値として扱える（set +e）"     t_survives_bash_e
test_case "report.sh の失敗を握りつぶさない"                  t_report_failure_is_not_swallowed
test_case "ok 経路でも report.sh の失敗で赤くする"            t_report_failure_on_ok_path

echo "-- $PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]
