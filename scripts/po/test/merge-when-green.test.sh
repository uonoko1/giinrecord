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
    # #1069: `skipped` を緑と数えてよいのは SKIPPABLE_CHECKS に載った名前だけになった。
    # **ここは実在する正当な skip に置き換える**（`issue-secrets` は実測で直近 60 PR の 60 件に出る）。
    # **架空の `lint` のままだと「走っていない必須チェック」になり、赤が正しい。**
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"},{"name":"issue-secrets","status":"completed","conclusion":"skipped","started_at":"t1"}]}' ;;
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
# 2026-09-23〜24 に 33 本（PO 31 / bot 2）をレビュー無しでマージした PO は「自分で検算したから十分だ」と
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

# **#1021: 「直してから」「反対」は止める**（2026-09-24 に規則が変わった）。
#
# **以前はここが「レビューは走ったか」だけを見ていた。** その結果、実測でこうなった:
#   #1014 21:52:16Z / #1020 22:33:05Z / #1013 23:00:07Z
#   **穴が開いてからマージされた 4 件のうち 3 件が「マージしてよい」以外で通った。**
#   #1013 はレビューが**素通りした変異を 4 件**指摘し、**担当者が対応中だった。**
#
# **旧版のコメントはこう書いていた**——「ここを『マージしてよい』だけにすると、
# 直して再レビューを受けた PR と一度もレビューされていない PR が同じ扱いになる」。
# **その懸念は正しいが、扱いは同じではない。** メッセージが違う:
#   レビューなし → 「レビュアーの報告がありません」（レビュアーを立てろ）
#   直してから   → 「レビューの結論は『直してから』です」（直して再レビューを受けろ）
# **次にやることが違うので、区別できていればよい。**
t_1006_rejects_negative_verdict() {
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
  assert_eq 1 "$STATUS" "「直してから」では止まる: \$ERR"
  assert_contains "$ERR" "直してから" "どの結論で止めたかを読み上げる"
  assert_contains "$ERR" "マージしません" "止めたことを言う"
}
test_case "1021: 「直してから」はマージしない（結論を読み上げて止める）" t_1006_rejects_negative_verdict

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

# **`反対` はこの専案の「データの語」である**（採決の記録が賛成／反対でできている）。
# 結論の語だけを本文のどこかから探す形だと、**PO 自身の検算コメントがすり抜ける**。
# **実測（直近 60 PR）でそうなった 3 件を、そのままフィクスチャにする**:
#   #947 / #945 / #942 — どれも票数の話で「反対」と書いているだけで、レビューではない。
t_1006_vote_word_hantai_is_not_a_review() {
  local body h
  for body in \
    '## PO が独立に数えた\n\n**PDF が刷っている賛成数・反対数と、読み取ったセルが 8 行すべて一致**（賛成 28 / 反対 18）。' \
    '## PO が確かめた\n\n（請願第38号は反対 32 人を 0 人と公表することになる）/ #899 を踏んだ自己申告' \
    '## PO が直した 1 件\n\n> **「反対者数の欄が空 = 0」と読む実装を実際に書いて測りました。**'
  do
    h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/issues/12/comments"*) echo '[{"user":{"login":"uonoko1"},"body":"$body"}]' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '$REVIEW_GREEN_CHECKS' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
EOF
)
    run_script "$h" merge-when-green.sh 12
    assert_eq 1 "$STATUS" "票数の話の「反対」はレビューではない: $body"
    assert_not_contains "$LOG" "pr	merge	12" "マージを試みない: $body"
  done
}
test_case "1006: 票数の話の「反対」をレビューとして通さない（実測の誤検出 3 件）" t_1006_vote_word_hantai_is_not_a_review

# 逆向き: **「レビュー」の語があるだけでは通さない。** 両方が同じコメントに要る。
t_1006_context_word_alone_is_not_enough() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/issues/12/comments"*) echo '[{"user":{"login":"uonoko1"},"body":"レビューをこれからお願いします。"}]' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '$REVIEW_GREEN_CHECKS' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "「レビュー」だけでは通さない"
  assert_not_contains "$LOG" "pr	merge	12" "マージを試みない"
}
test_case "1006: 「レビュー」の語だけでは通さない（結論の語も要る）" t_1006_context_word_alone_is_not_enough

# **別々のコメントに分かれているものを合算しない。**
# 「レビューします」というコメントと、票数の話で「反対」と書いたコメントが並んでいるだけで
# 通ってしまうと、**上で塞いだ誤検出が別の形で戻ってくる。**
t_1006_does_not_combine_across_comments() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/issues/12/comments"*) echo '[{"user":{"login":"uonoko1"},"body":"これからレビューを回します。"},{"user":{"login":"uonoko1"},"body":"## PO が測り直した\n\n賛成 28 / 反対 18 で一致した。"}]' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '$REVIEW_GREEN_CHECKS' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "別々のコメントを合算しない"
  assert_contains "$ERR" "コメント 2 件を見ました" "母数を出す（#757）"
  assert_not_contains "$LOG" "pr	merge	12" "マージを試みない"
}
test_case "1006: 別々のコメントの「レビュー」と「反対」を合算しない" t_1006_does_not_combine_across_comments

# ── #1009 のレビューが実測で破った 5 通り ────────────────────────────────────────────
# 「空でない」だけでは**逃げ道が実質無条件**になる。とくに `--no-review . <pr>` は
# **タイプ数が `--no-review <pr>` とほぼ変わらない**ので、
# **「1 コマンドでは通せない」という設計目標を逃げ道の側が真っ先に破る。**
t_1006_no_review_rejects_token_reasons() {
  local reason h
  # 空白1個 / ドット / 小数（is_int を回避）/ 単ハイフン（--* に当たらない）/ 改行 / タブ
  for reason in ' ' '.' '12.5' '-x' $'\n' $'\t' '短い' 'abcdef'; do
    h=$(handler <<'EOF'
handle() { echo "should not be called" >&2; exit 99; }
EOF
)
    run_script "$h" merge-when-green.sh --no-review "$reason" 12
    assert_eq 2 "$STATUS" "理由として通してはいけない: [$reason]"
    assert_eq "" "$LOG" "gh を一度も呼ばない: [$reason]"
  done
}
test_case "1006: 中身の無い理由（空白・記号・小数・単ハイフン・短すぎ）を通さない" t_1006_no_review_rejects_token_reasons

# **境界を両側から留める。** 片側だけだと「常に落とす」実装でも通る。
# 7 は**実測で決めた値**（`Closes なし（…）` の本物の理由 88 件の最短が 7 文字 = `作業合意の更新`）。
t_1006_no_review_boundary() {
  local h
  # 6 文字 → 落ちる
  h=$(handler <<'EOF'
handle() { echo "should not be called" >&2; exit 99; }
EOF
)
  run_script "$h" merge-when-green.sh --no-review 'あいうえおか' 12
  assert_eq 2 "$STATUS" "6 文字は落ちる"

  # 7 文字 → 通る（実在する最短の理由そのもの）
  h=$(handler <<EOF
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
  run_script "$h" merge-when-green.sh --no-review '作業合意の更新' 12
  assert_eq 0 "$STATUS" "7 文字（実在する最短の理由）は通る: \$ERR"
  assert_contains "$ERR" "作業合意の更新" "理由をログに残す"
}
test_case "1006: 理由の長さの境界（6 は落ちる / 7 は通る）" t_1006_no_review_boundary

# **空白で水増しできない。** `'.      '` は見た目 7 文字でも中身は 1 文字。
t_1006_no_review_padding_does_not_count() {
  local h; h=$(handler <<'EOF'
handle() { echo "should not be called" >&2; exit 99; }
EOF
)
  run_script "$h" merge-when-green.sh --no-review '.      ' 12
  assert_eq 2 "$STATUS" "空白で長さを水増しできない"
  assert_eq "" "$LOG" "gh を一度も呼ばない"
}
test_case "1006: 空白で理由の長さを水増しできない" t_1006_no_review_padding_does_not_count

# ── 【既知の穴】のテストは #1010 で消した ────────────────────────────────────────────
# #1009 は「担当者の返答で通ってしまう」穴を**わざと「通る」を期待値にしたテスト**で
# 明示し、「塞がったらこのテストを消すこと」と書いていた。**#1010 で塞いだので消した。**
# **塞がったことは、下の `1010: 担当者の返答を通さない` が実物 6 件で確かめている。**

# **API が落ちたのか、本当にコメントが 0 件なのかを区別する**（#757。#1009 のレビューの指摘）。
# どちらも止まるが、**PO が次にやることが違う**（レビューを貼る／認証と通信を見る）。
t_1006_api_failure_is_not_zero_comments() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/issues/12/comments"*) echo "HTTP 503" >&2; exit 1 ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '$REVIEW_GREEN_CHECKS' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "読めなければ止まる（fail-safe）"
  assert_contains "$ERR" "コメントを読めませんでした" "API が落ちたことを言う"
  assert_not_contains "$ERR" "コメント 0 件を見ました" "「0 件だった」と言わない（区別する）"
  assert_not_contains "$LOG" "pr	merge	12" "マージを試みない"
}
test_case "1006: API が読めなかったときに「コメント 0 件」と言わない" t_1006_api_failure_is_not_zero_comments

# ── #1010: 検査が読む綴りを `reviewer.md` が決める ──────────────────────────────────────
# **何が壊れていたか**: #1006 の検査は「レビュー」の語を必須にしていたが、
# **`reviewer.md` はその語を 1 度も規定していなかった**（実測 `grep -c 'レビュー[^ア]'` → **0 件**。
# 「レビュ**アー**」は役割の説明で、報告の書き方ではない）。
# **道具が語を推測し、仕様が何も決めていない状態**だったので、
# **仕様どおりに書いた報告が弾かれ、意味の無い 6 文字が通った**（実測、この PR で再現）:
#     `## 結論: マージしてよい。変異 3 件を当て直して全部落ちた。` → **status=1 止まる**
#     `結論を先に: マージしてよい。指摘は 0 件。`                  → **status=1 止まる**
#     `レビュー反対`（6 文字）                                      → **status=0 マージ**
#
# **直し方**: **`reviewer.md` に「報告の 1 行目は `## レビュー: <結論>`」を規定し、
# 検査はその形だけを読む。** 道具が推測するのをやめ、仕様が綴りを決める。

# review_case <期待status> <名前> <コメント本文(JSON文字列の中身)>
# ハンドラの繰り返しを 1 か所にまとめる（#1010 で足すケースが多いので）。
review_case() {
  local want=$1 name=$2 body=$3 h
  h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/issues/12/comments"*) echo '[{"user":{"login":"uonoko1"},"body":"$body"}]' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '$REVIEW_GREEN_CHECKS' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq "$want" "$STATUS" "$name"
  if [[ "$want" == 1 ]]; then
    assert_not_contains "$LOG" "pr	merge	12" "マージを試みない: $name"
  fi
}

