#!/usr/bin/env bash
# Tests for deploy/monitor/environment-protection.sh (Issue #661): the guard that reads the deployment
# Environments from the GitHub API and fails when their protection_rules differ from the intent recorded in #659.
#
# Why a guard at all: an Environment's protection_rules live in GitHub's settings, NOT in this repository. Nothing
# in a diff, a review or a CI run can show that they changed. #660's author said it outright — 「誰かが設定画面で
# reviewers を付けても、この PR のテストは緑のまま通ります」. Adding a required reviewer to `production-data`
# would stall the daily data deploy every day, and nothing would connect the stall to the settings change.
#
# No network: gh is a stub on PATH that answers with the JSON in $H_ENVS and records its arguments.
#   bash deploy/test/environment-protection.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../monitor/environment-protection.sh"
PASS=0; FAIL=0

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"; mkdir -p "$BIN"
cat > "$BIN/gh" <<'STUB'
#!/usr/bin/env bash
echo "gh $*" >> "$STUB_LOG"
case "$1 $2" in
  "api repos/"*)
    if [ -n "${H_GH_EXIT:-}" ]; then echo "${H_GH_STDERR:-gh: request failed}" >&2; exit "$H_GH_EXIT"; fi
    # `${H_ENVS+set}`, NOT `${H_ENVS:-…}`: the empty body is a real case to test, and `:-` would silently
    # replace it with the healthy default. It did — the "empty body" case passed the HEALTHY json and reported
    # ok, and the assertion that caught it was about the guard, not the fixture (#517: まず fixture を疑う).
    if [ -n "${H_ENVS+set}" ]; then printf '%s' "$H_ENVS"; else printf '%s' "$DEFAULT_ENVS"; fi ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$BIN/gh"

# One environment as the live API returns it. `protection_rules: []` is the state #659 recorded as the intent, and
# it is what the real API returned on 2026-09-08 for all three environments (verified in a workflow run with the
# default GITHUB_TOKEN: total_count 3, every protection_rules empty).
env_json() {  # env_json <name> <rules-json>
  printf '{"id":1,"name":"%s","can_admins_bypass":true,"protection_rules":%s,"deployment_branch_policy":null}' "$1" "$2"
}
envs_json() { # envs_json <env-json>...
  local IFS=,; printf '{"total_count":%d,"environments":[%s]}' "$#" "$*"
}
DEFAULT_ENVS=$(envs_json "$(env_json production '[]')" "$(env_json production-data '[]')" "$(env_json staging '[]')")
export DEFAULT_ENVS

# A required-reviewers rule in the shape GitHub returns it. The reviewer list is NOT asserted on anywhere — those
# are people, and this text is copied into a public Issue (same reasoning as branch-protection.sh's `restrictions`).
REVIEWERS_RULE='[{"id":9,"node_id":"x","type":"required_reviewers","reviewers":[{"type":"User","reviewer":{"login":"someone","id":1}}]}]'
WAIT_TIMER_RULE='[{"id":9,"node_id":"x","type":"wait_timer","wait_timer":30}]'

fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_contains()     { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in: $1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "$3: expected NOT to contain [$2] in: $1"; }

fresh() {
  P="$TMP/$1"; mkdir -p "$P"; LOG="$P/stub.log"; : > "$LOG"
  export STUB_LOG="$LOG"
  unset H_ENVS H_GH_EXIT H_GH_STDERR
}
# stdout and stderr are captured SEPARATELY and on purpose: stdout is what environment-protection.yml copies into
# a public Issue body, stderr only reaches the job log. Merging them (`2>&1`) would make every "must not be
# printed" assertion meaningless, since a leak on stdout and a diagnostic on stderr would look the same.
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

t_syntax() { bash -n "$SCRIPT" || fail "bash -n environment-protection.sh"; }

# --- 否定的対照: the intended state must NOT be reported ------------------------------------------------------
# A guard that cannot be green on the real configuration would be turned off within a week.
t_healthy() {
  fresh healthy
  run_guard uonoko1/giinrecord
  [[ $RC == 0 ]] || fail "expected exit 0 on the intended configuration, got $RC: $OUT"
  assert_contains "$OUT" "ok" "says ok"
  assert_contains "$(cat "$LOG")" "repos/uonoko1/giinrecord/environments" "asks the API for the environments"
}

# The order GitHub returns environments in is not guaranteed; the intended state must pass in any order.
t_healthy_any_order() {
  fresh healthy_order
  H_ENVS=$(envs_json "$(env_json staging '[]')" "$(env_json production '[]')" "$(env_json production-data '[]')") \
    run_guard uonoko1/giinrecord
  [[ $RC == 0 ]] || fail "environment order must not matter, got $RC: $OUT"
}

