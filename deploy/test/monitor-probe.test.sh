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
#   H_CODE_<path-ish>  HTTP status for / (H_CODE_ROOT), /members/ (H_CODE_MEMBERS), /data/meta.json (H_CODE_META),
#                      /assemblies/ (H_CODE_ASSEMBLIES) and any single assembly page (H_CODE_ASSEMBLY)
#   H_TITLE            <title> text of the HTML pages;  H_FETCHED_AT  meta.fetchedAt;  H_NOT_AFTER  certificate notAfter
#   H_IDS              ids the /assemblies/ page links to (#248), space separated — this is what probe.sh enumerates
#   H_ASSEMBLY_BODY    body served for an assembly page; default is what the real site renders
#                      ("$SPA_FALLBACK" emulates nginx's /__spa-fallback.html — the body nginx now serves for an
#                       unknown path; #325 made that a **404**, so pair it with H_CODE_ASSEMBLY=404)
#   H_OPEN             JSON array gh returns for the open-issue search;  H_CURL_EXIT  make curl fail outright
cat > "$TMP/handler" <<'H'
#!/usr/bin/env bash
cmd=$1; shift
IDS=${H_IDS:-"diet-sangiin pref-04 pref-24 pref-29"}
# What nginx really returns for an unknown path. #325: the status is 404 and the body is the SPA shell, whose
# <title> now DOES carry the site name (root.tsx's HydrateFallback + meta). So the title check no longer rejects it —
# the status check does, and that is the stronger of the two. Both cases are pinned below.
SPA_FALLBACK='<html lang="ja"><head><title>議員レコード</title><meta name="robots" content="noindex"></head><body></body></html>'
# The real /assemblies/ page: a link per assembly. The link text is deliberately NOT the full name here — on the
# live site an id appears both as "宮城" and "宮城県議会" — so the test pins that probe.sh keys on the id only.
assembly_list_html() {
  local id
  printf '<html><head><title>議会一覧 ・ %s</title></head><body><ul>' "${H_TITLE:-議員レコード}"
  for id in $IDS; do printf '<li><a href="/assemblies/%s" data-discover="true">%s</a></li>' "$id" "${id#pref-}"; done
  printf '</ul></body></html>'
}
case "$cmd" in
  curl)
    [ -n "${H_CURL_EXIT:-}" ] && exit "$H_CURL_EXIT"
    url=${*: -1}; out=/dev/stdout
    for ((i=1;i<=$#;i++)); do [[ "${!i}" == "-o" ]] && { j=$((i+1)); out=${!j}; }; done
    # -K <file>: keep a copy of the curl config (mode + content) — probe.sh deletes it on exit
    for ((i=1;i<=$#;i++)); do [[ "${!i}" == "-K" ]] && { j=$((i+1)); { stat -c %A "${!j}"; cat "${!j}"; } > "$STUB_LOG.curlrc"; }; done
    case "$url" in
      */data/meta.json) printf '{\n "fetchedAt": "%s",\n "sources": [{"fetchedAt": "2020-01-01T00:00:00Z"}]\n}\n' "${H_FETCHED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}" > "$out"; printf '%s' "${H_CODE_META:-200}" ;;
      */assemblies/)    assembly_list_html > "$out"; printf '%s' "${H_CODE_ASSEMBLIES:-200}" ;;
      */assemblies/*)   # a real assembly page names itself and carries the site name in its <title>
        id=${url##*/assemblies/}
        if [ -n "${H_ASSEMBLY_BODY+set}" ]; then printf '%s' "${H_ASSEMBLY_BODY//\$SPA_FALLBACK/$SPA_FALLBACK}" > "$out"
        else printf '<html><head><title>%s ・ %s</title></head><body><a href="/assemblies/%s">x</a></body></html>' \
          "$id" "${H_TITLE:-議員レコード}" "$id" > "$out"; fi
        printf '%s' "${H_CODE_ASSEMBLY:-200}" ;;
      */members/)       printf '<html><head><title>議員一覧 | %s</title></head></html>' "${H_TITLE:-議員レコード}" > "$out"; printf '%s' "${H_CODE_MEMBERS:-200}" ;;
      */)               printf '<html><head><title>%s</title></head></html>' "${H_TITLE:-議員レコード}" > "$out"; printf '%s' "${H_CODE_ROOT:-200}" ;;
      *) echo "unexpected url $url" >&2; exit 1 ;;
    esac ;;
  openssl)
    # s_client … | openssl x509 -noout -enddate
    if [[ "$1" == x509 ]]; then echo "notAfter=${H_NOT_AFTER-$(LC_ALL=C date -u -d '+60 days' '+%b %d %H:%M:%S %Y GMT')}"; fi ;;
  gh)
    case "$1 $2" in
      "issue list")   # emulate gh's --jq: the number of the open issue whose title equals $TITLE (exported by report.sh)
        python3 -c 'import json,os,sys
