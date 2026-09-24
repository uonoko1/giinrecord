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
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"},{"name":"lint","status":"completed","conclusion":"skipped","started_at":"t1"}]}' ;;
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
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
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
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
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
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      if [ "$(bump)" -lt 4 ]; then echo '{"check_runs":[{"name":"check","status":"in_progress","conclusion":null,"started_at":"t1"}]}'
      else echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}'; fi ;;
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
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      case "$(bump)" in
        1) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
        2) echo '{"check_runs":[{"name":"check","status":"in_progress","conclusion":null,"started_at":"t1"}]}' ;;
        *) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
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
  assert_eq 3 "$(grep -c 'api	repos/uonoko1/giinrecord/commits/.*/check-runs' <<<"$LOG")" "re-polled checks after the update"
}
test_case "merge: green but BEHIND → update-branch, re-poll, then merge" t_merge_behind_when_green

t_merge_update_branch_failure_is_not_fatal() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BEHIND","url":"u","headRefOid":"oid1"}' ;;
    "pr view 12 --json mergeStateStatus"*) echo '{"mergeStateStatus":"CLEAN"}' ;;
    "pr update-branch 12") echo "merge conflict" >&2; exit 1 ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
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
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
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
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
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
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      if [ "$(bump)" -lt 3 ]; then echo '{"check_runs":[{"name":"check","status":"in_progress","conclusion":null,"started_at":"t1"}]}'
      else echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}'; fi ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_eq 3 "$(grep -c 'api	repos/uonoko1/giinrecord/commits/.*/check-runs' <<<"$LOG")" "polled 3 times"
  assert_contains "$LOG" "pr	merge	12" "merged"
}
test_case "merge: pending checks are polled until they pass" t_merge_pending_then_pass

t_merge_failed_check_aborts() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BLOCKED","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"failure","started_at":"t1"},{"name":"smoke","status":"in_progress","conclusion":null,"started_at":"t1"}]}'; exit 1 ;;
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
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"in_progress","conclusion":null,"started_at":"t1"}]}'; exit 8 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "exit status"
  assert_contains "$ERR" "timed out" "reports timeout"
  assert_eq 5 "$(grep -c 'api	repos/uonoko1/giinrecord/commits/.*/check-runs' <<<"$LOG")" "polled POLL_MAX times"
  assert_not_contains "$LOG" "pr	merge" "never merges"
}
test_case "merge: gives up after POLL_MAX polls" t_merge_timeout

t_merge_data_refresh_approves() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 33 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"data/refresh","mergeStateStatus":"BLOCKED","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      if [ "$(bump)" -lt 2 ]; then echo '{"check_runs":[]}'; else echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}'; fi ;;
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
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      if [ "$(bump)" -lt 2 ]; then echo '{"check_runs":[]}'; else echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}'; fi ;;
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
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      # 1回目=緑（初回のポーリング）。update-branch の後は 2 回 pending を返してから緑に戻る
      case "$(bump)" in
        1) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"},{"name":"docker-web","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
        2|3) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"},{"name":"docker-web","status":"in_progress","conclusion":null,"started_at":"t1"}]}' ;;
        *) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"},{"name":"docker-web","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
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
  local order; order=$(grep -oE $'pr\tmerge\t12|pr\tupdate-branch\t12|api\trepos/uonoko1/giinrecord/commits/[^\t]+/check-runs' <<<"$LOG" | sed $'s#^api\trepos/uonoko1/giinrecord/commits/.*/check-runs#pr\tchecks#' | tr '\n' '|' || true)
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
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      # 初回だけ緑。以降はずっと pending（＝チェックが戻ってこない）
      if [ "$(bump)" -eq 1 ]; then echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}'
      else echo '{"check_runs":[{"name":"check","status":"in_progress","conclusion":null,"started_at":"t1"}]}'; fi ;;
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
  local polls; polls=$(grep -c $'api\trepos/uonoko1/giinrecord/commits/.*/check-runs' <<<"$LOG" || true)
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
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
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
    "api repos/uonoko1/giinrecord/commits/oid2 -q .parents[].sha") echo '{"parents":[{"sha":"oid1"},{"sha":"main1"}]}' ;;   # 旧 HEAD を親に持つ
    "pr update-branch 12") echo updated ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
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
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
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
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
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
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
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
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;   # ずっと緑（pending に落ちる前）
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
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
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
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
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
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
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
      if grep -q $'api\trepos/uonoko1/giinrecord/commits/.*/check-runs' "$FAKE_GH_LOG"; then echo '[{"number":13}]'; else echo '[]'; fi ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      if [ "$(bump)" -lt 2 ]; then echo '{"check_runs":[{"name":"check","status":"in_progress","conclusion":null,"started_at":"t1"}]}'
      else echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}'; fi ;;
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
    "api repos/uonoko1/giinrecord/commits/oid2 -q .parents[].sha") echo '{"parents":[{"sha":"oid1"},{"sha":"main1"}]}' ;;
    "pr update-branch 12") echo updated ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
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
    "api repos/uonoko1/giinrecord/commits/human1 -q .parents[].sha") echo '{"parents":[{"sha":"somethingelse"}]}' ;;
    "pr update-branch 12") echo updated ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
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

# #414: BEHIND でない状態（BLOCKED = CI 待ち）の間に、**自分以外**が main を取り込むと
# HEAD が動く（GitHub の "Update branch"、auto-update）。update_if_behind は BEHIND の
# ときしか走らないので repin されず、マージのたびに中断していた（PR #409 で2回踏んだ）。
t_merge_accepts_a_merge_of_main_done_elsewhere() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BLOCKED","url":"u","headRefOid":"oid1"}' ;;
    "pr view 12 --json mergeStateStatus"*) echo '{"mergeStateStatus":"BLOCKED"}' ;;
    "pr view 12 --json headRefOid"*) echo '{"headRefOid":"merged1"}' ;;   # 誰かが main を取り込んだ
    # **旧 HEAD を親に持つマージコミット**（親が2つ）＝ 取り込んだだけ
    "api repos/uonoko1/giinrecord/commits/merged1 -q .parents[].sha") echo '{"parents":[{"sha":"oid1"},{"sha":"main9"}]}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "continues instead of stopping: $ERR"
  assert_contains "$ERR" "updated with main elsewhere" "says what happened"
  assert_contains "$LOG" $'pr\tmerge\t12' "merged"
}
test_case "merge: 自分以外が main を取り込んだだけなら続行する（#414）" t_merge_accepts_a_merge_of_main_done_elsewhere

