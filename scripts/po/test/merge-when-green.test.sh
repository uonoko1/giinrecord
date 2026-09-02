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
  local order; order=$(grep -oE 'pr	list|pr	update-branch|pr	merge' <<<"$LOG" | head -2 | tr '\n' '|')
  assert_eq "pr	list|pr	update-branch|" "$order" "stacked-PR check runs before update-branch (before we move the branch)"
  # マージ直前にもう一度確かめる（待っている間に積まれた PR を巻き添えにしない）
  assert_eq 2 "$(grep -c 'pr	list' <<<"$LOG" || true)" "checked again just before merging, not only at startup"
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
  # POLL_MAX=5（run.sh）を通算で使い切る。リセットしていたら待ち続けて 5 を超える。
  # 再試行前の「必ず1回待つ」も同じ予算から引くので、checks の回数は 5 を**超えない**
  local polls; polls=$(grep -c $'pr\tchecks' <<<"$LOG" || true)
  assert_eq 1 "$([[ "$polls" -le 5 ]] && echo 1 || echo 0)" "checks polls ($polls) stay within POLL_MAX=5"
  assert_eq 1 "$([[ "$polls" -ge 3 ]] && echo 1 || echo 0)" "but it did keep polling ($polls), not give up at once"
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
    "api repos/uonoko1/giinrecord/commits/oid2"*) echo '{"parents":[{"sha":"oid1"},{"sha":"main1"}]}' ;;   # 旧 HEAD を親に持つ
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

# レビュー指摘（重大1）: repin_head が `update-branch` の成否に関わらず呼ばれていたため、
# **更新に失敗した窓で人が push したコミットを自分の更新として飲み込んでいた**。
# assert_head_unchanged が守るはずの #389 が、そのまま戻る経路だった。
t_merge_failed_update_does_not_swallow_a_foreign_push() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BEHIND","url":"u","headRefOid":"oid1"}' ;;
    "pr view 12 --json mergeStateStatus"*) echo '{"mergeStateStatus":"CLEAN"}' ;;
    "pr update-branch 12") echo "merge conflict" >&2; exit 1 ;;   # 更新は失敗した（何も push していない）
    "pr view 12 --json headRefOid"*) echo '{"headRefOid":"oid2"}' ;;   # なのに HEAD が動いている＝他人の push
    "pr checks 12 --json"*) echo '[{"name":"check","bucket":"pass"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "aborts"
  assert_contains "$ERR" "HEAD がこの処理の開始後に動きました" "treats it as someone else's push"
  assert_not_contains "$LOG" $'pr\tmerge' "never merges a head it did not create"
}
test_case "merge: update-branch が失敗した窓の push を飲み込まない（#392 レビュー指摘）" t_merge_failed_update_does_not_swallow_a_foreign_push

# 同じ穴のもう1つの入口: workflow-scope フォールバックの push が失敗したのに repin してしまう
t_merge_failed_ssh_push_does_not_swallow_a_foreign_push() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BEHIND","url":"u","headRefOid":"oid1"}' ;;
    "pr view 12 --json mergeStateStatus"*) echo '{"mergeStateStatus":"CLEAN"}' ;;
    "pr update-branch 12") echo 'refusing to allow an OAuth App to create or update workflow without `workflow` scope' >&2; exit 1 ;;
    "pr view 12 --json headRefOid"*) echo '{"headRefOid":"oid2"}' ;;
    "pr checks 12 --json"*) echo '[{"name":"check","bucket":"pass"}]' ;;
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
  assert_eq 1 "$STATUS" "aborts"
  assert_contains "$ERR" "HEAD がこの処理の開始後に動きました" "a failed push is not our update"
  assert_not_contains "$LOG" $'pr\tmerge' "never merges"
}
test_case "merge: SSH push が失敗した窓の push も飲み込まない（#392 レビュー指摘）" t_merge_failed_ssh_push_does_not_swallow_a_foreign_push