# **仕様どおりに書いた報告は「読める」。** `reviewer.md` が規定した 3 つの結論を全部留める。
# **ただしマージまで進むのは `マージしてよい` だけ**（#1021）。
# **「形として読めるか」と「マージを許すか」は別の問い**である——
# 3 つとも読めなければ「レビューなし」と区別がつかず、担当者に何を直せと言えばよいか分からない。
t_1010_spec_form_passes() {
  review_case 0 "1 行目が規定の形（マージしてよい）" \
    '## レビュー: **マージしてよい**（3 度目の敵対的レビュー）\n\n変異 4 件を当て直して 4 件とも再現した。'
  review_case 1 "規定の形でも「直してから」は止める（#1021）" \
    '## レビュー: **直してから**\n\n変異 M3 が素通りした。'
  review_case 1 "規定の形でも「反対」は止める（#1021）" \
    '## レビュー: **反対**\n\nこの経路は別人の記録を出す。'
  # 全角コロンも通す（日本語で書くので実際に起こる）
  review_case 0 "全角コロンも通す" \
    '## レビュー：マージしてよい\n\n指摘は 0 件。'
}
test_case "1010: reviewer.md が規定した 1 行目の形を通す（3 つの結論とも）" t_1010_spec_form_passes

# **6 文字の無意味な文字列は通さない**（#1010 の実測。**これが一番効く**）。
# 「レビュー」と「反対」を並べただけで通る形は、**歯止めではなく合言葉**である。
t_1010_six_chars_no_longer_passes() {
  review_case 1 "「レビュー反対」（6 文字）は通さない" 'レビュー反対'
  review_case 1 "「レビューマージしてよい」も通さない" 'レビューマージしてよい'
  review_case 1 "見出しでない 1 行目は通さない" 'レビューしました。マージしてよいです。'
}
test_case "1010: 見出しでない「レビュー」＋結論の語を通さない（6 文字の合言葉を塞ぐ）" t_1010_six_chars_no_longer_passes

# **担当者の返答を通さない。** 実測（PR 634 本・コメント 218 件）で、
# **`## …レビュー…` の見出しを持つコメント 36 件のうち 6 件が担当者の返答**だった。
# **その 6 件の実物の見出しを、そのままフィクスチャにする。**
# **どれも「レビュー」の直後が結論の語ではない**ので、1 行目の形で落ちる。
t_1010_developer_reply_is_not_a_review() {
  # #17 / #21 / #32 の実物
  review_case 1 "## レビュー対応（#17/#21/#32 の実物）" \
    '## レビュー対応\n\n指摘の 3 件を直しました。賛成会派／反対会派の注記も書き換えています。'
  # #262 の実物
  review_case 1 "## レビュー指摘を反映しました（#262 の実物）" \
    '## レビュー指摘を反映しました（4件訂正）\n\n落ちたときの対応が正反対になるので直しました。'
  # #457 の実物（#1009 が「既知の穴」として残した形）
  review_case 1 "## レビュー3点に対応しました（#457 の実物）" \
    '## レビュー3点に対応しました（e2e183ba）\n\n落ちたときの対応が正反対になる点も直しました。'
  # #466 の実物
  review_case 1 "## レビューへのお礼（#466 の実物）" \
    '## レビューへのお礼と、引き取った指摘について\n\n賛成／反対の注記は別 Issue に切ります。'
  # #224 の 2 件目（#1009 が「既知の穴」として残した形。本文は実物）
  review_case 1 "レビューありがとうございます（#224 の 2 件目の実物）" \
    'レビューありがとうございます。3点とも指摘が妥当だったので直しました。注記は「上の議案情報の『賛成会派／反対会派』に…」と書き換えています。'
}
test_case "1010: 担当者の返答を通さない（実測の 6 件の実物の見出し）" t_1010_developer_reply_is_not_a_review

# **#1009 が残した誤検出 2 件が、この形で塞がる。**
# **#1009 は「誤検出 3 件（#224 / #457 / #566）」と書いたが、#224 は誤りだった**
# ——**#224 には本物のレビュー報告が在る**（`## レビュー: PR #224 収録範囲ページ /coverage/`）。
# **正しくは 本物 8 件 / 誤検出 2 件**（#457・#566。この PR で数え直した。母数は PR 634 本・
# コメント 218 件で、#1009 の 217 件との差 1 は #1009 自身に貼られたレビュー報告である）。
t_1010_closes_the_known_holes() {
  # #566 の実物（PO 自身の検算。列仕様の説明で「反対者数」と書いているだけ）
  review_case 1 "#566（PO の検算。列仕様の「反対者数」）" \
    '## PO: 必須指摘 2 件を直し、1 件は実測待ちのため一旦 draft に戻します\n\n賛成者数／反対者数／表決方法の 3 列です。'
  # #945 / #622（**方向 2（`結論` も許す allowlist）を採ると通ってしまう** 2 件。
  # この PR ではその方向を採らなかったので、ここでも落ちることを固定する）
  review_case 1 "#945（PO の検算。結論の語を含むがレビューではない）" \
    '## PO が確かめた\n\n結論として、請願第38号は反対 32 人を 0 人と公表することになる。'
  review_case 1 "#622（PO の追試。結論の語を含むがレビューではない）" \
    '## PO: 追試しました\n\n結論: 「𠮷 が消える」は本物です。賛成 28 / 反対 18。'
}
test_case "1010: #1009 が残した誤検出と、方向 2 で増える誤検出を通さない" t_1010_closes_the_known_holes

# **票数の話の「反対」は、1 行目が規定の形でも本文にあるだけでは効かない**——という
# 逆向きの確認。**本物の報告は、票数を論じていても通る**（レビューは採決データを論じる）。
t_1010_real_review_may_discuss_votes() {
  review_case 0 "本物の報告は票数を論じていても通る" \
    '## レビュー: **マージしてよい**\n\nPDF が刷っている賛成数・反対数と、読み取ったセルが 8 行すべて一致（賛成 28 / 反対 18）。'
}
test_case "1010: 本物の報告は採決データの「反対」を含んでいても通る" t_1010_real_review_may_discuss_votes

# **どの結論で当たったかを必ず読み上げる**（#1006 から引き継ぐ性質）。
# **#1021 以降は、読み上げたうえで止める。** 読み上げが要るのは、
# **PO と担当者が「何を直せば通るか」を知るため**である。
t_1010_reads_out_the_verdict() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/issues/12/comments"*) echo '[{"user":{"login":"uonoko1"},"body":"## レビュー: **直してから**\n\n変異 M3 が素通りした。"}]' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '$REVIEW_GREEN_CHECKS' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "「直してから」では止まる: \$ERR"
  assert_contains "$ERR" "直してから" "どの結論で当たったかを読み上げる"
}
test_case "1010: どの結論で当たったかを読み上げる（「直してから」のまま押していないか）" t_1010_reads_out_the_verdict

# **止まったときに、規定の綴りをそのまま見せる**（#1010 の再発を防ぐ唯一の手）。
# **「レビューが要る」とだけ言われても、何と書けばよいかが分からない**
# ——それが #1010 で起きたことである。
t_1010_error_shows_the_exact_form() {
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
  assert_contains "$ERR" "## レビュー: " "書くべき 1 行目をそのまま見せる"
  assert_contains "$ERR" "マージしてよい" "結論の選択肢を見せる"
  assert_contains "$ERR" "reviewer.md" "どこに規定があるかを指す"
  assert_contains "$ERR" "コメント 0 件を見ました" "母数を出す（#757）"
}
test_case "1010: 止まったときに、書くべき 1 行目をそのまま見せる" t_1010_error_shows_the_exact_form

# **複数コメントの中から拾う**（レビューは往復する）。母数も出す（#757）。
t_1010_finds_among_many() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/issues/12/comments"*) echo '[{"user":{"login":"uonoko1"},"body":"## レビュー: **直してから**\n\n1 件ある。"},{"user":{"login":"uonoko1"},"body":"## レビュー対応\n\n直しました。"},{"user":{"login":"uonoko1"},"body":"## レビュー: **マージしてよい**（2 度目）\n\n直っている。"}]' ;;
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
test_case "1010: 往復した複数コメントの中から拾う（母数も出す）" t_1010_finds_among_many

# **1 行目でなければ通さない。** **本文の途中に見出しがあるだけでは足りない。**
# #496 の実物がこの形（1 行目は「**承認します。マージします。**」で、
# `## レビューが確かめたこと` は 31 行目）。
# **#1009 は「#496 は見出しが無い」と書いたが、それも誤りだった**
# ——**#496 には見出しが 2 本ある**（`^##\s*(敵対的)?レビュー` の一致行数は **2**）。
# **この PR は「1 行目」を要求するので、#496 の形は落ちる。**
# **それでよい**: #496 は `reviewer.md` が綴りを規定する前に書かれたもので、
# **規定した後の報告は 1 行目に書かれる。過去の形に道具を合わせない。**
t_1010_heading_must_be_first_line() {
  review_case 1 "1 行目が見出しでない（#496 の実物の形）" \
    '**承認します。マージします。** ただし**1点だけ直してから**にしてください。\n\n## レビューが確かめたこと\n\n数字は一致した。'
}
test_case "1010: 本文の途中の見出しでは通さない（1 行目であること）" t_1010_heading_must_be_first_line

# **`^` のアンカーが効いていることを留める**（#1010 の変異 M4 が素通りしたので足した）。
# **1 行目の「先頭」でなければならない。** 引用や本文の途中に規定の形が現れただけでは通さない。
# **これが無いと、`^` を外す変異が 9 件とも緑で素通りする**（実測）。
# 現実に起こる形: **担当者が返答の中で、レビューの見出しを引用する。**
t_1010_heading_must_be_at_line_start() {
  review_case 1 "引用記号つきの行頭は通さない" \
    '> ## レビュー: **マージしてよい**\n\nと言われたので直しました。'
  review_case 1 "行の途中に現れた規定の形は通さない" \
    '前回の ## レビュー: マージしてよい を受けて直しました。'
  # shellcheck disable=SC2016  # フィクスチャの本文。バッククォートは Markdown の記法
  review_case 1 "コードブロックの中の引用も通さない" \
    '`## レビュー: マージしてよい` と書けばよい、という説明です。'
}
test_case "1010: 規定の形は 1 行目の先頭でなければならない（引用を通さない）" t_1010_heading_must_be_at_line_start

# **コロンは省略できない**（#1010 の変異 M5 が素通りしたので足した）。
# **これが無いと、コロンを任意にする変異が 10 件とも緑で素通りする**（実測）。
# **コロンを任意にすると `## レビュー反対` が通る**——#1010 で塞いだ
# 「レビュー反対（6 文字）」に `## ` を足しただけの形が、見出しの体裁で戻ってくる。
# **全履歴（コメント 218 件）では、コロン無しの形で書かれた報告は 0 件**なので、
# **コロンを要求しても落ちるものは無い**（実測）。
t_1010_colon_is_required() {
  review_case 1 "## レビュー反対（コロン無し）は通さない" '## レビュー反対'
  review_case 1 "## レビューマージしてよい（コロン無し）も通さない" '## レビューマージしてよい'
  review_case 1 "## 敵対的レビュー直してから（コロン無し）も通さない" '## 敵対的レビュー直してから'
}
test_case "1010: コロンは省略できない（`## レビュー反対` を通さない）" t_1010_colon_is_required