# **親に旧 HEAD がある = 安全、ではない。** 旧 HEAD の上に**普通のコミット**を積んだ場合も
# 親には旧 HEAD が入る。その追加分は検査を通っていないので、従来どおり中断する
t_merge_still_stops_for_a_plain_commit_on_top() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BLOCKED","url":"u","headRefOid":"oid1"}' ;;
    "pr view 12 --json mergeStateStatus"*) echo '{"mergeStateStatus":"BLOCKED"}' ;;
    "pr view 12 --json headRefOid"*) echo '{"headRefOid":"pushed1"}' ;;   # 人が push した
    # **親が1つ**（普通のコミット）。旧 HEAD を親に持つが、取り込みではない
    "api repos/uonoko1/giinrecord/commits/pushed1 -q .parents[].sha") echo '{"parents":[{"sha":"oid1"}]}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "still aborts"
  assert_contains "$ERR" "HEAD がこの処理の開始後に動きました" "treats it as an unreviewed push"
  assert_not_contains "$LOG" $'pr\tmerge' "never merges the unchecked commit"
}
test_case "merge: 旧 HEAD の上の普通のコミットは、親が一致しても中断する（#414）" t_merge_still_stops_for_a_plain_commit_on_top

# 旧 HEAD を親に持たないマージコミット（別の枝の取り込み）も中断する
t_merge_stops_for_a_merge_not_based_on_us() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BLOCKED","url":"u","headRefOid":"oid1"}' ;;
    "pr view 12 --json mergeStateStatus"*) echo '{"mergeStateStatus":"BLOCKED"}' ;;
    "pr view 12 --json headRefOid"*) echo '{"headRefOid":"other1"}' ;;
    "api repos/uonoko1/giinrecord/commits/other1 -q .parents[].sha") echo '{"parents":[{"sha":"somethingelse"},{"sha":"main9"}]}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "aborts"
  assert_contains "$ERR" "HEAD がこの処理の開始後に動きました" "not a merge of our head"
  assert_not_contains "$LOG" $'pr\tmerge' "never merges"
}
test_case "merge: 旧 HEAD を親に持たないマージコミットは中断する（#414）" t_merge_stops_for_a_merge_not_based_on_us

# ---- #434: マージ成功を「拒否された」と誤報しない ------------------------------------------
# `mergeStateStatus` が UNKNOWN（GitHub がマージ可能性を計算中）の間に `gh pr merge` を叩くと、
# **実際にはマージされるのに非ゼロで返る**。実地で PR #428/#429/#430/#432/#437 の5件で踏んだ。
# 非ゼロを見たら、**PR の今の state を読んでから**判断する。
t_merge_nonzero_but_actually_merged() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*)
      # 1回目（起動時）は OPEN。マージ後の確認では MERGED を返す
      if grep -q 'pr	merge' "$FAKE_GH_LOG"; then
        echo '{"state":"MERGED","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"UNKNOWN","url":"u","headRefOid":"oid1"}'
      else
        echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"UNKNOWN","url":"u","headRefOid":"oid1"}'
      fi ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
    "pr merge 12 --squash --delete-branch")
      echo "X Pull request uonoko1/giinrecord#12 is not mergeable: the merge commit cannot be cleanly created." >&2
      exit 1 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "非ゼロでも MERGED なら成功: $ERR"
  assert_contains "$OUT" "merged PR #12" "成功として報告する"
  assert_eq 1 "$(grep -c 'pr	merge	12' <<<"$LOG")" "1回で止める（再試行しない）"
  assert_not_contains "$ERR" "merge refused 3 times" "誤報しない"
}
test_case "merge: 非ゼロで返っても state=MERGED なら成功として終わる（#434）" t_merge_nonzero_but_actually_merged

# 本当に失敗したときは従来どおり die する（成功扱いが緩すぎないことの裏）。
t_merge_nonzero_and_still_open_dies() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
    "pr update-branch 12") echo updated ;;
    "pr merge 12 --squash --delete-branch")
      echo "X Pull request uonoko1/giinrecord#12 is not mergeable: the base branch policy prohibits the merge." >&2
      exit 1 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "OPEN のままなら失敗"
  assert_contains "$ERR" "merge refused 3 times" "従来どおり die する"
  assert_eq 3 "$(grep -c 'pr	merge	12' <<<"$LOG")" "3回試す"
}
test_case "merge: 非ゼロで state=OPEN のままなら従来どおり die（#434）" t_merge_nonzero_and_still_open_dies

# **緩すぎないための線引き**: MERGED でも、マージされたのが**我々が検査した HEAD でない**なら
# 成功と報告しない。他人が新しいコミットを push してからマージした場合がこれにあたる。
# 「検査を通った commit だけがマージされる」という #392/#414 の不変条件を、ここでも守る。
t_merge_merged_with_a_different_head_is_not_our_success() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*)
      if grep -q 'pr	merge' "$FAKE_GH_LOG"; then
        echo '{"state":"MERGED","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"UNKNOWN","url":"u","headRefOid":"other9"}'
      else
        echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"UNKNOWN","url":"u","headRefOid":"oid1"}'
      fi ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
    "pr merge 12 --squash --delete-branch") echo "X refused" >&2; exit 1 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "別の HEAD がマージされていたら成功と報告しない"
  assert_contains "$ERR" "別の commit" "何が起きたかを説明する"
  assert_eq 1 "$(grep -c 'pr	merge	12' <<<"$LOG")" "MERGED なので再試行はしない"
}
test_case "merge: MERGED でも検査した HEAD と違うなら成功と報告しない（#434）" t_merge_merged_with_a_different_head_is_not_our_success

# CLOSED（マージされずに閉じられた）は成功でも「再試行してよい状態」でもない。すぐ止める。
t_merge_closed_while_waiting_stops() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*)
      if grep -q 'pr	merge' "$FAKE_GH_LOG"; then
        echo '{"state":"CLOSED","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"UNKNOWN","url":"u","headRefOid":"oid1"}'
      else
        echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"UNKNOWN","url":"u","headRefOid":"oid1"}'
      fi ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
    "pr merge 12 --squash --delete-branch") echo "X refused" >&2; exit 1 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "CLOSED は失敗"
  assert_contains "$ERR" "CLOSED" "state を報告する"
  assert_eq 1 "$(grep -c 'pr	merge	12' <<<"$LOG")" "再試行しない"
}
test_case "merge: マージ中に CLOSED になったら再試行せず止める（#434）" t_merge_closed_while_waiting_stops

# ローカルブランチの削除に失敗しても（worktree が使っている）、マージ自体は成功している。
# 警告に留める（実地で踏んだ）。
t_merge_local_branch_delete_failure_is_a_warning() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*)
      if grep -q 'pr	merge' "$FAKE_GH_LOG"; then
        echo '{"state":"MERGED","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"UNKNOWN","url":"u","headRefOid":"oid1"}'
      else
        echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"UNKNOWN","url":"u","headRefOid":"oid1"}'
      fi ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
    "pr merge 12 --squash --delete-branch")
      echo "failed to delete local branch feat/x: used by worktree at /somewhere" >&2
      exit 1 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "マージは成功している: $ERR"
  assert_contains "$OUT" "merged PR #12" "成功として報告する"
}
test_case "merge: --delete-branch のローカル削除失敗は警告に留める（#434）" t_merge_local_branch_delete_failure_is_a_warning

