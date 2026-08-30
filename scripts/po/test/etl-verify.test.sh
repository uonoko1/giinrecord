# shellcheck shell=bash
# Tests for scripts/po/etl-verify.sh (sourced by run.sh)

# The script asks for one run per workflow and the latest data/refresh PR, then prints facts.
etl_handler() {
  handler <<EOF
handle() {
  case "\$*" in
    "run list --workflow etl.yml"*) echo '[{"databaseId":1,"status":"completed","conclusion":"$1","createdAt":"2026-08-23T21:00:00Z","url":"https://github.com/uonoko1/giinrecord/actions/runs/1"}]' ;;
    "pr list --head data/refresh"*) echo '$2' ;;
    "run list --workflow deploy-data.yml"*) echo '[{"databaseId":2,"status":"completed","conclusion":"$3","createdAt":"2026-08-23T21:20:00Z","url":"https://github.com/uonoko1/giinrecord/actions/runs/2"}]' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
EOF
}

t_etl_all_good() {
  local h; h=$(etl_handler success '[{"number":80,"state":"MERGED","mergedAt":"2026-08-23T21:15:00Z","url":"https://github.com/uonoko1/giinrecord/pull/80"}]' success)
  run_script "$h" etl-verify.sh
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_contains "$OUT" "ETL" "ETL row"
  assert_contains "$OUT" "success" "ETL conclusion"
  assert_contains "$OUT" "#80" "data PR number"
  assert_contains "$OUT" "MERGED" "data PR state"
  assert_contains "$OUT" "actions/runs/2" "deploy run url"
  assert_contains "$OUT" "actions/runs/1" "etl run url"
}
test_case "etl-verify: prints ETL conclusion, data PR, Deploy and exits 0 when all succeeded" t_etl_all_good

t_etl_failed_run() {
  local h; h=$(etl_handler failure '[]' success)
  run_script "$h" etl-verify.sh
  assert_eq 1 "$STATUS" "exit status"
  assert_contains "$OUT" "failure" "shows failure"
  assert_contains "$OUT" "なし" "no data PR"
}
test_case "etl-verify: failed ETL run → exit 1, no data PR shown as なし" t_etl_failed_run

t_etl_open_pr() {
  local h; h=$(etl_handler success '[{"number":81,"state":"OPEN","mergedAt":null,"url":"u"}]' success)
  run_script "$h" etl-verify.sh
  assert_eq 1 "$STATUS" "open data PR is not done → exit 1"
  assert_contains "$OUT" "#81" "number"
  assert_contains "$OUT" "OPEN" "state"
}
test_case "etl-verify: data PR still OPEN → exit 1" t_etl_open_pr

t_etl_deploy_failed() {
  local h; h=$(etl_handler success '[{"number":80,"state":"MERGED","mergedAt":"x","url":"u"}]' failure)
  run_script "$h" etl-verify.sh
  assert_eq 1 "$STATUS" "exit status"
  assert_contains "$OUT" "failure" "deploy failure shown"
}
test_case "etl-verify: failed Deploy → exit 1" t_etl_deploy_failed

t_etl_in_progress() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "run list --workflow etl.yml"*) echo '[{"status":"in_progress","conclusion":"","createdAt":"2026-08-23T21:00:00Z","url":"https://x/runs/1"}]' ;;
    "pr list --head data/refresh"*) echo '[{"number":75,"state":"OPEN","mergedAt":null,"url":"https://x/pull/75"}]' ;;
    "run list --workflow deploy-data.yml"*) echo '[{"status":"completed","conclusion":"success","createdAt":"2026-08-22T15:46:10Z","url":"https://x/runs/2"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" etl-verify.sh
  assert_eq 1 "$STATUS" "exit status"
  assert_contains "$OUT" "ETL        in_progress  2026-08-23T21:00:00Z  https://x/runs/1" "null conclusion does not shift columns"
  assert_contains "$OUT" "data PR    #75  OPEN  -  https://x/pull/75" "null mergedAt does not shift columns"
}
test_case "etl-verify: in_progress run / unmerged PR keep their columns (null fields)" t_etl_in_progress

t_etl_no_runs() {
  local h; h=$(handler <<'EOF'
handle() { echo '[]'; }
EOF
)
  run_script "$h" etl-verify.sh
  assert_eq 1 "$STATUS" "exit status"
  assert_contains "$OUT" "(no run)" "no run placeholder"
}
test_case "etl-verify: no runs at all → placeholders, exit 1" t_etl_no_runs
