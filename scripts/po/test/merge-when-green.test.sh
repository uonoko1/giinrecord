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
    "pr view 12 --json"*) echo '{"state":"MERGED","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"UNKNOWN","url":"u","headRefOid":"oid1"}' ;;
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
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":true,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
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
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
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

# Issue 384: 保護は strict:true（main に追いついていることが必須）なので、チェックが緑になってから
# マージするまでの間に別の PR が main に入ると、その瞬間だけ古くなって
# "the base branch policy prohibits the merge" で拒まれる（mergeStateStatus は CLEAN のまま）。
# 実際に踏んだ。1 回で諦めず、取り込み直して再試行する。
t_merge_retries_when_base_policy_refuses() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "pr checks 12 --json"*) echo '[{"name":"check","bucket":"pass"}]' ;;
    "pr merge 12 --squash --delete-branch")
      # 1 回目だけ拒む（GitHub の実際のメッセージ）。2 回目以降はログに update-branch が残っている
      if grep -q update-branch "$FAKE_GH_LOG"; then echo merged; else
        echo "X Pull request uonoko1/giinrecord#12 is not mergeable: the base branch policy prohibits the merge." >&2
        exit 1
      fi ;;
    "pr update-branch 12") echo updated ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  POLL_INTERVAL=0 run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "retried and merged: $ERR"
  assert_contains "$LOG" "pr	update-branch	12" "took main in before retrying"
  assert_eq 2 "$(grep -c 'pr	merge	12' <<<"$LOG")" "merge attempted twice"
}
test_case "merge: base branch policy で拒まれたら取り込み直して再試行（#384）" t_merge_retries_when_base_policy_refuses

t_merge_behind_updates_first() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*)
      if [ "$(bump)" -eq 1 ]; then echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BEHIND","url":"u","headRefOid":"oid1"}'
      else echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}'; fi ;;
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
  # 積まれた PR の確認（#392）が先、その後に update-branch。ブランチを進める前に安全確認を済ませる
  local order; order=$(grep -oE 'pr	list|pr	update-branch|pr	merge' <<<"$LOG" | head -3 | tr '\n' '|')
  assert_eq "pr	list|pr	update-branch|pr	merge|" "$order" "stacked-PR check, then update-branch, then merge"
  assert_contains "$LOG" "pr	merge	12" "merged afterwards"
  assert_eq 1 "$(grep -c 'pr	update-branch' <<<"$LOG")" "updated exactly once"
}
test_case "merge: BEHIND → update-branch before polling" t_merge_behind_updates_first

# #89: main moved while we were waiting (e.g. another PR merged) → BEHIND during the poll loop
t_merge_behind_while_pending() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BLOCKED","url":"u","headRefOid":"oid1"}' ;;
    "pr view 12 --json mergeStateStatus"*)
      # BEHIND on the 2nd poll only; back to BLOCKED once the branch was updated
      if [ "$(cat "$FAKE_COUNTER")" -eq 2 ] && ! grep -q update-branch "$FAKE_GH_LOG"; then echo '{"mergeStateStatus":"BEHIND"}'
      else echo '{"mergeStateStatus":"BLOCKED"}'; fi ;;
    "pr update-branch 12") echo updated ;;
    "pr checks 12 --json"*)
      if [ "$(bump)" -lt 4 ]; then echo '[{"name":"check","bucket":"pending"}]'; exit 8
      else echo '[{"name":"check","bucket":"pass"}]'; fi ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_eq 1 "$(grep -c 'pr	update-branch	12' <<<"$LOG")" "update-branch called once while pending"
  assert_contains "$LOG" "pr	merge	12" "merged afterwards"
}
test_case "merge: BEHIND during the poll loop → update-branch and keep waiting" t_merge_behind_while_pending

# #83: checks went green on the old base, but main advanced meanwhile → update, wait for new checks, merge
t_merge_behind_when_green() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "pr view 12 --json mergeStateStatus"*)
      if grep -q update-branch "$FAKE_GH_LOG"; then echo '{"mergeStateStatus":"CLEAN"}'; else echo '{"mergeStateStatus":"BEHIND"}'; fi ;;
    "pr update-branch 12") echo updated ;;
    "pr checks 12 --json"*)
      case "$(bump)" in
        1) echo '[{"name":"check","bucket":"pass"}]' ;;
        2) echo '[{"name":"check","bucket":"pending"}]'; exit 8 ;;
        *) echo '[{"name":"check","bucket":"pass"}]' ;;
      esac ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "exit status: $ERR"
  local order; order=$(grep -E 'update-branch|pr	merge' <<<"$LOG" | tr '\n' '|')
  assert_eq "pr	update-branch	12|pr	merge	12	--squash	--delete-branch|" "$order" "update-branch before merge"
  assert_eq 3 "$(grep -c 'pr	checks' <<<"$LOG")" "re-polled checks after the update"
}
test_case "merge: green but BEHIND → update-branch, re-poll, then merge" t_merge_behind_when_green

