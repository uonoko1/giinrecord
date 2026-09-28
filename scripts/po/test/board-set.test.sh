# shellcheck shell=bash
# **Do not run this file directly** (#1124). It is sourced by scripts/po/test/run.sh, which
# defines test_case / assert_* / run_script. Running it with `bash` used to print 200 lines of
# `test_case: command not found` and then **exit 0** — an error that looked like a pass.
[[ -n ${PO_TEST_RUN_SH:-} ]] || {
  echo "$(basename "${BASH_SOURCE[0]}"): このファイルは単体では走りません（run.sh が source します）。" >&2
  echo "  bash scripts/po/test/run.sh                       # 全部" >&2
  echo "  bash scripts/po/test/run.sh ${BASH_SOURCE[0]##*/} # このファイルだけ" >&2
  exit 2
}
# Tests for scripts/po/board-set.sh (sourced by run.sh)

t_board_usage() {
  local h; h=$(handler <<'EOF'
handle() { echo "should not be called" >&2; exit 99; }
EOF
)
  run_script "$h" board-set.sh 70
  assert_eq 2 "$STATUS" "missing status → usage"
  run_script "$h" board-set.sh 70 "Doing"
  assert_eq 2 "$STATUS" "unknown status → usage"
  assert_contains "$ERR" "In Progress" "lists valid statuses"
  run_script "$h" board-set.sh x "Done"
  assert_eq 2 "$STATUS" "non-numeric issue → usage"
  assert_eq "" "$LOG" "gh never called"
}
test_case "board: usage errors before any gh call" t_board_usage

# Fixtures mirror the GraphQL shapes board-set.sh queries; an item on another project must be ignored.
t_board_updates_existing_item() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    *projectItems*) echo '{"data":{"repository":{"issue":{"id":"I_kwDOissue70","projectItems":{"nodes":[{"id":"PVTI_item70","project":{"id":"PVT_kwHOBy0CLs4BhHqj"}},{"id":"PVTI_other","project":{"id":"PVT_other"}}]}}}}}' ;;
    *updateProjectV2ItemFieldValue*) echo '{"data":{"updateProjectV2ItemFieldValue":{"projectV2Item":{"id":"PVTI_item70"}}}}' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" board-set.sh 70 "In Review"
  assert_eq 0 "$STATUS" "exit status: $ERR"
  local update; update=$(grep updateProjectV2ItemFieldValue <<<"$LOG")
  assert_contains "$update" "projectId=PVT_kwHOBy0CLs4BhHqj" "project id"
  assert_contains "$update" "itemId=PVTI_item70" "item id"
  assert_contains "$update" "fieldId=PVTSSF_lAHOBy0CLs4BhHqjzhgEpXs" "Status field id"
  assert_contains "$update" "optionId=9e9b8e0c" "In Review option id"
  assert_not_contains "$LOG" "addProjectV2ItemById" "does not re-add"
  assert_contains "$OUT" "#70" "prints issue"
  assert_contains "$OUT" "In Review" "prints status"
}
test_case "board: issue already on the board → only the Status field is updated" t_board_updates_existing_item

t_board_adds_missing_item() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    *projectItems*) echo '{"data":{"repository":{"issue":{"id":"I_kwDOissue71","projectItems":{"nodes":[{"id":"PVTI_other","project":{"id":"PVT_other"}}]}}}}}' ;;
    *addProjectV2ItemById*) echo '{"data":{"addProjectV2ItemById":{"item":{"id":"PVTI_new71"}}}}' ;;
    *updateProjectV2ItemFieldValue*) echo '{}' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" board-set.sh 71 Backlog
  assert_eq 0 "$STATUS" "exit status: $ERR"
  local add; add=$(grep addProjectV2ItemById <<<"$LOG")
  assert_contains "$add" "contentId=I_kwDOissue71" "adds by issue node id"
  local update; update=$(grep updateProjectV2ItemFieldValue <<<"$LOG")
  assert_contains "$update" "itemId=PVTI_new71" "uses the new item id"
  assert_contains "$update" "optionId=569dcc89" "Backlog option id"
}
test_case "board: issue not on the board → added, then Status set" t_board_adds_missing_item

t_board_option_ids() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    *projectItems*) echo '{"data":{"repository":{"issue":{"id":"I_1","projectItems":{"nodes":[{"id":"PVTI_1","project":{"id":"PVT_kwHOBy0CLs4BhHqj"}},{"id":"PVTI_other","project":{"id":"PVT_other"}}]}}}}}' ;;
    *updateProjectV2ItemFieldValue*) echo '{}' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  local s id
  for s in "Ready:d2186140" "In Progress:5b5c55b5" "Done:e92e5038"; do
    id=${s##*:}
    run_script "$h" board-set.sh 1 "${s%%:*}"
    assert_eq 0 "$STATUS" "${s%%:*}: exit status: $ERR"
    assert_contains "$LOG" "optionId=$id" "${s%%:*} → $id"
  done
}
test_case "board: every status maps to its option id" t_board_option_ids

t_board_lookup_failure() {
  local h; h=$(handler <<'EOF'
handle() { echo "gh: Could not resolve to an Issue" >&2; exit 1; }
EOF
)
  run_script "$h" board-set.sh 9999 Done
  assert_eq 1 "$STATUS" "exit status"
  assert_not_contains "$LOG" "updateProjectV2ItemFieldValue" "no update after failed lookup"
}
test_case "board: failed lookup stops before any mutation" t_board_lookup_failure
