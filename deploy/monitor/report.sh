#!/usr/bin/env bash
# Turn one check result into GitHub Issue state, with gh (Issue #135; used by run.sh in monitor.yml).
#   report.sh <title> fail <body-file>   open an Issue "<title>" (label monitor) unless one with exactly that title is open
#   report.sh <title> ok                 if an Issue "<title>" is open: comment "recovered" and close it
# The title is the identity (one Issue per environment × check), so a flapping check never piles up Issues.
# gh needs GH_TOKEN with issues:write (the workflow's GITHUB_TOKEN) and runs inside the checkout (repo inferred).
#   Tests: deploy/test/monitor-probe.test.sh (gh is a stub)
set -euo pipefail

TITLE=${1:-}; STATUS=${2:-}; BODY=${3:-}
case "$STATUS" in
  fail) [ -n "$TITLE" ] && [ -f "$BODY" ] || { echo "usage: report.sh <title> fail <body-file>" >&2; exit 2; } ;;
  ok)   [ -n "$TITLE" ] || { echo "usage: report.sh <title> ok" >&2; exit 2; } ;;
  *)    echo "usage: report.sh <title> ok|fail [body-file]" >&2; exit 2 ;;
esac
LABEL=${MONITOR_LABEL:-monitor}

# number of the open issue with exactly this title (the search is a substring match, so filter again)
export TITLE   # read by the --jq filter below
open_number() {
  # shellcheck disable=SC2016  # $ENV.TITLE is jq syntax, expanded by gh, not by the shell
  gh issue list --label "$LABEL" --state open --limit 100 --search "\"$TITLE\" in:title" \
    --json number,title --jq 'map(select(.title == $ENV.TITLE)) | .[0].number // empty'
}

NUM=$(open_number)
case "$STATUS" in
  fail)
    if [ -n "$NUM" ]; then
      echo "report: #$NUM already open for '$TITLE'"
    else
      # --force: create or update; keeps the label present without a separate "does it exist" call
      gh label create "$LABEL" --force --color D93F0B --description "opened and closed automatically by the monitoring (docs/ops/monitoring.md)" >/dev/null
      gh issue create --title "$TITLE" --label "$LABEL" --body-file "$BODY"
    fi ;;
  ok)
    if [ -n "$NUM" ]; then
      gh issue comment "$NUM" --body "Recovered: the check passed again at $(date -u +%Y-%m-%dT%H:%M:%SZ)."
      gh issue close "$NUM" --reason completed
      echo "report: closed #$NUM for '$TITLE'"
    fi ;;
esac