# ---- #446: state を読めなかったときと、空 oid の偽の一致 ------------------------------------
# `gh pr merge` が非ゼロで返った後の確認で `gh pr view` 自体が失敗すると、`read` が何も
# 読めずに state が空のまま `*)` に落ち、`PR #12 はマージ中に  になりました` と**空白**が出る。
# （`if assert_merged_by_us` の中では set -e が効かないので、read の失敗では止まらない）
# 止まること自体は安全だが、**PO が何が起きたか分からない**。空を別の case にして、
# 「state を読めなかった」と言う。未知の state（catch-all）は従来どおり die のまま。
t_merge_state_read_failure_says_so() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*)
      # 起動時は OPEN。マージ後の確認（state,headRefOid）だけ API エラーで落ちる
      if grep -q 'pr	merge' "$FAKE_GH_LOG"; then
        echo "gh: HTTP 502 (api.github.com)" >&2; exit 1
      else
        echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"UNKNOWN","url":"u","headRefOid":"oid1"}'
      fi ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
    "pr merge 12 --squash --delete-branch") echo "X refused" >&2; exit 1 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "state を読めなければ止まる"
  assert_contains "$ERR" "state を読めませんでした" "何が起きたか分かるメッセージ"
  assert_not_contains "$ERR" "マージ中に  になりました" "空白のメッセージを出さない"
  assert_contains "$OUT" "" "成功として報告しない"
  assert_not_contains "$OUT" "merged PR #12" "成功として報告しない"
  assert_eq 1 "$(grep -c 'pr	merge	12' <<<"$LOG")" "読めない state で再試行はしない"
}
test_case "merge: マージ後の state を読めなかったらそう言って止まる（#446）" t_merge_state_read_failure_says_so

# 未知の state（catch-all）は従来どおり die する。空を別の case にしても allowlist 構造
# （OPEN / MERGED / "" 以外は die）が保たれていることの裏。
t_merge_unknown_state_still_dies() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*)
      if grep -q 'pr	merge' "$FAKE_GH_LOG"; then
        echo '{"state":"WEIRD","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"UNKNOWN","url":"u","headRefOid":"oid1"}'
      else
        echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"UNKNOWN","url":"u","headRefOid":"oid1"}'
      fi ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
    "pr merge 12 --squash --delete-branch") echo "X refused" >&2; exit 1 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "未知の state は失敗側に倒す"
  assert_contains "$ERR" "WEIRD" "state を報告する"
  assert_eq 1 "$(grep -c 'pr	merge	12' <<<"$LOG")" "再試行しない"
}
test_case "merge: 未知の state は従来どおり die する（#446 の allowlist 維持）" t_merge_unknown_state_still_dies

# MERGED だが headRefOid が空（ブランチが削除済みで API が空を返す等）。旧実装は
# `[[ "$oid" == "$HEAD_OID" ]]` で、HEAD_OID も空なら `"" == ""` が真になり、
# **検査していない HEAD を「我々がマージした」と報告**しうる。空は一致とみなさない。
t_merge_empty_oids_do_not_match() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,isDraft"*)
      # 起動時: headRefOid が空（HEAD_OID="" になる）
      echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"UNKNOWN","url":"u","headRefOid":""}' ;;
    "pr view 12 --json state,headRefOid"*)
      # マージ後の確認: MERGED だが oid も空
      echo '{"state":"MERGED","headRefOid":""}' ;;
    "pr view 12 --json headRefOid"*) echo '{"headRefOid":""}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
    "pr merge 12 --squash --delete-branch") echo "X refused" >&2; exit 1 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "空 oid 同士を一致とみなさない"
  assert_not_contains "$OUT" "merged PR #12" "成功として報告しない"
  assert_contains "$ERR" "別の commit" "我々の成功ではないと伝える"
}
test_case "merge: HEAD_OID と headRefOid が両方空でも偽の一致にしない（#446）" t_merge_empty_oids_do_not_match

# 削除に失敗した経路（"used by worktree at ..."）でだけ「ローカルブランチが残っているかも」を出す。
# UNKNOWN 由来の非ゼロ（削除は成功している）で出すのは、PO を無駄に確認に行かせる余計な一文。
t_merge_branch_hint_only_when_delete_failed() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*)
      if grep -q 'pr	merge' "$FAKE_GH_LOG"; then
        echo '{"state":"MERGED","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"UNKNOWN","url":"u","headRefOid":"oid1"}'
      else
        echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"UNKNOWN","url":"u","headRefOid":"oid1"}'
      fi ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
    "pr merge 12 --squash --delete-branch")
      echo "X Pull request uonoko1/giinrecord#12 is not mergeable: the merge commit cannot be cleanly created." >&2
      exit 1 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "マージは成功: $ERR"
  assert_not_contains "$ERR" "ローカルブランチ" "削除に失敗していないなら出さない"
}
test_case "merge: 削除が失敗していないときは残存ブランチの注意を出さない（#446）" t_merge_branch_hint_only_when_delete_failed

# 逆側: 実際に削除が失敗した経路では出す（上の条件が常に false になっていないことの裏）。
t_merge_branch_hint_when_delete_failed() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*)
      if grep -q 'pr	merge' "$FAKE_GH_LOG"; then
        echo '{"state":"MERGED","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"UNKNOWN","url":"u","headRefOid":"oid1"}'
      else
        echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"UNKNOWN","url":"u","headRefOid":"oid1"}'
      fi ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
    "pr merge 12 --squash --delete-branch")
      echo "failed to delete local branch feat/x: used by worktree at /somewhere" >&2
      exit 1 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "マージは成功: $ERR"
  assert_contains "$ERR" "ローカルブランチ" "削除に失敗したときは残存を伝える"
}
test_case "merge: ローカル削除に失敗したときだけ残存ブランチを伝える（#446）" t_merge_branch_hint_when_delete_failed

