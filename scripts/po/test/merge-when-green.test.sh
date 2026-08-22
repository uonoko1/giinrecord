# shellcheck shell=bash
# Tests for scripts/po/merge-when-green.sh (sourced by run.sh)

t_merge_rejects_non_numeric() {
  local h; h=$(handler <<'EOF'
handle() { echo "should not be called" >&2; exit 99; }
EOF
)
  run_script "$h" merge-when-green.sh abc
  assert_eq 2 "$STATUS" "exit status"
  assert_contains "$ERR" "usage" "usage on stderr"
  assert_eq "" "$LOG" "gh never called"
}
test_case "merge: rejects non-numeric PR" t_merge_rejects_non_numeric

t_merge_refuses_closed() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"MERGED","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"UNKNOWN","url":"u"}' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "exit status"
  assert_contains "$ERR" "MERGED" "reports state"
  assert_not_contains "$LOG" "pr merge" "no merge attempted"
}
test_case "merge: refuses a PR that is not OPEN" t_merge_refuses_closed

t_merge_refuses_draft() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":true,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u"}' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "exit status"
  assert_contains "$ERR" "draft" "reports draft"
  assert_not_contains "$LOG" "pr merge" "no merge attempted"
}
test_case "merge: refuses a draft PR" t_merge_refuses_draft

t_merge_green_merges() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u"}' ;;
    "pr checks 12 --json"*) echo '[{"name":"check","bucket":"pass"},{"name":"lint","bucket":"skipping"}]' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_contains "$LOG" "pr	merge	12	--squash	--delete-branch" "squash merge with branch deletion"
  assert_not_contains "$LOG" "update-branch" "no update-branch when not BEHIND"
  assert_not_contains "$LOG" "action_required" "no approval lookup for non-data branch"
}
test_case "merge: all checks green → squash merge + delete branch" t_merge_green_merges

t_merge_behind_updates_first() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BEHIND","url":"u"}' ;;
    "pr update-branch 12") echo updated ;;
    "pr checks 12 --json"*) echo '[{"name":"check","bucket":"pass"}]' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "exit status: $ERR"
  local first_line; first_line=$(sed -n 2p <<<"$LOG")
  assert_eq "pr	update-branch	12" "$first_line" "update-branch is the 2nd gh call"
  assert_contains "$LOG" "pr	merge	12" "merged afterwards"
}
test_case "merge: BEHIND → update-branch before polling" t_merge_behind_updates_first

t_merge_pending_then_pass() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BLOCKED","url":"u"}' ;;
    "pr checks 12 --json"*)
      if [ "$(bump)" -lt 3 ]; then echo '[{"name":"check","bucket":"pending"}]'; exit 8
      else echo '[{"name":"check","bucket":"pass"}]'; fi ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_eq 3 "$(grep -c 'pr	checks' <<<"$LOG")" "polled 3 times"
  assert_contains "$LOG" "pr	merge	12" "merged"
}
test_case "merge: pending checks are polled until they pass" t_merge_pending_then_pass

t_merge_failed_check_aborts() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BLOCKED","url":"u"}' ;;
    "pr checks 12 --json"*) echo '[{"name":"check","bucket":"fail"},{"name":"smoke","bucket":"pending"}]'; exit 1 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "exit status"
  assert_contains "$ERR" "check" "names the failed check"
  assert_not_contains "$LOG" "pr	merge" "never merges"
}
test_case "merge: a failed check aborts without merging" t_merge_failed_check_aborts

t_merge_timeout() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BLOCKED","url":"u"}' ;;
    "pr checks 12 --json"*) echo '[{"name":"check","bucket":"pending"}]'; exit 8 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "exit status"
  assert_contains "$ERR" "timed out" "reports timeout"
  assert_eq 5 "$(grep -c 'pr	checks' <<<"$LOG")" "polled POLL_MAX times"
  assert_not_contains "$LOG" "pr	merge" "never merges"
}
test_case "merge: gives up after POLL_MAX polls" t_merge_timeout

t_merge_data_refresh_approves() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 33 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"data/refresh","mergeStateStatus":"BLOCKED","url":"u"}' ;;
    "pr checks 33 --json"*)
      if [ "$(bump)" -lt 2 ]; then echo '[]'; exit 1; else echo '[{"name":"check","bucket":"pass"}]'; fi ;;
    "api repos/uonoko1/seiji-kiroku/actions/runs?branch=data/refresh&status=action_required"*) echo '{"workflow_runs":[{"id":101},{"id":102}]}' ;;
    "api -X POST repos/uonoko1/seiji-kiroku/actions/runs/101/approve") echo ok ;;
    "api -X POST repos/uonoko1/seiji-kiroku/actions/runs/102/approve") echo "forbidden" >&2; exit 1 ;;
    "pr merge 33 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 33
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_contains "$LOG" "actions/runs/101/approve" "approves run 101"
  assert_contains "$LOG" "actions/runs/102/approve" "tries run 102 even though 101 was approved"
  assert_contains "$LOG" "pr	merge	33" "merged after checks pass"
}
test_case "merge: data/refresh → approves action_required runs while waiting" t_merge_data_refresh_approves

t_merge_no_approval_for_feature_branch() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BLOCKED","url":"u"}' ;;
    "pr checks 12 --json"*)
      if [ "$(bump)" -lt 2 ]; then echo '[]'; exit 1; else echo '[{"name":"check","bucket":"pass"}]'; fi ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_not_contains "$LOG" "action_required" "no approval lookup"
}
test_case "merge: feature branch never approves workflow runs" t_merge_no_approval_for_feature_branch