t_merge_update_branch_failure_is_not_fatal() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BEHIND","url":"u","headRefOid":"oid1"}' ;;
    "pr view 12 --json mergeStateStatus"*) echo '{"mergeStateStatus":"CLEAN"}' ;;
    "pr update-branch 12") echo "merge conflict" >&2; exit 1 ;;
    "pr checks 12 --json"*) echo '[{"name":"check","bucket":"pass"}]' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_contains "$ERR" "could not update" "warns about the failed update"
  assert_contains "$LOG" "pr	merge	12" "still tries to merge (gh reports the real blocker)"
  assert_not_contains "$LOG" "rev-parse" "no git fallback for a non-scope error"
}
test_case "merge: a failed update-branch is logged, not fatal" t_merge_update_branch_failure_is_not_fatal

# #200: update-branch refused because the gh OAuth token lacks the workflow scope (the PR touches
# .github/workflows/*) → merge origin/main locally in a temporary worktree and push over SSH
t_merge_workflow_scope_fallback() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BEHIND","url":"u","headRefOid":"oid1"}' ;;
    "pr view 12 --json mergeStateStatus"*) echo '{"mergeStateStatus":"CLEAN"}' ;;
    "pr update-branch 12") echo 'GraphQL: refusing to allow an OAuth App to create or update workflow `.github/workflows/etl.yml` without `workflow` scope (updatePullRequestBranch)' >&2; exit 1 ;;
    "pr checks 12 --json"*) echo '[{"name":"check","bucket":"pass"}]' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
git_handle() {
  case "$*" in
    "rev-parse --show-toplevel") echo /repo ;;
    "-C /repo fetch origin "*) : ;;
    "-C /repo worktree add --detach "*" origin/feat/x") : ;;
    "-C "*" merge --no-edit origin/main") echo "Merge made by the 'ort' strategy." ;;
    "-C "*" push git@github.com:uonoko1/giinrecord.git HEAD:refs/heads/feat/x") : ;;
    "-C /repo worktree remove --force "*) : ;;
    *) echo "unexpected git: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_contains "$LOG" $'git\t-C\t/repo\tfetch\torigin' "fetches into the local checkout"
  assert_contains "$LOG" $'merge\t--no-edit\torigin/main' "merges origin/main in the worktree"
  assert_contains "$LOG" $'push\tgit@github.com:uonoko1/giinrecord.git\tHEAD:refs/heads/feat/x' "pushes the PR head over SSH"
  assert_contains "$LOG" $'worktree\tremove\t--force' "removes the temporary worktree"
  assert_eq $'pr\tmerge\t12\t--squash\t--delete-branch' "$(tail -n 1 <<<"$LOG")" "PR merge is the last call"
}
test_case "merge: update-branch refused (workflow scope) → local merge + SSH push" t_merge_workflow_scope_fallback

# #200: the local merge conflicts → abort cleanly, push NOTHING, exit non-zero with a clear message
t_merge_workflow_scope_fallback_conflict() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BEHIND","url":"u","headRefOid":"oid1"}' ;;
    "pr update-branch 12") echo 'refusing to allow an OAuth App to create or update workflow without `workflow` scope' >&2; exit 1 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
git_handle() {
  case "$*" in
    "rev-parse --show-toplevel") echo /repo ;;
    "-C /repo fetch origin "*) : ;;
    "-C /repo worktree add --detach "*" origin/feat/x") : ;;
    "-C "*" merge --no-edit origin/main") echo "CONFLICT (content): Merge conflict in a.txt" >&2; exit 1 ;;
    "-C "*" merge --abort") : ;;
    "-C /repo worktree remove --force "*) : ;;
    *) echo "unexpected git: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "exit status"
  assert_contains "$ERR" "resolve the conflict manually" "clear conflict message"
  assert_contains "$LOG" $'merge\t--abort' "aborts the conflicted merge"
  assert_contains "$LOG" $'worktree\tremove\t--force' "removes the temporary worktree"
  assert_not_contains "$LOG" "push" "nothing is pushed"
  assert_not_contains "$LOG" $'pr\tmerge' "never merges the PR"
}
test_case "merge: fallback merge conflict → abort with nothing pushed" t_merge_workflow_scope_fallback_conflict