# #561: PR #534 で observed — GitHub 側の不整合で forbidden-patterns が
# status:in_progress のまま conclusion:success を持っていた（completed_at も入っていた）。
# `gh pr checks` の bucket は status から作られるので pending のまま。
# conclusion が付いていれば status に関わらず完了として扱うこと。
t_merge_in_progress_with_success_conclusion_is_treated_as_done() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      echo '{"check_runs":[
        {"name":"gitleaks","status":"completed","conclusion":"success","started_at":"t1"},
        {"name":"forbidden-patterns","status":"in_progress","conclusion":"success","started_at":"t1"},
        {"name":"audit","status":"completed","conclusion":"success","started_at":"t1"}
      ]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "conclusion が付いていれば status:in_progress でも完了扱いしてマージする: $ERR"
  assert_contains "$LOG" $'pr\tmerge\t12' "merged instead of polling forever"
}
test_case "merge: status:in_progress でも conclusion:success なら完了扱いする（#561）" t_merge_in_progress_with_success_conclusion_is_treated_as_done

# conclusion が null（本当にまだ実行中）なら、status に関わらず引き続き pending として待つ。
# 完了扱いを緩めすぎていないことの裏返しの確認（#561）。
t_merge_null_conclusion_still_pending() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      if [ "$(bump)" -lt 2 ]; then
        echo '{"check_runs":[{"name":"docker-web","status":"in_progress","conclusion":null,"started_at":"t1"}]}'
      else
        echo '{"check_runs":[{"name":"docker-web","status":"completed","conclusion":"success","started_at":"t1"}]}'
      fi ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_eq 2 "$(grep -c 'api	repos/uonoko1/giinrecord/commits/.*/check-runs' <<<"$LOG")" "polled twice: conclusion:null keeps it pending"
  assert_contains "$LOG" $'pr\tmerge\t12' "merged after the real conclusion appears"
}
test_case "merge: conclusion:null は status に関わらず pending のまま（#561）" t_merge_null_conclusion_still_pending

# conclusion:failure（本当の失敗）は status に関わらず失敗として扱い、マージしない。
# 「conclusion があれば通す」に倒れて偽陽性を出していないことの確認（#561）。
t_merge_failure_conclusion_aborts_even_if_status_says_in_progress() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      echo '{"check_runs":[{"name":"guard","status":"in_progress","conclusion":"failure","started_at":"t1"}]}' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "conclusion:failure は status を問わず失敗として止める"
  assert_contains "$ERR" "guard" "names the failed check"
  assert_not_contains "$LOG" $'pr\tmerge' "never merges a real failure"
}
test_case "merge: conclusion:failure は status に関わらず失敗として止める（#561）" t_merge_failure_conclusion_aborts_even_if_status_says_in_progress

# --- #858: 必須でない検査が赤いとき ------------------------------------------------------------
# **何が問題だったか**: `wait_for_green` は fail が 1 件でもあれば無条件に die していた。
# `docker-web` は GitHub の必須ステータスチェックではない（branch protection の contexts は
# check / gitleaks / forbidden-patterns / audit の 4 件。**実測 2026-09-21**）ので
# **GitHub はマージを許すのに、この道具だけが止めていた**。PO はこの回だけで 3 回、
# 手で `gh pr merge` を打って回避しており、そのたびに #389/#392/#414/#434/#446 で
# 積み上げた守り（HEAD が動いていないか・上に PR が積まれていないか）が全部飛んでいた。
#
# **母数**（実測、直近 12 件のマージ済み PR は全部同じ）: 1 PR につき check-run は **7 件**
#   audit, check, docker-web, forbidden-patterns, gitleaks, pr-closes, stale-base
# このうち **必須 5 件** / **必須でない 2 件（stale-base, docker-web）**。
#
# **`stale-base` が必須でない側なのが #858 の本題**: 2 つ目の step（`--net-deletions`、#836）は
# #846 の担当者自身が「**合図であって証拠ではありません**（4 件中 2 件が本物）」と書いており、
# **「赤いが通してよい」状態が正常に起こりうる**（実地 5 件中 3 件）。PR #856 はそれで詰まった。
# **`pr-closes` は必須のまま**: 赤いなら本文を直せば緑にできるので、「赤いが通してよい」は起こらない。
#
# 設計:
#   - 必須が 1 件でも赤 → **常に die**（`--allow-nonrequired-red` があっても）
#   - 必須でないものだけが赤 → **何が赤いかを必ず出力し**、既定では die。
#     `--allow-nonrequired-red` があるときだけ、赤の名前を読み上げてからマージする
#   - **知らない名前は必須として扱う**（fail-closed）。新しい job が増えたときに
#     黙って「必須でない」側に落ちると、この道具の守りが痩せる
#   - **母数を毎回出す**（#757）: 見た件数 / 必須 / 赤

# 既定では従来どおり止まる。ただし「なぜ止まったか」が従来より詳しい。
t_858_nonrequired_red_still_stops_by_default() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[
      {"name":"check","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"gitleaks","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"forbidden-patterns","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"audit","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"stale-base","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"pr-closes","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"docker-web","status":"completed","conclusion":"failure","started_at":"t1"}]}' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "既定では止まる（挙動を変えない）"
  assert_contains "$ERR" "docker-web" "何が赤いかを名指しする"
  assert_contains "$ERR" "--allow-nonrequired-red" "逃げ道の名前を教える"
  assert_not_contains "$LOG" $'pr\tmerge' "マージしない"
}
test_case "858: 必須でない検査が赤いとき、既定では止まる（合図が無ければ押さない）" t_858_nonrequired_red_still_stops_by_default

# 本丸: 合図があれば、必須が全部緑なのでマージしてよい。
t_858_nonrequired_red_merges_with_flag() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[
      {"name":"check","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"gitleaks","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"forbidden-patterns","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"audit","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"stale-base","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"pr-closes","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"docker-web","status":"completed","conclusion":"failure","started_at":"t1"}]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh --allow-nonrequired-red 12
  assert_eq 0 "$STATUS" "必須が全部緑なのでマージできる: $ERR"
  assert_contains "$LOG" $'pr\tmerge\t12' "マージした"
  assert_contains "$ERR" "docker-web" "黙って押さない: 何が赤いかを読み上げる"
  assert_contains "$ERR" "failure" "赤の中身（conclusion）まで出す"
  # **母数の行だけでは足りない**: 母数は「赤があった」を言うだけで、「それでも進む」とは
  # 言っていない。**押す直前に、押すと言うこと**を別の行として固定する。
  # （最初に書いたときは母数の行が docker-web と failure を両方含んでいたため、
  #  この読み上げを丸ごと消しても落ちなかった。変異 M3 で気づいて足した。）
  assert_contains "$ERR" "必須でない検査が赤いまま進みます（--allow-nonrequired-red）: docker-web (failure)" \
    "押す直前に「押す」と言う（母数の行とは別に）"
}
test_case "858: --allow-nonrequired-red があれば、必須が全部緑ならマージする" t_858_nonrequired_red_merges_with_flag

