#!/usr/bin/env bash
# Tests for the GitHub Actions side of the monitoring (Issue #135): deploy/monitor/probe.sh (external HTTP / data
# freshness / TLS expiry checks), deploy/monitor/report.sh (Issue open/close with gh, deduplicated by title) and
# deploy/monitor/run.sh (probe twice, report only what failed twice). No network: curl, openssl, gh and sleep are
# stubs on PATH that record their arguments and answer from env.
#   bash deploy/test/monitor-probe.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MON="$HERE/../monitor"
PASS=0; FAIL=0

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"; mkdir -p "$BIN"
for cmd in curl openssl gh sleep; do
  cat > "$BIN/$cmd" <<STUB
#!/usr/bin/env bash
echo "$cmd \$*" >> "\$STUB_LOG"
"\$STUB_HANDLER" "$cmd" "\$@"
STUB
  chmod +x "$BIN/$cmd"
done

# Handler: a healthy site unless H_* says otherwise.
#   H_CODE_<path-ish>  HTTP status for / (H_CODE_ROOT), /members/ (H_CODE_MEMBERS), /data/meta.json (H_CODE_META)
#   H_TITLE            <title> text of the HTML pages;  H_FETCHED_AT  meta.fetchedAt;  H_NOT_AFTER  certificate notAfter
#   H_OPEN             JSON array gh returns for the open-issue search;  H_CURL_EXIT  make curl fail outright
cat > "$TMP/handler" <<'H'
#!/usr/bin/env bash
cmd=$1; shift
case "$cmd" in
  curl)
    [ -n "${H_CURL_EXIT:-}" ] && exit "$H_CURL_EXIT"
    url=${*: -1}; out=/dev/stdout
    for ((i=1;i<=$#;i++)); do [[ "${!i}" == "-o" ]] && { j=$((i+1)); out=${!j}; }; done
    case "$url" in
      */data/meta.json) printf '{\n "fetchedAt": "%s",\n "sources": [{"fetchedAt": "2020-01-01T00:00:00Z"}]\n}\n' "${H_FETCHED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}" > "$out"; printf '%s' "${H_CODE_META:-200}" ;;
      */members/)       printf '<html><head><title>議員一覧 | %s</title></head></html>' "${H_TITLE:-議会ログ}" > "$out"; printf '%s' "${H_CODE_MEMBERS:-200}" ;;
      */)               printf '<html><head><title>%s</title></head></html>' "${H_TITLE:-議会ログ}" > "$out"; printf '%s' "${H_CODE_ROOT:-200}" ;;
      *) echo "unexpected url $url" >&2; exit 1 ;;
    esac ;;
  openssl)
    # s_client … | openssl x509 -noout -enddate
    if [[ "$1" == x509 ]]; then echo "notAfter=${H_NOT_AFTER-$(LC_ALL=C date -u -d '+60 days' '+%b %d %H:%M:%S %Y GMT')}"; fi ;;
  gh)
    case "$1 $2" in
      "issue list")   echo "${H_OPEN:-[]}" ;;
      "issue create") echo "https://github.com/example/repo/issues/99" ;;
      "issue close"|"issue comment"|"label create") ;;
    esac ;;
  sleep) ;;
esac
H
chmod +x "$TMP/handler"

fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_eq() { [[ "$2" == "$1" ]] || fail "$3: expected [$1] got [$2]"; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in: $1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "$3: expected NOT to contain [$2] in: $1"; }

fresh() {
  P="$TMP/$1"; mkdir -p "$P"; LOG="$P/stub.log"; : > "$LOG"
  export STUB_LOG="$LOG" STUB_HANDLER="$TMP/handler"
  unset H_CODE_ROOT H_CODE_MEMBERS H_CODE_META H_TITLE H_FETCHED_AT H_NOT_AFTER H_OPEN H_CURL_EXIT
}
run_probe()  { PATH="$BIN:$PATH" bash "$MON/probe.sh" "$@" > "$P/out" 2>&1; }
run_report() { PATH="$BIN:$PATH" bash "$MON/report.sh" "$@" > "$P/out" 2>&1; }
run_run()    { PATH="$BIN:$PATH" bash "$MON/run.sh" "$@" > "$P/out" 2>&1; }

test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

t_syntax() { for s in probe report run; do bash -n "$MON/$s.sh" || fail "bash -n $s"; done; }