# #200: a failed SSH push is logged, not fatal (worktree still cleaned up; gh surfaces the blocker)
t_merge_workflow_scope_push_failure_not_fatal() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BEHIND","url":"u","headRefOid":"oid1"}' ;;
    "pr view 12 --json mergeStateStatus"*) echo '{"mergeStateStatus":"CLEAN"}' ;;
    "pr update-branch 12") echo 'refusing to allow an OAuth App to create or update workflow without `workflow` scope' >&2; exit 1 ;;
    "pr checks 12 --json"*) echo '[{"name":"check","bucket":"pass"}]' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
git_handle() {
  case "$*" in
    "rev-parse --show-toplevel") echo /repo ;;
    "-C /repo fetch origin "*) : ;;
    "-C /repo worktree add --detach "*" origin/feat/x") : ;;
    "-C "*" merge --no-edit origin/main") : ;;
    "-C "*" push git@github.com:uonoko1/giinrecord.git HEAD:refs/heads/feat/x") echo "Permission denied (publickey)." >&2; exit 128 ;;
    "-C /repo worktree remove --force "*) : ;;
    *) echo "unexpected git: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_contains "$ERR" "push it manually" "warns about the failed push"
  assert_contains "$LOG" $'worktree\tremove\t--force' "worktree cleaned up despite the push failure"
  assert_contains "$LOG" $'pr\tmerge\t12' "still tries to merge (gh reports the real blocker)"
}
test_case "merge: fallback SSH push failure is logged, not fatal" t_merge_workflow_scope_push_failure_not_fatal

t_merge_pending_then_pass() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BLOCKED","url":"u","headRefOid":"oid1"}' ;;
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
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BLOCKED","url":"u","headRefOid":"oid1"}' ;;
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
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BLOCKED","url":"u","headRefOid":"oid1"}' ;;
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
    "pr view 33 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"data/refresh","mergeStateStatus":"BLOCKED","url":"u","headRefOid":"oid1"}' ;;
    "pr checks 33 --json"*)
      if [ "$(bump)" -lt 2 ]; then echo '[]'; exit 1; else echo '[{"name":"check","bucket":"pass"}]'; fi ;;
    "api repos/uonoko1/giinrecord/actions/runs?branch=data/refresh&status=action_required"*) echo '{"workflow_runs":[{"id":101},{"id":102}]}' ;;
    "api -X POST repos/uonoko1/giinrecord/actions/runs/101/approve") echo ok ;;
    "api -X POST repos/uonoko1/giinrecord/actions/runs/102/approve") echo "forbidden" >&2; exit 1 ;;
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
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BLOCKED","url":"u","headRefOid":"oid1"}' ;;
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

# --- #392: マージ前の前提を確かめる（再実行待ち・HEAD 一致・スタック PR） --------------------

# (1) update-branch の後はチェックが再実行される。固定 sleep で再試行すると BLOCKED で拒まれる。
# 実際に PR #390 で踏んだ（POLL_INTERVAL×3 ≒ 1分しか待たないが docker-web は 1〜3 分）。
t_merge_waits_for_checks_after_update() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "pr view 12 --json mergeStateStatus"*) echo '{"mergeStateStatus":"CLEAN"}' ;;
    "pr merge 12 --squash --delete-branch")
      # update-branch がまだなら base policy で拒む。済んでいれば通す
      if grep -q update-branch "$FAKE_GH_LOG"; then echo merged; else
        echo "X the base branch policy prohibits the merge." >&2; exit 1
      fi ;;
    "pr update-branch 12") echo updated ;;
    "pr checks 12 --json"*)
      # 1回目=緑（初回のポーリング）。update-branch の後は 2 回 pending を返してから緑に戻る
      case "$(bump)" in
        1) echo '[{"name":"check","bucket":"pass"},{"name":"docker-web","bucket":"pass"}]' ;;
        2|3) echo '[{"name":"check","bucket":"pass"},{"name":"docker-web","bucket":"pending"}]'; exit 8 ;;
        *) echo '[{"name":"check","bucket":"pass"},{"name":"docker-web","bucket":"pass"}]' ;;
      esac ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "waited for the re-run and merged: $ERR"
  # 拒否 → update-branch → **再ポーリング** → マージ、の順であること
  # grep の無マッチ + set -e でスイートが途中終了する（#386 で一度踏んだ）ので必ず受ける
  local order; order=$(grep -oE $'pr\tmerge\t12|pr\tupdate-branch\t12|pr\tchecks' <<<"$LOG" | tr '\n' '|' || true)
  assert_eq $'pr\tchecks|pr\tmerge\t12|pr\tupdate-branch\t12|pr\tchecks|pr\tchecks|pr\tchecks|pr\tmerge\t12|' "$order" "re-polled checks between the two merge attempts"
  assert_contains "$ERR" "waiting for the checks to re-run" "says what it is waiting for"
}
test_case "merge: update-branch の後はチェックの再実行を待ってから再試行（#392）" t_merge_waits_for_checks_after_update