# --- the failure this Issue is about: a rule APPEARS ----------------------------------------------------------
# One case per environment, so that a guard checking only `production` cannot pass this file.
t_reviewers_added() {
  local name
  for name in production production-data staging; do
    fresh "reviewers_$name"
    local a b c
    a='[]'; b='[]'; c='[]'
    case $name in production) a=$REVIEWERS_RULE ;; production-data) b=$REVIEWERS_RULE ;; staging) c=$REVIEWERS_RULE ;; esac
    H_ENVS=$(envs_json "$(env_json production "$a")" "$(env_json production-data "$b")" "$(env_json staging "$c")") \
      run_guard uonoko1/giinrecord
    [[ $RC == 1 ]] || fail "expected exit 1 when required_reviewers appears on '$name', got $RC: $OUT"
    assert_contains "$OUT" "$name" "names the environment '$name'"
    assert_contains "$OUT" "required_reviewers" "names the rule type"
    # the reviewers are people; the Issue body is public
    assert_not_contains "$OUT" "someone" "must not print who was named as a reviewer (personal data)"
  done
}

# A wait_timer is not a reviewer, but it stalls the deploy just the same — 30 minutes every daily data run.
t_wait_timer_added() {
  fresh wait_timer
  H_ENVS=$(envs_json "$(env_json production '[]')" "$(env_json production-data "$WAIT_TIMER_RULE")" "$(env_json staging '[]')") \
    run_guard uonoko1/giinrecord
  [[ $RC == 1 ]] || fail "expected exit 1 when a wait_timer appears, got $RC: $OUT"
  assert_contains "$OUT" "production-data" "names the environment"
  assert_contains "$OUT" "wait_timer" "names the rule type"
}

# --- the other direction: the table says a rule is expected and it is GONE ------------------------------------
# The intent may change to "reviewers ARE required" (#659 left that open). Then losing the rule is the failure,
# and a guard written as "any rule is bad" would say ok. Driven here through the table itself.
t_rule_expected_but_missing() {
  fresh expected_missing
  # rewrite the guard's table so that production expects required_reviewers, then feed it the CURRENT (empty) state
  local mutated="$P/guard.sh"
  sed 's/^  \[production\]=""$/  [production]="required_reviewers"/' "$SCRIPT" > "$mutated"
  grep -q '\[production\]="required_reviewers"' "$mutated" || fail "fixture did not change the table; the case below proves nothing"
  RC=0
  PATH="$BIN:$PATH" bash "$mutated" uonoko1/giinrecord > "$P/out" 2> "$P/err" || RC=$?
  OUT=$(cat "$P/out")
  [[ $RC == 1 ]] || fail "expected exit 1 when an expected rule is absent, got $RC: $OUT"
  assert_contains "$OUT" "production" "names the environment"
  assert_contains "$OUT" "消えた" "says the rule went missing, not that one was added"
}

# …and with that same table, the state that HAS the rule must pass — otherwise the table is not really consulted
# and the previous case would pass for the wrong reason.
t_rule_expected_and_present() {
  fresh expected_present
  local mutated="$P/guard.sh"
  sed 's/^  \[production\]=""$/  [production]="required_reviewers"/' "$SCRIPT" > "$mutated"
  RC=0
  PATH="$BIN:$PATH" H_ENVS=$(envs_json "$(env_json production "$REVIEWERS_RULE")" "$(env_json production-data '[]')" "$(env_json staging '[]')") \
    bash "$mutated" uonoko1/giinrecord > "$P/out" 2> "$P/err" || RC=$?
  OUT=$(cat "$P/out")
  [[ $RC == 0 ]] || fail "with the table expecting required_reviewers, the matching state must pass, got $RC: $OUT"
}

# --- environments appearing / disappearing ---------------------------------------------------------------------
# A deploy target nobody recorded an intent for is how an unreviewed environment slips in.
t_unknown_environment() {
  fresh unknown
  H_ENVS=$(envs_json "$(env_json production '[]')" "$(env_json production-data '[]')" "$(env_json staging '[]')" "$(env_json brand-new "$REVIEWERS_RULE")") \
    run_guard uonoko1/giinrecord
  [[ $RC == 1 ]] || fail "expected exit 1 for an environment not in the table, got $RC: $OUT"
  assert_contains "$OUT" "brand-new" "names the unknown environment"
}

# The subset test in one direction alone is satisfied for free when the left side shrinks (#541). Deleting an
# environment is a settings change with no diff either.
t_environment_deleted() {
  local name
  for name in production production-data staging; do
    fresh "deleted_$name"
    local parts=()
    for e in production production-data staging; do
      [ "$e" = "$name" ] || parts+=("$(env_json "$e" '[]')")
    done
    H_ENVS=$(envs_json "${parts[@]}") run_guard uonoko1/giinrecord
    [[ $RC == 1 ]] || fail "expected exit 1 when environment '$name' is gone, got $RC: $OUT"
    assert_contains "$OUT" "$name" "names the missing environment '$name'"
    assert_contains "$OUT" "存在しない" "says it does not exist"
  done
}

# --- unreadable is NOT the same as drifted (#540) ---------------------------------------------------------------
t_unreadable_is_exit_2() {
  fresh unreadable_rc
  H_GH_EXIT=1 H_GH_STDERR="gh: Resource not accessible by integration (HTTP 403)" run_guard uonoko1/giinrecord
  [[ $RC == 2 ]] || fail "expected exit 2 when the settings cannot be read, got $RC"
  assert_not_contains "$OUT" "食い違っている" "must not claim drift when nothing was read"
  assert_contains "$OUT" "判定できていない" "says the verdict could not be reached"
}