# **本丸の裏**: 合図があっても、必須が赤ければ絶対にマージしない。
t_858_required_red_never_merges_even_with_flag() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[
      {"name":"check","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"gitleaks","status":"completed","conclusion":"failure","started_at":"t1"},
      {"name":"forbidden-patterns","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"audit","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"stale-base","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"pr-closes","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"docker-web","status":"completed","conclusion":"failure","started_at":"t1"}]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh --allow-nonrequired-red 12
  assert_eq 1 "$STATUS" "必須が赤なら合図があっても止まる"
  assert_contains "$ERR" "gitleaks" "必須の赤を名指しする"
  assert_not_contains "$LOG" $'pr\tmerge' "絶対にマージしない"
}
test_case "858: 必須の検査が赤ければ、--allow-nonrequired-red があってもマージしない" t_858_required_red_never_merges_even_with_flag

# 必須の赤が 5 種類それぞれで止まること。1 つだけ測って「必須は守られている」と言わない（#757）。
t_858_each_required_check_red_stops() {
  local name h
  for name in check gitleaks forbidden-patterns audit pr-closes; do
    h=$(NAME="$name" bash -c 'cat' <<EOF
handle() {
  case "\$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"$name","status":"completed","conclusion":"failure","started_at":"t1"}]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
EOF
)
    local f="$TMP/handler.each.$name.sh"; printf '%s\n' "$h" > "$f"
    run_script "$f" merge-when-green.sh --allow-nonrequired-red 12
    assert_eq 1 "$STATUS" "$name が赤なら止まる"
    assert_not_contains "$LOG" $'pr\tmerge' "$name: マージしない"
  done
}
test_case "858: 必須 5 件はそれぞれ単独で赤でも止まる（母数を 1 件で測らない）" t_858_each_required_check_red_stops

# **知らない名前は必須として扱う**（fail-closed）。新しい job が増えたとき、
# 黙って「必須でない」側に落ちてはいけない。
t_858_unknown_check_is_treated_as_required() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[
      {"name":"check","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"brand-new-job","status":"completed","conclusion":"failure","started_at":"t1"}]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh --allow-nonrequired-red 12
  assert_eq 1 "$STATUS" "知らない名前は必須扱いなので止まる"
  assert_contains "$ERR" "brand-new-job" "名指しする"
  assert_not_contains "$LOG" $'pr\tmerge' "マージしない"
}
test_case "858: 知らない名前の検査は必須として扱う（fail-closed）" t_858_unknown_check_is_treated_as_required

# **母数を出す**（#757）: 見た件数 / 必須 / 赤 が出力に載ること。
t_858_reports_denominator() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[
      {"name":"check","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"gitleaks","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"forbidden-patterns","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"audit","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"stale-base","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"pr-closes","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"docker-web","status":"completed","conclusion":"failure","started_at":"t1"}]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh --allow-nonrequired-red 12
  assert_eq 0 "$STATUS" "マージした: $ERR"
  assert_contains "$ERR" "検査 7 件" "母数: 見た件数"
  assert_contains "$ERR" "必須 5 件" "母数: 必須の件数（stale-base を外したので 6 → 5）"
  assert_contains "$ERR" "赤 1 件" "母数: 赤の件数"
}
test_case "858: 母数を出力に書く（検査 N 件 / 必須 M 件 / 赤 K 件）" t_858_reports_denominator

# **母数が 0 なら緑にしない**（#757）。既存の「no checks reported yet」の挙動を、
# 必須/必須でないの分岐を足した後も保っていることの確認。
t_858_empty_denominator_never_green() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh --allow-nonrequired-red 12
  assert_eq 1 "$STATUS" "検査が 1 件も無ければマージしない"
  assert_contains "$ERR" "timed out" "待ち続けて時間切れになる"
  assert_not_contains "$LOG" $'pr\tmerge' "マージしない"
}
test_case "858: 母数が 0 のときは緑にしない（--allow-nonrequired-red があっても）" t_858_empty_denominator_never_green

# 必須でないものが **pending** のときは、赤ではないので従来どおり待つ。
# 「必須でないなら見ない」に倒れていないこと（案 A の懸念）。
t_858_nonrequired_pending_is_still_waited_for() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      if [ "$(bump)" -lt 3 ]; then
        echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"},{"name":"docker-web","status":"in_progress","conclusion":null,"started_at":"t1"}]}'
      else
        echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"},{"name":"docker-web","status":"completed","conclusion":"success","started_at":"t1"}]}'
      fi ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh --allow-nonrequired-red 12
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_eq 3 "$(grep -c 'api	repos/uonoko1/giinrecord/commits/.*/check-runs' <<<"$LOG")" "pending の間は待つ（必須でなくても飛ばさない）"
  assert_contains "$LOG" $'pr\tmerge\t12' "緑になってからマージ"
}
test_case "858: 必須でない検査が pending のときは従来どおり待つ（見ないことにはしない）" t_858_nonrequired_pending_is_still_waited_for

# 引数の順序を問わない / 不正な引数は usage で落ちる。
t_858_flag_after_pr_number() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"},{"name":"docker-web","status":"completed","conclusion":"failure","started_at":"t1"}]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12 --allow-nonrequired-red
  assert_eq 0 "$STATUS" "PR 番号の後ろに置いても効く: $ERR"
  assert_contains "$LOG" $'pr\tmerge\t12' "マージした"
}
test_case "858: --allow-nonrequired-red は PR 番号の前後どちらでも効く" t_858_flag_after_pr_number

t_858_unknown_flag_is_usage_error() {
  local h; h=$(handler <<'EOF'
handle() { echo "unexpected: $*" >&2; exit 99; }
EOF
)
  run_script "$h" merge-when-green.sh --allow-everything 12
  assert_eq 2 "$STATUS" "知らないフラグは usage（exit 2）"
  assert_contains "$ERR" "usage" "usage を出す"
  assert_eq "" "$LOG" "gh を1回も叩かない"
}
test_case "858: 知らないフラグは usage で落とす（似た名前で素通りさせない）" t_858_unknown_flag_is_usage_error

# **REQUIRED_CHECKS / NONREQUIRED_CHECKS を固定する**（#499: 期待値はハードコードする）。
# 配列を実行時に対象から読み出すと自己参照になるので、**ここに独立して書き写す**。
# 中身が痩せる・入れ替わる・GitHub 側の登録と食い違う、のどれが起きてもここが落ちる。
t_858_check_lists_are_pinned() {
  local req nonreq
  req=$(grep -E '^REQUIRED_CHECKS=' "$PO_DIR/merge-when-green.sh")
  nonreq=$(grep -E '^NONREQUIRED_CHECKS=' "$PO_DIR/merge-when-green.sh")
  assert_eq 'REQUIRED_CHECKS=(check gitleaks forbidden-patterns audit pr-closes)' "$req" \
    "必須 5 件（GitHub の登録 4 件 + この道具が上乗せする pr-closes）"
  assert_eq 'NONREQUIRED_CHECKS=(stale-base docker-web)' "$nonreq" \
    "必須でないのは stale-base / docker-web の 2 件（抜け道を増やすなら意識的にここを直す）"
}
test_case "858: 必須 / 必須でないの一覧をハードコードで固定する（#499）" t_858_check_lists_are_pinned