# **結論の語は見出しの直後でなければならない**（間に本文を挟めない）。
# **これが無いと、`[[:space:]*_]*` を `.*` にする変異が素通りする**——
# `.*` にすると **`## レビュー: この PR に反対した会派は 3 つ` が通る**。
t_1010_verdict_must_follow_immediately() {
  review_case 1 "見出しの後に本文を挟んだ形は通さない" \
    '## レビュー: この PR で扱う議案に反対した会派は 3 つ\n\n（これは報告ではない）'
  review_case 1 "見出しの後に別の語を置いた形も通さない" \
    '## レビュー: 途中経過。まだ直してからにするか決めていない。'
}
test_case "1010: 結論の語は見出しの直後（間に本文を挟めない）" t_1010_verdict_must_follow_immediately

# **allowlist が空になったら、黙って通す側に落ちない**（#1010 の変異 M7 が実測で示した）。
# **`REVIEW_VERDICTS=()` にすると、正規表現の `(%s)` が空の group `()` になり、
# 何にでも当たる**——**`## レビュー: ` とだけ書けば通ってしまう。**
# **allowlist が痩せたときに厳しくなるのではなく、黙って開く**形だった。
# これが無いと、一覧を空にする変異が 12 件中 10 件緑で素通りする（実測）。
t_1010_empty_verdict_list_fails_closed() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/issues/12/comments"*) echo '[{"user":{"login":"uonoko1"},"body":"## レビュー: "}]' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '$REVIEW_GREEN_CHECKS' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
EOF
)
  # 結論の語が無い見出しだけでは通さない（一覧が生きているときの確認）
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "「## レビュー: 」だけでは通さない"
  assert_not_contains "$LOG" "pr	merge	12" "マージを試みない"
}
test_case "1010: 結論の語の無い「## レビュー: 」だけでは通さない" t_1010_empty_verdict_list_fails_closed

# **`## 敵対的レビュー: <結論>` も通す**（#1010 の変異 M9 が素通りしたので足した）。
# **`reviewer.md` の役割名が「敵対的レビュアー」なので、実際にそう書かれる**
# ——実測（全履歴）で **#223 の 1 行目が `## 敵対的レビュー: …`** だった。
# **これが無いと、`(敵対的)?` を消す変異が 12 件とも緑で素通りする**（実測）。
t_1010_accepts_tekitaiteki_prefix() {
  review_case 0 "## 敵対的レビュー: マージしてよい" \
    '## 敵対的レビュー: **マージしてよい**\n\n変異 4 件を当て直して 4 件とも再現した。'
  # **形としては読めるが、結論が「直してから」なので止まる**（#1021）。
  # ここで見ているのは「`敵対的` と全角コロンの組み合わせを読めるか」である。
  review_case 1 "## 敵対的レビュー：直してから（全角コロンも読めたうえで止める）" \
    '## 敵対的レビュー：直してから\n\n1 件ある。'
}
test_case "1010: 「## 敵対的レビュー: <結論>」も通す（#223 の実物の形）" t_1010_accepts_tekitaiteki_prefix

# --- #1054: 同名の check run が 2 本並ぶとき、新しい方だけを見て古い赤を捨てていた ------------
#
# **実測（2026-09-27、`gh api repos/<repo>/commits/<sha>/check-runs`）:**
#   - `conclusion: skipped` の check run は**実在する**: **直近 60 PR の HEAD で 60 件、
#     その全部が `issue-secrets`、60/60 PR**（2026-09-27 に測り直した値）。
#     **`if:` で止めた job は「走らない」のではなく、`skipped` の check run が作られる**
#     （`security.yml` の `issue-secrets`、`ci.yml` の `stale-base`、`pr-body.yml` の `pr-closes`、
#     `deploy-data.yml` の `staging` — job レベルの `if:` は実測 6 件）。
#     **（訂正）** 最初は「直近 200 PR で 30 件」と書いていたが、**下の (B) の「61 PR に出る常連」と
#     桁が合っていなかった**（古い PR には当該 job がまだ無く、母数の取り方が揃っていなかった）。
#     **測り直して一本化した。結論は弱まるどころか強まる——`skipped` は全 PR に出る。**
#   - 同名の check run が同じ commit に 2 本以上並んだ例は、**#1050 の前**は
#     **0 件 / 200 PR**（同じ workflow が同じ commit で 2 回走った例も 0 件 / 60 PR）。
#     **「0 件」であって「数えていない」ではない。**
#   - **#1050 はマージ済みなので、もう起きている**（「生きる」ではなく「生きている」）。
#     **実測（直近 60 PR の HEAD、2026-09-27）: `pr-closes` の n=2 が 5 PR**
#     （#1032 / #1043 / #1062 / #1064 / #1068。**#1064 はこの変更自身の PR**）。
#     **5 PR で断定してよい**（併記をやめた。#1064 の 4 度目のレビューが自分の測り損ねを
#     認めている）。**時刻の差ではない**: #1032 の `pr-closes` の 2 本目は
#     `started_at=15:05:24Z` で、**3 度目のレビュー（15:07:01Z 投稿）の時点で既に在った。**
#     **「7 本・`pr-closes` は 1 本」はその時点で測っても誤りだった。**
#
# **穴の形**: `group_by(.name) | map(max_by(.started_at))` は同名グループから
# **最新の 1 件だけ**を残す。`failure`(10:00) と `skipped`(10:05) が並ぶと `skipped` が勝ち、
# `pass` に分類され、**REQUIRED_RED が空になってマージされる**。
# **#1021 で 4 回起きた誤マージと同じ構造**（歯止めが在るつもりで無い）。
#
# **直し方 (A)**: 同名グループに fail 系（failure/cancelled/timed_out/...）が 1 件でもあれば
# **fail を採る**。`started_at` の新旧を見ない。
#   - 代償: **「赤かったものを直して緑にした後」も赤く見える。** ただしこの道具は
#     **PR の HEAD commit を固定して読む**（`assert_head_unchanged` / `repin_head`）ので、
#     「直した」なら HEAD が動いており、別の commit の check-runs を読む。**同じ commit の中で
#     赤→緑に変わるのは `gh run rerun` の場合だけ**で、そのときは GitHub が
#     **同じ check run を上書きする**（run_attempt が上がる）ので 2 本には並ばない
#     ——実測で同名重複 0 件だったのがその裏付け。
#   - **(B) `skipped` を pass から外す**は採らなかった: **`issue-secrets` は実測で
#     直近 60 PR の 60 件すべてに出る**（上と同じ測定）。**名前が REQUIRED/NONREQUIRED の
#     どちらにも無い＝必須扱い**なので、(B) にすると
#     **全 PR が永久に赤くなってこの道具が使えなくなる**。
#   - **(C) `completed_at` / run id で見る**も採らなかった: 並び順を変えるだけで、
#     **「新しい 1 件だけを見る」という形そのものが穴**である以上、直らない。
#
# **#1054 やること 3（`skipped` を「走っていない」と「走らせる必要がなかった」に分けられるか）:
# 分けられない。** check-runs API の `conclusion: skipped` には、
# **job の `if:` が false だった場合と、step が `continue-on-error` で飛んだ場合と、
# `concurrency` でキャンセルされた場合の区別が無い**（`output` も空。実測で
# `issue-secrets` の skipped は `started_at == completed_at` だったが、
# これは「意図した skip」の印ではない）。**分けられないので、`skipped` は pass のまま置き、
# 代わりに「同名に赤があれば赤」で守る。**

# **fixture の並び順は「本物の API と同じ新しい順」にしてある**（#1064 のレビュー指摘）。
# **実測（`gh api commits/7aeede2a/check-runs`、main の HEAD）:**
#   production: **1 番目 skipped@08:00:32 / 2 番目 failure@07:03:25**
#   staging:    **1 番目 success@08:00:34 / 2 番目 skipped@07:03:23**
# **API は新しい順に返し、`group_by` は名前で安定ソートするので順序が保たれる。**
# つまり**本番では「配列の先頭」＝「最新」＝バグそのもの**である。
#
# **赤を 1 番目に置くと、検査が「配列の順序」を固定してしまって `severity` を固定しない。**
# 実測: `map(max_by(severity))` → `map(first)` の変異が **173 件中 172 件緑で素通りした**
# （落ちるのは下の「failure(新) + skipped(旧)」1 件だけ）。**`map(first)` は
# `max_by(.started_at)` とほぼ同じ挙動なのに、検査が通ってしまう。**
# **だから赤は 2 番目（＝古い側）に置く**——「先頭を採る」実装だと緑を採ってしまう形にする。
# **`t_1054_failure_newer_also_red` だけは逆順（赤が先頭）に置いてある**: 対にして、
# **どちらの並びでも赤を採る**ことを固定するため。

# 同名 2 本（**新しい順**: skipped が先＝新、failure が後＝旧）→ **赤と判定してマージしない**
t_1054_skipped_does_not_mask_failure() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      echo '{"check_runs":[
        {"name":"check","status":"completed","conclusion":"skipped","started_at":"2026-09-26T10:05:00Z","details_url":"u2"},
        {"name":"check","status":"completed","conclusion":"failure","started_at":"2026-09-26T10:00:00Z","details_url":"u1"}
      ]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "必須の赤でマージを拒む"
  assert_contains "$ERR" "check" "赤い検査の名前を言う"
  assert_not_contains "$LOG" "pr	merge	12" "マージを試みない"
}
test_case "1054: 同名の skipped(新) が failure(旧) を塗り替えない" t_1054_skipped_does_not_mask_failure

# **順序を入れ替えても同じ**（failure が新しい側でも赤）。**`max_by` を残したままでも
# こちらだけは通ってしまう**ので、上のテストと対で置く。
t_1054_failure_newer_also_red() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      echo '{"check_runs":[
        {"name":"check","status":"completed","conclusion":"skipped","started_at":"2026-09-26T10:00:00Z","details_url":"u1"},
        {"name":"check","status":"completed","conclusion":"failure","started_at":"2026-09-26T10:05:00Z","details_url":"u2"}
      ]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "必須の赤でマージを拒む"
  assert_not_contains "$LOG" "pr	merge	12" "マージを試みない"
}
test_case "1054: 同名の failure(新) + skipped(旧) も赤" t_1054_failure_newer_also_red

# **`success` も塗り替えない**（`skipped` だけの話ではない。`success`(新) が
# `failure`(旧) を隠す形も同じ穴）。
t_1054_success_does_not_mask_failure() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      echo '{"check_runs":[
        {"name":"gitleaks","status":"completed","conclusion":"success","started_at":"2026-09-26T10:05:00Z","details_url":"u2"},
        {"name":"gitleaks","status":"completed","conclusion":"failure","started_at":"2026-09-26T10:00:00Z","details_url":"u1"},
        {"name":"check","status":"completed","conclusion":"success","started_at":"2026-09-26T10:00:00Z"}
      ]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "必須の赤でマージを拒む"
  assert_contains "$ERR" "gitleaks" "赤い検査の名前を言う"
  assert_not_contains "$LOG" "pr	merge	12" "マージを試みない"
}
test_case "1054: 同名の success(新) も failure(旧) を塗り替えない" t_1054_success_does_not_mask_failure