# ---- probe.sh ----
t_probe_ok() {
  fresh p_ok
  run_probe https://gikailog.jp || fail "exit $? $(cat "$P/out")"
  local out; out=$(cat "$P/out")
  assert_contains "$out" "ok http" "http ok"
  assert_contains "$out" "ok data" "data ok"
  assert_contains "$out" "ok tls" "tls ok"
  assert_contains "$(cat "$LOG")" "https://gikailog.jp/members/" "members page probed"
  assert_contains "$(cat "$LOG")" "https://gikailog.jp/data/meta.json" "meta probed"
  assert_contains "$(cat "$LOG")" "-servername gikailog.jp" "TLS of the right host"
}
t_probe_http_status() {
  fresh p_http
  H_CODE_MEMBERS=502 run_probe https://gikailog.jp && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "fail http" "http fails"
  assert_contains "$(cat "$P/out")" "/members/ 502" "reason names path and status"
  assert_contains "$(cat "$P/out")" "ok tls" "tls still ok"
}
t_probe_title() {
  fresh p_title
  H_TITLE="Welcome to nginx" run_probe https://gikailog.jp && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "fail http" "wrong title fails http"
  assert_contains "$(cat "$P/out")" "title" "reason mentions title"
}
t_probe_stale_data() {
  fresh p_stale
  H_FETCHED_AT="2020-01-01T00:00:00.000Z" run_probe https://gikailog.jp && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "fail data" "stale data fails"
  assert_contains "$(cat "$P/out")" "ok http" "http still ok"
}
t_probe_data_within_window() {
  fresh p_fresh
  H_FETCHED_AT="$(date -u -d '-40 hours' +%Y-%m-%dT%H:%M:%S.000Z)" run_probe https://gikailog.jp || fail "40h old is within 48h: $(cat "$P/out")"
}
t_probe_meta_unparseable() {
  fresh p_meta
  H_FETCHED_AT="not-a-date" run_probe https://gikailog.jp && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "fail data" "unparseable fetchedAt fails data"
}
t_probe_tls_expiring() {
  fresh p_tls
  H_NOT_AFTER="$(LC_ALL=C date -u -d '+10 days' '+%b %d %H:%M:%S %Y GMT')" run_probe https://gikailog.jp && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "fail tls" "10 days left fails"
  assert_contains "$(cat "$P/out")" "days" "reason says days"
}
t_probe_tls_unreadable() {
  fresh p_tls2
  H_NOT_AFTER="" run_probe https://gikailog.jp && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "fail tls" "no notAfter fails tls"
}
t_probe_curl_down() {
  fresh p_down
  H_CURL_EXIT=7 run_probe https://gikailog.jp && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "fail http" "connection failure is http fail"
  assert_contains "$(cat "$P/out")" "fail data" "…and data cannot be checked"
}
t_probe_rejects_bad_origin() {
  fresh p_origin
  run_probe "http://gikailog.jp" && fail "http origin refused"
  run_probe "https://gikailog.jp/path" && fail "origin with path refused"
  run_probe && fail "missing origin refused"
}

# ---- report.sh ----
t_report_creates_once() {
  fresh r_new
  echo "body text" > "$P/body"
  run_report "[monitor] production: http" fail "$P/body" || fail "exit $? $(cat "$P/out")"
  local log; log=$(cat "$LOG")
  assert_contains "$log" "gh label create monitor" "label ensured"
  assert_contains "$log" "gh issue list" "open issues searched"
  assert_contains "$log" "gh issue create --title [monitor] production: http --label monitor --body-file $P/body" "created"
}
t_report_dedups() {
  fresh r_dup
  echo "body" > "$P/body"
  H_OPEN='[{"number":5,"title":"[monitor] production: http"}]' run_report "[monitor] production: http" fail "$P/body" || fail "exit $?"
  assert_not_contains "$(cat "$LOG")" "gh issue create" "no duplicate"
}
t_report_exact_title_only() {
  fresh r_exact
  echo "body" > "$P/body"
  H_OPEN='[{"number":5,"title":"[monitor] production: http (old)"}]' run_report "[monitor] production: http" fail "$P/body" || fail "exit $?"
  assert_contains "$(cat "$LOG")" "gh issue create" "similar title is not the same issue"
}
t_report_closes_on_ok() {
  fresh r_close
  H_OPEN='[{"number":5,"title":"[monitor] production: http"}]' run_report "[monitor] production: http" ok || fail "exit $?"
  local log; log=$(cat "$LOG")
  assert_contains "$log" "gh issue comment 5" "recovery comment"
  assert_contains "$log" "gh issue close 5" "closed"
  assert_not_contains "$log" "gh issue create" "nothing created"
}
t_report_ok_without_issue_is_noop() {
  fresh r_noop
  run_report "[monitor] production: http" ok || fail "exit $?"
  assert_not_contains "$(cat "$LOG")" "gh issue close" "nothing to close"
  assert_not_contains "$(cat "$LOG")" "gh label create" "label not touched on a quiet run"
}