# 知らない名前を「必須として扱った」と**言う**こと。黙って必須に倒すと、
# REQUIRED_CHECKS が空になっても挙動が同じになり、配列が飾りになる。
t_858_unknown_check_is_announced() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[
      {"name":"check","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"brand-new-job","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "緑ならマージする（知らない名前でも止めはしない）: $ERR"
  assert_contains "$ERR" "知らない検査があります" "知らない名前があることを言う"
  assert_contains "$ERR" "brand-new-job" "名指しする"
}
test_case "858: 一覧に無い検査名は「必須として扱った」と言う" t_858_unknown_check_is_announced

# 一覧にある名前では、その note を出さない（毎回鳴る警告は読まれなくなる）。
t_858_known_checks_are_quiet() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[
      {"name":"check","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"gitleaks","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"forbidden-patterns","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"audit","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"stale-base","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"pr-closes","status":"completed","conclusion":"success","started_at":"t1"},
      {"name":"docker-web","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "全部緑ならマージする: $ERR"
  assert_not_contains "$ERR" "知らない検査があります" "本番の 7 件では黙っている"
}
test_case "858: 本番の 7 件（実測）では「知らない検査」を言わない" t_858_known_checks_are_quiet

# フラグだけで PR 番号が無ければ usage（フラグを足したせいで「引数が 1 個」の検査が
# 効かなくなっていないこと。以前は `$# -ne 1` の 1 行がこれを守っていた）。
t_858_flag_without_pr_is_usage_error() {
  local h; h=$(handler <<'EOF'
handle() { echo "unexpected: $*" >&2; exit 99; }
EOF
)
  run_script "$h" merge-when-green.sh --allow-nonrequired-red
  assert_eq 2 "$STATUS" "PR 番号が無ければ usage（exit 2）"
  assert_contains "$ERR" "usage" "usage を出す"
  assert_eq "" "$LOG" "gh を1回も叩かない"
}
test_case "858: --allow-nonrequired-red だけで PR 番号が無ければ usage" t_858_flag_without_pr_is_usage_error

# PR 番号を 2 つ渡したら usage（2 つ目を黙って捨てて 1 つ目をマージしない）。
t_858_two_pr_numbers_is_usage_error() {
  local h; h=$(handler <<'EOF'
handle() { echo "unexpected: $*" >&2; exit 99; }
EOF
)
  run_script "$h" merge-when-green.sh 12 13
  assert_eq 2 "$STATUS" "PR 番号が 2 つなら usage（どちらをマージするか決めない）"
  assert_eq "" "$LOG" "gh を1回も叩かない"
}
test_case "858: PR 番号を 2 つ渡したら usage（黙って片方をマージしない）" t_858_two_pr_numbers_is_usage_error

# 「知らない検査」の note は、顔ぶれが同じなら 1 回だけ。wait_for_green は最大 60 回
# まわるので、毎回出すと読まれなくなる（毎回鳴る警告は警告ではない）。
t_858_unknown_note_is_said_once() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      if [ "$(bump)" -lt 3 ]; then
        echo '{"check_runs":[{"name":"brand-new-job","status":"in_progress","conclusion":null,"started_at":"t1"}]}'
      else
        echo '{"check_runs":[{"name":"brand-new-job","status":"completed","conclusion":"success","started_at":"t1"}]}'
      fi ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_eq 3 "$(grep -c 'api	repos/uonoko1/giinrecord/commits/.*/check-runs' <<<"$LOG")" "3 回ポーリングした"
  assert_eq 1 "$(grep -c '知らない検査があります' <<<"$ERR")" "3 回まわっても note は 1 回だけ"
}
test_case "858: 「知らない検査」の note は顔ぶれが同じなら 1 回だけ" t_858_unknown_note_is_said_once

# --- #856 の形（#858 の本題）------------------------------------------------------------------
# `--net-deletions` が「正しく鳴った」PR。**必須は全部緑で、`stale-base` だけが赤い。**
# 実地では PO がこれで 3 回、手で `gh pr merge` を打った。
#
# **押す人が「何行が減っているか」を読める形になっているか**を確かめる（PO の指摘）。
# その数字は **`stale-base` の job のログの中にしかない**（PR の画面にも `gh pr checks` の
# 一覧にも出てこない）ので、**ログの URL を指せているか**を見る。
# **数字そのものをこの道具が作り直すことはしない**——検査が既に数えたものを二重に実装すると、
# 片方が古くなったときに嘘をつく。

STALE_BASE_RED_CHECKS='{"check_runs":[
      {"name":"check","status":"completed","conclusion":"success","started_at":"t1","details_url":"https://example.invalid/check"},
      {"name":"gitleaks","status":"completed","conclusion":"success","started_at":"t1","details_url":"https://example.invalid/gitleaks"},
      {"name":"forbidden-patterns","status":"completed","conclusion":"success","started_at":"t1","details_url":"https://example.invalid/fp"},
      {"name":"audit","status":"completed","conclusion":"success","started_at":"t1","details_url":"https://example.invalid/audit"},
      {"name":"pr-closes","status":"completed","conclusion":"success","started_at":"t1","details_url":"https://example.invalid/prcloses"},
      {"name":"docker-web","status":"completed","conclusion":"success","started_at":"t1","details_url":"https://example.invalid/docker"},
      {"name":"stale-base","status":"completed","conclusion":"failure","started_at":"t1","details_url":"https://example.invalid/runs/1/job/2"}]}'

t_858_856_shape_stops_and_points_at_the_log() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '$STALE_BASE_RED_CHECKS' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "既定では止まる"
  assert_contains "$ERR" "stale-base (failure)" "何がどう赤いかを名指しする"
  assert_contains "$ERR" "必須 5 件は全部緑" "必須が緑であることを言う（GitHub はマージを許す状態）"
  # **本題**: 押す人が「何行が減っているか」を読みに行ける場所を指しているか。
  assert_contains "$ERR" "https://example.invalid/runs/1/job/2" "赤い検査の job ログの URL を出す"
  assert_contains "$ERR" "gh run view --log-failed" "手元で読む手順も出す"
  assert_contains "$ERR" "--allow-nonrequired-red 12" "読んだうえで通す道を示す"
  assert_not_contains "$LOG" $'pr\tmerge' "マージしない"
  # **緑の検査のログは出さない**（7 件全部の URL を並べたら、赤がどれか分からなくなる）
  assert_not_contains "$ERR" "https://example.invalid/check" "緑の検査の URL は出さない"
}
test_case "858: #856 の形（stale-base だけ赤）は止まり、ログの URL を指す" t_858_856_shape_stops_and_points_at_the_log