# レビュー指摘（重大2の対）: HEAD の確認は**再試行のたび**に効く。
# 待ち時間中の push こそがこのガードの主目的なので、attempt 1 だけの検査では守れない
t_merge_head_checked_on_every_attempt() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "pr view 12 --json mergeStateStatus"*) echo '{"mergeStateStatus":"CLEAN"}' ;;
    "pr view 12 --json headRefOid"*)
      # 1回目の確認は一致。update-branch は成功しないので repin されず、
      # 2回目（再試行の直前）に人の push が見える
      if grep -q update-branch "$FAKE_GH_LOG"; then echo '{"headRefOid":"oid2"}'; else echo '{"headRefOid":"oid1"}'; fi ;;
    "pr update-branch 12") echo "merge conflict" >&2; exit 1 ;;
    "pr checks 12 --json"*) echo '[{"name":"check","bucket":"pass"}]' ;;
    "pr merge 12 --squash --delete-branch") echo "X the base branch policy prohibits the merge." >&2; exit 1 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "aborts on the retry"
  assert_contains "$ERR" "HEAD がこの処理の開始後に動きました" "the guard runs on later attempts too"
  # 1回目は実際にマージを試み、2回目は HEAD の確認で止まる
  assert_eq 1 "$(grep -c $'pr\tmerge\t12' <<<"$LOG" || true)" "merged once, then stopped before the second attempt"
}
test_case "merge: HEAD の確認は再試行のたびに効く（#392 レビュー指摘）" t_merge_head_checked_on_every_attempt

# レビュー指摘（重大2）: update-branch の後、GitHub がチェックを pending に落とすまでは
# 「前回の緑」が見える。wait_for_green は緑を見た瞬間 break するので、**必ず1回は待つ**
t_merge_retry_always_waits_at_least_once() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "pr view 12 --json mergeStateStatus"*) echo '{"mergeStateStatus":"CLEAN"}' ;;
    "pr view 12 --json headRefOid"*) echo '{"headRefOid":"oid1"}' ;;
    "pr update-branch 12") echo updated ;;
    "pr checks 12 --json"*) echo '[{"name":"check","bucket":"pass"}]' ;;   # ずっと緑（pending に落ちる前）
    "pr merge 12 --squash --delete-branch") echo "X the base branch policy prohibits the merge." >&2; exit 1 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  # SLEEP_LOG に sleep の呼び出しを記録させる（fake-bin/sleep）
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "gives up rather than hammering the API"
  # 待たずに素通りしていたら sleep が1回も呼ばれない
  assert_eq 1 "$([[ "$(grep -c '^sleep' <<<"$LOG" || true)" -ge 2 ]] && echo 1 || echo 0)" "slept between merge attempts (not a 0-second retry)"
}
test_case "merge: チェックが緑のままでも再試行の前に必ず待つ（#392 レビュー指摘）" t_merge_retry_always_waits_at_least_once

# レビュー指摘（2回目）: merge_main_locally の**早期 return**（checkout の外 / fetch 失敗 /
# worktree を作れない）は「ブランチを1バイトも進めていない」ので repin してはいけない。
# 3箇所とも `return 1` に直したが、**変異が素通りしていた**（C 経路の修正の大半が無検査だった）。
t_merge_local_fallback_no_op_does_not_repin() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BEHIND","url":"u","headRefOid":"oid1"}' ;;
    "pr view 12 --json mergeStateStatus"*) echo '{"mergeStateStatus":"CLEAN"}' ;;
    "pr update-branch 12") echo 'refusing to allow an OAuth App to create or update workflow without `workflow` scope' >&2; exit 1 ;;
    "pr view 12 --json headRefOid"*) echo '{"headRefOid":"oid2"}' ;;   # その窓で人が push した
    "pr checks 12 --json"*) echo '[{"name":"check","bucket":"pass"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