# **pending は赤より弱い**: 同名に fail があれば、pending が並んでいても**赤**として止める
# （`pending` を採ると「待ち続けて POLL_MAX でタイムアウト」になり、
# **「必須が赤い」という本当の理由がログに出ない**）。
t_1054_fail_beats_pending_in_same_name() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      echo '{"check_runs":[
        {"name":"check","status":"in_progress","conclusion":null,"started_at":"2026-09-26T10:05:00Z"},
        {"name":"check","status":"completed","conclusion":"failure","started_at":"2026-09-26T10:00:00Z","details_url":"u1"}
      ]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "必須の赤でマージを拒む"
  assert_contains "$ERR" "checks failed" "赤として止める（タイムアウトではない）"
  assert_not_contains "$ERR" "timed out" "pending 扱いで待たない"
}
test_case "1054: 同名に failure があれば pending より赤を採る" t_1054_fail_beats_pending_in_same_name

# **必須でない検査では、今までどおり `--allow-nonrequired-red` で通せる**
# （同名重複を赤く採るようにしても、`--allow-nonrequired-red` の意味は変えない）。
t_1054_nonrequired_dup_still_passable() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      echo '{"check_runs":[
        {"name":"stale-base","status":"completed","conclusion":"skipped","started_at":"2026-09-26T10:05:00Z","details_url":"u2"},
        {"name":"stale-base","status":"completed","conclusion":"failure","started_at":"2026-09-26T10:00:00Z","details_url":"u1"},
        {"name":"check","status":"completed","conclusion":"success","started_at":"2026-09-26T10:00:00Z"}
      ]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  # フラグ無しでは止まる（黙って押さない）
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "フラグ無しでは止まる"
  assert_contains "$ERR" "stale-base" "必須でない赤の名前を言う"
  # フラグ付きなら通る（既存の動作を壊していない）
  run_script "$h" merge-when-green.sh --allow-nonrequired-red 12
  assert_eq 0 "$STATUS" "--allow-nonrequired-red で通る: $ERR"
  assert_contains "$LOG" "pr	merge	12" "マージした"
}
test_case "1054: 必須でない同名重複の赤は --allow-nonrequired-red で通る" t_1054_nonrequired_dup_still_passable

# **単独の `skipped` は今までどおり pass**（`issue-secrets` は**実測で直近 60 PR の
# 60 件すべてに出る**。ここを赤くすると全 PR が止まる）。
t_1054_lone_skipped_still_passes() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      echo '{"check_runs":[
        {"name":"check","status":"completed","conclusion":"success","started_at":"2026-09-26T10:00:00Z"},
        {"name":"issue-secrets","status":"completed","conclusion":"skipped","started_at":"2026-09-26T10:00:00Z"}
      ]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "単独の skipped は緑のまま: $ERR"
  assert_contains "$LOG" "pr	merge	12" "マージした"
}
test_case "1054: 単独の skipped は今までどおり pass" t_1054_lone_skipped_still_passes

# **同名が 2 本とも緑なら緑**（重複そのものを赤にしていない）。
# **これが無いと「同名が 2 本あれば赤」という乱暴な直し方が素通りする。**
t_1054_dup_all_green_stays_green() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      echo '{"check_runs":[
        {"name":"check","status":"completed","conclusion":"success","started_at":"2026-09-26T10:00:00Z"},
        {"name":"check","status":"completed","conclusion":"neutral","started_at":"2026-09-26T10:05:00Z"}
      ]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "2 本とも pass 系なら緑: $ERR"
  assert_contains "$LOG" "pr	merge	12" "マージした"
}
test_case "1054: 同名 2 本が両方 pass 系なら緑のまま" t_1054_dup_all_green_stays_green

# **同名グループは 1 行に畳む**（必須の件数を二重に数えない）。
# `required_total` が水増しされると、ログの「必須 N 件」が嘘になる。
t_1054_dup_counted_once() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      echo '{"check_runs":[
        {"name":"check","status":"completed","conclusion":"success","started_at":"2026-09-26T10:00:00Z"},
        {"name":"check","status":"completed","conclusion":"neutral","started_at":"2026-09-26T10:05:00Z"},
        {"name":"gitleaks","status":"completed","conclusion":"success","started_at":"2026-09-26T10:00:00Z"}
      ]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "緑: $ERR"
  assert_contains "$OUT$ERR" "all 2 checks green" "同名は 1 件として数える（3 本の run → 2 件）"
}
test_case "1054: 同名の run は 1 件として数える" t_1054_dup_counted_once

# **PR 側の経路**（#1050 が 2026-09-27 にマージされた直後に実測）。
# `pr-body.yml` が `types: [..., edited]` で走るので、**本文を続けて直すと、同じ commit に
# `pr-closes` の check run が複数本並ぶ**——実測: `fed085e2` に **5 本**、`04b15d9b` に **2 本**。
#
# **ただし `cancelled` になった例は実測 0 件**（`pr-body.yml` の run 25 件は**全部 success**。
# 速すぎて `cancel-in-progress` が発火していない）。**この fixture の `cancelled` は推論である。**
# **実測で裏付いているのは `production` の方**（下の `t_1054_monitor_...` を見よ）。
# それでもこの形を置くのは、**`cancelled` が fail 系として扱われること**と、
# **この道具の REQUIRED_CHECKS に載っている名前はフラグでも通せないこと**を固定するため。
#
# **そして実際に効いている**（#1064 の 3 度目のレビューで指摘され、担当者が追試した）:
# **`else "fail"` を「`failure` だけを赤とみなす denylist」に変える変異**
# （`else (if .conclusion == "failure" then "fail" else "pass" end)`）を当てると、
# **178 件のうちこの 1 件だけが落ちる**（実測 177/1）。
# **`cancelled` / `timed_out` / `action_required` / `stale` が黙って緑になる変異**を、
# **この fixture だけが捕まえている。**
# **推論で置いた fixture が、実データには現れない変異を殺している**
# ——実データに無いことは「置く必要がない」ことを意味しない。
#
# **`pr-closes` は GitHub の必須チェックではない**（実測: `branches/main/protection` の
# `required_status_checks.contexts` は `["check","gitleaks","forbidden-patterns","audit"]`）。
# **この道具の REQUIRED_CHECKS には載っているので、止まるのはこの道具だけ**
# ——**GitHub は許すので、この道具が唯一の歯止めである。**
t_1054_pr_closes_cancelled_then_success() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      echo '{"check_runs":[
        {"name":"check","status":"completed","conclusion":"success","started_at":"2026-09-27T00:32:31Z"},
        {"name":"pr-closes","status":"completed","conclusion":"success","started_at":"2026-09-27T00:34:54Z","details_url":"u2"},
        {"name":"pr-closes","status":"completed","conclusion":"cancelled","started_at":"2026-09-27T00:32:31Z","details_url":"u1"}
      ]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  # フラグ付きでも通らない（この道具の REQUIRED_CHECKS に載っている）。
  # **--allow-nonrequired-red が抜け道にならないことを固定する**
  run_script "$h" merge-when-green.sh --allow-nonrequired-red 12
  assert_eq 1 "$STATUS" "REQUIRED_CHECKS の赤なのでフラグ付きでも止まる"
  assert_contains "$ERR" "pr-closes" "赤い必須検査の名前を言う"
  assert_contains "$ERR" "--allow-nonrequired-red では通せません" "フラグでは通せないと言う"
  assert_not_contains "$LOG" "pr	merge	12" "マージを試みない"
}
test_case "1054: pr-closes の cancelled(旧)+success(新) はこの道具の必須の赤（フラグでも通さない）" t_1054_pr_closes_cancelled_then_success

# **main で今まさに起きている実例**（#1064 のレビューで PO が発見、担当者が追試。
# `gh api repos/<repo>/commits/7aeede2a/check-runs`——**当時の main の HEAD**）:
#
#   production  skipped  2026-09-27T08:00:32Z   ← 1 番目（新しい）
#   production  failure  2026-09-27T07:03:25Z   ← 2 番目（古い）
#
#   $ jq 'group_by(.name)|map(max_by(.started_at))|.[]|select(.name=="production")'
#     production  skipped        ← **pass 扱い。failure が隠れる**
#
# **`monitor.yml` の `production` / `staging` は job レベルの `if:` 付きで、
# スケジュール実行が同じ commit に何度も走る。** `failure` のあとに `skipped` が乗る。
# **実測: main の直近 30 コミットに同名重複 7 グループ、うち 3 つが「fail + pass」の形**
# （`7aeede2a` の `production` / `177a06ac` の `production` / `2f98748a` の `guard`）。
# **`pr-closes` の `cancelled` を待つ必要はなかった——`main` で既に起きている。**
#
# **`production` は REQUIRED_CHECKS にも NONREQUIRED_CHECKS にも無い＝必須扱い**（fail-closed）
# なので、**`--allow-nonrequired-red` では通せない。黙って通るしかなかった。**
t_1054_monitor_production_real_example() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      # 実物をそのまま（並び順も実物どおり: 新しい skipped が先）
      # **#1069 の後も `production` の形はそのまま残す**: `production` は SKIPPABLE_CHECKS に
      # 無いので `skipped` も `failure` も fail になり、**どちらを採っても赤**。
      # **つまりこの検査は #1054 の保証（新しい緑が古い赤を塗り替えない）を弱めていない。**
      # **`staging` の古い側だけ `skipped` → `neutral` に替えた**（#1069）——
      # `skipped` のままだと `staging` も赤くなり、**「重複そのものを赤にしていない」という
      # この検査の主張が消えてしまう**。`neutral` は `skipped` と同じ pass 系で、
      # **名前に依らず緑**なので、主張だけを残せる。
      echo '{"check_runs":[
        {"name":"production","status":"completed","conclusion":"skipped","started_at":"2026-09-27T08:00:32Z","details_url":"u1"},
        {"name":"production","status":"completed","conclusion":"failure","started_at":"2026-09-27T07:03:25Z","details_url":"u2"},
        {"name":"staging","status":"completed","conclusion":"success","started_at":"2026-09-27T08:00:34Z"},
        {"name":"staging","status":"completed","conclusion":"neutral","started_at":"2026-09-27T07:03:23Z"},
        {"name":"check","status":"completed","conclusion":"success","started_at":"2026-09-27T08:00:00Z"}
      ]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  # **フラグ付きでも通らない**（production は必須扱い）
  run_script "$h" merge-when-green.sh --allow-nonrequired-red 12
  assert_eq 1 "$STATUS" "必須扱いの赤なのでフラグ付きでも止まる"
  assert_contains "$ERR" "production" "赤い検査の名前を言う"
  assert_not_contains "$LOG" "pr	merge	12" "マージを試みない"
  # **staging は success(新) + skipped(旧) で、どちらも pass 系なので赤にしない**
  # （重複そのものを赤にしていないことを、実物の形で固定する）。
  # **`staging` という語そのもので見てはいけない**——「知らない検査があります」の行に出るため。
  # **赤の一覧が `production` だけ**であることを見る。
  assert_contains "$ERR" "checks failed on PR #12: production" "赤は production だけ（staging は入らない）"
  # **同名は 1 件に畳まれている**（production 2 本 + staging 2 本 + check 1 本 = 5 run → 3 件）
  assert_contains "$OUT$ERR" "検査 3 件 / 必須 3 件 / 赤 1 件" "5 run を 3 件に畳む"
}
test_case "1054: main の実例（production が skipped(新) で failure(旧) を隠していた）" t_1054_monitor_production_real_example

