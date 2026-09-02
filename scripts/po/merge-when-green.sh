#!/usr/bin/env bash
# merge-when-green.sh <pr>
#   1. refuse unless the PR is OPEN and not a draft
#   2. `gh pr update-branch` when it is BEHIND main
#      if that is refused because the gh OAuth token lacks the `workflow` scope (the PR touches
#      .github/workflows/*), fall back to merging origin/main into the PR head in a temporary
#      worktree and pushing over SSH (#200); a merge conflict aborts with nothing pushed
#   3. poll `gh pr checks` until every check is pass/skipping (fail/cancel → abort)
#      main may move while we wait (another PR merged → BEHIND, strict status checks block the
#      merge): every poll re-checks mergeStateStatus and runs update-branch again (#89, like etl.yml)
#      while waiting on data/refresh only: approve `action_required` workflow runs
#   4. `gh pr merge --squash --delete-branch`
# Env: POLL_INTERVAL (s, default 20), POLL_MAX (default 60), PO_REPO (owner/name override).
# Destructive operations: the squash merge (+ head branch deletion) of the given PR, and — only
# in the workflow-scope fallback — a merge commit of origin/main pushed to the PR head branch.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DATA_BRANCH="data/refresh"

if [[ $# -ne 1 ]] || ! is_int "$1"; then usage "merge-when-green.sh <pr-number>"; fi
PR=$1
REPO=$(po_repo)

# --- 1. state ---------------------------------------------------------------------------------
IFS=$'\t' read -r STATE DRAFT HEAD MERGE_STATE URL < <(
  gh pr view "$PR" --json state,isDraft,headRefName,mergeStateStatus,url \
    -q '[.state, (.isDraft|tostring), .headRefName, .mergeStateStatus, .url] | @tsv'
)
log "PR #$PR ($HEAD) state=$STATE draft=$DRAFT mergeState=$MERGE_STATE $URL"
[[ "$STATE" == "OPEN" ]] || die "PR #$PR is $STATE, not OPEN"
[[ "$DRAFT" == "false" ]] || die "PR #$PR is a draft; mark it ready for review first"

# --- 2. bring up to date ----------------------------------------------------------------------
# merge_main_locally — fallback for `gh pr update-branch` being refused because the gh OAuth
# token lacks the `workflow` scope (the PR touches .github/workflows/*, #200). Merges
# origin/main into the PR head in a temporary worktree and pushes it over SSH (SSH keys are not
# limited by OAuth scopes). A merge conflict aborts cleanly: nothing is pushed, the worktree is
# removed, and the script exits with a message; other failures are logged, not fatal.
merge_main_locally() {
  local root tmp wt
  root=$(git rev-parse --show-toplevel 2>/dev/null) \
    || { log "not inside a git checkout; update PR #$PR manually"; return 0; }
  log "update-branch refused (workflow scope) → merging origin/main locally and pushing via SSH"
  git -C "$root" fetch origin \
      "+refs/heads/main:refs/remotes/origin/main" "+refs/heads/$HEAD:refs/remotes/origin/$HEAD" \
    || { log "git fetch failed; update PR #$PR manually"; return 0; }
  tmp=$(mktemp -d)
  wt="$tmp/wt"
  if ! git -C "$root" worktree add --detach "$wt" "origin/$HEAD"; then
    rm -rf "$tmp"
    log "could not create a temporary worktree; update PR #$PR manually"
    return 0
  fi
  if ! git -C "$wt" merge --no-edit origin/main; then
    git -C "$wt" merge --abort || true
    git -C "$root" worktree remove --force "$wt" || true
    rm -rf "$tmp"
    die "origin/main conflicts with $HEAD — resolve the conflict manually (nothing was pushed)"
  fi
  git -C "$wt" push "git@github.com:$REPO.git" "HEAD:refs/heads/$HEAD" \
    || log "SSH push of the merged $HEAD failed — push it manually"
  git -C "$root" worktree remove --force "$wt" || true
  rm -rf "$tmp"
}

# update_if_behind [state] → 0 when an update was attempted (checks will re-run), 1 otherwise.
# A failed update is logged, not fatal: the merge step then surfaces the real blocker. The one
# exception is the workflow-scope refusal, which is handled by merge_main_locally (see above).
update_if_behind() {
  local state=${1:-} err
  [[ -n "$state" ]] || state=$(gh pr view "$PR" --json mergeStateStatus -q .mergeStateStatus)
  [[ "$state" == "BEHIND" ]] || return 1
  log "branch is behind main → gh pr update-branch"
  if ! err=$(gh pr update-branch "$PR" 2>&1); then
    [[ -n "$err" ]] && printf '%s\n' "$err" >&2
    if [[ "$err" == *workflow*scope* ]]; then
      merge_main_locally
    else
      log "could not update branch (conflicts? update it manually)"
    fi
  fi
  return 0
}
update_if_behind "$MERGE_STATE" || true

# --- 3. poll checks ---------------------------------------------------------------------------
approve_pending_runs() {
  local run
  # `gh api -q` prints nothing for an empty list; each approval is best-effort (permissions).
  for run in $(gh api "repos/$REPO/actions/runs?branch=$DATA_BRANCH&status=action_required" -q '.workflow_runs[].id'); do
    log "approving action_required run $run"
    gh api -X POST "repos/$REPO/actions/runs/$run/approve" >/dev/null || log "could not approve run $run (approve it in the Actions UI)"
  done
}

i=0
while true; do
  i=$((i + 1))
  # exit 8 = checks pending, exit 1 = a check failed or no checks yet; output still carries the facts
  checks=$(gh pr checks "$PR" --json name,bucket -q '.[] | "\(.bucket)\t\(.name)"' || true)
  failed=$(awk -F'\t' '$1=="fail"||$1=="cancel"{print $2}' <<<"$checks")
  pending=$(awk -F'\t' '$1=="pending"{print $2}' <<<"$checks")
  total=$(grep -c . <<<"$checks" || true)
  if [[ -n "$failed" ]]; then
    die "checks failed on PR #$PR: $(tr '\n' ' ' <<<"$failed")"
  fi
  if [[ -z "$pending" && "$total" -gt 0 ]]; then
    if update_if_behind; then
      log "[$i/$POLL_MAX] checks were green on an old base; waiting for them to re-run"
    else
      log "all $total checks green"
      break
    fi
  else
    if [[ "$total" -eq 0 ]]; then log "[$i/$POLL_MAX] no checks reported yet"; else log "[$i/$POLL_MAX] pending: $(tr '\n' ' ' <<<"$pending")"; fi
    update_if_behind || true
    if [[ "$HEAD" == "$DATA_BRANCH" ]]; then approve_pending_runs; fi
  fi
  if [[ "$i" -ge "$POLL_MAX" ]]; then
    die "timed out after $POLL_MAX polls waiting for checks on PR #$PR"
  fi
  sleep "$POLL_INTERVAL"
done

# --- 4. merge ---------------------------------------------------------------------------------
# 保護は `strict: true`（main に追いついていることが必須）なので、**チェックが緑になってから
# マージするまでの間に別の PR が main に入るとその瞬間だけ古くなり**、GitHub は
# "the base branch policy prohibits the merge" で拒む（mergeStateStatus は CLEAN のまま）。
# 実際に踏んだ（#384）。1 回で諦めず、取り込み直して数回試す。
log "squash-merging PR #$PR and deleting $HEAD"
for attempt in 1 2 3; do
  if gh pr merge "$PR" --squash --delete-branch; then
    echo "merged PR #$PR ($HEAD) $URL"
    exit 0
  fi
  [[ "$attempt" == 3 ]] && die "merge refused 3 times for PR #$PR (see the message above)"
  log "merge refused (attempt $attempt/3); updating the branch and retrying"
  gh pr update-branch "$PR" >/dev/null 2>&1 || true
  sleep "$POLL_INTERVAL"
done