# ---- run.sh ----
t_run_all_ok_no_retry() {
  fresh run_ok
  run_run production https://gikailog.jp || fail "exit $? $(cat "$P/out")"
  local log; log=$(cat "$LOG")
  assert_not_contains "$log" "sleep" "no second round when the first is clean"
  assert_not_contains "$log" "gh issue create" "nothing created"
  assert_contains "$log" "gh issue list" "open issues checked so recoveries close"
}
t_run_reports_after_two_rounds() {
  fresh run_fail
  H_CODE_ROOT=503 run_run production https://gikailog.jp && fail "expected non-zero"
  local log; log=$(cat "$LOG")
  assert_contains "$log" "sleep" "second round after a pause"
  assert_eq "2" "$(grep -c 'curl .*https://gikailog.jp/$' "$LOG")" "root probed twice"
  assert_contains "$log" "gh issue create --title [monitor] production: http" "http issue created"
  assert_not_contains "$log" "gh issue create --title [monitor] production: tls" "tls not created"
  assert_not_contains "$log" "gh issue create --title [monitor] production: data" "data (ok) not created"
}
t_run_body_has_no_secrets_or_paths() {
  fresh run_body
  GITHUB_SERVER_URL=https://github.com GITHUB_REPOSITORY=example/repo GITHUB_RUN_ID=123 \
    H_CODE_ROOT=503 run_run production https://gikailog.jp || true
  local bodyfile; bodyfile=$(grep -o -- '--body-file [^ ]*' "$LOG" | head -1 | cut -d' ' -f2)
  [ -n "$bodyfile" ] || { fail "no body file"; return; }
  local body; body=$(cat "$bodyfile")
  assert_contains "$body" "production" "environment named"
  assert_contains "$body" "/ 503" "reason included"
  assert_contains "$body" "https://github.com/example/repo/actions/runs/123" "run link"
  assert_not_contains "$body" "$TMP" "no local paths"
}
t_run_transient_failure_not_reported() {
  fresh run_flap
  # first round fails, second round is fine → handler flips on a marker file
  cat > "$P/flap" <<'H'
#!/usr/bin/env bash
if [[ "$1" == curl && ! -f "$FLAP_MARK" ]]; then
  url=${*: -1}; [[ "$url" == */ ]] && { touch "$FLAP_MARK"; for ((i=1;i<=$#;i++)); do [[ "${!i}" == "-o" ]] && { j=$((i+1)); : > "${!j}"; }; done; printf '503'; exit 0; }
fi
exec "$STUB_HANDLER_REAL" "$@"
H
  chmod +x "$P/flap"
  FLAP_MARK="$P/mark" STUB_HANDLER_REAL="$TMP/handler" STUB_HANDLER="$P/flap" run_run production https://gikailog.jp || fail "a one-off failure is not a failure: $(cat "$P/out")"
  assert_not_contains "$(cat "$LOG")" "gh issue create" "not reported"
}

test_case "monitor scripts: bash -n" t_syntax
test_case "probe: 正常なら http/data/tls すべて ok、/ /members/ /data/meta.json と TLS を見る" t_probe_ok
test_case "probe: /members/ が 502 なら http が fail（パスと status を理由に）" t_probe_http_status
test_case "probe: title に『議会ログ』が無ければ http が fail" t_probe_title
test_case "probe: meta.fetchedAt が 48 時間より古ければ data が fail" t_probe_stale_data
test_case "probe: fetchedAt が 40 時間前なら ok（境界内）" t_probe_data_within_window
test_case "probe: fetchedAt が日付でなければ data が fail" t_probe_meta_unparseable
test_case "probe: 証明書の残りが 14 日未満なら tls が fail" t_probe_tls_expiring
test_case "probe: 証明書が読めなければ tls が fail" t_probe_tls_unreadable
test_case "probe: 接続できなければ http と data が fail" t_probe_curl_down
test_case "probe: origin は https のホストのみ（パス付き・http・無しは拒否）" t_probe_rejects_bad_origin
test_case "report: fail → ラベル確保・検索・同名が無ければ作成" t_report_creates_once
test_case "report: 同名の open Issue があれば作らない" t_report_dedups
test_case "report: 似た title は別物（完全一致のみ）" t_report_exact_title_only
test_case "report: ok → open Issue があればコメントして close" t_report_closes_on_ok
test_case "report: ok で Issue が無ければ何もしない" t_report_ok_without_issue_is_noop
test_case "run: 全部 ok なら 2 回目を走らせず、作成もしない" t_run_all_ok_no_retry
test_case "run: 2 回連続で fail した check だけ Issue" t_run_reports_after_two_rounds
test_case "run: Issue 本文は環境名・理由・run へのリンクのみ（ローカルパス無し）" t_run_body_has_no_secrets_or_paths
test_case "run: 1 回だけの失敗は報告しない" t_run_transient_failure_not_reported

echo; echo "passed: $PASS  failed: $FAIL"
[[ $FAIL == 0 ]]