# **赤を「先頭でも末尾でもない位置」に置く**——**位置で選ぶ実装をすべて殺すため**（#1064 のレビュー）。
#
# **実測した jq の性質**: `max_by` は**同値のとき最後の要素を返す**
# （`[a,b,c] | max_by(0)` → `c`。`min_by(0)` → `a`）。
# つまり `severity` を全部同じ値にする変異は **`map(last)` と等価**になる。
# **赤を末尾に置いた fixture だけでは、その変異が素通りする**（実測: 「severity 全部 0」で
# 174 件全部緑になった）。**赤を先頭に置いた fixture だけでは `map(first)` が素通りする**
# （実測: 173 件中 172 件緑）。
#
# **だから赤を真ん中に置く。** `first` も `last` も緑を掴む。
# **ただしこれだけでは足りない**（#1064 の 2 度目のレビュー）: **3 要素の「真ん中」＝ index 1 なので、
# `map(.[1])` は赤を返して生き残る**（実測: 176 件全部緑で素通りした）。
# **index 0 だけに赤を置いた 4 本の fixture**（`t_1054_red_at_index_zero_only_of_four`）
# **と対で初めて、位置で選ぶ実装が全部落ちる。**
# **ただし「位置で選ぶ実装」が全部落ちても、「見る範囲を切る」実装は落ちない**
# ——`t_1054_red_far_from_both_ends`（赤を先頭からも末尾からも離した 6 本）が要る。
# `production` の実例（新しい順: skipped / failure）に、さらに古い `success` を足した形。
# **`monitor.yml` はスケジュールで何度も走るので、3 本以上並ぶのは実在の形である。**
t_1054_red_in_the_middle() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      echo '{"check_runs":[
        {"name":"check","status":"completed","conclusion":"skipped","started_at":"2026-09-27T08:00:32Z","details_url":"u1"},
        {"name":"check","status":"completed","conclusion":"failure","started_at":"2026-09-27T07:03:25Z","details_url":"u2"},
        {"name":"check","status":"completed","conclusion":"success","started_at":"2026-09-27T06:01:11Z","details_url":"u3"}
      ]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh --allow-nonrequired-red 12
  assert_eq 1 "$STATUS" "真ん中の赤を見落とさない（先頭 skipped / 末尾 success）"
  assert_contains "$ERR" "checks failed on PR #12: check" "必須の赤として止める"
  assert_not_contains "$LOG" "pr	merge	12" "マージを試みない"
}
test_case "1054: 赤が先頭でも末尾でもない位置にあっても赤（位置で選ぶ実装を殺す）" t_1054_red_in_the_middle

# **pending も真ん中に置いた対**（`severity` の `pending` のキーが効いていることを、
# 位置に依らずに固定する）。**指摘 5 の「キー打ち間違いが素通りする」に対応する:**
# `{...}[bucket_of]` は**知らないキーで null を返し、`max_by` は null を最小として扱う**ので、
# `pending` のキーが壊れると **pending が pass に負けて消える**（＝待つべきものを緑と読む）。
# **赤が無く pending と pass だけが並ぶ形**にして、**pending が勝つ**ことを見る。
t_1054_pending_beats_pass_in_same_name() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      echo '{"check_runs":[
        {"name":"check","status":"completed","conclusion":"neutral","started_at":"2026-09-27T08:00:32Z"},
        {"name":"check","status":"in_progress","conclusion":null,"started_at":"2026-09-27T07:03:25Z"},
        {"name":"check","status":"completed","conclusion":"success","started_at":"2026-09-27T06:01:11Z"}
      ]}' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  # **pending のまま待ち続けて POLL_MAX でタイムアウトする**（マージしない）。
  # **緑と読んだらここが 0 になってマージされる**——それが見たい差である。
  assert_eq 1 "$STATUS" "pending として待つ（緑と読まない）"
  assert_contains "$ERR" "timed out" "pending 扱いで待つ"
  assert_not_contains "$LOG" "pr	merge	12" "マージを試みない"
}
test_case "1054: 同名の pending は pass に負けない（真ん中に置いても）" t_1054_pending_beats_pass_in_same_name

# **4 本並べて、赤を index 0 だけに置く**——**「位置で選ぶ実装」を網羅的に殺すため**
# （#1064 の 2 度目のレビュー。**「先頭・末尾・真ん中に置け」という指針は誤りだった**:
# **3 要素では「真ん中」＝ index 1 なので、`map(.[1])` は赤を返して生き残る。**
# 実測: `map(if length>1 then .[1] else .[0] end)` が **176 件全部緑で素通りした。**
# 私の 12 件の fixture は、重複グループの最悪の run が**例外なく index 1** に置かれていた）。
#
# **自分で検算した**（4 要素・赤を index 0 だけ）:
#   max_by = failure  ← 本番実装
#   first  = failure  ← 別の fixture（failure(新)+skipped(旧)）が殺す
#   last   = skipped   .[1] = skipped   .[2] = success   .[-2] = success   min_by = skipped
# **`max_by` と `first` 以外は全部「緑」を返す**ので、**位置で選ぶ実装はここで落ちる。**
#
# **ただし「これで十分」ではなかった**（#1064 の 3 度目のレビュー）:
# **赤が index 0 にあると、`.[0:2]` のように「見る範囲を先頭 2 件に切る」実装は
# 赤を掴んでしまうので殺せない**（実測: T1 / U2 がともに 177 件全部緑で素通りした）。
# **それを殺すのは `t_1054_red_far_from_both_ends`**（赤を index 3 に置いた 6 本）である。
#
# **実データでも別人の答えが出る**（`gh api commits/42f9c225/check-runs`。
# `monitor.yml` が 10 分ごとに走るので同じ sha に run が積まれている実物）:
#   etl        n=2   failure,failure
#   guard      n=3   failure,success,failure
#   production n=18  failure,skipped,failure,skipped,...
#
#   本番実装 max_by(severity) → 赤 3 件（etl / guard / production）
#   変異 .[1]                 → 赤 1 件（etl のみ。**guard と production が黙って消える**）
#
# **`guard` も `production` もどちらの一覧にも無い＝必須扱い**なので、
# **赤い必須チェックのままマージされる方向に倒れる——塞ごうとしたバグそのものである。**
#
# 並びは本物どおり「新しい順」。`monitor.yml` の `production` の実物の形
# （`failure` のあとに `skipped` が何度も乗る）に合わせてある。
t_1054_red_at_index_zero_only_of_four() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      echo '{"check_runs":[
        {"name":"production","status":"completed","conclusion":"failure","started_at":"2026-09-27T08:00:32Z","details_url":"u1"},
        {"name":"production","status":"completed","conclusion":"skipped","started_at":"2026-09-27T07:03:25Z","details_url":"u2"},
        {"name":"production","status":"completed","conclusion":"success","started_at":"2026-09-27T06:01:11Z","details_url":"u3"},
        {"name":"production","status":"completed","conclusion":"skipped","started_at":"2026-09-27T05:00:04Z","details_url":"u4"},
        {"name":"check","status":"completed","conclusion":"success","started_at":"2026-09-27T08:00:00Z"}
      ]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  # **フラグ付きでも通らない**（production はどちらの一覧にも無い＝必須扱い）
  run_script "$h" merge-when-green.sh --allow-nonrequired-red 12
  assert_eq 1 "$STATUS" "index 0 の赤を見落とさない（1〜3 番目は全部 pass 系）"
  assert_contains "$ERR" "checks failed on PR #12: production" "必須扱いの赤として止める"
  assert_not_contains "$LOG" "pr	merge	12" "マージを試みない"
  # **4 run + 1 run を 2 件に畳む**（件数のログが嘘にならないこと）
  assert_contains "$OUT$ERR" "検査 2 件 / 必須 2 件 / 赤 1 件" "5 run を 2 件に畳む"
}
test_case "1054: 4 本並んで赤が index 0 だけでも赤（.[1] / .[2] / last / min_by を殺す）" t_1054_red_at_index_zero_only_of_four

# **6 本並べて、赤を index 3 に置く**——**「見る範囲を切る」実装を殺すため**
# （#1064 の 3 度目のレビュー。**「4 本・赤を index 0 だけで十分」という指針も誤りだった**）。
#
# **位置で選ぶ実装は index 0 の fixture で全部死ぬが、範囲を切る実装は死なない。**
# 実測（当時の 177 件）: **どちらも 177 件全部緑で素通りした**
#   T1 `map(.[0:2] | max_by(severity))`
#   U2 `map(sort_by(.started_at) | reverse | .[0:2] | max_by(severity))`
#
# **U2 がとくに怖い形である**: **「再実行は直近の試行だけ見ればいい」という発想は、
# M1（`max_by(.started_at)`）を直すときに人が書きそうな中間形**で、
# **`severity` も `group_by` も `// 2` も全部正しく残っているので目視では違和感が無い。**
#
# **実データにこの並びが在る**: `42f9c225` の `staging`（18 本）には **pass 系が 2 つ以上
# 連続する箇所**があり、そこに赤が来れば `[pass, pass, fail, ...]` になる。
# `production` は必須扱いなので **`--allow-nonrequired-red` でも通せない＝黙って通るしかない。**
#
# **赤の位置は「前から 4 番目（index 3）」にしてある。自分で検算した**
# （A = 既存の `[failure, skipped, success, skipped]`、B = この fixture）:
#
#   変異      A          B          判定
#   first     failure    skipped    殺せる     .[0:2]   failure  skipped  殺せる
#   last      skipped    skipped    殺せる     .[0:3]   failure  skipped  殺せる
#   .[1]      skipped    skipped    殺せる     .[0:4]   failure  failure  **★この 2 本では残る**
#   .[2]      success    skipped    殺せる     .[-2:]   success  success  殺せる
#   .[3]      skipped    failure    殺せる     .[-3:]   skipped  failure  殺せる
#   .[-2]     success    success    殺せる     .[1:]    skipped  failure  殺せる
#   min_by    skipped    skipped    殺せる
#
# **【訂正】ここに「`.[0:4]` が残るのは構造的な限界で、fixture を伸ばしても消えない」と
# 書いていたが、それは誤りだった**（#1064 の 4 度目・5 度目のレビューで名指しの訂正を受けた。
# **測ったら消えた**）。**長さ 8・赤 index 5 の fixture を 1 本足すと `.[0:4]` は落ちる**
# （実測: 178 件全部緑 → 179 件中 1 件落ちる。下の `t_1054_red_at_index_five_of_eight`）。
#
# **正しい命題はこうである**（**全称命題から個別命題を導いてしまったのが誤りの形**）:
#   - **正しい**: `.[0:n]` は `n >= 配列の長さ` のとき配列全体を見るので、本番実装と同じ答えを返す。
#     **どんな有限の fixture にも「それより広い窓」がある。**
#   - **正しい**: **どの特定の `n` も、長さ > n・赤を index >= n に置いた fixture 1 本で必ず殺せる。**
#   - **誤り**: 「だから `.[0:4]` は殺せない」。**殺せないのは「全ての `n` を有限本で同時に」であって、
#     個別の `n` は殺せる。**
#
# **これは #1067 で直したはずの型だった**（「構造的に不可能」と書く前に測る）。
# **「これで全部と書かない」という態度は正しかったのに、その根拠として置いた命題が
# 測れば崩れていた。** 記述を消し、**測った fixture を下に 2 本置いた。**
t_1054_red_far_from_both_ends() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      # 並びは本物どおり「新しい順」。`monitor.yml` の production の実物の形に合わせてある
      echo '{"check_runs":[
        {"name":"production","status":"completed","conclusion":"skipped","started_at":"2026-09-27T08:00:32Z","details_url":"u1"},
        {"name":"production","status":"completed","conclusion":"skipped","started_at":"2026-09-27T07:50:11Z","details_url":"u2"},
        {"name":"production","status":"completed","conclusion":"skipped","started_at":"2026-09-27T07:40:07Z","details_url":"u3"},
        {"name":"production","status":"completed","conclusion":"failure","started_at":"2026-09-27T07:30:02Z","details_url":"u4"},
        {"name":"production","status":"completed","conclusion":"success","started_at":"2026-09-27T07:20:55Z","details_url":"u5"},
        {"name":"production","status":"completed","conclusion":"skipped","started_at":"2026-09-27T07:10:44Z","details_url":"u6"},
        {"name":"check","status":"completed","conclusion":"success","started_at":"2026-09-27T08:00:00Z"}
      ]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  # **フラグ付きでも通らない**（production はどちらの一覧にも無い＝必須扱い）
  run_script "$h" merge-when-green.sh --allow-nonrequired-red 12
  assert_eq 1 "$STATUS" "前からも後ろからも離れた赤を見落とさない"
  assert_contains "$ERR" "checks failed on PR #12: production" "必須扱いの赤として止める"
  assert_not_contains "$LOG" "pr	merge	12" "マージを試みない"
  # **6 run + 1 run を 2 件に畳む**（件数のログが嘘にならないこと）
  assert_contains "$OUT$ERR" "検査 2 件 / 必須 2 件 / 赤 1 件" "7 run を 2 件に畳む"
}
test_case "1054: 赤が先頭からも末尾からも離れていても赤（範囲を切る実装を殺す）" t_1054_red_far_from_both_ends