m=[i["number"] for i in json.loads(sys.argv[1]) if i["title"]==os.environ.get("TITLE")]
print(m[0]) if m else None' "${H_OPEN:-[]}" ;;
      "issue create")   # keep a copy of the body (run.sh deletes its temp files on exit)
        for ((i=1;i<=$#;i++)); do [[ "${!i}" == "--body-file" ]] && { j=$((i+1)); cat "${!j}" >> "$STUB_LOG.body"; }; done
        echo "https://github.com/example/repo/issues/99" ;;
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
  P="$TMP/$1"; mkdir -p "$P"; LOG="$P/stub.log"; : > "$LOG"; rm -f "$LOG.body" "$LOG.curlrc"
  export STUB_LOG="$LOG" STUB_HANDLER="$TMP/handler"
  unset H_CODE_ROOT H_CODE_MEMBERS H_CODE_META H_TITLE H_FETCHED_AT H_NOT_AFTER H_OPEN H_CURL_EXIT
  unset H_CODE_ASSEMBLIES H_CODE_ASSEMBLY H_IDS H_ASSEMBLY_BODY PROBE_ASSEMBLY_SAMPLE PROBE_NOW
  unset CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET MONITOR_REQUIRE_CF_ACCESS
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
  run_probe https://giinrecord.jp || fail "exit $? $(cat "$P/out")"
  local out; out=$(cat "$P/out")
  assert_contains "$out" "ok http" "http ok"
  assert_contains "$out" "ok data" "data ok"
  assert_contains "$out" "ok tls" "tls ok"
  assert_contains "$(cat "$LOG")" "https://giinrecord.jp/members/" "members page probed"
  assert_contains "$(cat "$LOG")" "https://giinrecord.jp/data/meta.json" "meta probed"
  assert_contains "$(cat "$LOG")" "-servername giinrecord.jp" "TLS of the right host"
}
t_probe_http_status() {
  fresh p_http
  H_CODE_MEMBERS=502 run_probe https://giinrecord.jp && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "fail http" "http fails"
  assert_contains "$(cat "$P/out")" "/members/ 502" "reason names path and status"
  assert_contains "$(cat "$P/out")" "ok tls" "tls still ok"
}
t_probe_title() {
  fresh p_title
  H_TITLE="Welcome to nginx" run_probe https://giinrecord.jp && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "fail http" "wrong title fails http"
  assert_contains "$(cat "$P/out")" "title" "reason mentions title"
}
t_probe_stale_data() {
  fresh p_stale
  H_FETCHED_AT="2020-01-01T00:00:00.000Z" run_probe https://giinrecord.jp && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "fail data" "stale data fails"
  assert_contains "$(cat "$P/out")" "ok http" "http still ok"
}
t_probe_data_within_window() {
  fresh p_fresh
  H_FETCHED_AT="$(date -u -d '-40 hours' +%Y-%m-%dT%H:%M:%S.000Z)" run_probe https://giinrecord.jp || fail "40h old is within 48h: $(cat "$P/out")"
}
t_probe_meta_unparseable() {
  fresh p_meta
  H_FETCHED_AT="not-a-date" run_probe https://giinrecord.jp && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "fail data" "unparseable fetchedAt fails data"
}
t_probe_tls_expiring() {
  fresh p_tls
  H_NOT_AFTER="$(LC_ALL=C date -u -d '+10 days' '+%b %d %H:%M:%S %Y GMT')" run_probe https://giinrecord.jp && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "fail tls" "10 days left fails"
  assert_contains "$(cat "$P/out")" "days" "reason says days"
}
t_probe_tls_unreadable() {
  fresh p_tls2
  H_NOT_AFTER="" run_probe https://giinrecord.jp && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "fail tls" "no notAfter fails tls"
}
t_probe_curl_down() {
  fresh p_down
  H_CURL_EXIT=7 run_probe https://giinrecord.jp && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "fail http" "connection failure is http fail"
  assert_contains "$(cat "$P/out")" "fail data" "…and data cannot be checked"
}
t_probe_rejects_bad_origin() {
  fresh p_origin
  if run_probe "http://giinrecord.jp"; then fail "http origin accepted"; fi
  if run_probe "https://giinrecord.jp/path"; then fail "origin with path accepted"; fi
  if run_probe; then fail "missing origin accepted"; fi
}

# ---- probe.sh: assembly pages (#248) ----
t_probe_probes_assemblies_index_page() {
  fresh p_asm_index
  run_probe https://giinrecord.jp || fail "exit $? $(cat "$P/out")"
  grep -qE "https://giinrecord\.jp/assemblies/$" "$LOG" || fail "the assembly list page is probed"
}
t_probe_assemblies_page_status() {
  fresh p_asm_500
  H_CODE_ASSEMBLIES=500 run_probe https://giinrecord.jp && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "fail http" "/assemblies/ 500 fails http"
  assert_contains "$(cat "$P/out")" "/assemblies/ 500" "reason names path and status"
}
# The list of assembly pages is not hard-coded: it is read from the /assemblies/ page's own links, so a new
# assembly is monitored without touching probe.sh.
t_probe_assembly_pages_come_from_the_list_page() {
  fresh p_asm_follow
  run_probe https://giinrecord.jp || fail "exit $? $(cat "$P/out")"
  # 4 assemblies linked, sample 3 → exactly 3 assembly pages, all of them from those links
  assert_eq "3" "$(grep -cE 'curl .*https://giinrecord\.jp/assemblies/[a-z0-9-]+$' "$LOG")" "sample size honoured"
  local probed id; probed=$(grep -oE 'https://giinrecord\.jp/assemblies/[a-z0-9-]+$' "$LOG" | sed 's|.*/assemblies/||')
  for id in $probed; do
    assert_contains "diet-sangiin pref-04 pref-24 pref-29" "$id" "probed id is one the list page links to"
  done
}
# Regression guard for the bug this replaced: /data/assemblies/index.json is bundled into a JS chunk at build time
# and is NOT served under /data/ (404 in production), so the probe must never depend on it.
t_probe_never_fetches_the_unserved_index_json() {
  fresh p_asm_nojson
  run_probe https://giinrecord.jp || fail "exit $? $(cat "$P/out")"
  assert_not_contains "$(cat "$LOG")" "/data/assemblies/index.json" "that URL is a 404 in production; never request it"
}
t_probe_new_assembly_is_picked_up_without_code_change() {
  fresh p_asm_new
  # a brand new assembly, alone on the list page → probed although probe.sh never heard of it
  H_IDS="pref-99" run_probe https://giinrecord.jp || fail "exit $? $(cat "$P/out")"
  assert_contains "$(cat "$LOG")" "https://giinrecord.jp/assemblies/pref-99" "the new assembly is probed"
}
t_probe_assembly_page_status() {
  fresh p_asm_page
  H_CODE_ASSEMBLY=500 run_probe https://giinrecord.jp && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "fail http" "a broken assembly page fails http"
  assert_contains "$(cat "$P/out")" "/assemblies/" "reason names the assembly path"
  assert_contains "$(cat "$P/out")" "500" "reason names the status"
  assert_contains "$(cat "$P/out")" "ok tls" "tls still ok"
}
# A vanished prerender: nginx answers the unknown path with the SPA shell. #325 made that a 404, so the status
# check rejects it. This is what the live site does today and is the primary defence.
t_probe_spa_fallback_on_assembly_page_fails() {
  fresh p_asm_fallback
  # shellcheck disable=SC2016  # literal placeholder: the stub handler substitutes $SPA_FALLBACK, not this shell
  H_ASSEMBLY_BODY='$SPA_FALLBACK' H_CODE_ASSEMBLY=404 run_probe https://giinrecord.jp && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "fail http" "a 404 from a vanished prerender fails http"
  assert_contains "$(cat "$P/out")" "404" "…and the reason names the status"
}
# Defence in depth for #325: even if some future change served the SPA shell with **200** again, the shell has no
# assembly id in it, so the id check still rejects it. (Before #325 the title check did this job; the shell's
# <title> now carries the site name, so that check alone would pass — this pins that the probe does not go blind.)
t_probe_spa_fallback_with_200_still_fails() {
  fresh p_asm_fallback_200
  # shellcheck disable=SC2016  # literal placeholder: the stub handler substitutes $SPA_FALLBACK, not this shell
  H_ASSEMBLY_BODY='$SPA_FALLBACK' run_probe https://giinrecord.jp && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "fail http" "the SPA shell served with 200 still fails http"
  assert_contains "$(cat "$P/out")" "is not this assembly" "…because the shell does not name the assembly"
}
# Defence in depth: 200 + the site name, but the body is some other assembly's page.
t_probe_wrong_assembly_page_fails() {
  fresh p_asm_wrong
  H_ASSEMBLY_BODY='<html><head><title>別の議会 ・ 議員レコード</title></head><body>nothing here</body></html>' \
    run_probe https://giinrecord.jp && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "fail http" "a page that is not this assembly fails http"
  assert_contains "$(cat "$P/out")" "is not this assembly" "reason says the page is not this assembly's"
}
t_probe_list_page_without_links_fails() {
  fresh p_asm_nolinks
  H_IDS=" " run_probe https://giinrecord.jp && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "links to no assembly" "an empty list is a failure, not a silent pass"
}
# A broken /assemblies/ is reported once, and no assembly page is probed off a body we could not trust.
t_probe_no_pages_probed_when_list_is_broken() {
  fresh p_asm_listbroken
  H_CODE_ASSEMBLIES=503 run_probe https://giinrecord.jp && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "/assemblies/ 503" "the list page failure is the reason"
  assert_not_contains "$(cat "$LOG")" "/assemblies/pref-" "no page probed when the list is unknown"
}
# The rotation must step by the SAMPLE SIZE, not by 1: consecutive runs probe disjoint blocks, so n assemblies are
# covered in ceil(n / sample) slots. Stepping by 1 would re-probe most of the previous run and take 3x longer.
# (Regression: an earlier revision stepped by 1 and covered only 5 of the 9 live assemblies in 30 minutes.)
t_probe_rotation_steps_by_the_sample_size() {
  fresh p_asm_step
  # 4 ids, sample 2 → two slots must cover all four with no overlap
  local seen="" slot ids
  for slot in 0 1; do
    : > "$LOG"
    PROBE_ASSEMBLY_SAMPLE=2 PROBE_NOW=$(( slot * 600 )) run_probe https://giinrecord.jp || fail "exit $? $(cat "$P/out")"
    ids=$(grep -oE 'https://giinrecord\.jp/assemblies/[a-z0-9-]+$' "$LOG" | sed 's|.*/assemblies/||')
    seen="$seen $ids"
  done
  assert_eq "4" "$(echo "$seen" | tr ' ' '\n' | sort -u | grep -c .)" "2 slots x sample 2 cover all 4 assemblies"
}
# The rotation keeps a run cheap but must still reach every assembly: with sample 1 and 4 assemblies, the four
# 10-minute slots probe four different ids.
t_probe_rotation_covers_every_assembly() {
  fresh p_asm_rot
  local seen="" slot id
  for slot in 0 1 2 3; do
    : > "$LOG"
    PROBE_ASSEMBLY_SAMPLE=1 PROBE_NOW=$(( slot * 600 )) run_probe https://giinrecord.jp || fail "exit $? $(cat "$P/out")"
    id=$(grep -oE 'https://giinrecord\.jp/assemblies/[a-z0-9-]+$' "$LOG" | sed 's|.*/assemblies/||' | head -1)
    [ -n "$id" ] || { fail "slot $slot probed no assembly"; return; }
    assert_not_contains "$seen" "$id" "slot $slot probes an assembly the earlier slots did not"
    seen="$seen $id"
  done
}
t_probe_sample_zero_skips_assembly_pages() {
  fresh p_asm_off
  PROBE_ASSEMBLY_SAMPLE=0 run_probe https://giinrecord.jp || fail "exit $? $(cat "$P/out")"
  assert_not_contains "$(cat "$LOG")" "/assemblies/pref-" "no assembly page probed"
  grep -qE "https://giinrecord\.jp/assemblies/$" "$LOG" || fail "the list page is still probed"
}

# ---- probe.sh: Cloudflare Access service token (#163) ----
t_probe_cf_access_headers_via_config_file() {
  fresh p_cf
  CF_ACCESS_CLIENT_ID=id-abc.access CF_ACCESS_CLIENT_SECRET=s3cr3t-xyz run_probe https://staging.giinrecord.jp || fail "exit $? $(cat "$P/out")"
  local log; log=$(cat "$LOG")
  assert_not_contains "$log" "s3cr3t-xyz" "secret never on the curl command line"
  assert_not_contains "$log" "id-abc.access" "client id never on the curl command line"
  assert_not_contains "$(cat "$P/out")" "s3cr3t-xyz" "secret never printed"
  [ -f "$LOG.curlrc" ] || { fail "curl was given a config file (-K)"; return; }
  local rc; rc=$(cat "$LOG.curlrc")
  assert_contains "$rc" "-rw-------" "config file mode 600"
  assert_contains "$rc" 'header = "CF-Access-Client-Id: id-abc.access"' "client id header"
  assert_contains "$rc" 'header = "CF-Access-Client-Secret: s3cr3t-xyz"' "client secret header"
  # / /members/ /assemblies/ /data/meta.json + PROBE_ASSEMBLY_SAMPLE (3) assembly pages = 7
  assert_eq "$(grep -c '^curl ' "$LOG")" "$(grep -c 'curl .*-K ' "$LOG")" "every request carries the headers"
  assert_eq "7" "$(grep -c '^curl ' "$LOG")" "requests per run stay at the documented budget"
}
t_probe_without_cf_access_sends_no_headers() {
  fresh p_nocf
  run_probe https://giinrecord.jp || fail "exit $? $(cat "$P/out")"
  assert_not_contains "$(cat "$LOG")" "-K" "no config file without a token"
  [ ! -f "$LOG.curlrc" ] || fail "no curl config written"
}
t_probe_rejects_half_token() {
  fresh p_half
  if CF_ACCESS_CLIENT_ID=only-id run_probe https://staging.giinrecord.jp; then fail "id without secret must be an error"; fi
  assert_contains "$(cat "$P/out")" "CF_ACCESS_CLIENT_SECRET" "names the missing variable"
  assert_not_contains "$(cat "$P/out")" "only-id" "value not printed"
}
t_probe_rejects_token_with_newline_or_quote() {
  fresh p_badtok
  if CF_ACCESS_CLIENT_ID=$'id\nheader = "X: y"' CF_ACCESS_CLIENT_SECRET=s run_probe https://staging.giinrecord.jp; then fail "newline in token must be rejected (curl config injection)"; fi
  if CF_ACCESS_CLIENT_ID=id CF_ACCESS_CLIENT_SECRET='s"x' run_probe https://staging.giinrecord.jp; then fail "quote in token must be rejected"; fi
  [ ! -f "$LOG.curlrc" ] || fail "no request made"
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
t_run_skips_without_required_token() {
  fresh run_skip
  MONITOR_REQUIRE_CF_ACCESS=1 run_run staging https://staging.giinrecord.jp || fail "skip must exit 0: $(cat "$P/out")"
  assert_contains "$(cat "$P/out")" "::warning::" "GitHub warning annotation"
  assert_contains "$(cat "$P/out")" "CF_ACCESS_CLIENT_ID" "names the missing secret"
  assert_eq "" "$(cat "$LOG")" "no curl, no gh (an Issue must not be opened or closed blindly)"
}
t_run_probes_with_token() {
  fresh run_tok
  # 秘密の値は**ログに偶然現れない sentinel** にする（Issue 377）。
  # 以前は "sec" という3文字で、mktemp のランダム名などに紛れ込めば偽陽性になりえた。
  # 「秘密が argv に出ていない」ことを検査したいのであって、短い文字列の不在を見たいのではない。
  local secret="s3cr3t-sentinel-do-not-log"
  MONITOR_REQUIRE_CF_ACCESS=1 CF_ACCESS_CLIENT_ID=id CF_ACCESS_CLIENT_SECRET="$secret" run_run staging https://staging.giinrecord.jp || fail "exit $? $(cat "$P/out")"
  assert_contains "$(cat "$LOG")" "curl " "probed"
  assert_contains "$(cat "$LOG")" "-K " "with the token headers"
  assert_not_contains "$(cat "$LOG")" "$secret" "secret not in argv"
  assert_not_contains "$(cat "$P/out")" "::warning::" "no warning"
}
t_run_all_ok_no_retry() {
  fresh run_ok
  run_run production https://giinrecord.jp || fail "exit $? $(cat "$P/out")"
  local log; log=$(cat "$LOG")
  assert_not_contains "$log" "sleep" "no second round when the first is clean"
  assert_not_contains "$log" "gh issue create" "nothing created"
  assert_contains "$log" "gh issue list" "open issues checked so recoveries close"
}
t_run_reports_after_two_rounds() {
  fresh run_fail
  H_CODE_ROOT=503 run_run production https://giinrecord.jp && fail "expected non-zero"
  local log; log=$(cat "$LOG")
  assert_contains "$log" "sleep" "second round after a pause"
  assert_eq "2" "$(grep -c 'curl .*https://giinrecord.jp/$' "$LOG")" "root probed twice"
  assert_contains "$log" "gh issue create --title [monitor] production: http" "http issue created"
  assert_not_contains "$log" "gh issue create --title [monitor] production: tls" "tls not created"
  assert_not_contains "$log" "gh issue create --title [monitor] production: data" "data (ok) not created"
}
t_run_body_has_no_secrets_or_paths() {
  fresh run_body
  GITHUB_SERVER_URL=https://github.com GITHUB_REPOSITORY=example/repo GITHUB_RUN_ID=123 \
    H_CODE_ROOT=503 run_run production https://giinrecord.jp || true
  [ -f "$LOG.body" ] || { fail "no body file"; return; }
  local body; body=$(cat "$LOG.body")
  assert_contains "$body" "production" "environment named"
  assert_contains "$body" "/ 503" "reason included"
  assert_contains "$body" "https://github.com/example/repo/actions/runs/123" "run link"
  assert_not_contains "$body" "$TMP" "no local paths"
}
# #248: the rotating sample must not rotate between the two rounds — otherwise "failed twice in a row" would be
# comparing two different sets of pages (and a broken assembly probed only in round 1 would never be reported).
t_run_both_rounds_probe_the_same_assemblies() {
  fresh run_same
  # the retry is 60 s later; PROBE_NOW is pinned at the very end of a slot, where the slot would otherwise flip
  PROBE_NOW=599 PROBE_ASSEMBLY_SAMPLE=1 H_CODE_ROOT=503 run_run production https://giinrecord.jp && fail "expected non-zero"
  local ids uniq
  ids=$(grep -oE 'https://giinrecord\.jp/assemblies/[a-z0-9-]+$' "$LOG" | sed 's|.*/assemblies/||')
  assert_eq "2" "$(echo "$ids" | grep -c .)" "one assembly page per round"
  uniq=$(echo "$ids" | sort -u | grep -c .)
  assert_eq "1" "$uniq" "both rounds probed the same assembly"
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
  FLAP_MARK="$P/mark" STUB_HANDLER_REAL="$TMP/handler" STUB_HANDLER="$P/flap" run_run production https://giinrecord.jp || fail "a one-off failure is not a failure: $(cat "$P/out")"
  assert_not_contains "$(cat "$LOG")" "gh issue create" "not reported"
}

test_case "monitor scripts: bash -n" t_syntax
test_case "probe: 正常なら http/data/tls すべて ok、/ /members/ /data/meta.json と TLS を見る" t_probe_ok
test_case "probe: /members/ が 502 なら http が fail（パスと status を理由に）" t_probe_http_status
test_case "probe: title に『議員レコード』が無ければ http が fail" t_probe_title
test_case "probe: meta.fetchedAt が 48 時間より古ければ data が fail" t_probe_stale_data
test_case "probe: fetchedAt が 40 時間前なら ok（境界内）" t_probe_data_within_window
test_case "probe: fetchedAt が日付でなければ data が fail" t_probe_meta_unparseable
test_case "probe: 証明書の残りが 14 日未満なら tls が fail" t_probe_tls_expiring
test_case "probe: 証明書が読めなければ tls が fail" t_probe_tls_unreadable
test_case "probe: 接続できなければ http と data が fail" t_probe_curl_down
test_case "probe: origin は https のホストのみ（パス付き・http・無しは拒否）" t_probe_rejects_bad_origin
test_case "probe: /assemblies/ も見る（#248）" t_probe_probes_assemblies_index_page
test_case "probe: /assemblies/ が 500 なら http が fail" t_probe_assemblies_page_status
test_case "probe: 議会ページの一覧は /assemblies/ のリンク由来（ハードコードしない）" t_probe_assembly_pages_come_from_the_list_page
test_case "probe: 本番に無い /data/assemblies/index.json は取りに行かない（回帰防止）" t_probe_never_fetches_the_unserved_index_json
test_case "probe: 議会が増えればコード変更なしで probe 対象になる" t_probe_new_assembly_is_picked_up_without_code_change
test_case "probe: 議会ページが 500 なら http が fail（パスと status を理由に）" t_probe_assembly_page_status
test_case "probe: 議会ページが消えて SPA fallback の 404 になったら fail（#325）" t_probe_spa_fallback_on_assembly_page_fails
test_case "probe: SPA fallback が 200 で返っても、議会 id が無いので fail（#325 の二重の守り）" t_probe_spa_fallback_with_200_still_fails
test_case "probe: 200＋サイト名でも別の議会のページなら fail（多層防御）" t_probe_wrong_assembly_page_fails
test_case "probe: /assemblies/ にリンクが無ければ fail（黙って pass しない）" t_probe_list_page_without_links_fails
test_case "probe: /assemblies/ が壊れていれば議会ページは probe しない" t_probe_no_pages_probed_when_list_is_broken
test_case "probe: 巡回は sample 幅ずつ進む（前回と重複しない・回帰防止）" t_probe_rotation_steps_by_the_sample_size
test_case "probe: 巡回で全議会をいずれ網羅する（1 回あたりの本数は固定）" t_probe_rotation_covers_every_assembly
test_case "probe: PROBE_ASSEMBLY_SAMPLE=0 なら議会ページは見ない（/assemblies/ は見る）" t_probe_sample_zero_skips_assembly_pages
test_case "probe: CF_ACCESS_CLIENT_ID/SECRET があれば curl の設定ファイル（600）経由でヘッダを付け、argv と出力に秘密を出さない" t_probe_cf_access_headers_via_config_file
test_case "probe: トークンが無ければヘッダも設定ファイルも無し" t_probe_without_cf_access_sends_no_headers
test_case "probe: ID と SECRET の片方だけはエラー（値は出さない）" t_probe_rejects_half_token
test_case "probe: トークンに改行や引用符があれば拒否（curl 設定への注入）" t_probe_rejects_token_with_newline_or_quote
test_case "report: fail → ラベル確保・検索・同名が無ければ作成" t_report_creates_once
test_case "report: 同名の open Issue があれば作らない" t_report_dedups
test_case "report: 似た title は別物（完全一致のみ）" t_report_exact_title_only
test_case "report: ok → open Issue があればコメントして close" t_report_closes_on_ok
test_case "report: ok で Issue が無ければ何もしない" t_report_ok_without_issue_is_noop
test_case "run: MONITOR_REQUIRE_CF_ACCESS=1 でトークンが無ければ probe せず warning、exit 0、Issue は触らない" t_run_skips_without_required_token
test_case "run: MONITOR_REQUIRE_CF_ACCESS=1 でトークンがあれば普通に probe（ヘッダ付き）" t_run_probes_with_token
test_case "run: 全部 ok なら 2 回目を走らせず、作成もしない" t_run_all_ok_no_retry
test_case "run: 2 回連続で fail した check だけ Issue" t_run_reports_after_two_rounds
test_case "run: Issue 本文は環境名・理由・run へのリンクのみ（ローカルパス無し）" t_run_body_has_no_secrets_or_paths
test_case "run: 2 回のラウンドは同じ議会ページを見る（巡回が途中でずれない・#248）" t_run_both_rounds_probe_the_same_assemblies
test_case "run: 1 回だけの失敗は報告しない" t_run_transient_failure_not_reported

echo; echo "passed: $PASS  failed: $FAIL"
[[ $FAIL == 0 ]]