t_858_856_shape_merges_with_flag_and_records_the_log() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '$STALE_BASE_RED_CHECKS' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh --allow-nonrequired-red 12
  assert_eq 0 "$STATUS" "必須が全部緑なのでマージできる: $ERR"
  assert_contains "$LOG" $'pr\tmerge\t12' "マージした"
  assert_contains "$ERR" "必須でない検査が赤いまま進みます（--allow-nonrequired-red）: stale-base (failure)" \
    "押す直前に「押す」と言う"
  # **押したときにも URL を残す**——あとから「何を見て押したのか」を追えるように。
  assert_contains "$ERR" "https://example.invalid/runs/1/job/2" "押したときもログの URL を記録する"
}
test_case "858: #856 の形は --allow-nonrequired-red でマージでき、そのときログの URL も残る" t_858_856_shape_merges_with_flag_and_records_the_log

# `stale-base` が赤くても、**必須が赤ければ通らない**（抜け道が `stale-base` 経由で広がらない）。
t_858_stale_base_red_plus_required_red_never_merges() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[
      {"name":"check","status":"completed","conclusion":"failure","started_at":"t1","details_url":"https://example.invalid/check"},
      {"name":"stale-base","status":"completed","conclusion":"failure","started_at":"t1","details_url":"https://example.invalid/sb"}]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh --allow-nonrequired-red 12
  assert_eq 1 "$STATUS" "必須の check が赤いので止まる"
  assert_contains "$ERR" "check" "必須の赤を名指しする"
  assert_contains "$ERR" "必須でない赤: stale-base" "必須でない赤も併せて言う"
  assert_not_contains "$LOG" $'pr\tmerge' "絶対にマージしない"
}
test_case "858: stale-base が赤くても、必須が赤ければマージしない" t_858_stale_base_red_plus_required_red_never_merges

# **ログの URL が取れなかったとき、黙って行を落とさない。**
# `details_url` が null の check-run は実在しうる（外部 App のチェック）。
# 「URL が無い」と「赤い検査が 1 件少ない」を取り違えさせない。
t_858_missing_details_url_is_said() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[
      {"name":"check","status":"completed","conclusion":"success","started_at":"t1","details_url":null},
      {"name":"stale-base","status":"completed","conclusion":"failure","started_at":"t1","details_url":null}]}' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "既定では止まる"
  assert_contains "$ERR" "stale-base (failure)" "赤い検査は名指しする"
  assert_contains "$ERR" "ログの URL が取れませんでした" "URL が無いことを言う（行を黙って落とさない）"
}
test_case "858: ログの URL が取れなくても、赤い検査の行は落とさずそう言う" t_858_missing_details_url_is_said

# 赤いまま通したときは **「all N checks green」と言わない**。
# ログは後から「何が起きたか」を読む唯一の記録なので、そこに嘘が混ざってはいけない。
t_858_does_not_claim_all_green_when_proceeding_over_red() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '$STALE_BASE_RED_CHECKS' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh --allow-nonrequired-red 12
  assert_eq 0 "$STATUS" "マージした: $ERR"
  assert_not_contains "$ERR" "all 7 checks green" "赤いまま通したのに「全部緑」と言わない"
  assert_contains "$ERR" "stale-base (failure) を赤いまま通してマージします" "何を通したかを言う"
}
test_case "858: 赤いまま通したときは「all N checks green」と言わない" t_858_does_not_claim_all_green_when_proceeding_over_red

# 逆: 前の poll で赤かったものが緑になったら、**持ち越さず**「全部緑」と言う。
# （PROCEEDED_OVER_RED を毎 poll で捨てていること。持ち越すと逆向きの嘘になる。）
t_858_red_then_green_says_all_green() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      if [ "$(bump)" -lt 2 ]; then
        echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1","details_url":"u1"},{"name":"stale-base","status":"completed","conclusion":"failure","started_at":"t1","details_url":"u2"},{"name":"docker-web","status":"in_progress","conclusion":null,"started_at":"t1","details_url":"u3"}]}'
      else
        echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1","details_url":"u1"},{"name":"stale-base","status":"completed","conclusion":"success","started_at":"t1","details_url":"u2"},{"name":"docker-web","status":"completed","conclusion":"success","started_at":"t1","details_url":"u3"}]}'
      fi ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh --allow-nonrequired-red 12
  assert_eq 0 "$STATUS" "マージした: $ERR"
  assert_contains "$ERR" "all 3 checks green" "緑になったら素直に「全部緑」と言う（持ち越さない）"
  assert_not_contains "$ERR" "を赤いまま通してマージします" "緑なのに「赤いまま通した」と言わない"
}
test_case "858: 赤が緑に変わったら「赤いまま通した」を持ち越さない" t_858_red_then_green_says_all_green

# ── #1006: レビュー済みでない PR を止める ────────────────────────────────────────────────
# **なぜラベルではないか**: `reviewed` ラベルは PO が 1 コマンドで付けられる。
# 2026-09-23〜24 に 32 本をレビュー無しでマージした PO は「自分で検算したから十分だ」と
# 判断していた。同じ PO が「自分で検算したから `reviewed` を付ける」と判断できる。
# **自己申告の歯止めは歯止めではない。**
# ここが見るのは**レビュアーの報告の実体**（`reviewer.md` の「結論を先に」の形）である。

# 母数の検算に使う既定の検査（緑 1 件）。
REVIEW_GREEN_CHECKS='{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}'

# 本物の形（PR #1000 の 1 行目をそのまま。実測 2026-09-25）
REVIEW_OK_COMMENT='[{"user":{"login":"uonoko1"},"body":"## レビュー: **マージしてよい**（3 度目の敵対的レビュー）\n\n変異 4 件を当て直して 4 件とも再現した。"}]'

t_1006_blocks_without_review() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/issues/12/comments"*) echo '[]' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '$REVIEW_GREEN_CHECKS' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "exit status"
  assert_contains "$ERR" "レビュー" "なぜ止めたかを言う"
  assert_not_contains "$LOG" "pr	merge	12" "マージを試みない"
  assert_not_contains "$LOG" "check-runs" "検査を待たずに、先に止める（20 分待たせない）"
}
test_case "1006: レビューの報告が無い PR はマージしない" t_1006_blocks_without_review

t_1006_allows_with_review() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/issues/12/comments"*) echo '$REVIEW_OK_COMMENT' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '$REVIEW_GREEN_CHECKS' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "マージした: \$ERR"
  assert_contains "$LOG" "pr	merge	12	--squash	--delete-branch" "マージする"
}
test_case "1006: レビューの報告があればマージする" t_1006_allows_with_review