git_handle() {
  # checkout の中にいない（rev-parse が失敗）→ ローカルマージは**何もできずに戻る**
  case "$*" in
    "rev-parse --show-toplevel") echo "not a git repository" >&2; exit 128 ;;
    *) echo "unexpected git: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "aborts"
  assert_contains "$ERR" "HEAD がこの処理の開始後に動きました" "a no-op fallback is not our update"
  assert_not_contains "$LOG" $'pr\tmerge' "never merges"
  assert_not_contains "$LOG" "worktree" "did not even get as far as a worktree"
}
test_case "merge: ローカルマージが何もできなかった窓の push も飲み込まない（#392 レビュー指摘2回目）" t_merge_local_fallback_no_op_does_not_repin

# 同じく: fetch に失敗した場合（checkout はあるが更新できていない）
t_merge_local_fallback_fetch_failure_does_not_repin() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BEHIND","url":"u","headRefOid":"oid1"}' ;;
    "pr view 12 --json mergeStateStatus"*) echo '{"mergeStateStatus":"CLEAN"}' ;;
    "pr update-branch 12") echo 'refusing to allow an OAuth App to create or update workflow without `workflow` scope' >&2; exit 1 ;;
    "pr view 12 --json headRefOid"*) echo '{"headRefOid":"oid2"}' ;;
    "pr checks 12 --json"*) echo '[{"name":"check","bucket":"pass"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
git_handle() {
  case "$*" in
    "rev-parse --show-toplevel") echo /repo ;;
    "-C /repo fetch origin "*) echo "could not read from remote" >&2; exit 128 ;;
    *) echo "unexpected git: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "aborts"
  assert_contains "$ERR" "HEAD がこの処理の開始後に動きました" "a failed fetch is not our update"
  assert_not_contains "$LOG" $'pr\tmerge' "never merges"
}
test_case "merge: fetch に失敗した窓の push も飲み込まない（#392 レビュー指摘2回目）" t_merge_local_fallback_fetch_failure_does_not_repin

# 同じく: worktree を作れなかった場合
t_merge_local_fallback_worktree_failure_does_not_repin() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BEHIND","url":"u","headRefOid":"oid1"}' ;;
    "pr view 12 --json mergeStateStatus"*) echo '{"mergeStateStatus":"CLEAN"}' ;;
    "pr update-branch 12") echo 'refusing to allow an OAuth App to create or update workflow without `workflow` scope' >&2; exit 1 ;;
    "pr view 12 --json headRefOid"*) echo '{"headRefOid":"oid2"}' ;;
    "pr checks 12 --json"*) echo '[{"name":"check","bucket":"pass"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
git_handle() {
  case "$*" in
    "rev-parse --show-toplevel") echo /repo ;;
    "-C /repo fetch origin "*) : ;;
    "-C /repo worktree add --detach "*) echo "fatal: could not create work tree" >&2; exit 128 ;;
    *) echo "unexpected git: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "aborts"
  assert_contains "$ERR" "HEAD がこの処理の開始後に動きました" "a failed worktree is not our update"
  assert_not_contains "$LOG" $'pr\tmerge' "never merges"
}
test_case "merge: worktree を作れなかった窓の push も飲み込まない（#392 レビュー指摘2回目）" t_merge_local_fallback_worktree_failure_does_not_repin

# レビュー指摘（PO 代理）: 積まれた PR の確認は起動時に1回だけで、
# **CI を待っている数分の間に誰かが上に PR を積んだ場合を取り逃がしていた**。
# assert_head_unchanged はマージ直前に毎回呼ぶのに、こちらだけ1回では非対称だった。
t_merge_detects_a_pr_stacked_while_waiting() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BLOCKED","url":"u","headRefOid":"oid1"}' ;;
    "pr view 12 --json mergeStateStatus"*) echo '{"mergeStateStatus":"CLEAN"}' ;;
    "pr view 12 --json headRefOid"*) echo '{"headRefOid":"oid1"}' ;;
    "pr list --repo uonoko1/giinrecord --base feat/x --state open --json number"*)
      # 起動時は誰も積んでいない。CI を待っている間に #13 が積まれた
      if grep -q "pr	checks" "$FAKE_GH_LOG"; then echo '[{"number":13}]'; else echo '[]'; fi ;;
    "pr checks 12 --json"*)
      if [ "$(bump)" -lt 2 ]; then echo '[{"name":"check","bucket":"pending"}]'; exit 8
      else echo '[{"name":"check","bucket":"pass"}]'; fi ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "aborts"
  assert_contains "$ERR" "13" "names the PR that was stacked while we waited"
  assert_not_contains "$LOG" $'pr\tmerge' "never merges (that would close #13)"
}
test_case "merge: 待っている間に積まれた PR も検出する（PO 代理の指摘）" t_merge_detects_a_pr_stacked_while_waiting

