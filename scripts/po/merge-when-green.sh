#!/usr/bin/env bash
# merge-when-green.sh <pr>
#   1. refuse unless the PR is OPEN and not a draft
#   2. `gh pr update-branch` when it is BEHIND main
#   3. poll `gh pr checks` until every check is pass/skipping (fail/cancel → abort)
#      while waiting on data/refresh only: approve `action_required` workflow runs
#   4. `gh pr merge --squash --delete-branch`
# Env: POLL_INTERVAL (s, default 20), POLL_MAX (default 60), PO_REPO (owner/name override).
# Only destructive operation: the squash merge (+ head branch deletion) of the given PR.
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
if [[ "$MERGE_STATE" == "BEHIND" ]]; then
  log "branch is behind main → gh pr update-branch"
  gh pr update-branch "$PR"
fi

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
    log "all $total checks green"
    break
  fi
  if [[ "$total" -eq 0 ]]; then log "[$i/$POLL_MAX] no checks reported yet"; else log "[$i/$POLL_MAX] pending: $(tr '\n' ' ' <<<"$pending")"; fi
  if [[ "$HEAD" == "$DATA_BRANCH" ]]; then approve_pending_runs; fi
  if [[ "$i" -ge "$POLL_MAX" ]]; then
    die "timed out after $POLL_MAX polls waiting for checks on PR #$PR"
  fi
  sleep "$POLL_INTERVAL"
done

# --- 4. merge ---------------------------------------------------------------------------------
log "squash-merging PR #$PR and deleting $HEAD"
gh pr merge "$PR" --squash --delete-branch
echo "merged PR #$PR ($HEAD) $URL"