# **8 本並べて、赤を index 5 に置く**——**「先頭側の窓」を、境界のすぐ外側まで殺すため**
# （#1064 の 4 度目・5 度目のレビューの必須 2）。
#
# **これは訂正の fixture である。** 上の `t_1054_red_far_from_both_ends` のコメントに
# 「`.[0:4]` は構造的に殺せない／fixture を伸ばしても消えない」と書いていたが、
# **伸ばしたら消えた**。**この 1 本がその反証であり、同時に守りである。**
#
# **自分で jq に食わせて検算した**（`["skipped","skipped","skipped","skipped","skipped","failure","success","skipped"]`）:
#   max_by(本番) = failure   ← 本番実装は赤を掴む（この fixture は本番実装では緑のまま通る）
#   .[0:2] = skipped   .[0:3] = skipped   .[0:4] = skipped   .[0:5] = skipped   **← ここまで殺せる**
#   .[0:6] = failure   ← 赤が index 5 なので窓に入る。**より長い fixture が要る（個別の n は殺せる）**
#
# **「どの特定の `n` も 1 本で殺せるが、全ての `n` を有限本で同時には殺せない」**——
# これが測った結論である。**「殺せない」ではない。**
#
# **長さ 8 は実在の形である**: `42f9c225` の `production` は同じ sha に **18 本**積まれている
# （`monitor.yml` が `*/10 * * * *`）。**8 本は実物より短い。**
#
# **この 1 本が同時に締める変異**（実測。下の PR 本文・ソースの表と同じ数字）:
#   `map(.[0:4] | max_by(severity))`                     0 件 → 1 件
#   `map(.[0:5] | max_by(severity))`                     0 件 → 1 件
#   `map(if length > 6 then max_by(.started_at) else max_by(severity) end)`（N1d）  0 件 → 1 件
t_1054_red_at_index_five_of_eight() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      # 並びは本物どおり「新しい順」。`monitor.yml` の production の実物の形に合わせてある
      echo '{"check_runs":[
        {"name":"production","status":"completed","conclusion":"skipped","started_at":"2026-09-27T08:00:32Z","details_url":"u1"},
        {"name":"production","status":"completed","conclusion":"skipped","started_at":"2026-09-27T07:50:11Z","details_url":"u2"},
        {"name":"production","status":"completed","conclusion":"skipped","started_at":"2026-09-27T07:40:07Z","details_url":"u3"},
        {"name":"production","status":"completed","conclusion":"skipped","started_at":"2026-09-27T07:30:02Z","details_url":"u4"},
        {"name":"production","status":"completed","conclusion":"skipped","started_at":"2026-09-27T07:20:55Z","details_url":"u5"},
        {"name":"production","status":"completed","conclusion":"failure","started_at":"2026-09-27T07:10:44Z","details_url":"u6"},
        {"name":"production","status":"completed","conclusion":"success","started_at":"2026-09-27T07:00:31Z","details_url":"u7"},
        {"name":"production","status":"completed","conclusion":"skipped","started_at":"2026-09-27T06:50:18Z","details_url":"u8"},
        {"name":"check","status":"completed","conclusion":"success","started_at":"2026-09-27T08:00:00Z"}
      ]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  # **フラグ付きでも通らない**（production はどちらの一覧にも無い＝必須扱い）
  run_script "$h" merge-when-green.sh --allow-nonrequired-red 12
  assert_eq 1 "$STATUS" "先頭 5 件が全部 pass 系でも 6 番目の赤を見落とさない"
  assert_contains "$ERR" "checks failed on PR #12: production" "必須扱いの赤として止める"
  assert_not_contains "$LOG" "pr	merge	12" "マージを試みない"
  # **8 run + 1 run を 2 件に畳む**（件数のログが嘘にならないこと）
  assert_contains "$OUT$ERR" "検査 2 件 / 必須 2 件 / 赤 1 件" "9 run を 2 件に畳む"
}
test_case "1054: 8 本並んで赤が index 5 でも赤（.[0:4] / .[0:5] / 長さ条件を殺す）" t_1054_red_at_index_five_of_eight

# **8 本並べて、赤を index 2 に置き、末尾 5 件を全部 pass 系にする**
# ——**「末尾側の窓」を殺すため**（#1064 の 4 度目・5 度目のレビューの必須 1）。
#
# **これまでの fixture が 1 本も殺せていなかったクラスである**（実測: 178 件全部緑）:
#   `map(.[-4:] | max_by(severity))`                          178 件全部緑
#   `map(.[-5:] | max_by(severity))`                          178 件全部緑
#   `map(sort_by(.started_at) | .[-4:] | max_by(severity))`    178 件全部緑
#
# **なぜ既存の 2 本が殺さなかったか**（自分で確かめた）:
#   A `t_1054_red_at_index_zero_only_of_four`（長さ 4）→ `.[-4:]` は**配列全体**になる
#   B `t_1054_red_far_from_both_ends`（長さ 6・赤 index 3）→ `.[-4:]` = index 2..5 に**赤が入る**
# **赤を先頭寄りに置き、末尾 4 件以上を全部 pass にした fixture が 1 本も無かった。**
# **境界のすぐ外側**——#1064 で 5 回続けて穴になったのと同じ型である。
#
# **実データで別人の答えが出る**（`42f9c225` の `production`、n=18。**PR が引用している実物**）:
#   新しい順: failure,skipped,failure,skipped,failure,skipped,failure,skipped,
#             failure,skipped,failure,success,skipped,success,skipped,success,skipped,success
#   **末尾 4 件（最古の 4 件）が `skipped,success,skipped,success` で全部 pass 系**
#
#   本番実装 max_by(severity)              → RED: ["etl","guard","production"]
#   変異 map(.[-4:] | max_by(severity))     → RED: ["etl","guard"]   **← production が黙って消える**
#   変異 map(.[-5:] | max_by(severity))     → RED: ["etl","guard"]   **← 同じ**
#
# **`production` はどちらの一覧にも無い＝必須扱い**なので **`--allow-nonrequired-red` でも通せない
# ——黙って通るしかない。塞ごうとしたバグそのものの向きである。**
#
# **長さは 8 にした。4 度目のレビューの「長さ 7」では `.[-5:]` が残る**
# （5 度目のレビューが自分の PROBE で測って訂正した。自分でも jq で検算した）:
#   長さ 7・赤 index 2 → `.[-5:]` = index 2..6 で**赤を掴む**（殺せない）
#   長さ 8・赤 index 2 → `.[-5:]` = index 3..7 で**全部 pass**（殺せる）
#
# **検算**（`["skipped","skipped","failure","success","skipped","success","skipped","success"]`）:
#   max_by(本番) = failure   ← 本番実装は赤を掴む
#   .[-4:] = success   .[-5:] = success   **← ここまで殺せる**
#   .[-6:] = failure   ← 赤が index 2 なので窓に入る。**先頭側と同じく、個別の n は殺せる**
#   .[0:2] = skipped   **← 先頭側の狭い窓もついでに殺す**
t_1054_red_early_with_all_pass_tail() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      # 並びは本物どおり「新しい順」。**末尾（最古）5 件を全部 pass 系にしてある**
      echo '{"check_runs":[
        {"name":"production","status":"completed","conclusion":"skipped","started_at":"2026-09-27T08:00:32Z","details_url":"u1"},
        {"name":"production","status":"completed","conclusion":"skipped","started_at":"2026-09-27T07:50:11Z","details_url":"u2"},
        {"name":"production","status":"completed","conclusion":"failure","started_at":"2026-09-27T07:40:07Z","details_url":"u3"},
        {"name":"production","status":"completed","conclusion":"success","started_at":"2026-09-27T07:30:02Z","details_url":"u4"},
        {"name":"production","status":"completed","conclusion":"skipped","started_at":"2026-09-27T07:20:55Z","details_url":"u5"},
        {"name":"production","status":"completed","conclusion":"success","started_at":"2026-09-27T07:10:44Z","details_url":"u6"},
        {"name":"production","status":"completed","conclusion":"skipped","started_at":"2026-09-27T07:00:31Z","details_url":"u7"},
        {"name":"production","status":"completed","conclusion":"success","started_at":"2026-09-27T06:50:18Z","details_url":"u8"},
        {"name":"check","status":"completed","conclusion":"success","started_at":"2026-09-27T08:00:00Z"}
      ]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  # **フラグ付きでも通らない**（production はどちらの一覧にも無い＝必須扱い）
  run_script "$h" merge-when-green.sh --allow-nonrequired-red 12
  assert_eq 1 "$STATUS" "末尾 5 件が全部 pass 系でも先頭寄りの赤を見落とさない"
  assert_contains "$ERR" "checks failed on PR #12: production" "必須扱いの赤として止める"
  assert_not_contains "$LOG" "pr	merge	12" "マージを試みない"
  # **8 run + 1 run を 2 件に畳む**（件数のログが嘘にならないこと）
  assert_contains "$OUT$ERR" "検査 2 件 / 必須 2 件 / 赤 1 件" "9 run を 2 件に畳む"
}
test_case "1054: 末尾 5 件が全部 pass 系でも先頭寄りの赤は赤（.[-4:] / .[-5:] を殺す）" t_1054_red_early_with_all_pass_tail

