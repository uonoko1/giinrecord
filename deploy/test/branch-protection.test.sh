#!/usr/bin/env bash
# Tests for deploy/monitor/branch-protection.sh (Issue #521): the guard that reads main's branch protection from
# the GitHub API and fails when the settings that make CI unskippable have been weakened.
#
# Why a guard at all: branch protection lives in GitHub's settings, NOT in this repository. Nothing in a diff, a
# review or a CI run can show that it changed. It was `enforce_admins: false` for an unknown length of time and the
# PO pushed to main three times without running a single required check; the `remote:` line that says so ("Bypassed
# rule violations") is easy to read as a rejection (#521, and WORKING_AGREEMENT "git の出力は、比べている基準を
# 自分で言えるまで信じない"). Flipping the setting back is one API call and leaves no trace in the repository, so
# the setting alone is not a defence — this check is what makes a re-weakening loud instead of silent.
#
# No network: gh is a stub on PATH that answers with the JSON in $H_PROTECTION and records its arguments.
#   bash deploy/test/branch-protection.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MON="$HERE/../monitor"
SCRIPT="$MON/branch-protection.sh"
PASS=0; FAIL=0

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"; mkdir -p "$BIN"
cat > "$BIN/gh" <<'STUB'
#!/usr/bin/env bash
echo "gh $*" >> "$STUB_LOG"
case "$1 $2" in
  "api repos/"*)
    if [ -n "${H_GH_EXIT:-}" ]; then echo "${H_GH_STDERR:-gh: request failed}" >&2; exit "$H_GH_EXIT"; fi
    printf '%s' "${H_PROTECTION:-$DEFAULT_PROTECTION}" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$BIN/gh"

# The settings as they must be. This is the shape the real API returns (verified against
# `gh api repos/<owner>/<repo>/branches/main/protection` on 2026-09-06).
# shellcheck disable=SC2089,SC2090  # 中の " は JSON の一部。常に単一の値として渡すので再分割されない
DEFAULT_PROTECTION='{"required_status_checks":{"strict":true,"checks":[{"context":"check","app_id":null},{"context":"gitleaks","app_id":15368},{"context":"forbidden-patterns","app_id":15368},{"context":"audit","app_id":15368}]},"enforce_admins":{"enabled":true},"allow_force_pushes":{"enabled":false},"allow_deletions":{"enabled":false}}'
# shellcheck disable=SC2090
export DEFAULT_PROTECTION

fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_contains()     { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in: $1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "$3: expected NOT to contain [$2] in: $1"; }

fresh() {
  P="$TMP/$1"; mkdir -p "$P"; LOG="$P/stub.log"; : > "$LOG"
  export STUB_LOG="$LOG"
  unset H_PROTECTION H_GH_EXIT H_GH_STDERR
}
# Runs the guard and records its exit code in $RC (never aborts the suite under `set -e`).
run_guard() { RC=0; PATH="$BIN:$PATH" bash "$SCRIPT" "$@" > "$P/out" 2>&1 || RC=$?; OUT=$(cat "$P/out"); }

test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

t_syntax() { bash -n "$SCRIPT" || fail "bash -n branch-protection.sh"; }

t_healthy() {
  fresh healthy
  run_guard uonoko1/giinrecord main
  [[ $RC == 0 ]] || fail "expected exit 0, got $RC: $OUT"
  assert_contains "$OUT" "ok" "says ok"
  assert_contains "$(cat "$LOG")" "repos/uonoko1/giinrecord/branches/main/protection" "asks the API for main's protection"
}

# --- the failure this Issue is about -------------------------------------------------------------------------
t_enforce_admins_off() {
  fresh admins_off
  H_PROTECTION=${DEFAULT_PROTECTION/'"enforce_admins":{"enabled":true}'/'"enforce_admins":{"enabled":false}'} \
    run_guard uonoko1/giinrecord main
  [[ $RC != 0 ]] || fail "expected non-zero when enforce_admins is false"
  assert_contains "$OUT" "enforce_admins" "names the setting"
}

# --- the required checks: the SET, not the count (#499: an allowlist must pin its contents) -------------------
# Two substitutions are needed because the first element of the array has no leading comma: `,{"context":"x"}`
# removes any element but the first, `{"context":"x"},` removes the first one.
#
# This is a plain function, not two chained prefix assignments (`A=${A/x/} A=${A/y/} cmd`). An earlier revision of
# this file used the chained form and its comment claimed the second expansion could not see the first assignment.
# THAT CLAIM WAS WRONG — it was measured afterwards and bash does apply them left to right:
#   $ probe(){ echo "[$B]"; };  B=x;  B=first B=${B}-second probe   →   [first-second]
# so the old fixture really did remove `check`, and it was not passing vacuously. shellcheck's SC2097/SC2098 warn
# that the construct is hard to read and not portable, not that it misbehaves in bash. The function is kept anyway:
# it is clearer, and the fixture self-check below is worth having on its own.
without_check() {
  local ctx=$1 json=$DEFAULT_PROTECTION
  # elements carry an app_id, so match up to the closing brace of the element
  json=$(printf '%s' "$json" | sed -E "s/,\{\"context\":\"$ctx\"[^}]*\}//; s/\{\"context\":\"$ctx\"[^}]*\},//")
  printf '%s' "$json"
}
t_missing_check() {
  local ctx json
  for ctx in check gitleaks forbidden-patterns audit; do
    fresh "missing_$ctx"
    json=$(without_check "$ctx")
    # the fixture must really have lost it, or the case below proves nothing
    [[ "$json" != *"\"context\":\"$ctx\""* ]] || fail "fixture for '$ctx' still lists it: $json"
    H_PROTECTION=$json run_guard uonoko1/giinrecord main
    [[ $RC != 0 ]] || fail "expected non-zero when required check '$ctx' is gone"
    assert_contains "$OUT" "'$ctx'" "names the missing check '$ctx'"
  done
}