# **実地で踏んだ**（PR #396 のマージ時）: `gh pr update-branch` が返った直後に
# headRefOid を読むと、GitHub 側にまだ新しい commit が見えておらず**古い oid が返る**。
# そのまま基準にすると、次の assert_head_unchanged が
# 「自分で作ったマージコミット」を他人の push と誤検出して中断する。
# 安全側に倒れるので事故にはならないが、BEHIND のたびに1回止まる。
t_merge_repin_waits_for_the_new_head_to_appear() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BEHIND","url":"u","headRefOid":"oid1"}' ;;
    "pr view 12 --json mergeStateStatus"*) echo '{"mergeStateStatus":"CLEAN"}' ;;
    "pr view 12 --json headRefOid"*)
      # update-branch の直後（repin の1回目）はまだ古い oid が見える。2回目から新しい oid になる。
      # **1回しか読まない実装**だと基準が oid1 のまま残り、マージ直前に読む oid2 と食い違って中断する
      if [ "$(bump)" -eq 1 ]; then echo '{"headRefOid":"oid1"}'; else echo '{"headRefOid":"oid2"}'; fi ;;
    "api repos/uonoko1/giinrecord/commits/oid2"*) echo '{"parents":[{"sha":"oid1"},{"sha":"main1"}]}' ;;
    "pr update-branch 12") echo updated ;;
    "pr checks 12 --json"*) echo '[{"name":"check","bucket":"pass"}]' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "merges instead of stopping on its own update: $ERR"
  assert_not_contains "$ERR" "動きました" "does not mistake its own merge commit for someone else's push"
  assert_contains "$LOG" $'pr\tmerge\t12' "merged"
}
test_case "merge: update-branch 直後にまだ古い oid が見えても誤検出しない（実地で踏んだ）" t_merge_repin_waits_for_the_new_head_to_appear

# **「変わったら採用」では自分の更新と他人の push を区別できない**（レビューが指摘した窓）。
# update-branch が作るのは旧 HEAD を親に持つマージコミットなので、**親を見て確かめる**。
# 親に旧 HEAD が無ければ人が直接 push したものなので、基準を動かさずガードに委ねる
t_merge_repin_gives_up_and_defers_to_the_guard() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BEHIND","url":"u","headRefOid":"oid1"}' ;;
    "pr view 12 --json mergeStateStatus"*) echo '{"mergeStateStatus":"CLEAN"}' ;;
    "pr view 12 --json headRefOid"*) echo '{"headRefOid":"human1"}' ;;
    # 人が直接 push したコミット。**旧 HEAD（oid1）を親に持たない**ので、我々の更新ではない。
    # 「変わったら採用」で飲み込むと、検査を通っていない HEAD を基準にしてマージしてしまう
    "api repos/uonoko1/giinrecord/commits/human1"*) echo '{"parents":[{"sha":"somethingelse"}]}' ;;
    "pr update-branch 12") echo updated ;;
    "pr checks 12 --json"*) echo '[{"name":"check","bucket":"pass"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "still stops for a real foreign push"
  assert_contains "$ERR" "動きました" "the guard is not disabled by the retry"
  assert_not_contains "$LOG" $'pr\tmerge' "never merges"
}
test_case "merge: 旧 HEAD を親に持たない commit は自分の更新として採用しない（#392 レビュー指摘）" t_merge_repin_gives_up_and_defers_to_the_guard
