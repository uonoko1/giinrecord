#!/usr/bin/env bash
# board-set.sh <issue> <Backlog|Ready|In Progress|In Review|Done>
#   Sets the Status field of the Issue on the scrum board (GitHub Project 2). If the Issue is not
#   on the board yet it is added first. Ids come from docs/ops/board.md.
# Env: PO_REPO (owner/name override).
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PROJECT_ID="PVT_kwHOBy0CLs4BhHqj"              # 政治記録 スクラムボード (project 2)
STATUS_FIELD_ID="PVTSSF_lAHOBy0CLs4BhHqjzhgEpXs" # Status (single select)

status_option_id() {
  case "$1" in
    "Backlog")     echo 569dcc89 ;;
    "Ready")       echo d2186140 ;;
    "In Progress") echo 5b5c55b5 ;;
    "In Review")   echo 9e9b8e0c ;;
    "Done")        echo e92e5038 ;;
    *) return 1 ;;
  esac
}

USAGE="board-set.sh <issue-number> <Backlog|Ready|In Progress|In Review|Done>"
if [[ $# -ne 2 ]] || ! is_int "$1"; then usage "$USAGE"; fi
ISSUE=$1
STATUS=$2
OPTION_ID=$(status_option_id "$STATUS") || usage "$USAGE"

REPO=$(po_repo)
OWNER=${REPO%%/*}
NAME=${REPO#*/}

# --- lookup: issue node id + its item on this project (if any) --------------------------------
# shellcheck disable=SC2016  # $vars below are GraphQL variables, not shell
LOOKUP='query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    issue(number:$number){ id projectItems(first:50){ nodes{ id project{ id } } } } } }'
IFS=$'\t' read -r ISSUE_NODE_ID ITEM_ID < <(
  gh api graphql -f query="$LOOKUP" -F owner="$OWNER" -F repo="$NAME" -F number="$ISSUE" \
    -q ".data.repository.issue | [.id, ((.projectItems.nodes[] | select(.project.id==\"$PROJECT_ID\") | .id) // \"\")] | @tsv"
)
[[ -n "$ISSUE_NODE_ID" ]] || die "issue #$ISSUE not found in $REPO"

# --- add to the board when missing ------------------------------------------------------------
if [[ -z "$ITEM_ID" ]]; then
  log "#$ISSUE is not on the board → adding"
  # shellcheck disable=SC2016
  ADD='mutation($projectId:ID!,$contentId:ID!){
    addProjectV2ItemById(input:{projectId:$projectId,contentId:$contentId}){ item{ id } } }'
  ITEM_ID=$(gh api graphql -f query="$ADD" -F projectId="$PROJECT_ID" -F contentId="$ISSUE_NODE_ID" \
    -q '.data.addProjectV2ItemById.item.id')
  [[ -n "$ITEM_ID" ]] || die "could not add #$ISSUE to the board"
fi

# --- set Status -------------------------------------------------------------------------------
# shellcheck disable=SC2016
UPDATE='mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$optionId:String!){
  updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,
    value:{singleSelectOptionId:$optionId}}){ projectV2Item{ id } } }'
gh api graphql -f query="$UPDATE" -F projectId="$PROJECT_ID" -F itemId="$ITEM_ID" \
  -F fieldId="$STATUS_FIELD_ID" -F optionId="$OPTION_ID" >/dev/null
echo "#$ISSUE → $STATUS (item $ITEM_ID)"