# **「直してから」「反対」も『レビューは走った』とみなす**（実装の意図を固定する）。
# ここを「マージしてよい」だけにすると、**直して再レビューを受けた PR と
# 一度もレビューされていない PR が同じ扱い**になる。
# この道具が見ているのは「レビュアーが走ったか」であって「許したか」ではない。
t_1006_accepts_negative_verdict() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/issues/12/comments"*) echo '[{"user":{"login":"uonoko1"},"body":"## レビュー: **直してから**。変異 M3 が素通りした。"}]' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '$REVIEW_GREEN_CHECKS' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "マージした: \$ERR"
  assert_contains "$ERR" "直してから" "どの語で当たったかを読み上げる（PO が見落とさないため）"
}
test_case "1006: 「直してから」もレビューの報告として通す（ただし読み上げる）" t_1006_accepts_negative_verdict

# **PO 自身の検算はレビューではない**（#1001）。実測: 直近 60 PR のコメント 14 件のうち
# **13 件が「PO が測り直した」等の PO 自身の検算**で、レビュアーの報告は 1 件だけだった。
# **その 13 件の形で素通りしてはいけない。**
t_1006_po_recheck_is_not_a_review() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/issues/12/comments"*) echo '[{"user":{"login":"uonoko1"},"body":"## PO が測り直した\n\n三重の採決 365 → 733 件。担当者の数字と一致した。"}]' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '$REVIEW_GREEN_CHECKS' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "止まる"
  assert_contains "$ERR" "コメント 1 件を見ました" "母数を出す（#757）"
  assert_not_contains "$LOG" "pr	merge	12" "マージを試みない"
}
test_case "1006: PO 自身の検算コメントはレビューとして通さない" t_1006_po_recheck_is_not_a_review

# 逃げ道: **理由つきなら通す**。理由は**ログに必ず残る**（唯一の記録になるため）。
t_1006_no_review_with_reason() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '$REVIEW_GREEN_CHECKS' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh --no-review 'レビュアーを立てられない障害中' 12
  assert_eq 0 "$STATUS" "マージした: \$ERR"
  assert_contains "$ERR" "レビュアーを立てられない障害中" "理由をログに残す"
  assert_not_contains "$LOG" "issues/12/comments" "--no-review のときはコメントを読みに行かない"
}
test_case "1006: --no-review <理由> なら通す（理由はログに残る）" t_1006_no_review_with_reason

# **理由の無い --no-review は通さない**（`pr-closes.sh` の「`Closes なし` だけでは通さない」）。
# **何も書かずに通せるなら、逃げ道ではなく素通しである。**
t_1006_no_review_requires_reason() {
  local h; h=$(handler <<'EOF'
handle() { echo "should not be called" >&2; exit 99; }
EOF
)
  run_script "$h" merge-when-green.sh --no-review 12
  assert_eq 2 "$STATUS" "usage で落ちる"
  assert_contains "$ERR" "理由が要ります" "何が足りないかを言う"
  assert_eq "" "$LOG" "gh を一度も呼ばない"
}
test_case "1006: --no-review に理由が無ければ usage（PR 番号を理由と読まない）" t_1006_no_review_requires_reason

t_1006_no_review_requires_reason_at_end() {
  local h; h=$(handler <<'EOF'
handle() { echo "should not be called" >&2; exit 99; }
EOF
)
  run_script "$h" merge-when-green.sh 12 --no-review
  assert_eq 2 "$STATUS" "usage で落ちる"
  assert_eq "" "$LOG" "gh を一度も呼ばない"
}
test_case "1006: 末尾の --no-review（理由なし）も usage" t_1006_no_review_requires_reason_at_end

# **他のフラグを理由と読まない。** `--no-review --allow-nonrequired-red 12` を通すと、
# 「理由 = --allow-nonrequired-red」という無意味な記録が残り、逃げ道が実質無条件になる。
t_1006_no_review_does_not_eat_flags() {
  local h; h=$(handler <<'EOF'
handle() { echo "should not be called" >&2; exit 99; }
EOF
)
  run_script "$h" merge-when-green.sh --no-review --allow-nonrequired-red 12
  assert_eq 2 "$STATUS" "usage で落ちる"
  assert_eq "" "$LOG" "gh を一度も呼ばない"
}
test_case "1006: --no-review が次のフラグを理由として飲み込まない" t_1006_no_review_does_not_eat_flags

# **検査を待つ前に止める。** レビューが無いと分かっているのに 20 分ポーリングさせない。
# （最初のテストでも見ているが、こちらは「赤い検査があっても、先にレビューで止まる」を固定する
#   ——順序が逆だと、赤い検査のメッセージが出てレビューの話が埋もれる）
t_1006_checked_before_polling() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"BEHIND","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/issues/12/comments"*) echo '[]' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "止まる"
  assert_not_contains "$LOG" "update-branch" "ブランチを動かす前に止める"
  assert_not_contains "$LOG" "check-runs" "検査を待つ前に止める"
}
test_case "1006: ブランチを動かす前・検査を待つ前に止める" t_1006_checked_before_polling

# **コメントが複数あって、レビューの報告が後ろに混ざっている場合**も拾う。
# 実測（直近 60 PR）では 1 PR あたりコメント 1〜2 件だが、**レビューは往復する**設計なので
# 「担当者の返答 → レビュアーの報告」の並びは普通に起こる。
t_1006_finds_review_among_many_comments() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/issues/12/comments"*) echo '[{"user":{"login":"uonoko1"},"body":"## PO が測り直した\n\n数字は一致した。"},{"user":{"login":"uonoko1"},"body":"## 担当者の返答\n\n指摘の 2 件を直しました。"},{"user":{"login":"uonoko1"},"body":"## レビュー: **マージしてよい**（2 度目）\n\n直っている。"}]' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '$REVIEW_GREEN_CHECKS' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "マージした: \$ERR"
  assert_contains "$ERR" "コメント 3 件中" "母数を出す（#757）"
}
test_case "1006: 複数コメントの中のレビューの報告を拾う（母数も出す）" t_1006_finds_review_among_many_comments

# **コメントが 0 件のときに「0 件を見た」と言う**（#757: 母数 0 を「きれい」と報告しない）。
t_1006_reports_zero_denominator() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/issues/12/comments"*) echo '[]' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "止まる"
  assert_contains "$ERR" "コメント 0 件を見ました" "母数 0 をそう言う"
  assert_contains "$ERR" "reviewer.md" "何をすればよいかを指す"
}
test_case "1006: コメント 0 件のときも母数を言う" t_1006_reports_zero_denominator