# (1) 待ち直しでも POLL_MAX は**通算**で使い切る（拒否のたびに上限がリセットされると無限に粘る）
t_merge_retry_wait_shares_poll_budget() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "pr view 12 --json mergeStateStatus"*) echo '{"mergeStateStatus":"CLEAN"}' ;;
    "pr merge 12 --squash --delete-branch") echo "X the base branch policy prohibits the merge." >&2; exit 1 ;;
    "pr update-branch 12") echo updated ;;
    "pr checks 12 --json"*)
      # 初回だけ緑。以降はずっと pending（＝チェックが戻ってこない）
      if [ "$(bump)" -eq 1 ]; then echo '[{"name":"check","bucket":"pass"}]'
      else echo '[{"name":"check","bucket":"pending"}]'; exit 8; fi ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "gives up"
  assert_contains "$ERR" "timed out" "timeout, not an infinite retry"
  # POLL_MAX=5（run.sh）を通算で使い切る。リセットしていたら 5 を超える
  assert_eq 5 "$(grep -c $'pr\tchecks' <<<"$LOG" || true)" "POLL_MAX polls in total, not per attempt"
}
test_case "merge: 待ち直しでも POLL_MAX は通算（#392）" t_merge_retry_wait_shares_poll_budget

# (2) 起動後に HEAD が動いていたら**マージしない**。PR #389 で追加コミットが取り残された
t_merge_aborts_when_head_moved() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "pr view 12 --json headRefOid"*) echo '{"headRefOid":"oid2"}' ;;   # 待っている間に誰かが push した
    "pr checks 12 --json"*) echo '[{"name":"check","bucket":"pass"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "aborts"
  assert_contains "$ERR" "HEAD がこの処理の開始後に動きました" "says why"
  assert_contains "$ERR" "oid1" "names the old head"
  assert_contains "$ERR" "oid2" "names the new head"
  assert_not_contains "$LOG" $'pr\tmerge' "never merges the stale head"
}
test_case "merge: 待っている間に HEAD が動いたら中断する（#392）" t_merge_aborts_when_head_moved

# (2) 自分で update-branch して進めた分は「他人の push」ではない（毎回中断してしまう）
t_merge_own_update_is_not_a_foreign_push() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BEHIND","url":"u","headRefOid":"oid1"}' ;;
    "pr view 12 --json mergeStateStatus"*) echo '{"mergeStateStatus":"CLEAN"}' ;;
    "pr view 12 --json headRefOid"*) echo '{"headRefOid":"oid2"}' ;;   # update-branch でマージコミットが乗った
    "pr update-branch 12") echo updated ;;
    "pr checks 12 --json"*) echo '[{"name":"check","bucket":"pass"}]' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "merges: $ERR"
  assert_not_contains "$ERR" "動きました" "does not mistake its own update for someone else's push"
  assert_contains "$LOG" $'pr\tmerge\t12' "merged"
}
test_case "merge: 自分の update-branch を他人の push と誤検出しない（#392）" t_merge_own_update_is_not_a_foreign_push

# (3) このブランチを base にした open PR があるとき、マージすると GitHub がそれを CLOSED にする。
# #390 → #391 で実際に起きた（reopen もできない）。先に中断して人に base を切り替えてもらう
t_merge_refuses_when_prs_are_stacked_on_it() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "pr list --repo uonoko1/giinrecord --base feat/x --state open --json number"*) echo '[{"number":13},{"number":14}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "aborts before touching anything"
  assert_contains "$ERR" "13, 14" "names the stacked PRs"
  assert_contains "$ERR" "--base main" "says how to fix it"
  assert_not_contains "$LOG" $'pr\tmerge' "never merges"
  assert_not_contains "$LOG" "update-branch" "does not even update the branch"
  assert_not_contains "$LOG" $'pr\tchecks' "does not wait for checks first"
}
test_case "merge: このブランチに積まれた open PR があれば中断する（#392）" t_merge_refuses_when_prs_are_stacked_on_it