# --- #1069: `skipped` を pass として数えていたので、走っていない必須チェックが緑になっていた ------
#
# **再現（この PR を書く前に、`origin/main` の素の状態で実際に走らせた）:**
#   必須 5 件（check / gitleaks / forbidden-patterns / audit / pr-closes）を全部
#   `conclusion: skipped` にした check-runs を返すと——
#     [..] all 5 checks green
#     [..] squash-merging PR #12 and deleting feat/x
#   **STATUS=0 でマージされた。** **1 行も走っていないのに「全部緑」。**
#
# **これは #757「母数を検算に入れる」の check-runs 版である。**
# **`skipped` は「0 件（問題なし）」ではなく「数えていない」。**
#
# **#1054 は「分けられない」と結論して `skipped` を pass のまま置いた**（同ファイル上部の
# 「#1054 やること 3」）。**その根拠——「check-runs API の `conclusion: skipped` には
# `if:` が false だった場合と `concurrency` で消えた場合を区別する欄が無い」——は
# API については正しい。**
# **だが区別に API は要らない。`name` が在る。**
# **「その job が PR で必ず skip されるか」は `.github/workflows/` の `if:` を見れば分かる。**
# **#1054 は「check run の中で分ける」ことだけを試して、「名前で分ける」を試していなかった。**
#
# **実測（2026-09-28、直近 60 PR の HEAD の check-runs、`--paginate`、母数 483 件）:**
#   conclusion 別   success 408 / skipped 63 / failure 12
#   **skipped 63 件の名前は 2 つだけ**:  `issue-secrets` 60 PR / `docker-web` 3 PR
#   **必須 5 件が skipped だった例  0 件 / 295 件**
#     （check 57 success + 3 failure / gitleaks 60 / forbidden-patterns 60 /
#       audit 60 / pr-closes 58 success + 5 failure）
#   **つまり「必須が skipped」は実データに 1 件も無い**——赤にしても正常な PR は止まらない。
#
# **`docker-web` を SKIPPABLE_CHECKS に入れなかったのは測って決めた:**
#   **`docker-web` が skipped の PR = {1084, 1092, 1103}**
#   **`check` が failure の PR      = {1084, 1092, 1103}**   ——**3/3 で完全一致。**
#   `docker-web` は `needs: check` を持ち、**job 直下の `if:` を持たない**。
#   **skipped は「走る必要が無かった」ではなく「上流の `check` が赤くて巻き添えになった」**。
#   **緑と数えてはいけない。** かつ**この 3 件はどれも必須の `check` が赤なので、
#   この道具はもともと止まる**——入れなくても正常な PR は止まらない。

# **(1) 穴そのもの**: 必須 5 件が全部 skipped → **マージしない**
t_1069_all_required_skipped_is_red() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      echo '{"check_runs":[
        {"name":"check","status":"completed","conclusion":"skipped","started_at":"t1","details_url":"u1"},
        {"name":"gitleaks","status":"completed","conclusion":"skipped","started_at":"t1","details_url":"u2"},
        {"name":"forbidden-patterns","status":"completed","conclusion":"skipped","started_at":"t1","details_url":"u3"},
        {"name":"audit","status":"completed","conclusion":"skipped","started_at":"t1","details_url":"u4"},
        {"name":"pr-closes","status":"completed","conclusion":"skipped","started_at":"t1","details_url":"u5"}
      ]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  # **`--allow-nonrequired-red` を付けても通らない**（全部が必須なので）
  run_script "$h" merge-when-green.sh --allow-nonrequired-red 12
  assert_eq 1 "$STATUS" "必須が全部 skipped なのでマージしない"
  assert_not_contains "$LOG" "pr	merge	12" "マージを試みない"
  # **「all 5 checks green」と言わせない**——それがこの穴の見え方そのものだった
  assert_not_contains "$OUT$ERR" "all 5 checks green" "走っていないものを「全部緑」と呼ばない"
  # **5 件すべてを名指しする**（どれが走っていないのかを押す人が読める）
  local n; n=$(grep -c . <<<"$ERR" || true)
  assert_contains "$ERR" "check" "check を名指しする"
  assert_contains "$ERR" "gitleaks" "gitleaks を名指しする"
  assert_contains "$ERR" "forbidden-patterns" "forbidden-patterns を名指しする"
  assert_contains "$ERR" "audit" "audit を名指しする"
  assert_contains "$ERR" "pr-closes" "pr-closes を名指しする"
  assert_contains "$OUT$ERR" "検査 5 件 / 必須 5 件 / 赤 5 件" "母数と赤の数を出す（#757）"
  [[ "$n" -gt 0 ]] || fail "stderr が空"
}
test_case "1069: 必須が全部 skipped なら「全部緑」ではなく赤" t_1069_all_required_skipped_is_red

# **(2) 必須 1 件だけが skipped でも止まる**（全部揃わないと気づけない、では守りにならない）。
# **他の 4 件が本当に緑**なので、**`skipped` の 1 件だけが差**である。
t_1069_single_required_skipped_is_red() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      echo '{"check_runs":[
        {"name":"check","status":"completed","conclusion":"success","started_at":"t1"},
        {"name":"gitleaks","status":"completed","conclusion":"skipped","started_at":"t1","details_url":"u2"},
        {"name":"forbidden-patterns","status":"completed","conclusion":"success","started_at":"t1"},
        {"name":"audit","status":"completed","conclusion":"success","started_at":"t1"},
        {"name":"pr-closes","status":"completed","conclusion":"success","started_at":"t1"}
      ]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh --allow-nonrequired-red 12
  assert_eq 1 "$STATUS" "必須 1 件が skipped でも止まる"
  assert_contains "$ERR" "checks failed on PR #12: gitleaks" "走っていない 1 件を名指しする"
  assert_not_contains "$LOG" "pr	merge	12" "マージを試みない"
}
test_case "1069: 必須 1 件だけが skipped でも赤" t_1069_single_required_skipped_is_red

# **(3) 正常系——これが無いとこの道具は使えない**（PBI が名指しで要求した確認）。
# **実測した本物の顔ぶれ**（PR #1108 の HEAD `c91202fe`、2026-09-28）をそのまま置く:
#   skipped  issue-secrets
#   success  audit / check / docker-web / forbidden-patterns / gitleaks / pr-closes / stale-base
# **`issue-secrets` は直近 60 PR の 60 件すべてに skipped で出る**ので、
# **ここが赤くなるとこの道具は全 PR で使えなくなる。** **マージできることを固定する。**
t_1069_legitimate_skip_still_merges() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      echo '{"check_runs":[
        {"name":"issue-secrets","status":"completed","conclusion":"skipped","started_at":"t1"},
        {"name":"audit","status":"completed","conclusion":"success","started_at":"t1"},
        {"name":"check","status":"completed","conclusion":"success","started_at":"t1"},
        {"name":"docker-web","status":"completed","conclusion":"success","started_at":"t1"},
        {"name":"forbidden-patterns","status":"completed","conclusion":"success","started_at":"t1"},
        {"name":"gitleaks","status":"completed","conclusion":"success","started_at":"t1"},
        {"name":"pr-closes","status":"completed","conclusion":"success","started_at":"t1"},
        {"name":"stale-base","status":"completed","conclusion":"success","started_at":"t1"}
      ]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  # **フラグ無しでマージできること**（`--allow-nonrequired-red` が要るようでは使えない）
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "正当な skip を含む実物の顔ぶれでマージできる: $ERR"
  assert_contains "$LOG" "pr	merge	12	--squash	--delete-branch" "マージした"
  assert_contains "$OUT$ERR" "all 8 checks green" "8 件を緑として数える"
}
test_case "1069: 正当な skip（issue-secrets）の実物の顔ぶれはマージできる" t_1069_legitimate_skip_still_merges

# **(4) `docker-web` の skipped は緑にしない**（SKIPPABLE_CHECKS を広げすぎない側の固定）。
# **実測で `docker-web` の skipped は `check` が赤いときだけ起きる**（3/3）。
# ここでは**その巻き添えの形をそのまま置く**——`check` が failure で `docker-web` が skipped。
# **`check` が必須なのでどのみち止まるが、`docker-web` も赤として数える**ことを見る。
t_1069_docker_web_skip_not_green() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      echo '{"check_runs":[
        {"name":"check","status":"completed","conclusion":"failure","started_at":"t1","details_url":"u1"},
        {"name":"docker-web","status":"completed","conclusion":"skipped","started_at":"t1","details_url":"u2"},
        {"name":"issue-secrets","status":"completed","conclusion":"skipped","started_at":"t1"},
        {"name":"gitleaks","status":"completed","conclusion":"success","started_at":"t1"},
        {"name":"forbidden-patterns","status":"completed","conclusion":"success","started_at":"t1"},
        {"name":"audit","status":"completed","conclusion":"success","started_at":"t1"},
        {"name":"pr-closes","status":"completed","conclusion":"success","started_at":"t1"}
      ]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh --allow-nonrequired-red 12
  assert_eq 1 "$STATUS" "必須の check が赤なので止まる"
  assert_contains "$ERR" "checks failed on PR #12: check" "必須の赤を名指しする"
  # **`docker-web` は「必須でない赤」として数える**（緑に混ぜない）
  assert_contains "$ERR" "docker-web" "巻き添えの skipped も赤として出す"
  # **`issue-secrets` は赤に入らない**（正当な skip なので緑のまま）
  # **必須は 6 件**（5 件ではない）。**`issue-secrets` は REQUIRED_CHECKS にも
  # NONREQUIRED_CHECKS にも無いので、`is_required_check` の fail-closed で必須に数えられる**
  # ——**これは #1069 の前からそうで、この PR は変えていない**（`--allow-nonrequired-red` の
  # 扱いに関わるので、**測った値をそのまま書く**。予想は 5 件で、外れた）。
  # **害は無い**（緑を赤にする向きなので、誤ってマージする側には倒れない）が、
  # **毎 PR で「知らない検査があります」と鳴る**。**#1069 の範囲外なので触らない。**
  assert_contains "$OUT$ERR" "検査 7 件 / 必須 6 件 / 赤 2 件" "issue-secrets は赤に数えない（赤は check と docker-web の 2 件）"
  assert_not_contains "$LOG" "pr	merge	12" "マージを試みない"
}
test_case "1069: docker-web の skipped は緑にしない（上流の赤の巻き添え）" t_1069_docker_web_skip_not_green