# The swap that keeps the count at 4 (#499: "5→5 のすり替えが通る"). Dropping `gitleaks` and adding some other
# context leaves four required checks, so anything that counts is satisfied while secret scanning is no longer
# required at all.
t_swapped_check() {
  fresh swapped
  H_PROTECTION=${DEFAULT_PROTECTION/'{"context":"gitleaks","app_id":15368}'/'{"context":"some-other-job","app_id":15368}'} \
    run_guard uonoko1/giinrecord main
  [[ $RC != 0 ]] || fail "expected non-zero when gitleaks is swapped for another context (count still 4)"
  assert_contains "$OUT" "gitleaks" "names the check that went missing"
}

# An extra required check is not a weakening — it must not fail, or the guard would fight every new CI job.
t_extra_check_is_ok() {
  fresh extra
  H_PROTECTION=${DEFAULT_PROTECTION/'{"context":"audit","app_id":15368}'/'{"context":"audit","app_id":15368},{"context":"brand-new-job","app_id":null}'} \
    run_guard uonoko1/giinrecord main
  [[ $RC == 0 ]] || fail "an ADDITIONAL required check must not fail the guard, got $RC: $OUT"
}

t_strict_off() {
  fresh strict_off
  H_PROTECTION=${DEFAULT_PROTECTION/'"strict":true'/'"strict":false'} run_guard uonoko1/giinrecord main
  [[ $RC != 0 ]] || fail "expected non-zero when strict (up-to-date-before-merge) is off"
  assert_contains "$OUT" "strict" "names the setting"
}

t_force_push_on() {
  fresh force_push
  H_PROTECTION=${DEFAULT_PROTECTION/'"allow_force_pushes":{"enabled":false}'/'"allow_force_pushes":{"enabled":true}'} \
    run_guard uonoko1/giinrecord main
  [[ $RC != 0 ]] || fail "expected non-zero when force pushes are allowed"
  assert_contains "$OUT" "force" "names the setting"
}

t_deletion_on() {
  fresh deletion
  H_PROTECTION=${DEFAULT_PROTECTION/'"allow_deletions":{"enabled":false}'/'"allow_deletions":{"enabled":true}'} \
    run_guard uonoko1/giinrecord main
  [[ $RC != 0 ]] || fail "expected non-zero when branch deletion is allowed"
  assert_contains "$OUT" "deletion" "names the setting"
}

# `restrictions` names the users/teams/apps allowed to push to the branch. It is ABSENT on a healthy main (verified
# against the live API on 2026-09-06), and adding it is one API call with no diff anywhere — so a review found the
# guard reported ok while one named user could push straight to main. Its mere presence is the weakening; the
# contents do not matter, and the names are deliberately not printed (they are people).
t_restrictions_present() {
  fresh restrictions
  H_PROTECTION=${DEFAULT_PROTECTION/'"enforce_admins"'/'"restrictions":{"users":[{"login":"someone"}],"teams":[],"apps":[]},"enforce_admins"'} \
    run_guard uonoko1/giinrecord main
  [[ $RC != 0 ]] || fail "expected non-zero when restrictions grants push access to specific accounts"
  assert_contains "$OUT" "restrictions" "names the setting"
  assert_not_contains "$OUT" "someone" "must not print who was allowed (personal data)"
}

# Same idea one level down: a PR-review bypass list lets named accounts merge around the requirements.
t_bypass_allowances_present() {
  fresh bypass
  H_PROTECTION=${DEFAULT_PROTECTION/'"enforce_admins"'/'"required_pull_request_reviews":{"bypass_pull_request_allowances":{"users":[{"login":"someone"}],"teams":[],"apps":[]}},"enforce_admins"'} \
    run_guard uonoko1/giinrecord main
  [[ $RC != 0 ]] || fail "expected non-zero when bypass_pull_request_allowances names anyone"
  assert_contains "$OUT" "bypass" "names the setting"
  assert_not_contains "$OUT" "someone" "must not print who was allowed (personal data)"
}

