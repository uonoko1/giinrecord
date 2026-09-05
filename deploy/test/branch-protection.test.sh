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
# stdout and stderr are captured SEPARATELY and on purpose: stdout is what branch-protection.yml copies into a
# public Issue body, stderr only reaches the job log. Merging them here (`2>&1`) would make every assertion about
# "must not be printed" meaningless, since a leak on stdout and a diagnostic on stderr would look the same.
#   $OUT = stdout   $ERR = stderr
run_guard() {
  RC=0
  PATH="$BIN:$PATH" bash "$SCRIPT" "$@" > "$P/out" 2> "$P/err" || RC=$?
  OUT=$(cat "$P/out"); ERR=$(cat "$P/err")
}

test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

t_syntax() { bash -n "$SCRIPT" || fail "bash -n branch-protection.sh"; }

# The guard's REQUIRED_CHECKS and the cases below are both in the two files of this PR, so weakening them TOGETHER
# passes: a review demonstrated that dropping `gitleaks` from the guard's list AND from the loop below gives
# 15 passed / shellcheck rc=0 while secret scanning is no longer required to merge (#521 review).
# This case takes the expected set from a THIRD place that neither file controls — the CI workflows that define the
# jobs. `gitleaks` / `forbidden-patterns` / `audit` are job ids in .github/workflows/security.yml and `check` is one
# in ci.yml; a required status check is named after the job that reports it. To drop one from the guard now, the
# job itself has to be deleted from the workflow, which is a visible change in a third file
# (WORKING_AGREEMENT: 防御は「不可能にすること」ではなく「隠れて通れなくすること」／経路が2つ以上あるものは
#  それぞれ別々に釘打つ).
# NOT CLOSED, on purpose — read this before trusting the case below.
#
# This is a SUBSET assertion in ONE DIRECTION ONLY: every job found in the workflows must appear in
# REQUIRED_CHECKS. Measured, both directions (2026-09-06):
#
#   RENAME  `gitleaks:` → `secrets-scan:` in security.yml, REQUIRED_CHECKS untouched
#             → 15 passed, 1 failed (exit 1). `want` changes, `got` does not, the subset breaks. Caught.
#   DELETE  remove the whole `gitleaks:` job from security.yml, REQUIRED_CHECKS untouched
#             → 16 passed, 0 failed (exit 0). NOT CAUGHT.
#
# The delete direction is not caught because removing a job SHRINKS `want`, and a subset assertion is satisfied
# for free when the left side shrinks. That is exactly the shape #499 warns about ("allowlist は痩せたら落とす
# だけでなく、中身が入れ替わったら落とすまで固定する") — here only the "入れ替わったら" half is covered.
#
# Why it is not made bidirectional here: `docker-web` is a job in ci.yml that is deliberately NOT a required
# check, so "every job must be required" is false as stated. A bidirectional check needs an allowlist of such
# exceptions, and that allowlist would itself need pinning — which is more than this layer can carry, since it
# reads YAML with sed/grep and depends on job ids being two-space-indented keys. This is the
# "そのレイヤでは塞げない" side of #504, not the "塞げるのに塞いでいない" side.
#
# What deleting a job is BELIEVED to cause — THIS IS REASONING, NOT MEASURED: the required contexts live in the
# branch protection settings, not in the workflow, so deleting the job does not remove `gitleaks` from the
# required set. Nothing would report it, the check would stay `expected`, and PRs would stop being mergeable
# (the `4 of 4 required status checks are expected.` state seen in #521). That fails towards "merges stop",
# not towards "secret scanning silently stops being required". It has NOT been verified end to end on a real PR.
#
# Where this should move: #526 does the same kind of work in TypeScript (packages/etl). The bidirectional
# comparison, plus a pinned allowlist for exceptions like `docker-web`, belongs there.
t_required_checks_match_workflows() {
  local want got missing=""
  # job ids = the two-space-indented keys AFTER the top-level `jobs:` line (sed range), so `permissions:` and
  # `concurrency:` above it are not mistaken for jobs. Plus `check`, the job ci.yml defines.
  want=$( { sed -n '/^jobs:/,$p' "$HERE/../../.github/workflows/security.yml" \
              | grep -oE '^  [a-z][a-z0-9-]*:' | tr -d ' :'
           echo check; } | sort -u)
  [ -n "$want" ] || { fail "workflow から job 名を1つも取れなかった（この検査自体が空振りしている）"; return; }
  # the list the guard actually enforces
  got=$(sed -n 's/^REQUIRED_CHECKS=(\(.*\))$/\1/p' "$SCRIPT" | tr ' ' '\n' | sort -u)
  [ -n "$got" ] || { fail "REQUIRED_CHECKS を読み取れなかった"; return; }
  local w
  while read -r w; do
    [ -z "$w" ] && continue
    grep -qxF "$w" <<<"$got" || missing="$missing $w"
  done <<<"$want"
  [ -z "$missing" ] || fail "CI の job なのに必須チェックに入っていない:$missing (guard: $(tr '\n' ' ' <<<"$got"))"
}

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
# this file used the chained form, and its comment claimed the second expansion could not see the first assignment,
# so the fixture had been passing vacuously. THAT CLAIM WAS WRONG (#521 review). Prefix assignments are applied
# left to right and each one sees the previous:
#   $ probe(){ echo "[$B]"; };  B=x;  B=first B=${B}-second probe   →   [first-second]
# The old fixture really did remove `check`; it was not vacuous.
#
# The SC2097/SC2098 warnings are not wrong either — the behaviour they describe is real, it just applies to a
# DIFFERENT construct: an expansion in the command's ARGUMENTS is performed by the parent, before the assignment
# takes effect:
#   $ A=outer; A=new echo "[$A]"   →   [outer]
# The linter reports both shapes with the same message, and reading it as "my two assignments cannot see each
# other" was the error. A tool firing is not proof that its warning applies to the line in front of you.
# The function is kept anyway: it is clearer, and the fixture self-check below is worth having on its own.
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

