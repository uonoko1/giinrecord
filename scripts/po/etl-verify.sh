#!/usr/bin/env bash
# etl-verify.sh
#   Prints the three facts of docs/ops/etl.md's PO checklist: the latest ETL (daily) run,
#   the latest data/refresh PR, and the latest "Deploy data" run (deploy-data.yml, #127). Read-only.
#   Exit 0 only when ETL = success, data PR is MERGED (or there is none), Deploy = success.
# Env: PO_REPO (owner/name override).
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DATA_BRANCH="data/refresh"
REPO=$(po_repo)

# latest_run <workflow file> → "status<TAB>conclusion<TAB>createdAt<TAB>url" or empty
latest_run() {
  gh run list --workflow "$1" --limit 1 --repo "$REPO" --json status,conclusion,createdAt,url \
    -q '.[0] | select(. != null) | [.status, (.conclusion | if . == null or . == "" then "-" else . end), .createdAt, .url] | @tsv'
}

# Empty JSON fields become "-" above: `read` with IFS=tab collapses consecutive tabs, so an
# empty column would shift every later column (seen live with an in_progress run).
ETL=$(latest_run etl.yml)
DEPLOY=$(latest_run deploy-data.yml)
DATA_PR=$(gh pr list --head "$DATA_BRANCH" --state all --limit 1 --repo "$REPO" --json number,state,mergedAt,url \
  -q '.[0] | select(. != null) | [.number, .state, (.mergedAt | if . == null or . == "" then "-" else . end), .url] | @tsv')

# describe_run <tsv> → one human line (facts only)
describe_run() {
  local status conclusion created url
  if [[ -z "$1" ]]; then echo "(no run)"; return; fi
  IFS=$'\t' read -r status conclusion created url <<<"$1"
  if [[ "$status" == "completed" ]]; then echo "$conclusion  $created  $url"; else echo "$status  $created  $url"; fi
}
# run_ok <tsv> → 0 when the run concluded with success
run_ok() { [[ -n "$1" ]] && [[ "$(cut -f2 <<<"$1")" == "success" ]]; }

ETL_LINE=$(describe_run "$ETL");       ETL_OK=0;    run_ok "$ETL" && ETL_OK=1
DEPLOY_LINE=$(describe_run "$DEPLOY"); DEPLOY_OK=0; run_ok "$DEPLOY" && DEPLOY_OK=1

if [[ -z "$DATA_PR" ]]; then
  PR_LINE="なし（data/refresh の PR が無い）"; PR_OK=1
else
  IFS=$'\t' read -r number state merged_at url <<<"$DATA_PR"
  PR_LINE="#$number  $state  $merged_at  $url"
  [[ "$state" == "MERGED" ]] && PR_OK=1 || PR_OK=0
fi

printf '%-10s %s\n' "ETL"     "$ETL_LINE"
printf '%-10s %s\n' "data PR" "$PR_LINE"
printf '%-10s %s\n' "Deploy"  "$DEPLOY_LINE"

if [[ $ETL_OK == 1 && $PR_OK == 1 && $DEPLOY_OK == 1 ]]; then echo "all good"; exit 0; fi
echo "needs attention (see docs/ops/etl.md 失敗モード)"
exit 1