# A required context is identified by name AND by the app that reports it. Keeping the name while pointing it at a
# different app_id means some other integration can report `gitleaks` as green (#504: 名前を固定した is not
# 値を固定した). The healthy values are: `check` is reported by Actions (app_id null in the API's checks array is
# not what we see — the live response gives 15368 for the security jobs and null for `check`), so this pins the
# app_id of each context to what the live API returned on 2026-09-06.
t_app_id_swapped() {
  fresh app_id
  H_PROTECTION='{"required_status_checks":{"strict":true,"checks":[{"context":"check","app_id":null},{"context":"gitleaks","app_id":99999},{"context":"forbidden-patterns","app_id":15368},{"context":"audit","app_id":15368}]},"enforce_admins":{"enabled":true},"allow_force_pushes":{"enabled":false},"allow_deletions":{"enabled":false}}' \
    run_guard uonoko1/giinrecord main
  [[ $RC != 0 ]] || fail "expected non-zero when a required context is reported by a different app"
  assert_contains "$OUT" "gitleaks" "names the context whose app changed"
}

# The healthy fixture carries the real app_ids, so the guard must accept them.
t_app_id_healthy() {
  fresh app_id_ok
  H_PROTECTION='{"required_status_checks":{"strict":true,"checks":[{"context":"check","app_id":null},{"context":"gitleaks","app_id":15368},{"context":"forbidden-patterns","app_id":15368},{"context":"audit","app_id":15368}]},"enforce_admins":{"enabled":true},"allow_force_pushes":{"enabled":false},"allow_deletions":{"enabled":false}}' \
    run_guard uonoko1/giinrecord main
  [[ $RC == 0 ]] || fail "the live app_ids must be accepted, got $RC: $OUT"
}

# Protection removed entirely: the API answers 404. "No protection at all" is the WORST case, so it must never be
# mistaken for "nothing to report" (#484: a check that only fails on a written violation is not alive).
t_no_protection_at_all() {
  fresh unprotected
  H_GH_EXIT=1 H_GH_STDERR="gh: Branch not protected (HTTP 404)" run_guard uonoko1/giinrecord main
  [[ $RC != 0 ]] || fail "expected non-zero when the API call fails / the branch is unprotected"
  assert_not_contains "$OUT" "ok " "must not report ok"
}

# Everything this script prints on stdout is copied verbatim into a PUBLIC GitHub Issue body by
# branch-protection.yml, and gh echoes the Authorization header in some API failures. An earlier revision tried to
# redact it with `sed -E 's/gh[pousr]_[A-Za-z0-9]+/<redacted>/g'`, which is a denylist: it caught `ghp_…` and let
# `github_pat_…` (the current fine-grained format — it contains `_`, so `[A-Za-z0-9]+` does not even match it)
# through into the Issue. So the guard no longer relays gh's message at all. These cases drive the real error path
# with several token shapes; a redaction list would have to grow for each one, this must pass for any of them.
t_no_secret_in_output() {
  local shape
  for shape in \
    "ghp_examplenotarealtoken1234" \
    "github_pat_11ABCDEFG0aaaabbbbccccdddd_eeeeffffgggghhhh" \
    "gho_examplenotarealtoken1234" \
    "ghs_examplenotarealtoken1234" \
    "some_future_prefix_9998887776665554443332221110"; do
    fresh "nosecret_${shape:0:6}"
    H_GH_EXIT=1 H_GH_STDERR="gh: Bad credentials — Authorization: Bearer $shape (HTTP 401)" \
      run_guard uonoko1/giinrecord main
    [[ $RC != 0 ]] || fail "expected non-zero when the API call fails"
    assert_not_contains "$OUT" "$shape" "token shape [$shape] must never be printed"
  done
}

echo "== deploy/monitor/branch-protection.sh =="
test_case "syntax"                                   t_syntax
test_case "設定が正しいとき ok で終わる"                  t_healthy
test_case "enforce_admins が false なら落ちる"          t_enforce_admins_off
test_case "必須チェックが1つでも欠けたら落ちる（4通り）"     t_missing_check
test_case "個数が同じまま中身がすり替わったら落ちる"        t_swapped_check
test_case "必須チェックが増えるのは落とさない"              t_extra_check_is_ok
test_case "strict（マージ前に main へ追随）が外れたら落ちる" t_strict_off
test_case "force push が許可されたら落ちる"              t_force_push_on
test_case "ブランチ削除が許可されたら落ちる"                t_deletion_on
test_case "restrictions で名指しの push 許可が付いたら落ちる" t_restrictions_present
test_case "PR 要件の bypass 許可が付いたら落ちる"          t_bypass_allowances_present
test_case "必須チェックを報告するアプリが変わったら落ちる"    t_app_id_swapped
test_case "実際の app_id は通す"                         t_app_id_healthy
test_case "保護そのものが無い（API 404）なら落ちる"        t_no_protection_at_all
test_case "トークンを出力に出さない（5形式）"              t_no_secret_in_output

echo "-- $PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]
