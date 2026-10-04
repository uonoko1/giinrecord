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
#                      #1185: the objects may carry createdAt / labels / comments, which is how report.sh learns
#                      how long the Issue has been open and how many rounds already reported into it.
#                      **Use gh's real shapes** (verified against `gh issue list --json labels,comments`):
#                      `labels` is an array of objects with a `name`, `comments` is an ARRAY (its length is
#                      the count — report.sh's jq does `.comments|length`). A fixture with `"comments": 4`
#                      would be a number and would not exercise the same expression.
#   H_MAIN_META        body served for the raw main data/meta.json (#1185); H_MAIN_CODE its HTTP status
#   H_MAIN_URL_BASE    where probe.sh is told to read main from (the tests point it at the stubbed curl)
#   H_RUNS             JSON gh returns for the deploy-data.yml run list (#1185); H_RUNS_EXIT makes gh fail
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
      # #1185: main's own data/meta.json, read over https from the repository host. It is a DIFFERENT origin from
      # the site, so it gets its own case — matched before the site's /data/meta.json below.
      *main-meta*)      printf '%s' "${H_MAIN_META-$(printf '{"fetchedAt": "%s"}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)")}" > "$out"; printf '%s' "${H_MAIN_CODE:-200}" ;;
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
      "issue list")
        # **report.sh が渡した `--jq` の式を、本物の jq で実行する。**
        # **自分で同じ絞り込みを書き直してはいけない**（#1185 の実測でここに踏んだ):
        # stub 側に python で同じ判定を書いていたあいだ、**report.sh の `--jq` を
        # `map(select(.title == $ENV.TITLE))` に書き換える変異が 68 テスト全緑で素通りした。**
        # 式が fixture に二重に在ると、**実装側の式は誰も検査していない。**
        # gh は `--json a,b` で取れるフィールドだけを `--jq` に渡すので、ここでも同じ形にする。
        jqexpr=''; jsonfields=''
        for ((i=1;i<=$#;i++)); do
          [[ "${!i}" == "--jq" ]]   && { j=$((i+1)); jqexpr=${!j}; }
          [[ "${!i}" == "--json" ]] && { j=$((i+1)); jsonfields=${!j}; }
        done
        if [ -n "$jqexpr" ]; then
          # `--json number,title,createdAt,labels,comments` の形に合わせて、H_OPEN から
          # 要求されたフィールドだけを残す（gh の挙動。余分を渡すと式の検査が甘くなる）。
          printf '%s' "${H_OPEN:-[]}" \
            | jq -c --arg f "$jsonfields" '[.[] | with_entries(select(.key as $k | ($f|split(",")) | index($k)))]' \
            | jq -r "$jqexpr"
        fi ;;
      "issue edit")   ;;
      "run list")     # deploy-data.yml run history (#1185)
        [ -n "${H_RUNS_EXIT:-}" ] && exit "$H_RUNS_EXIT"
        printf '%s' "${H_RUNS:-[]}" ;;
      "issue create")   # keep a copy of the body (run.sh deletes its temp files on exit)
        for ((i=1;i<=$#;i++)); do [[ "${!i}" == "--body-file" ]] && { j=$((i+1)); cat "${!j}" >> "$STUB_LOG.body"; }; done
        echo "https://github.com/example/repo/issues/99" ;;
      "issue comment")  # #1185: keep a copy of the escalation comment body (report.sh deletes its temp file)
        # **末尾に `true` が要る**: `for` の最後の反復で `[[ ]]` が偽だと `$?` が 1 のまま残り、
        # **stub が exit 1 を返して report.sh の `set -e` を落とす**（実測でここに踏んだ。
        # 「実装が壊れている」ように見えるが fixture の側だった）。
        for ((i=1;i<=$#;i++)); do [[ "${!i}" == "--body-file" ]] && { j=$((i+1)); cat "${!j}" >> "$STUB_LOG.comment"; }; done; true ;;
      "issue close"|"label create") ;;
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
  P="$TMP/$1"; mkdir -p "$P"; LOG="$P/stub.log"; : > "$LOG"; rm -f "$LOG.body" "$LOG.curlrc" "$LOG.comment"
  export STUB_LOG="$LOG" STUB_HANDLER="$TMP/handler"
  unset H_CODE_ROOT H_CODE_MEMBERS H_CODE_META H_TITLE H_FETCHED_AT H_NOT_AFTER H_OPEN H_CURL_EXIT
  unset H_CODE_ASSEMBLIES H_CODE_ASSEMBLY H_IDS H_ASSEMBLY_BODY PROBE_ASSEMBLY_SAMPLE PROBE_NOW
  unset H_MAIN_META H_MAIN_CODE H_MAIN_URL_BASE H_RUNS H_RUNS_EXIT
  unset MONITOR_ESCALATE_HOURS PROBE_MAIN_META_URL PROBE_DEPLOY_LAG_MINUTES
  unset CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET MONITOR_REQUIRE_CF_ACCESS
}
run_probe()  { PATH="$BIN:$PATH" bash "$MON/probe.sh" "$@" > "$P/out" 2>&1; }
run_report() { PATH="$BIN:$PATH" bash "$MON/report.sh" "$@" > "$P/out" 2>&1; }
run_run()    { PATH="$BIN:$PATH" bash "$MON/run.sh" "$@" > "$P/out" 2>&1; }
run_deploy_started() { PATH="$BIN:$PATH" bash "$MON/deploy-started.sh" "$@" > "$P/out" 2>&1; }

test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

t_syntax() { for s in probe report run deploy-started; do bash -n "$MON/$s.sh" || fail "bash -n $s"; done; }

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
    id=$(head -1 < <(grep -oE 'https://giinrecord\.jp/assemblies/[a-z0-9-]+$' "$LOG" | sed 's|.*/assemblies/||'))
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

# ---- report.sh: escalation while the failure continues (#1185) ----
# 実測（#1185）: `[monitor] production: data` は 2026-10-02T06:20Z に立ち、2026-10-03T22:14Z に閉じた
# ——**39 時間開いていて、そのあいだ監視からのコメントは 0 件**だった（`gh issue view 1172` の
# comments は 3 件で、3 件とも PO か「Recovered」）。**監視は 10 分ごとに正しく鳴っていた**が、
# 鳴った先は Actions のログで、**Issue を見ただけでは 1 回目か 50 回目か分からなかった。**
# だからここでは「同名が開いている」を**黙って終わらせない**。
MIN_AGO() { date -u -d "-$1 minutes" +%Y-%m-%dT%H:%M:%SZ; }
HOURS_AGO() { date -u -d "-$1 hours" +%Y-%m-%dT%H:%M:%SZ; }

t_report_repeat_comments_elapsed() {
  fresh r_elapsed
  echo "reason body" > "$P/body"
  H_OPEN="[{\"number\":5,\"title\":\"[monitor] production: data\",\"createdAt\":\"$(MIN_AGO 30)\",\"comments\":[]}]" \
    run_report "[monitor] production: data" fail "$P/body" || fail "exit $? $(cat "$P/out")"
  local log; log=$(cat "$LOG")
  assert_not_contains "$log" "gh issue create" "まだ同じ Issue（作り直さない）"
  assert_contains "$log" "gh issue comment 5" "開いている Issue に経過を書く"
}
# **経過時間が本文に数字で出ること。** 「93h old」は probe の理由行に在ったが、
# **Issue 側には出ていなかった**（#1185 の受け入れ条件 1）。
t_report_repeat_body_has_elapsed_hours() {
  fresh r_elapsed_body
  echo "fetchedAt 93h old (limit 48h)" > "$P/body"
  H_OPEN="[{\"number\":5,\"title\":\"[monitor] production: data\",\"createdAt\":\"$(HOURS_AGO 7)\",\"comments\":[{},{},{},{}]}]" \
    run_report "[monitor] production: data" fail "$P/body" || fail "exit $? $(cat "$P/out")"
  [ -f "$LOG.comment" ] || { fail "コメント本文が採れていない"; return; }
  local c; c=$(cat "$LOG.comment")
  assert_contains "$c" "7h" "経過時間が時間で出る"
  assert_contains "$c" "93h old" "いまの理由も出る（1 回目の理由のままにしない）"
}
# **閾値を越えたら扱いが変わること**（受け入れ条件 1）。選んだのは
#   (a) タイトルの先頭に経過を出す  (b) ラベル `escalated` を足す
# **両方**にしたのは、**どちらも「Issue の一覧」で見える**から。本文の先頭だけだと
# **一覧では区別が付かず、1172 が 39 時間見られなかった形がそのまま残る。**
t_report_escalates_past_threshold() {
  fresh r_esc
  echo "body" > "$P/body"
  MONITOR_ESCALATE_HOURS=6 \
  H_OPEN="[{\"number\":5,\"title\":\"[monitor] production: data\",\"createdAt\":\"$(HOURS_AGO 7)\",\"comments\":[{},{},{},{}]}]" \
    run_report "[monitor] production: data" fail "$P/body" || fail "exit $? $(cat "$P/out")"
  local log; log=$(cat "$LOG")
  assert_contains "$log" "gh issue edit 5" "扱いが変わる（edit される）"
  assert_contains "$log" "--add-label" "ラベルが足される"
  assert_contains "$log" "escalated" "ラベル名 escalated"
  assert_contains "$log" "--title" "タイトルも変わる"
  assert_contains "$log" "7h" "タイトルに経過が入る（一覧で見える）"
}
# **閾値の手前では扱いを変えない**（鳴り始めた瞬間に escalated にしてしまうと、
# **escalated が常態になって意味を失う**）。
t_report_does_not_escalate_before_threshold() {
  fresh r_noesc
  echo "body" > "$P/body"
  MONITOR_ESCALATE_HOURS=6 \
  H_OPEN="[{\"number\":5,\"title\":\"[monitor] production: data\",\"createdAt\":\"$(HOURS_AGO 2)\",\"comments\":[{}]}]" \
    run_report "[monitor] production: data" fail "$P/body" || fail "exit $? $(cat "$P/out")"
  local log; log=$(cat "$LOG")
  assert_not_contains "$log" "gh issue edit" "まだ扱いは変えない"
  assert_contains "$log" "gh issue comment 5" "でも経過は書く（黙らない）"
}
# **一度 escalated にしたら、以後の round で edit を繰り返さない**
# （10 分ごとに title を書き換えると通知が 6 回/時 鳴り、**読まれなくなる**——#1185 の本体が
#  「鳴っていたのに読まれない」なので、ここで同じ穴を作らない）。
t_report_escalates_only_once() {
  fresh r_esc_once
  echo "body" > "$P/body"
  MONITOR_ESCALATE_HOURS=6 \
  H_OPEN="[{\"number\":5,\"title\":\"[monitor] production: data\",\"createdAt\":\"$(HOURS_AGO 9)\",\"comments\":[{},{},{},{},{},{},{},{}],\"labels\":[{\"name\":\"monitor\"},{\"name\":\"escalated\"}]}]" \
    run_report "[monitor] production: data" fail "$P/body" || fail "exit $? $(cat "$P/out")"
  assert_not_contains "$(cat "$LOG")" "gh issue edit" "すでに escalated なら edit しない"
}
# **既に escalated なタイトルでも同一性が壊れないこと。** タイトルを書き換える設計なので、
# **書き換えた後に同名検索が効かなくなると Issue が増殖する**（1 回の障害で 100 本立つ）。
# だから検索は**接尾辞を剥がした素のタイトル**で突き合わせる。
t_report_finds_the_issue_after_the_title_changed() {
  fresh r_esc_find
  echo "body" > "$P/body"
  MONITOR_ESCALATE_HOURS=6 \
  H_OPEN="[{\"number\":5,\"title\":\"[monitor] production: data — 9h 継続\",\"createdAt\":\"$(HOURS_AGO 9)\",\"comments\":[{},{},{},{},{},{},{},{}],\"labels\":[{\"name\":\"escalated\"}]}]" \
    run_report "[monitor] production: data" fail "$P/body" || fail "exit $? $(cat "$P/out")"
  assert_not_contains "$(cat "$LOG")" "gh issue create" "改題した自分の Issue をもう一度立てない"
}
# **復旧したら escalated を落として閉じる**（次の障害が escalated で始まってはいけない）。
t_report_ok_removes_escalated_label() {
  fresh r_esc_clear
  H_OPEN="[{\"number\":5,\"title\":\"[monitor] production: data — 9h 継続\",\"createdAt\":\"$(HOURS_AGO 9)\",\"labels\":[{\"name\":\"escalated\"}]}]" \
    run_report "[monitor] production: data" ok || fail "exit $? $(cat "$P/out")"
  local log; log=$(cat "$LOG")
  assert_contains "$log" "gh issue close 5" "閉じる"
  assert_contains "$log" "--remove-label" "escalated を外す"
}
# 本文にサーバー情報を入れない（OSS）
t_report_escalation_comment_has_no_paths() {
  fresh r_esc_safe
  echo "fetchedAt 93h old" > "$P/body"
  H_OPEN="[{\"number\":5,\"title\":\"[monitor] production: data\",\"createdAt\":\"$(HOURS_AGO 7)\",\"comments\":[{},{},{},{}]}]" \
    run_report "[monitor] production: data" fail "$P/body" || fail "exit $?"
  [ -f "$LOG.comment" ] || { fail "no comment body"; return; }
  assert_not_contains "$(cat "$LOG.comment")" "$TMP" "ローカルパスを出さない"
}

# ---- probe.sh: main も古いのか、main は新しいのに出ていないのか (#1185 受け入れ条件 2) ----
# 実測（#1185）: 2026-10-03T22:00Z の本番は fetchedAt 2026-09-29T23:59:47Z（94h）で、
# **main も同じ 2026-09-29T23:59:47Z だった**（`git show 99dac9d7:data/meta.json`）。
# つまり今回は **「main も古い」= ETL が止まっていた**側で、deploy は毎日 success していた。
# **報告がどちら側か言えなければ、PO は毎回両方を調べ直すことになる。**
t_probe_data_says_main_is_stale_too() {
  fresh p_main_stale
  local old; old="$(date -u -d '-90 hours' +%Y-%m-%dT%H:%M:%S.000Z)"
  H_FETCHED_AT="$old" H_MAIN_META="{\"fetchedAt\": \"$old\"}" \
    PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp && fail "expected non-zero"
  local out; out=$(cat "$P/out")
  assert_contains "$out" "fail data" "data が fail"
  assert_contains "$out" "main も古い" "どちら側かを名指しする"
}
t_probe_data_says_main_is_fresh_but_undeployed() {
  fresh p_main_fresh
  H_FETCHED_AT="$(date -u -d '-90 hours' +%Y-%m-%dT%H:%M:%S.000Z)" \
  H_MAIN_META="{\"fetchedAt\": \"$(date -u -d '-1 hours' +%Y-%m-%dT%H:%M:%S.000Z)\"}" \
    PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp && fail "expected non-zero"
  local out; out=$(cat "$P/out")
  assert_contains "$out" "fail data" "data が fail"
  assert_contains "$out" "main は新しい" "deploy 側だと名指しする"
  assert_not_contains "$out" "main も古い" "ETL 側と言わない"
}
# **取れなかったときに「古くない」と解釈しないこと**（#1056 / 受け入れ条件 2）。
# **これがこの設計の一番危ない所**: main を読めないときに黙って従来どおりに倒すと、
# **区別する機能が無言で死んでいても誰も気づかない**（#1185 そのものの型）。
t_probe_main_unreadable_is_reported_as_unmeasured() {
  fresh p_main_down
  H_FETCHED_AT="$(date -u -d '-90 hours' +%Y-%m-%dT%H:%M:%S.000Z)" H_MAIN_CODE=503 \
    PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp && fail "expected non-zero"
  local out; out=$(cat "$P/out")
  assert_contains "$out" "fail data" "data は fail のまま"
  assert_contains "$out" "main を読めなかった" "測れなかったと書く"
  assert_not_contains "$out" "main も古い" "読めなかったのに ETL 側と断定しない"
  assert_not_contains "$out" "main は新しい" "読めなかったのに deploy 側と断定しない"
}
# **本番が健康なときは main を読まない。** 10 分ごとに外部へ 1 要求増やす理由が無く、
# **読みに行く先が落ちているだけで監視が赤くなる**のは避ける（この経路は fail 時の切り分け専用）。
t_probe_does_not_read_main_when_production_is_fresh() {
  fresh p_main_quiet
  PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp || fail "exit $? $(cat "$P/out")"
  assert_not_contains "$(cat "$LOG")" "main-meta" "健康なら main は読まない"
}
# main 側の fetchedAt が壊れていても「古くない」にしない
t_probe_main_meta_unparseable_is_unmeasured() {
  fresh p_main_bad
  H_FETCHED_AT="$(date -u -d '-90 hours' +%Y-%m-%dT%H:%M:%S.000Z)" H_MAIN_META='{"fetchedAt": "not-a-date"}' \
    PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "main を読めなかった" "読めたが解釈できない＝測れていない"
}
# **main を読む先が設定されていなければ、黙って従来どおり**（env が無い環境＝手元の probe.sh で
# 振る舞いが変わらないこと）。ただし**その場合も「区別していない」と書く**。
t_probe_without_main_url_still_fails_data() {
  fresh p_main_unset
  H_FETCHED_AT="$(date -u -d '-90 hours' +%Y-%m-%dT%H:%M:%S.000Z)" run_probe https://giinrecord.jp && fail "expected non-zero"
  local out; out=$(cat "$P/out")
  assert_contains "$out" "fail data" "data は fail"
  assert_not_contains "$(cat "$LOG")" "main-meta" "設定が無ければ読まない"
}
# 理由にサーバー情報が出ない
t_probe_main_reason_has_no_server_details() {
  fresh p_main_safe
  H_FETCHED_AT="$(date -u -d '-90 hours' +%Y-%m-%dT%H:%M:%S.000Z)" H_MAIN_CODE=503 \
    PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp && true
  assert_not_contains "$(cat "$P/out")" "example.invalid" "読んだ URL を理由に出さない"
}

# ---- deploy-started.sh: data/ が main に入ったのに deploy が始まらなかった (#1185 受け入れ条件 3) ----
# **N = 30 分**にした根拠（実測。母数つき）:
#   `gh run list --workflow deploy-data.yml --limit 300` の **98 run**（2026-08-23T15:30Z〜2026-10-04T01:40Z）と、
#   同じ窓の origin/main で `data/` を触った **79 コミット**を突き合わせ、各コミットから**次に始まった
#   deploy-data run まで**の分を数えた。**79 本すべてに後続 run が在った。**
#     bot の `data:` コミット   母数 52 本  **49 本が 0.03〜0.42 分**、残り 3 本が 251.9 / 335.8 / 650.6 分
#     人のマージ（data: 以外） 母数 27 本  p50 339.3 / p90 1127.5 / max 1367.3 分
#   **bot 側は 0.42 分と 251.9 分のあいだが空っぽ**（1/2/5/10/15/30/60/120 分のどの境でも 49/52 のまま）。
#   **30 分はその空白の中に在るので、どこに置いても同じ 49/52 を分ける。**
#   **人のマージは対象にしない**（dispatch する設計がそもそも無く、cron 待ちが正常。
#   27 本中 24 本が 30 分超なので、含めれば常時鳴る）。
t_deploy_started_ok_when_a_run_followed() {
  fresh ds_ok
  H_RUNS="[{\"createdAt\":\"$(MIN_AGO 3)\"}]" \
    run_deploy_started "$(MIN_AGO 10)" || fail "exit $? $(cat "$P/out")"
  assert_contains "$(cat "$P/out")" "ok deploy" "コミットの後に run が在れば ok"
}
# **今回の形**: data/ が入ったのに N 分以内に run が 1 本も無い
t_deploy_started_fails_when_no_run_followed() {
  fresh ds_none
  H_RUNS="[{\"createdAt\":\"$(MIN_AGO 600)\"}]" \
    run_deploy_started "$(MIN_AGO 90)" && fail "expected non-zero"
  local out; out=$(cat "$P/out")
  assert_contains "$out" "fail deploy" "fail になる"
  assert_contains "$out" "90" "何分経ったかを数字で出す"
}
# **N の手前では鳴らない**（0.42 分で始まるのが常態なので、30 分の手前で鳴らせば常時赤になる）
t_deploy_started_quiet_inside_the_window() {
  fresh ds_window
  H_RUNS='[]' PROBE_DEPLOY_LAG_MINUTES=30 \
    run_deploy_started "$(MIN_AGO 10)" || fail "10 分はまだ窓の中: $(cat "$P/out")"
  assert_contains "$(cat "$P/out")" "ok deploy" "窓の中は ok"
}
# **run を数えられなかったら「始まった」にしない**（#1056。gh が落ちた・権限が無い・
# レートに当たった、のいずれでも「異常なし」と言ってはいけない）
t_deploy_started_gh_failure_is_unmeasured() {
  fresh ds_gh
  H_RUNS_EXIT=1 run_deploy_started "$(MIN_AGO 90)" && fail "expected non-zero"
  local out; out=$(cat "$P/out")
  assert_contains "$out" "測れなかった" "測れなかったと書く"
  assert_not_contains "$out" "ok deploy" "測れていないのに ok にしない"
}
# **コミットが無い（data/ を触っていない）日は ok**。鳴らす理由が無い
t_deploy_started_no_commit_is_ok() {
  fresh ds_nocommit
  H_RUNS='[]' run_deploy_started "" || fail "exit $? $(cat "$P/out")"
  assert_contains "$(cat "$P/out")" "ok deploy" "data/ のコミットが無ければ ok"
}
# **コミット時刻が壊れていたら測れなかった扱い**（空文字＝無しとは区別する）
t_deploy_started_bad_timestamp_is_unmeasured() {
  fresh ds_badts
  H_RUNS='[]' run_deploy_started "not-a-date" && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "測れなかった" "解釈できない時刻は測れていない"
}
# **コミットより前の run を「後続」と数えない**（これを間違えると今回の 93 時間が
# 「毎日 success だったので ok」になる——実測で deploy は毎日 success していた）
t_deploy_started_ignores_runs_before_the_commit() {
  fresh ds_before
  H_RUNS="[{\"createdAt\":\"$(MIN_AGO 120)\"},{\"createdAt\":\"$(MIN_AGO 200)\"}]" \
    run_deploy_started "$(MIN_AGO 90)" && fail "コミット前の run で ok にしてはいけない"
  assert_contains "$(cat "$P/out")" "fail deploy" "前の run は後続ではない"
}
# 出力にサーバー情報・ローカルパスを出さない（OSS）
t_deploy_started_output_has_no_paths() {
  fresh ds_safe
  H_RUNS='[]' run_deploy_started "$(MIN_AGO 90)" && true
  assert_not_contains "$(cat "$P/out")" "$TMP" "ローカルパスを出さない"
}

# ---- run.sh: deploy check と「判定行が無い」(#1185) ----
# **MONITOR_DATA_COMMIT_AT が渡っていなければ deploy check を足さない**（staging と手元で
# 振る舞いを変えない。測れないものを check にしない）
t_run_no_deploy_check_without_commit_time() {
  fresh run_nodeploy
  run_run production https://giinrecord.jp || fail "exit $? $(cat "$P/out")"
  assert_not_contains "$(cat "$P/out")" "deploy" "時刻が無ければ deploy は出ない"
  assert_not_contains "$(cat "$LOG")" "gh issue list --label monitor --state open --limit 100 --search \"[monitor] production: deploy\"" "deploy の Issue も触らない"
}
# **渡っていれば 4 つめの check として扱われ、Issue も既存の仕組みで立つ**
t_run_deploy_check_opens_the_issue() {
  fresh run_deploy_fail
  H_RUNS='[]' MONITOR_DATA_COMMIT_AT="$(MIN_AGO 90)" \
    run_run production https://giinrecord.jp && fail "expected non-zero"
  local log; log=$(cat "$LOG")
  assert_contains "$(cat "$P/out")" "fail deploy" "deploy が fail"
  assert_contains "$log" "gh issue create --title [monitor] production: deploy" "既存の report.sh がそのまま Issue にする"
}
t_run_deploy_check_ok_is_quiet() {
  fresh run_deploy_ok
  H_RUNS="[{\"createdAt\":\"$(MIN_AGO 3)\"}]" MONITOR_DATA_COMMIT_AT="$(MIN_AGO 10)" \
    run_run production https://giinrecord.jp || fail "exit $? $(cat "$P/out")"
  assert_contains "$(cat "$P/out")" "ok deploy" "ok"
  assert_not_contains "$(cat "$LOG")" "gh issue create" "作らない"
}
# **判定行が 1 本も出なかった check を ok に倒さない**（#1185 / #1056）。
# **これが一番危ない形**: probe.sh が途中で死ぬと該当 check の行が消え、
# 旧実装では `r1`/`r2` が両方空なので **else（= ok 扱い）に落ちて緑になっていた。**
t_run_missing_verdict_is_not_ok() {
  fresh run_novedict
  # probe.sh を「tls の行を出さない」版に差し替える（stub ではなく本物の probe.sh を迂回する）
  mkdir -p "$P/mon"
  cp "$MON/report.sh" "$MON/deploy-started.sh" "$MON/run.sh" "$P/mon/"
  cat > "$P/mon/probe.sh" <<'FAKE'
#!/usr/bin/env bash
echo "ok http"
echo "ok data"
exit 0
FAKE
  PATH="$BIN:$PATH" bash "$P/mon/run.sh" production https://giinrecord.jp > "$P/out" 2>&1 && fail "判定行が無いのに緑にしてはいけない"
  local log; log=$(cat "$LOG")
  assert_contains "$log" "gh issue create --title [monitor] production: tls" "tls の Issue が立つ"
  assert_not_contains "$log" "gh issue create --title [monitor] production: http" "http は ok なので立たない"
  [ -f "$LOG.body" ] || { fail "本文が無い"; return; }
  assert_contains "$(cat "$LOG.body")" "no verdict" "判定が無かったと書く"
}

# **ラウンド 2 だけ判定行が消えた形を、`ok` に倒さない**（#1185 / #1194 のレビュー）。
# **上のテストとは別の形である**: 上は「両方のラウンドで行が無い」で、
# **こちらは「1 回目に fail が出て、2 回目で probe が死ぬ」**——**実際に起きるのはこちら**
# （10 分ごとに走るので、2 回目だけが刺さる確率は 1 回目だけのそれと同じ）。
# **旧実装では `[ -n "$r1" ] && [ -n "$r2" ]` が偽になって else（= ok 扱い）に落ち、
# 39 時間 escalated だった Issue に「Recovered: the check passed again」が書かれて閉じた。**
# **check は 1 度も通っていないのに。** しかも `escalated` ラベルと `— Nh 継続` の題が同時に剥がれ、
# 次に立て直される Issue は `createdAt` が新しいので **経過時間が 0h に戻る**
# ——**93 時間の障害が永遠に「0h・escalated 無し」に見え続ける。** #1185 のより悪い版である。
t_run_second_round_died_does_not_close() {
  fresh run_r2died
  mkdir -p "$P/mon"
  cp "$MON/report.sh" "$MON/deploy-started.sh" "$MON/run.sh" "$P/mon/"
  # 1 回目は #1185 の実値の形で `fail data`、2 回目は 1 行も出さずに exit 137（SIGKILL 相当）
  cat > "$P/mon/probe.sh" <<'FAKE'
#!/usr/bin/env bash
if [ -f "$ROUND_MARK" ]; then exit 137; fi
touch "$ROUND_MARK"
echo "ok http"
echo "fail data fetchedAt 93h old (limit 48h); main も古い (93h) → ETL 側"
echo "ok tls"
exit 1
FAKE
  # 開いている Issue は #1172 の実値（39 時間前・`escalated` 付き）
  H_OPEN="[{\"number\":1172,\"title\":\"[monitor] production: data\",\"createdAt\":\"$(MIN_AGO 2340)\",\"labels\":[{\"name\":\"monitor\"},{\"name\":\"escalated\"}],\"comments\":[{},{},{}]}]" \
  ROUND_MARK="$P/mark" PATH="$BIN:$PATH" bash "$P/mon/run.sh" production https://giinrecord.jp > "$P/out" 2>&1 \
    && fail "2 回目の probe が死んだのに緑にしてはいけない: $(cat "$P/out")"
  local log; log=$(cat "$LOG")
  # **鎖の 3 つの環を 1 つずつ固定する**（レビュアーが実スクリプトで再現した鎖）
  assert_not_contains "$log" "gh issue close 1172" "通っていない check で Issue を閉じない"
  assert_not_contains "$log" "Recovered" "通っていない check を『passed again』と書かない"
  assert_not_contains "$log" "--remove-label escalated" "escalated を剥がさない（経過時間の計器を巻き戻さない）"
  # **#1172 には「まだ失敗している」が入り、閉じるのではなく経過が積まれる**
  assert_contains "$log" "gh issue comment 1172" "開いている Issue には継続を報告する"
  assert_contains "$(cat "$P/out")" "still failing" "閉じずに継続として扱う"
  # **1 回目に ok だった http / tls も「測れていない」として扱う**——**ラウンド 2 は走ったのに
  # 1 行も出していないので、この 2 つも再測できていない。** 「1 回目が ok だったから ok」は
  # **前のラウンドの結果で今のラウンドの無測定を埋めること**で、#1185 の型そのものである。
  # **Issue は題で重複排除されるので、10 分ごとに増え続けはしない**（check あたり 1 本）。
  assert_contains "$log" "gh issue create --title [monitor] production: http" "再測できていない check も黙らせない"
  [ -f "$LOG.body" ] || { fail "本文が無い"; return; }
  assert_contains "$(cat "$LOG.body")" "no verdict" "判定が無かったと書く"
}

# **createdAt が読めないときに、もっともらしい嘘の経過時間を書かないこと**（#1185）。
# **実測**: GNU date は `-d ""` をエラーにせず **今日の 00:00Z** として受ける
# （`date -u -d "" '+%Y-%m-%dT%H:%M:%SZ'` → `2026-10-04T00:00:00Z`、同時刻 09:36Z）。
# **だから guard が無いと、93 時間続いている障害が「9h 継続」と書かれる**
# ——**もっともらしいので誰も疑わない。** #1185 の本体（鳴っているのに読まれない）より質が悪い。
# `escalated` の閾値も経過時間で決まるので、**嘘の経過はエスカレーションの取りこぼしにもなる。**
t_report_unreadable_created_at_is_not_a_number() {
  fresh r_badcreated
  echo "fetchedAt 93h old" > "$P/body"
  MONITOR_ESCALATE_HOURS=6 \
  H_OPEN='[{"number":5,"title":"[monitor] production: data","comments":[{},{},{},{}]}]' \
    run_report "[monitor] production: data" fail "$P/body" || fail "exit $? $(cat "$P/out")"
  [ -f "$LOG.comment" ] || { fail "コメント本文が採れていない"; return; }
  local c; c=$(cat "$LOG.comment")
  assert_contains "$c" "測れません" "経過を測れなかったと書く"
  # **数字の経過を書いていないこと。** `Nh 継続` の形が在れば、それは作った数字である。
  if grep -qE '[0-9]+h 継続' <<<"$c"; then fail "createdAt が無いのに経過時間を書いている: $c"; fi
  # **測れていない経過で escalate しないこと**（題を書き換えてしまうと戻せない）
  assert_not_contains "$(cat "$LOG")" "gh issue edit" "測れていない経過で改題しない"
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

test_case "report: 継続中は開いている Issue に経過をコメントする（黙って終わらない・#1185）" t_report_repeat_comments_elapsed
test_case "report: コメント本文に経過時間と今の理由が数字で出る（#1185）" t_report_repeat_body_has_elapsed_hours
test_case "report: 閾値を越えたら扱いが変わる（改題＋ラベル escalated・一覧で見える）" t_report_escalates_past_threshold
test_case "report: 閾値の手前では扱いを変えない（でも経過は書く）" t_report_does_not_escalate_before_threshold
test_case "report: 一度 escalated にしたら毎 round 改題しない（通知で埋もれさせない）" t_report_escalates_only_once
test_case "report: 改題した後も同名検索が効き、Issue が増殖しない" t_report_finds_the_issue_after_the_title_changed
test_case "report: 復旧時は escalated を外して閉じる（次の障害が escalated で始まらない）" t_report_ok_removes_escalated_label
test_case "report: 継続コメントにローカルパスを出さない" t_report_escalation_comment_has_no_paths
test_case "probe: 本番が古く main も古ければ『main も古い』（ETL 側・#1185）" t_probe_data_says_main_is_stale_too
test_case "probe: 本番が古く main が新しければ『main は新しい』（deploy 側・#1185）" t_probe_data_says_main_is_fresh_but_undeployed
test_case "probe: main を読めなければ『測れなかった』（古くないと解釈しない・#1056）" t_probe_main_unreadable_is_reported_as_unmeasured
test_case "probe: 本番が健康なら main は読まない（要求を増やさない）" t_probe_does_not_read_main_when_production_is_fresh
test_case "probe: main の fetchedAt が壊れていても『測れなかった』" t_probe_main_meta_unparseable_is_unmeasured
test_case "probe: main の読み先が未設定でも data の fail は従来どおり" t_probe_without_main_url_still_fails_data
test_case "probe: main 側の理由に URL やサーバー情報を出さない" t_probe_main_reason_has_no_server_details
test_case "deploy-started: コミットの後に run が在れば ok（#1185）" t_deploy_started_ok_when_a_run_followed
test_case "deploy-started: N 分以内に run が無ければ fail（経過を数字で）" t_deploy_started_fails_when_no_run_followed
test_case "deploy-started: N 分の手前では鳴らない" t_deploy_started_quiet_inside_the_window
test_case "deploy-started: run を数えられなければ『測れなかった』（ok にしない）" t_deploy_started_gh_failure_is_unmeasured
test_case "deploy-started: data/ のコミットが無ければ ok" t_deploy_started_no_commit_is_ok
test_case "deploy-started: コミット時刻が壊れていれば『測れなかった』" t_deploy_started_bad_timestamp_is_unmeasured
test_case "deploy-started: コミットより前の run を後続と数えない（毎日 success でも fail）" t_deploy_started_ignores_runs_before_the_commit
test_case "deploy-started: 出力にローカルパスを出さない" t_deploy_started_output_has_no_paths

test_case "run: MONITOR_DATA_COMMIT_AT が無ければ deploy check を足さない（#1185）" t_run_no_deploy_check_without_commit_time
test_case "run: deploy check が fail なら既存の report.sh がそのまま Issue にする（入口を増やさない）" t_run_deploy_check_opens_the_issue
test_case "run: deploy check が ok なら何も作らない" t_run_deploy_check_ok_is_quiet
test_case "run: 判定行が 1 本も出なかった check を ok に倒さない（#1185 / #1056）" t_run_missing_verdict_is_not_ok
test_case "run: 2 回目の probe が死んで判定行が消えた check を ok に倒さない（Issue を閉じない・#1185）" t_run_second_round_died_does_not_close

test_case "report: createdAt が読めなければ経過時間を作らない（date -d '' は今日の 00:00Z になる・#1185）" t_report_unreadable_created_at_is_not_a_number

echo; echo "passed: $PASS  failed: $FAIL"
[[ $FAIL == 0 ]]