t_drift_is_exit_1() {
  fresh drift_rc
  H_ENVS=$(envs_json "$(env_json production "$REVIEWERS_RULE")" "$(env_json production-data '[]')" "$(env_json staging '[]')") \
    run_guard uonoko1/giinrecord
  [[ $RC == 1 ]] || fail "expected exit 1 when the settings drifted, got $RC"
}

# An empty or wrong-shaped body must be exit 2, not a green "zero environments, nothing to complain about".
# Without the shape check, `{}` makes every loop iterate zero times and the guard prints ok (#484).
t_empty_body_is_unreadable() {
  local body
  for body in '' '{}' '[]' 'null' 'not json at all' '{"environments":null}'; do
    fresh "emptybody_$(printf '%s' "$body" | md5sum | cut -c1-8)"
    H_ENVS="$body" run_guard uonoko1/giinrecord
    [[ $RC == 2 ]] || fail "expected exit 2 for an unusable body [$body], got $RC: $OUT"
    assert_not_contains "$OUT" "ok environment-protection" "must never report ok for body [$body]"
  done
}

# The reason must be findable. Sending it to /dev/null made an earlier guard say "see the run log" while the run
# log did not have it either (#507). It belongs on stderr: the job log gets it, the public Issue body does not.
t_reason_on_stderr_not_stdout() {
  fresh reason
  H_GH_EXIT=1 H_GH_STDERR="gh: Resource not accessible by integration (HTTP 403)" run_guard uonoko1/giinrecord
  assert_contains "$ERR" "Resource not accessible by integration" "the API error reaches stderr (the job log)"
  assert_not_contains "$OUT" "Resource not accessible by integration" "…but never stdout (the public Issue body)"
}

# Everything printed on stdout is copied verbatim into a PUBLIC Issue body, and gh echoes the Authorization header
# in some failures. Redaction would be a denylist and is one token format behind for ever (branch-protection.sh
# lines 56-60), so the guard must not relay gh's message at all — for ANY token shape.
t_no_secret_in_output() {
  # The shapes are BUILT here rather than written out: a literal `github_pat_…` of realistic length is itself
  # matched by scripts/ci/forbidden-patterns.sh, and a test fixture must not look like a credential.
  local prefix shape body
  body="0123456789abcdefghij0123456789abcdefghij"
  for prefix in ghp_ gho_ ghu_ ghs_ ghr_ github_pat_ some_future_prefix_; do
    shape="${prefix}${body}"
    fresh "nosecret_${prefix}"
    H_GH_EXIT=1 H_GH_STDERR="gh: Bad credentials — Authorization: Bearer $shape (HTTP 401)" \
      run_guard uonoko1/giinrecord
    [[ $RC != 0 ]] || fail "expected non-zero when the API call fails"
    assert_not_contains "$OUT" "$shape" "token shape [$shape] must never be printed"
  done
}

# The table is the whole specification of intent. If it is empty, every environment becomes "unknown" and the
# guard still fails — but for the wrong reason. Fixing its CONTENTS here means shrinking it cannot pass quietly
# (#499: allowlist は中身を固定する). This reads the script's own array text, deliberately from a second place.
t_table_contents_pinned() {
  local decl want
  decl=$(sed -n '/^declare -A EXPECTED_RULES=(/,/^)/p' "$SCRIPT" | grep -o '\[[a-z-]*\]="[^"]*"' | sort | tr '\n' ' ')
  want='[production-data]="" [production]="" [staging]="" '
  [[ "$decl" == "$want" ]] || fail "EXPECTED_RULES の中身が変わっている（意図を変えたなら docs/ops/deploy.md も直す）
    期待: $want
    実際: $decl"
}

echo "== deploy/monitor/environment-protection.sh =="
test_case "syntax"                                       t_syntax
test_case "意図どおりの設定なら ok で終わる（誤検出しない）"   t_healthy
test_case "environment の並び順が変わっても ok"             t_healthy_any_order
test_case "required_reviewers が付いたら落ちる（3環境）"     t_reviewers_added
test_case "wait_timer が付いたら落ちる"                    t_wait_timer_added
test_case "期待するルールが消えたら落ちる（逆方向）"          t_rule_expected_but_missing
test_case "期待するルールがあるときは通す（表を実際に見ている）" t_rule_expected_and_present
test_case "表に無い environment が増えたら落ちる"           t_unknown_environment
test_case "表にある environment が消えたら落ちる（3通り）"    t_environment_deleted
test_case "読めなかったときは exit 2（食い違いとは言わない）"  t_unreadable_is_exit_2
test_case "食い違っているときは exit 1"                     t_drift_is_exit_1
test_case "空/壊れた応答は ok にせず exit 2（6通り）"        t_empty_body_is_unreadable
test_case "失敗の理由は stderr に出る（stdout には出ない）"   t_reason_on_stderr_not_stdout
test_case "トークンを出力に出さない（7形式）"                t_no_secret_in_output
test_case "意図の表の中身が固定されている"                   t_table_contents_pinned

echo "-- $PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]