# **(5) 知らない名前の skipped は赤**（fail-closed）。
# **新しい job が `skipped` で現れたとき、黙って緑に数えられるより止まったほうがよい。**
# **`SKIPPABLE_CHECKS` を「知らない名前も通す」形に緩める変異を殺す。**
t_1069_unknown_skip_is_red() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json state,"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*)
      echo '{"check_runs":[
        {"name":"check","status":"completed","conclusion":"success","started_at":"t1"},
        {"name":"gitleaks","status":"completed","conclusion":"success","started_at":"t1"},
        {"name":"forbidden-patterns","status":"completed","conclusion":"success","started_at":"t1"},
        {"name":"audit","status":"completed","conclusion":"success","started_at":"t1"},
        {"name":"pr-closes","status":"completed","conclusion":"success","started_at":"t1"},
        {"name":"brand-new-job","status":"completed","conclusion":"skipped","started_at":"t1","details_url":"u9"}
      ]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh --allow-nonrequired-red 12
  assert_eq 1 "$STATUS" "知らない名前の skipped は赤（fail-closed）"
  assert_contains "$ERR" "brand-new-job" "知らない名前を名指しする"
  assert_not_contains "$LOG" "pr	merge	12" "マージを試みない"
}
test_case "1069: 知らない名前の skipped は赤（fail-closed）" t_1069_unknown_skip_is_red

# **(6) `SKIPPABLE_CHECKS` の中身を固定する**（#484/#499: allowlist は名指しし、中身も固定する）。
# **痩せても増えても落ちる。** **増える側を止めるのが要点**——`skipped` を緑と数える名前が
# 黙って増えると、この PR で塞いだ穴がそのまま開き直る。
t_1069_skippable_list_is_pinned() {
  local list
  list=$(grep -E '^SKIPPABLE_CHECKS=\(' "$(dirname "${BASH_SOURCE[0]}")/../merge-when-green.sh")
  assert_eq 'SKIPPABLE_CHECKS=(issue-secrets)' "$list" "skipped を緑と数える名前の一覧"
}
test_case "1069: SKIPPABLE_CHECKS の中身が固定されている" t_1069_skippable_list_is_pinned

# --- 枝のコミットの身元（#1101）---------------------------------------------------------------
# **2026-09-28、#1064 の枝の 3 コミットが `219112946+seiji-kiroku-dev@…` で author されていた。**
# **`219112946` は `github.com/MLehnus`（無関係の実在の個人）の ID である。**
# **squash merge が author から `Co-authored-by` を合成し、その人が Contributors に出た。**
# **PO はマージ前に枝の author を見ていなかった。**
#
# **`--jq` は本物の jq が評価する**ので、ここの JSON は本物の API と同じ形で書く。
MWG_BAD_COMMITS='[{"parents":[{"sha":"p1"}],"commit":{"author":{"email":"219112946+seiji-kiroku-dev@users.noreply.github.com"},"committer":{"email":"219112946+seiji-kiroku-dev@users.noreply.github.com"}}}]'

t_merge_refuses_wrong_numeric_id() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/pulls/12/commits"*) echo '$MWG_BAD_COMMITS' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "exit status"
  assert_contains "$ERR" "219112946+seiji-kiroku-dev@users.noreply.github.com" "見つかったアドレスを名指しする"
  assert_contains "$ERR" "Contributors" "何が起きるかを書く"
  assert_not_contains "$LOG" "pr	merge	12" "マージしない"
}
test_case "merge: 枝が他人の数字 ID で author されていたらマージしない (#1101)" t_merge_refuses_wrong_numeric_id

# **形は正しいので、#1043 / #1075 の正規表現（`/^\d+\+[^@]+@users\.noreply\.github\.com$/`）は
# 2 つとも通す。** **逐語 allowlist だけが落とせる**——**その差をここで固定する。**
t_merge_refuses_any_unverified_numeric_id() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    # **形としては完全に正しい**（数字 + `+` + login + GitHub の noreply ドメイン）。
    "api repos/uonoko1/giinrecord/pulls/12/commits"*) echo '[{"parents":[{"sha":"p1"}],"commit":{"author":{"email":"120390191+uonoko1@users.noreply.github.com"},"committer":{"email":"120390191+uonoko1@users.noreply.github.com"}}}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "exit status"
  assert_contains "$ERR" "120390191+uonoko1" "1 桁違いでも落とす（形では区別できない）"
  assert_not_contains "$LOG" "pr	merge	12" "マージしない"
}
test_case "merge: 形が正しくても本人確認していない数字 ID なら止める (#1101)" t_merge_refuses_any_unverified_numeric_id

# **読めなかったことを「きれい」と読まない**（#757）。**母数 0 で緑にしない。**
t_merge_refuses_when_commits_unreadable() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/pulls/12/commits"*) echo "HTTP 503" >&2; exit 1 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 1 "$STATUS" "exit status"
  assert_contains "$ERR" "身元がきれい" "読めなかったことを「きれい」と読まないと書く"
  assert_not_contains "$LOG" "pr	merge	12" "マージしない"
}
test_case "merge: 枝のコミットを読めなければマージしない（母数 0 を緑にしない, #1101）" t_merge_refuses_when_commits_unreadable

# **bot のコミット（データ更新 PR）は通らなければならない**——**偽陽性が出ると、
# データ更新が毎回止まる。**
t_merge_allows_bot_identity() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    "api repos/uonoko1/giinrecord/pulls/12/commits"*) echo '[{"parents":[{"sha":"p1"}],"commit":{"author":{"email":"41898282+github-actions[bot]@users.noreply.github.com"},"committer":{"email":"41898282+github-actions[bot]@users.noreply.github.com"}}}]' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_contains "$LOG" "pr	merge	12" "bot の identity はマージできる"
}
test_case "merge: github-actions[bot] の identity は通る（偽陽性を出さない, #1101）" t_merge_allows_bot_identity

# **マージコミットは対象外**（`--no-merges` 相当の `select((.parents|length) < 2)`）。
# **理由は #1075 が測ってある**: **本人が手元で `git merge main` するたびに赤くなり、
# 8 件中 5 件が落ちる。** **squash merge が trailer を合成する元は squash 対象のコミットなので、
# 実害の経路は対象内に残る。**
t_merge_ignores_merge_commits() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr view 12 --json"*) echo '{"state":"OPEN","isDraft":false,"headRefName":"feat/x","mergeStateStatus":"CLEAN","url":"u","headRefOid":"oid1"}' ;;
    # 親が 2 つ = 手元で `git merge main` したマージコミット。本人の個人アドレスが author。
    "api repos/uonoko1/giinrecord/pulls/12/commits"*) echo '[{"parents":[{"sha":"p1"},{"sha":"p2"}],"commit":{"author":{"email":"someone@example.com"},"committer":{"email":"someone@example.com"}}},{"parents":[{"sha":"p1"}],"commit":{"author":{"email":"120390190+uonoko1@users.noreply.github.com"},"committer":{"email":"120390190+uonoko1@users.noreply.github.com"}}}]' ;;
    "api repos/uonoko1/giinrecord/commits/"*"/check-runs"*) echo '{"check_runs":[{"name":"check","status":"completed","conclusion":"success","started_at":"t1"}]}' ;;
    "pr merge 12 --squash --delete-branch") echo merged ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" merge-when-green.sh 12
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_contains "$LOG" "pr	merge	12" "マージコミットの author では止めない"
}
test_case "merge: マージコミットの author は見ない（偽陽性, #1101）" t_merge_ignores_merge_commits

# **逐語の綴りは、このスクリプトと `packages/etl/test/commit-identity-allowlist.test.ts` の
# 2 か所に在る**（TypeScript と bash で共有できない）。**ずれたら気づけるように固定する。**
t_merge_allowlist_is_verbatim() {
  local src
  src=$(cat "$PO_DIR/merge-when-green.sh")
  assert_contains "$src" '"120390190+uonoko1@users.noreply.github.com"' "本人の逐語アドレスを持っている"
  assert_contains "$src" '"41898282+github-actions[bot]@users.noreply.github.com"' "bot の逐語アドレスを持っている"
  # **形の正規表現に退化していないこと**（それだと #1101 が素通りする）。
  assert_not_contains "$src" '\d+\+[^@]+@users' "逐語 allowlist が形の要求に退化している"
}
test_case "merge: identity の allowlist が逐語で書かれている (#1101)" t_merge_allowlist_is_verbatim

# **逐語の綴りは 2 か所に在る**（bash と TypeScript。言語が違うので共有できない）。
# **初版はこの 2 つが「部分集合か」しか見ておらず、片方にだけアドレスを足すと素通りした**
# ——**PR の「自信が無い点」に自分で書いた穴を、レビューが実測で確かめた:**
#
# ```
# 尤もらしい ID を bash 側だけに足す   → shell 56 passed / 0 failed  （素通り）
# 同じものを TypeScript 側だけに足す   → TS   4 pass / 0 fail        （素通り）
# ```
#
# **「片方に足す」は、まさに誤帰属が入る形である**（#1101 は「誰かが身元を増やした」事故だった）。
# **だから部分集合ではなく、両方向の一致を要求する**——**集合として同じであることを見る。**
t_merge_allowlist_matches_typescript() {
  local sh_list ts_list ts_file
  ts_file="$PO_DIR/../../packages/etl/test/commit-identity-allowlist.test.ts"
  [[ -f "$ts_file" ]] || { fail "TypeScript 側の allowlist が見つからない: $ts_file"; return; }
  # **どちらも「逐語のアドレスだけを 1 行 1 個で」取り出して、並べ替えて比べる。**
  # **拾う場所を間違えると空同士で一致してしまう**ので、下で母数を見る。
  # **`|| true` が要る**: **`grep` は 0 件のとき終了コード 1 を返す**ので、
  # **`set -e` の下では代入そのものでランナーが落ちる**（落ちると残りのテストが走らない＝
  # **「赤」ではなく「無言で消える」**）。**実測で踏んだ**（抽出を空にする変異を当てたとき）。
  sh_list=$(sed -n '/^ALLOWED_IDENTITIES=(/,/^)/p' "$PO_DIR/merge-when-green.sh" \
    | grep -oE '[][A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+' | sort -u || true)
  ts_list=$(sed -n '/^export const ALLOWED_IDENTITIES/,/^];/p' "$ts_file" \
    | grep -oE '[][A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+' | sort -u || true)
  # **母数**（#757）: **空同士が一致して緑になるのを防ぐ。**
  # **実際に踏んだ**: **初版の文字クラス `[A-Za-z0-9._%+[]-]` は `[` が class を閉じてしまい、
  # 両側とも 0 件になって「空 == 空」で緑になるところだった**——**この 2 行が止めた。**
  # **`grep -c` は 0 件のとき終了コード 1 を返す**ので、`set -e` の下では
  # **`|| true` を付けないとランナーごと落ちる**（落ちると残りのテストが走らない）。
  local sh_n ts_n
  sh_n=$(grep -c . <<<"$sh_list" || true)
  ts_n=$(grep -c . <<<"$ts_list" || true)
  assert_eq 2 "$sh_n" "bash 側から取れた件数（0 なら抽出が壊れている）"
  assert_eq 2 "$ts_n" "TypeScript 側から取れた件数（0 なら抽出が壊れている）"
  assert_eq "$sh_list" "$ts_list" "2 か所の allowlist がずれている（片方にだけ身元が足された）"
}
test_case "merge: identity の allowlist が 2 か所で完全に一致する (#1101)" t_merge_allowlist_matches_typescript