# "could not read" and "is weak" are DIFFERENT outcomes and must not share an exit code (#540). The workflow keys
# the Issue title off this, and #540 was opened saying the protection was weak while it was in fact intact — the
# token simply lacked `administration: read`. A wrong alarm every morning cannot be told from a real one.
t_unreadable_is_exit_2() {
  fresh unreadable_rc
  H_GH_EXIT=1 H_GH_STDERR="gh: Resource not accessible by integration (HTTP 403)" run_guard uonoko1/giinrecord main
  [[ $RC == 2 ]] || fail "expected exit 2 when the settings cannot be read, got $RC"
  # it must NOT claim the settings are weak — that has not been determined
  assert_not_contains "$OUT" "弱まっている" "must not claim the settings are weak when they were never read"
  assert_contains "$OUT" "判定できていない" "says the verdict could not be reached"
}

# A weakened setting keeps exit 1, so the two cases stay distinguishable in both directions.
t_weak_is_exit_1() {
  fresh weak_rc
  H_PROTECTION=${DEFAULT_PROTECTION/'"enforce_admins":{"enabled":true}'/'"enforce_admins":{"enabled":false}'} \
    run_guard uonoko1/giinrecord main
  [[ $RC == 1 ]] || fail "expected exit 1 when a setting is weak, got $RC"
}

# The reason must be findable. The first fix sent gh's message to /dev/null, so the guard said "see the run log"
# while the run log did not contain it either — an instruction that could not be followed (#507). It belongs on
# stderr: the job log gets it, the public Issue body does not.
t_reason_on_stderr_not_stdout() {
  fresh reason
  H_GH_EXIT=1 H_GH_STDERR="gh: Resource not accessible by integration (HTTP 403)" run_guard uonoko1/giinrecord main
  assert_contains "$ERR" "Resource not accessible by integration" "the API error reaches stderr (the job log)"
  assert_not_contains "$OUT" "Resource not accessible by integration" "…but never stdout (the public Issue body)"
}

# Everything this script prints on stdout is copied verbatim into a PUBLIC GitHub Issue body by
# branch-protection.yml, and gh echoes the Authorization header in some API failures. An earlier revision tried to
# redact it with `sed -E 's/gh[pousr]_[A-Za-z0-9]+/<redacted>/g'`, which is a denylist: it caught `ghp_…` and let
# `github_pat_…` (the current fine-grained format — it contains `_`, so `[A-Za-z0-9]+` does not even match it)
# through into the Issue. So the guard no longer relays gh's message at all. These cases drive the real error path
# with several token shapes; a redaction list would have to grow for each one, this must pass for any of them.
t_no_secret_in_output() {
  # The shapes are BUILT here rather than written out: a literal `github_pat_…` of realistic length is itself
  # matched by scripts/ci/forbidden-patterns.sh (verified — it reported this file), and a test fixture must not
  # look like a credential. The prefix and the body are concatenated at run time, so the file contains neither.
  local prefix shape body
  body="0123456789abcdefghij0123456789abcdefghij"
  for prefix in ghp_ gho_ ghs_ ghr_ github_pat_ some_future_prefix_; do
    shape="${prefix}${body}"
    fresh "nosecret_${prefix}"
    H_GH_EXIT=1 H_GH_STDERR="gh: Bad credentials — Authorization: Bearer $shape (HTTP 401)" \
      run_guard uonoko1/giinrecord main
    [[ $RC != 0 ]] || fail "expected non-zero when the API call fails"
    assert_not_contains "$OUT" "$shape" "token shape [$shape] must never be printed"
  done
}

echo "== deploy/monitor/branch-protection.sh =="
test_case "syntax"                                   t_syntax
test_case "必須チェックの一覧が CI の job 定義と一致する"    t_required_checks_match_workflows
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
test_case "読めなかったときは exit 2（弱いとは言わない）"    t_unreadable_is_exit_2
test_case "設定が弱いときは exit 1"                       t_weak_is_exit_1
test_case "失敗の理由は stderr に出る（stdout には出ない）"  t_reason_on_stderr_not_stdout
test_case "トークンを出力に出さない（6形式）"              t_no_secret_in_output

echo "-- $PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]
