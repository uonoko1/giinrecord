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
#   H_PRS              JSON gh returns for `pr list --head <branch>` (#1230); H_PRS_EXIT makes gh fail.
#                      **Use gh's real shapes** (verified in CI against `gh pr list --json
#                      number,state,autoMergeRequest,createdAt,headRefName`): `state` is "OPEN"/"CLOSED"/"MERGED",
#                      `autoMergeRequest` is an OBJECT when auto-merge is armed and **null** when it is not,
#                      `createdAt` is ISO 8601 with a trailing Z. `headRefName` is what the stub filters on —
#                      the stub refuses a `pr list` without `--head`, so the branch filter is really exercised.
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
        # **`${H_RUNS:-[]}` ではなく `${H_RUNS-[]}`**（#1198 R10b）: **`:-` は「空文字」も
        # 既定値に差し替えるので、`H_RUNS=''`（gh が exit 0 で何も出さない形）を
        # fixture から作れなかった。** 本物の gh は、レートに当たった・応答が途切れた等で
        # **stdout が空のまま exit 0 になり得る**。**そこを `[]` と同じ扱いにしてはいけない。**
        printf '%s' "${H_RUNS-[]}" ;;
      "pr list")      # #1230: data/refresh の PR の状態（第 3 の状態 = 意図して止めてある）
        [ -n "${H_PRS_EXIT:-}" ] && exit "$H_PRS_EXIT"
        # **`--head` を本物と同じようにサーバ側の絞り込みとして効かせる。**
        # ここで H_PRS をそのまま返すと、**probe.sh が `--head` をまったく渡さなくても
        # テストは緑になる**（= 枝で引いている設計が誰にも検査されない。#1228 の型）。
        # 本物の gh は `--head <branch>` に一致する PR だけを返すので、fixture も
        # `headRefName` を持たせて同じ絞り込みをする。
        head=''
        for ((i=1;i<=$#;i++)); do [[ "${!i}" == "--head" ]] && { j=$((i+1)); head=${!j}; }; done
        # **`--head` が無ければ stub 側で落とす。** 本物の gh ならリポジトリの全 PR が返り、
        # 「いちばん新しい 1 本」が refresh と無関係な PR になる。黙って全件返すと
        # **枝で引いている設計が検査されないまま緑になる**。
        if [ -z "$head" ]; then echo "gh pr list: --head が無い（probe.sh は枝で引く設計）" >&2; exit 4; fi
        # `${H_PRS-[]}`（`:-` ではない）: **空文字の応答も fixture から作れること**（#1198 R10b と同じ理由）。
        printf '%s' "${H_PRS-[]}" \
          | jq -c --arg h "$head" 'if type=="array" then [.[] | select(.headRefName == $h)] else . end' \
          2>/dev/null || printf '%s' "${H_PRS-[]}" ;;
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
  unset H_MAIN_META H_MAIN_CODE H_MAIN_URL_BASE H_RUNS H_RUNS_EXIT H_PRS H_PRS_EXIT PROBE_REFRESH_BRANCH
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
  H_OPEN='[{"number":5,"title":"[monitor] production: http","labels":[{"name":"monitor"}]}]' run_report "[monitor] production: http" fail "$P/body" || fail "exit $?"
  assert_not_contains "$(cat "$LOG")" "gh issue create" "no duplicate"
}
t_report_exact_title_only() {
  fresh r_exact
  echo "body" > "$P/body"
  H_OPEN='[{"number":5,"title":"[monitor] production: http (old)","labels":[{"name":"monitor"}]}]' run_report "[monitor] production: http" fail "$P/body" || fail "exit $?"
  assert_contains "$(cat "$LOG")" "gh issue create" "similar title is not the same issue"
}
t_report_closes_on_ok() {
  fresh r_close
  H_OPEN='[{"number":5,"title":"[monitor] production: http","labels":[{"name":"monitor"}]}]' run_report "[monitor] production: http" ok || fail "exit $?"
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
  H_OPEN="[{\"number\":5,\"title\":\"[monitor] production: data\",\"createdAt\":\"$(MIN_AGO 30)\",\"labels\":[{\"name\":\"monitor\"}],\"comments\":[]}]" \
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
  H_OPEN="[{\"number\":5,\"title\":\"[monitor] production: data\",\"createdAt\":\"$(HOURS_AGO 7)\",\"labels\":[{\"name\":\"monitor\"}],\"comments\":[{},{},{},{}]}]" \
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
  H_OPEN="[{\"number\":5,\"title\":\"[monitor] production: data\",\"createdAt\":\"$(HOURS_AGO 7)\",\"labels\":[{\"name\":\"monitor\"}],\"comments\":[{},{},{},{}]}]" \
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
  H_OPEN="[{\"number\":5,\"title\":\"[monitor] production: data\",\"createdAt\":\"$(HOURS_AGO 2)\",\"labels\":[{\"name\":\"monitor\"}],\"comments\":[{}]}]" \
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
  H_OPEN="[{\"number\":5,\"title\":\"[monitor] production: data\",\"createdAt\":\"$(HOURS_AGO 7)\",\"labels\":[{\"name\":\"monitor\"}],\"comments\":[{},{},{},{}]}]" \
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

# ---- probe.sh: 第 3 の状態 — ETL は健全で、意図して止めてある (#1230) ----
# **#1221 がこれで 70 時間以上「→ ETL 側 (#1175 / #1179)」と言い続けた。** 2 分岐はどちらも
# 「何かが壊れている」を前提にしていたので、**壊れていない状態を言う語が無かった。**
#
# **実測（2026-10-07T15:51Z、CI の `secrets.GITHUB_TOKEN` で
#   `gh pr list --state all --head data/refresh --json number,state,autoMergeRequest,createdAt`。
#   monitor.yml と同じ `permissions: contents: read / issues: write`）**:
#     exit 0。母数 57 本（全状態）= MERGED 48 / CLOSED 未マージ 4 / OPEN 0（#1222 が 13:56Z に閉じた直後）
#     **`pull-requests: read` は要らなかった**（public リポジトリ）。同じ job の `gh run list` も exit 0。
#   CLOSED 未マージの 4 本のうち **3 本は「次の refresh が作られる 0.0 時間前」に閉じられていた**
#   （#1170 / #1208 / #1220 ＝ 次の run が前の PR を畳んだだけ。正常系の一部）。
#   **だから見るのは「いちばん新しい 1 本」だけ**にしてある: 畳まれた 3 本は定義上「いちばん新しい」に
#   なれないので、**この規則での誤検出は 4 本中 0 本**。残る #1222 が #1221 の指している状態そのもの。
#
# fixture の形は本物の gh から採った（`fixtures-and-prose-drift-from-reality`）:
#   `autoMergeRequest` は armed のとき**オブジェクト**、解除されていると **null**。
PR_JSON() {  # PR_JSON <number> <state> <armed|disarmed> <hours ago>
  local armed=null
  [ "$3" = armed ] && armed='{"mergeMethod":"SQUASH","enabledAt":"2026-10-04T01:30:06Z","enabledBy":{"is_bot":true,"login":"app/github-actions"}}'
  printf '{"number":%s,"state":"%s","autoMergeRequest":%s,"createdAt":"%s","headRefName":"data/refresh"}' \
    "$1" "$2" "$armed" "$(date -u -d "-$4 hours" +%Y-%m-%dT%H:%M:%SZ)"
}
STALE_90H() { date -u -d '-90 hours' +%Y-%m-%dT%H:%M:%S.000Z; }

# **状態 3a**: refresh の PR が open で auto-merge が解除されている → **止めてある。ETL 側ではない。**
t_probe_third_state_open_and_disarmed_is_held() {
  fresh p_hold_open
  local old; old=$(STALE_90H)
  H_FETCHED_AT="$old" H_MAIN_META="{\"fetchedAt\": \"$old\"}" \
  H_PRS="[$(PR_JSON 1222 OPEN disarmed 12)]" \
    PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp && fail "expected non-zero"
  local out; out=$(cat "$P/out")
  assert_contains "$out" "fail data" "data は fail のまま（鮮度落ちは事実）"
  assert_contains "$out" "main も古い" "main が古いことは言う"
  assert_contains "$out" "refresh #1222 が open（auto-merge 解除済み）" "どの PR が止まっているか名指しする"
  assert_contains "$out" "止めてある" "意図して止めてあると言う"
  # **これが #1230 の本体**: 壊れていない ETL を指さないこと。
  assert_not_contains "$out" "ETL 側 (#1175 / #1179)" "健全な ETL を見に行かせない"
}
# **状態 3b**: open だが auto-merge が armed → **止まっているとは言えない**（#1227。緑になれば入る）。
t_probe_third_state_open_but_armed_is_not_held() {
  fresh p_hold_armed
  local old; old=$(STALE_90H)
  H_FETCHED_AT="$old" H_MAIN_META="{\"fetchedAt\": \"$old\"}" \
  H_PRS="[$(PR_JSON 1186 OPEN armed 5)]" \
    PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp && fail "expected non-zero"
  local out; out=$(cat "$P/out")
  assert_contains "$out" "refresh #1186 が open（auto-merge 有効）" "armed だと書く"
  assert_contains "$out" "緑になれば入る" "armed は「入る途中」であると書く"
  assert_not_contains "$out" "止めてある" "armed を「止めてある」と言わない"
  assert_not_contains "$out" "ETL 側 (#1175 / #1179)" "armed でも健全な ETL は指さない"
}
# **状態 3c**: いちばん新しい refresh の PR が未マージで閉じられている（#1222 のいまの形）。
# **#1222 は 2026-10-07T13:56Z に閉じられたので、「open なら」だけでは #1221 を説明できない。**
t_probe_third_state_closed_unmerged_is_held() {
  fresh p_hold_closed
  local old; old=$(STALE_90H)
  H_FETCHED_AT="$old" H_MAIN_META="{\"fetchedAt\": \"$old\"}" \
  H_PRS="[$(PR_JSON 1222 CLOSED disarmed 13)]" \
    PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp && fail "expected non-zero"
  local out; out=$(cat "$P/out")
  assert_contains "$out" "refresh #1222 が未マージで閉じられている" "閉じられた PR も名指しする"
  assert_contains "$out" "止めてある" "閉じられた＝入れない判断がされている"
  assert_not_contains "$out" "ETL 側 (#1175 / #1179)" "健全な ETL を見に行かせない"
}
# **畳まれた古い PR を「止めてある」にしない。** 実測の 4 本中 3 本は「次の refresh が作られる
# 0.0 時間前」に閉じられた正常系で、**そのとき新しい PR のほうが「いちばん新しい」になる。**
t_probe_newest_pr_wins_over_superseded_ones() {
  fresh p_hold_newest
  local old; old=$(STALE_90H)
  # #1220（12 時間前・CLOSED、次の run が畳んだ）と #1222（1 時間前・OPEN）。見るのは #1222。
  H_FETCHED_AT="$old" H_MAIN_META="{\"fetchedAt\": \"$old\"}" \
  H_PRS="[$(PR_JSON 1220 CLOSED disarmed 12),$(PR_JSON 1222 OPEN disarmed 1)]" \
    PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp && fail "expected non-zero"
  local out; out=$(cat "$P/out")
  assert_contains "$out" "refresh #1222" "いちばん新しい 1 本を見る"
  assert_not_contains "$out" "#1220" "畳まれた古い PR を名指ししない"
}
# **main より古い PR では上書きしない。** これが閉じた PR を見る規則の唯一の歯止めで、
# **ETL が本当に死ぬ直前に誰かが PR を閉じていたら、その 1 本が永久に「止めてある」を言い続ける。**
# 入れても main が新しくならない PR は、鮮度落ちの理由ではない。
t_probe_pr_older_than_main_does_not_override() {
  fresh p_hold_older
  # main の fetchedAt は 90 時間前。PR は 100 時間前（＝ main より古い）→ ETL 側のまま。
  local old; old=$(STALE_90H)
  H_FETCHED_AT="$old" H_MAIN_META="{\"fetchedAt\": \"$old\"}" \
  H_PRS="[$(PR_JSON 900 OPEN disarmed 100)]" \
    PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp && fail "expected non-zero"
  local out; out=$(cat "$P/out")
  assert_contains "$out" "ETL 側 (#1175 / #1179)" "main より古い PR は理由にならない"
  assert_not_contains "$out" "止めてある" "入れても main が新しくならない PR で上書きしない"
}
# **MERGED なら上書きしない**（入っているのに main が古い＝中身の問題。ETL 側のまま）。
t_probe_merged_pr_does_not_override() {
  fresh p_hold_merged
  local old; old=$(STALE_90H)
  H_FETCHED_AT="$old" H_MAIN_META="{\"fetchedAt\": \"$old\"}" \
  H_PRS="[$(PR_JSON 1186 MERGED armed 2)]" \
    PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp && fail "expected non-zero"
  local out; out=$(cat "$P/out")
  assert_contains "$out" "ETL 側 (#1175 / #1179)" "入っている PR は止めてある理由にならない"
  assert_not_contains "$out" "止めてある" "MERGED を「止めてある」と言わない"
}
# ---- 受け入れ条件 2: refresh の PR が無ければ、**いまと一字一句同じ文言**（退行させない）----
# **これが #1230 で一番壊しやすい所。** 第 3 の枝を足すときに既存の 2 分岐の文字列をいじると、
# docs/ops/monitoring.md と Issue の履歴（#1221 の 4 本のコメント）が指す語が消える。
t_probe_no_refresh_pr_keeps_the_exact_old_wording() {
  fresh p_hold_absent
  local old; old=$(STALE_90H)
  H_FETCHED_AT="$old" H_MAIN_META="{\"fetchedAt\": \"$old\"}" H_PRS='[]' \
    PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp && fail "expected non-zero"
  local out; out=$(cat "$P/out")
  # 時間は実行時刻で動くので、そこだけ正規表現にして**残りは逐語で**固定する。
  [[ "$out" =~ fail\ data\ fetchedAt\ [0-9]+h\ old\ \(limit\ 48h\)\;\ main\ も古い\ \([0-9]+h\)\ →\ ETL\ 側\ \(#1175\ /\ #1179\) ]] \
    || fail "PR が無いときの文言が変わった: $out"
  assert_not_contains "$out" "refresh #" "PR が無いのに PR 番号を出さない"
  assert_not_contains "$out" "止めてある" "PR が無いのに止めてあると言わない"
}
# **deploy 側の 1 行も不変**（`fix-one-side-check-the-mirror`: 片側を直したら対の側を確かめる）。
# **main が新しいときは refresh の PR を見に行かないこと**——10 分ごとに gh を 1 回叩く理由が無い。
t_probe_deploy_side_wording_and_no_pr_lookup() {
  fresh p_hold_mirror
  H_FETCHED_AT="$(STALE_90H)" \
  H_MAIN_META="{\"fetchedAt\": \"$(date -u -d '-1 hours' +%Y-%m-%dT%H:%M:%S.000Z)\"}" \
  H_PRS="[$(PR_JSON 1222 OPEN disarmed 1)]" \
    PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp && fail "expected non-zero"
  local out; out=$(cat "$P/out")
  [[ "$out" =~ main\ は新しい\ \([0-9]+h\)\ のに本番は\ [0-9]+h\ →\ deploy\ 側\ \(deploy-data\.yml\ を起動\) ]] \
    || fail "deploy 側の文言が変わった: $out"
  assert_not_contains "$out" "refresh #" "main が新しいなら PR の状態は理由にならない"
  assert_not_contains "$(cat "$LOG")" "pr list" "main が新しいなら gh を叩かない"
}
# **main を読めなかったときも PR を見に行かない**（測れていないのに第 3 の状態を名乗らせない。#1056）。
t_probe_unreadable_main_does_not_claim_held() {
  fresh p_hold_unmeasured
  H_FETCHED_AT="$(STALE_90H)" H_MAIN_CODE=503 \
  H_PRS="[$(PR_JSON 1222 OPEN disarmed 1)]" \
    PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp && fail "expected non-zero"
  local out; out=$(cat "$P/out")
  assert_contains "$out" "main を読めなかった" "測れていないと書く"
  assert_not_contains "$out" "止めてある" "測れていないのに「止めてある」と断定しない"
}
# **PR の一覧が取れないときに「止めてある」にも「ETL 側」にも倒さない**（#1056）。
# **倒した先がどちらでも、区別する機能が無言で死んだことが Issue から読めなくなる**（#1185 の型）。
t_probe_pr_list_unreadable_is_reported_as_unmeasured() {
  fresh p_hold_gh_down
  local old; old=$(STALE_90H)
  H_FETCHED_AT="$old" H_MAIN_META="{\"fetchedAt\": \"$old\"}" H_PRS_EXIT=1 \
    PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp && fail "expected non-zero"
  local out; out=$(cat "$P/out")
  assert_contains "$out" "refresh の PR を数えられなかった" "測れなかったと書く"
  assert_not_contains "$out" "止めてある" "取れないのに止めてあると言わない"
  assert_not_contains "$out" "ETL 側 (#1175 / #1179)" "取れないのに ETL 側と断定しない"
}
# **gh が exit 0 で空を返す形**（レート・応答の途切れ）。`[]` と同じ扱いにしてはいけない。
t_probe_pr_list_empty_response_is_unmeasured() {
  fresh p_hold_gh_empty
  local old; old=$(STALE_90H)
  H_FETCHED_AT="$old" H_MAIN_META="{\"fetchedAt\": \"$old\"}" H_PRS='' \
    PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp && fail "expected non-zero"
  # 説明文をバックティックで囲まない（shell の置換として実行されかける。gh の --body と同じ罠）
  assert_contains "$(cat "$P/out")" "refresh の PR を数えられなかった" "空の応答は空配列ではない"
}
# **枝で引いていること。** stub は `--head` が無い `pr list` を exit 4 で拒むので、
# probe.sh が枝を渡さなくなればここが落ちる（**全 PR の最新を見てしまう形を塞ぐ**）。
t_probe_queries_the_refresh_branch_by_name() {
  fresh p_hold_branch
  local old; old=$(STALE_90H)
  H_FETCHED_AT="$old" H_MAIN_META="{\"fetchedAt\": \"$old\"}" \
  H_PRS="[$(PR_JSON 1222 OPEN disarmed 1)]" \
    PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp && fail "expected non-zero"
  assert_contains "$(cat "$LOG")" "--head data/refresh" "枝の名前で引く"
  assert_contains "$(cat "$P/out")" "refresh #1222" "枝で引いた結果を使う"
}
# **別の枝の PR は理由にならない**（stub が `--head` で絞るので、一致しなければ 0 件＝ETL 側のまま）。
t_probe_other_branch_pr_is_not_a_reason() {
  fresh p_hold_other
  local old; old=$(STALE_90H)
  H_FETCHED_AT="$old" H_MAIN_META="{\"fetchedAt\": \"$old\"}" \
  H_PRS='[{"number":1230,"state":"OPEN","autoMergeRequest":null,"createdAt":"2026-10-07T15:00:00Z","headRefName":"fix/1230-something"}]' \
    PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp && fail "expected non-zero"
  local out; out=$(cat "$P/out")
  assert_contains "$out" "ETL 側 (#1175 / #1179)" "refresh 以外の枝の PR は理由にならない"
  assert_not_contains "$out" "止めてある" "別の枝の PR で「止めてある」と言わない"
}
# **理由にサーバー情報・URL・アカウント名を出さない**（OSS。Issue 本文に載る）。
t_probe_hold_reason_has_no_server_details() {
  fresh p_hold_safe
  local old; old=$(STALE_90H)
  H_FETCHED_AT="$old" H_MAIN_META="{\"fetchedAt\": \"$old\"}" \
  H_PRS="[$(PR_JSON 1222 OPEN disarmed 1)]" \
    PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp && true
  local out; out=$(cat "$P/out")
  assert_not_contains "$out" "example.invalid" "読んだ URL を出さない"
  assert_not_contains "$out" "github-actions" "PR を作ったアカウント名を出さない"
  assert_not_contains "$out" "$TMP" "ローカルパスを出さない"
}
# **PROBE_REFRESH_BRANCH='' なら見に行かない**（手元で叩いたときに gh を要求しないこと）。
t_probe_refresh_branch_can_be_disabled() {
  fresh p_hold_off
  local old; old=$(STALE_90H)
  H_FETCHED_AT="$old" H_MAIN_META="{\"fetchedAt\": \"$old\"}" \
  H_PRS="[$(PR_JSON 1222 OPEN disarmed 1)]" PROBE_REFRESH_BRANCH='' \
    PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp && fail "expected non-zero"
  assert_contains "$(cat "$P/out")" "ETL 側 (#1175 / #1179)" "切ってあれば従来どおり"
  assert_not_contains "$(cat "$LOG")" "pr list" "切ってあれば gh を叩かない"
}
# **3 つの状態の文言が互いに違うこと**（受け入れ条件 1）。**同じ語になっていれば区別できていない。**
t_probe_three_states_have_three_distinct_wordings() {
  fresh p_hold_distinct
  local old; old=$(STALE_90H) ; local etl deploy held
  H_FETCHED_AT="$old" H_MAIN_META="{\"fetchedAt\": \"$old\"}" H_PRS='[]' \
    PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp && true
  etl=$(grep '^fail data' "$P/out" || true)
  H_FETCHED_AT="$old" H_MAIN_META="{\"fetchedAt\": \"$(date -u -d '-1 hours' +%Y-%m-%dT%H:%M:%S.000Z)\"}" H_PRS='[]' \
    PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp && true
  deploy=$(grep '^fail data' "$P/out" || true)
  H_FETCHED_AT="$old" H_MAIN_META="{\"fetchedAt\": \"$old\"}" H_PRS="[$(PR_JSON 1222 OPEN disarmed 1)]" \
    PROBE_MAIN_META_URL="https://example.invalid/main-meta" run_probe https://giinrecord.jp && true
  held=$(grep '^fail data' "$P/out" || true)
  for s in "$etl" "$deploy" "$held"; do [ -n "$s" ] || fail "3 つの理由のどれかが空"; done
  [ "$etl" != "$deploy" ] || fail "ETL 側と deploy 側が同じ文言"
  [ "$etl" != "$held" ]   || fail "ETL 側と「止めてある」が同じ文言（#1230 そのもの）"
  [ "$deploy" != "$held" ] || fail "deploy 側と「止めてある」が同じ文言"
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
  H_OPEN='[{"number":5,"title":"[monitor] production: data","labels":[{"name":"monitor"}],"comments":[{},{},{},{}]}]' \
    run_report "[monitor] production: data" fail "$P/body" || fail "exit $? $(cat "$P/out")"
  [ -f "$LOG.comment" ] || { fail "コメント本文が採れていない"; return; }
  local c; c=$(cat "$LOG.comment")
  assert_contains "$c" "測れません" "経過を測れなかったと書く"
  # **数字の経過を書いていないこと。** `Nh 継続` の形が在れば、それは作った数字である。
  if grep -qE '[0-9]+h 継続' <<<"$c"; then fail "createdAt が無いのに経過時間を書いている: $c"; fi
  # **測れていない経過で escalate しないこと**（題を書き換えてしまうと戻せない）
  assert_not_contains "$(cat "$LOG")" "gh issue edit" "測れていない経過で改題しない"
}

# ---- #1198: 変異が素通りしていた 5 か所の守り ----
# **どれも「今日の振る舞いは正しい」が実測で確認されている。守りが無いだけだった。**
# 基点 eaff0d40 で `scripts/dev/mutate.sh` を 5 件当て、**5 件すべてが 70 passed / 0 failed** だった。

# **R3: 閾値の等号の向き**（`report.sh` の `-ge` → `-gt`）。
# **既存の `t_report_escalates_past_threshold` は 7h vs 6h なので、`-gt` でも通る。**
# **境界そのものを置かないと、等号の向きは誰も見ていない。**
# `HOURS_AGO 6` に 30 秒の余白を足しているのは、**整数割りが 5 に落ちないため**
# （実測: `-6 hours` でちょうど 6。経過は増える方向にしか動かないので 6 を下回らないが、
#  余白を置けば「6 でなく 7」になる余地も無い——テストは数秒で終わる）。
t_report_escalates_exactly_at_the_threshold() {
  fresh r_esc_edge
  echo "body" > "$P/body"
  local at; at=$(date -u -d "-6 hours -30 seconds" +%Y-%m-%dT%H:%M:%SZ)
  MONITOR_ESCALATE_HOURS=6 \
  H_OPEN="[{\"number\":5,\"title\":\"[monitor] production: data\",\"createdAt\":\"$at\",\"labels\":[{\"name\":\"monitor\"}],\"comments\":[{},{}]}]" \
    run_report "[monitor] production: data" fail "$P/body" || fail "exit $? $(cat "$P/out")"
  local log; log=$(cat "$LOG")
  # **6h は「6 時間以上」に入る**（docs/ops/monitoring.md が「6 時間以上」と書いている側）
  assert_contains "$log" "gh issue edit 5" "ちょうど閾値なら扱いが変わる（境界を含む）"
  assert_contains "$(cat "$P/out")" "6h >= 6h" "判定に使った両方の数を出す"
}
# **境界の片側だけでは向きが決まらない**ので、1 時間手前も固定する（`-gt` を殺すのは上、
# `-ge` を `-le` のような向きに替える変異を殺すのはこちら）。
t_report_does_not_escalate_one_hour_before() {
  fresh r_esc_edge2
  echo "body" > "$P/body"
  local at; at=$(date -u -d "-5 hours -30 minutes" +%Y-%m-%dT%H:%M:%SZ)
  MONITOR_ESCALATE_HOURS=6 \
  H_OPEN="[{\"number\":5,\"title\":\"[monitor] production: data\",\"createdAt\":\"$at\",\"labels\":[{\"name\":\"monitor\"}],\"comments\":[{},{}]}]" \
    run_report "[monitor] production: data" fail "$P/body" || fail "exit $? $(cat "$P/out")"
  assert_not_contains "$(cat "$LOG")" "gh issue edit" "5h では扱いを変えない"
}

# **R14 (M7 の型): fixture が実物と違っていた。**
# **実測**（`run.sh` に probe の stub を食わせて、`gh issue create --body-file` が受け取った
# 本文をそのまま採った。2026-10-05）:
#
#     External check **http** of **production** (https://giinrecord.jp) failed twice in a row, 60s apart.
#     (空行)
#     - reason: `/ 503`
#     - first seen: 2026-10-05T03:10:35Z
#     - run: https://github.com/example/repo/actions/runs/123
#
# **`- reason: ` という接頭辞と、値を囲むバックティックが在る。**
# ここまでの report.sh のテストは `echo "reason body" > "$P/body"` のような
# **接頭辞の無い本文**を渡していたので、`sed -n 's/^- reason: //p'` を
# **どう書き換えても誰も気付かなかった**（抽出は何も取り出さず、空の行が出るだけ）。
# **だから fixture を実物の形に替える。**「テストを変異に合わせる」のではない。
REAL_FAIL_BODY() {
  # run.sh:111-119 が実際に書く形（値は #1185 の実測の理由）
  cat <<BODY
External check **data** of **production** (https://giinrecord.jp) failed twice in a row, 60s apart.

- reason: \`fetchedAt 93h old (limit 48h); main も古い (93h) → ETL 側\`
- first seen: $(date -u +%Y-%m-%dT%H:%M:%SZ)
- run: https://github.com/example/repo/actions/runs/123

What the check means and what to do: \`docs/ops/monitoring.md\`. This Issue is closed automatically once the check passes again.
BODY
}
t_report_reason_comes_from_the_real_body_shape() {
  fresh r_reason_shape
  REAL_FAIL_BODY > "$P/body"
  H_OPEN="[{\"number\":5,\"title\":\"[monitor] production: data\",\"createdAt\":\"$(HOURS_AGO 2)\",\"labels\":[{\"name\":\"monitor\"}],\"comments\":[{},{}]}]" \
    run_report "[monitor] production: data" fail "$P/body" || fail "exit $? $(cat "$P/out")"
  [ -f "$LOG.comment" ] || { fail "コメント本文が採れていない"; return; }
  local c; c=$(cat "$LOG.comment")
  # **抽出した理由が「いまの理由」の行に出ていること。** 空のまま通してはいけない。
  assert_contains "$c" "いまの理由: " "理由の行が在る"
  assert_contains "$c" "fetchedAt 93h old (limit 48h)" "実物の本文から理由を取り出せている"
  assert_contains "$c" "ETL 側" "理由の末尾まで取れている（途中で切れていない）"
  # **「いまの理由:」が空のまま出ていないこと**——これが R14 で起きる形である。
  if grep -qE '^- いまの理由: *$' <<<"$c"; then fail "理由を取り出せていない（抽出が実物の形と合っていない）: $c"; fi
  # **行そのものを固定する**（#1198 のレビュー指摘 1）。
  # **以前はここに `assert_not_contains "$c" "いまの理由: first seen"` 等を 2 本置いていたが、恒真だった。**
  # 実測（2026-10-07・bash 5.2）: `s/^- reason: //p` → **`s/^- //p`** の緩和を当てても **84 passed / 0 failed**。
  # 理由は 2 つ: (a) `- reason:` が本文の最初の `- ` 行なので、緩めても `head -1` が**同じ行**を拾う。
  # (b) 出力は `- いまの理由: reason: \`…\`` と**目に見えて劣化する**のに、
  # `assert_contains` は**部分一致**なので「前にゴミが付いた」形が全部通る。
  # **だから部分一致をやめ、行を 1 本取り出して `assert_eq` で全体を突き合わせる。**
  # 取り出しに `grep`/`sed` のパイプを使わない（#527: `pipefail` のもとでパイプ末尾の
  # 早期終了読み手が書き手を SIGPIPE で殺す）。bash の前方一致で 1 行ずつ見る。
  local reason_line="" line; local n=0
  while IFS= read -r line; do
    [[ "$line" == "- いまの理由: "* ]] || continue
    reason_line="$line"; n=$((n+1))
  done <<<"$c"
  # **1 本だけ在ること**も固定する（行が増える変異・消える変異の両方を見る）。
  assert_eq 1 "$n" "「いまの理由」の行はコメントにちょうど 1 本"
  # shellcheck disable=SC2016  # バックティックは report.sh が本文に書くリテラルで、展開させない
  assert_eq '- いまの理由: `fetchedAt 93h old (limit 48h); main も古い (93h) → ETL 側`' \
    "$reason_line" "理由の行は実物の本文の reason 行と一字一句同じ（接頭辞も余りも付かない）"
}
# **判定行が出なかったときの本文も、同じ接頭辞の形である**（run.sh:95-104）。
# **2 つの本文で接頭辞が揃っていること自体を固定する**——片方だけ変えても抽出が壊れる。
t_report_reason_from_the_no_verdict_body() {
  fresh r_reason_noverdict
  cat > "$P/body" <<BODY
External check **tls** of **production** (https://giinrecord.jp) **produced no verdict** in at least one of the rounds.

- reason: \`judgement line missing (the check did not report ok or fail)\`
- first seen: $(date -u +%Y-%m-%dT%H:%M:%SZ)
BODY
  H_OPEN="[{\"number\":5,\"title\":\"[monitor] production: tls\",\"createdAt\":\"$(HOURS_AGO 2)\",\"labels\":[{\"name\":\"monitor\"}],\"comments\":[{}]}]" \
    run_report "[monitor] production: tls" fail "$P/body" || fail "exit $? $(cat "$P/out")"
  assert_contains "$(cat "$LOG.comment")" "judgement line missing" "no verdict の本文からも理由を取り出せる"
}
# **実物とテストの接頭辞がずれたら落ちること**を、run.sh 側からも固定する。
# **上の 2 つは「report.sh は `- reason: ` を読める」を言っている。**
# **こちらは「run.sh は `- reason: ` を書いている」**——**両方無いと、
# 片方を変えたときにもう片方が追従せず、抽出が黙って空になる**（これが #1142 の M7 の型）。
t_run_body_reason_line_has_the_prefix_report_reads() {
  fresh run_prefix
  H_CODE_ROOT=503 run_run production https://giinrecord.jp && fail "expected non-zero"
  [ -f "$LOG.body" ] || { fail "本文が無い"; return; }
  local body; body=$(cat "$LOG.body")
  # **逐語で固定する。** `report.sh` の `sed -n 's/^- reason: //p'` がこの形に依存している。
  # shellcheck disable=SC2016  # バックティックは run.sh が本文に書くリテラルで、展開させない
  assert_contains "$body" '- reason: `/ 503`' "run.sh の理由行は report.sh が読む形で書かれている"
  # **report.sh の抽出式そのものを、run.sh が出した本文に当てる**（自己参照にしない）。
  # **パイプの末尾に `head` を置かない**（#527 / #1198 のレビューで CI が赤になった形）:
  # `pipefail` のもとで `head -1` が先に終わると、書き手が SIGPIPE(141) で死に、
  # **grep/sed が 0 を返しているのにパイプライン全体が偽になる。**
  # 実測（2026-10-05・bash 5.2）: 一致が 1 行だけの本文では 0/3000 だが、
  # **`- reason: ` が 20,000 行ある入力では 200/200 で偽になる**（sed の出力が
  # パイプのバッファ 64KB を超えた瞬間から確定的に落ちる）。
  # **「いま落ちない」は「将来も落ちない」ではない**ので、パイプをやめる。
  local extracted; extracted=$(head -1 < <(sed -n 's/^- reason: //p' "$LOG.body"))
  # shellcheck disable=SC2016
  assert_eq '`/ 503`' "$extracted" "実物の本文に report.sh の抽出を当てると理由が出る"
}

# **R5: `ROUNDS` を 1 に固定する変異。**
# **「この Issue に報告が入った回数」は下限でも情報である**（#757: 数には母数が要る）。
# **1 に固定されると、50 回目でも「1 回以上」になり、#1185 の「1 回目か 50 回目か分からない」に戻る。**
t_report_round_count_grows_with_the_comments() {
  fresh r_rounds
  REAL_FAIL_BODY > "$P/body"
  # **コメントが 12 件なら、このラウンドを足して 13 回以上**
  H_OPEN="[{\"number\":5,\"title\":\"[monitor] production: data\",\"createdAt\":\"$(HOURS_AGO 2)\",\"labels\":[{\"name\":\"monitor\"}],\"comments\":[{},{},{},{},{},{},{},{},{},{},{},{}]}]" \
    run_report "[monitor] production: data" fail "$P/body" || fail "exit $? $(cat "$P/out")"
  local c; c=$(cat "$LOG.comment")
  assert_contains "$c" "**13 回以上**" "コメント数 + 1 が回数になる（12 + 1）"
  assert_contains "$c" "下限" "下限であることを明示する（#757）"
}
# **2 つの値で固定する**: 1 点だけだと `ROUNDS=13` のような定数への変異が通る。
t_report_round_count_differs_between_two_issues() {
  fresh r_rounds2
  REAL_FAIL_BODY > "$P/body"
  H_OPEN="[{\"number\":5,\"title\":\"[monitor] production: data\",\"createdAt\":\"$(HOURS_AGO 2)\",\"labels\":[{\"name\":\"monitor\"}],\"comments\":[{},{}]}]" \
    run_report "[monitor] production: data" fail "$P/body" || fail "exit $? $(cat "$P/out")"
  assert_contains "$(cat "$LOG.comment")" "**3 回以上**" "コメント 2 件なら 3 回以上"
  # **初回（コメント 0 件）は「1 回以上」**。ここが `ROUNDS=1` と一致するので、
  # **上の 2 つと合わせて初めて向きが決まる。**
  fresh r_rounds3
  REAL_FAIL_BODY > "$P/body"
  H_OPEN="[{\"number\":5,\"title\":\"[monitor] production: data\",\"createdAt\":\"$(HOURS_AGO 2)\",\"labels\":[{\"name\":\"monitor\"}],\"comments\":[]}]" \
    run_report "[monitor] production: data" fail "$P/body" || fail "exit $? $(cat "$P/out")"
  assert_contains "$(cat "$LOG.comment")" "**1 回以上**" "コメントが無ければ 1 回以上"
}

# **R10b: `deploy-started.sh` が run の一覧として空文字を受けたとき。**
# **これは #1056 の「0 件」と「測れなかった」の区別そのもの。**
# `gh run list --json createdAt` は**成功すれば必ず JSON を返す**（run が無ければ `[]`）。
# **空文字は「応答が読めなかった」**——`[]` ではない。**ここを `ok` に倒すと、
# 読めなかった応答が全部緑に見える。**
t_deploy_started_empty_response_is_unmeasured() {
  fresh ds_empty
  # **gh は exit 0 で、何も出さない**（レート制限のメッセージが stderr に出て stdout が空、等）
  H_RUNS='' run_deploy_started "$(MIN_AGO 90)" && fail "空の応答を ok にしてはいけない"
  local out; out=$(cat "$P/out")
  assert_contains "$out" "測れなかった" "測れなかったと書く"
  assert_contains "$out" "空の応答" "空だったことを名指しする"
  assert_not_contains "$out" "ok deploy" "ok にしない"
}
# **「本当に 0 件」は別の言い方になること**（#1056 の両側）。**両方 fail だが理由が違う。**
# **ここを分けないと、毎日の運用で「測れなかった」が常態になって読まれなくなる**
# ——`[]` は gh が正しく答えた形なので、**「run が 0 本」として報告する**。
t_deploy_started_distinguishes_zero_from_unmeasured() {
  fresh ds_zero
  H_RUNS='[]' run_deploy_started "$(MIN_AGO 90)" && fail "expected non-zero"
  local out; out=$(cat "$P/out")
  assert_contains "$out" "run が 0 本" "0 件は 0 件として書く"
  assert_not_contains "$out" "測れなかった" "正しく答えた応答を『測れなかった』にしない（毎日鳴らせない）"
}

# **X2: 判定が出たかの検査を `r2` だけに狭める変異。**
# **`||` の両辺は対称なのに、#1194 が足したテストは `r1` 側しか殺していなかった**
# （R12 = `r1` だけに狭める は殺せ、X2 = `r2` だけに狭める は 70 全緑で素通りした）。
# **「片方を直したら、対になる側も確かめる」**——このリポジトリで繰り返している型である。
#
# **ここで固定する形**: **1 回目の probe が死んで（1 行も出さず）、2 回目は全部 ok。**
# `r1` には判定が無く `r2` には在るので、**`r2` だけを見る実装は「ok」と言って
# 開いている Issue を閉じる。** **check は 1 回も通っていないのに。**
# **誤報にならない根拠**: run.sh は `grep -q '^fail ' "$TMP/r1"` が真のときだけ 2 回目を走らせ、
# それ以外は `cp r1 r2` する。**1 回目が「1 行も無い」なら fail 行も無いので 2 回目は走らず、
# `r2` は `r1` の複製**＝実運用では `r1` だけが空になる形は起きない。
# **だから probe.sh を迂回して、その経路を人工的に作って固定する。**
t_run_first_round_died_does_not_close() {
  fresh run_r1died
  mkdir -p "$P/mon"
  cp "$MON/report.sh" "$MON/deploy-started.sh" "$MON/run.sh" "$P/mon/"
  # 1 回目は 1 行も出さずに exit 137、2 回目は全部 ok
  # （`r1` が空 → 上の `cp` に落ちないよう、run.sh の retry を通すために fail 行を 1 本だけ出す
  #  ——**http の fail で 2 回目に入り、data と tls の判定が `r1` から欠けている形**にする）
  cat > "$P/mon/probe.sh" <<'FAKE'
#!/usr/bin/env bash
if [ -f "$ROUND_MARK" ]; then
  echo "ok http"; echo "ok data"; echo "ok tls"; exit 0
fi
touch "$ROUND_MARK"
echo "fail http / 503"
exit 1
FAKE
  # 開いている Issue は #1172 の実値（39 時間前・`escalated` 付き）
  H_OPEN="[{\"number\":1172,\"title\":\"[monitor] production: data\",\"createdAt\":\"$(MIN_AGO 2340)\",\"labels\":[{\"name\":\"monitor\"},{\"name\":\"escalated\"}],\"comments\":[{},{},{}]}]" \
  ROUND_MARK="$P/mark" PATH="$BIN:$PATH" bash "$P/mon/run.sh" production https://giinrecord.jp > "$P/out" 2>&1 \
    && fail "1 回目に判定が無いのに緑にしてはいけない: $(cat "$P/out")"
  local log; log=$(cat "$LOG")
  # **`r1` に data / tls の判定が無い**ので、2 回目が ok でも「測れていない」である
  assert_contains "$log" "gh issue create --title [monitor] production: tls" "r1 で測れていない check を黙らせない"
  assert_not_contains "$log" "gh issue close 1172" "r1 で測れていない check の Issue を閉じない"
  assert_not_contains "$log" "Recovered" "測れていない check を『passed again』と書かない"
  assert_not_contains "$log" "--remove-label escalated" "escalated を剥がさない"
  [ -f "$LOG.body" ] || { fail "本文が無い"; return; }
  assert_contains "$(cat "$LOG.body")" "no verdict" "判定が無かったと書く"
}
# **`||` の両辺が両方効いていること**を、1 本のテストで対にして固定する。
# **片側だけのテストを 2 本置くより、ここで「両方向」を宣言したほうが、
# 次に誰かが片側を削ったときに何が失われるかが読める。**
t_run_verdict_check_looks_at_both_rounds() {
  fresh run_both_rounds
  mkdir -p "$P/mon"
  cp "$MON/report.sh" "$MON/deploy-started.sh" "$MON/run.sh" "$P/mon/"
  # **ラウンド 1 は tls が欠け、ラウンド 2 は data が欠ける。**
  # **どちらか片側しか見ない実装では、欠けた 2 つのうち 1 つを取りこぼす。**
  cat > "$P/mon/probe.sh" <<'FAKE'
#!/usr/bin/env bash
if [ -f "$ROUND_MARK" ]; then
  echo "fail http / 503"; echo "ok tls"; exit 1
fi
touch "$ROUND_MARK"
echo "fail http / 503"; echo "ok data"; exit 1
FAKE
  ROUND_MARK="$P/mark" PATH="$BIN:$PATH" bash "$P/mon/run.sh" production https://giinrecord.jp > "$P/out" 2>&1 \
    && fail "expected non-zero"
  local log; log=$(cat "$LOG")
  assert_contains "$log" "gh issue create --title [monitor] production: tls" "r1 で欠けた tls を拾う（r2 だけを見ていない）"
  assert_contains "$log" "gh issue create --title [monitor] production: data" "r2 で欠けた data を拾う（r1 だけを見ていない）"
}

# **`IFS=$'\t' read` はタブを「IFS の空白」として扱うので、連続するタブを 1 つに畳む**
# （受け入れ条件 3）。**実測**（bash 5.2 / 2026-10-05）:
#     ROW=$'5\t2026-10-01T00:00:00Z\t\t4'
#     IFS=$'\t' read -r NUM CREATED LABELS NCOMMENTS <<<"$ROW"
#     → NUM=[5] CREATED=[2026-10-01T00:00:00Z] LABELS=[4] NCOMMENTS=[]
# **labels が空だと、comments の数が labels に入り、comments が空になる。**
# **壊れるのは 2 つ**: (a) 「すでに escalated か」の判定（LABELS に数字が入る）、
# (b) 報告回数（NCOMMENTS が空 → 常に「1 回以上」）。
# **今日は到達しない**——`--label monitor` で絞るので labels が空にならない。
# **しかし「いま空にならない」は「将来も空にならない」ではない。**
t_report_handles_an_issue_with_no_labels() {
  fresh r_nolabels
  REAL_FAIL_BODY > "$P/body"
  # **labels が空配列** = TSV の 3 欄目が空になる形（jq の `join(",")` が "" を出す）
  MONITOR_ESCALATE_HOURS=6 \
  H_OPEN="[{\"number\":5,\"title\":\"[monitor] production: data\",\"createdAt\":\"$(HOURS_AGO 9)\",\"labels\":[],\"comments\":[{},{},{},{},{},{},{}]}]" \
    run_report "[monitor] production: data" fail "$P/body" || fail "exit $? $(cat "$P/out")"
  local c; c=$(cat "$LOG.comment")
  # **(b) 欄がずれていなければ、7 + 1 = 8 回以上になる**（ずれると NCOMMENTS が空で「1 回以上」）
  assert_contains "$c" "**8 回以上**" "labels が空でも comments の数が読める（欄がずれていない）"
  # **(a) LABELS に数字が入り込んでいないこと**: escalated は入っていないので、9h なら escalate する
  assert_contains "$(cat "$LOG")" "gh issue edit 5" "labels が空なら escalated 未付与＝閾値超えで扱いが変わる"
}
# **labels も comments も空の形**（どちらの欄も空）。**畳まれると 2 欄ずれる。**
t_report_handles_an_issue_with_no_labels_and_no_comments() {
  fresh r_nolabels2
  REAL_FAIL_BODY > "$P/body"
  MONITOR_ESCALATE_HOURS=6 \
  H_OPEN="[{\"number\":5,\"title\":\"[monitor] production: data\",\"createdAt\":\"$(HOURS_AGO 2)\",\"labels\":[],\"comments\":[]}]" \
    run_report "[monitor] production: data" fail "$P/body" || fail "exit $? $(cat "$P/out")"
  assert_contains "$(cat "$LOG")" "gh issue comment 5" "番号は正しく読めている（1 欄目がずれていない）"
  assert_contains "$(cat "$LOG.comment")" "**1 回以上**" "comments が空なら 1 回以上"
}
# **escalated が付いている Issue で、labels の前の欄が空の形。**
# **createdAt が空（= 読めない）かつ labels に escalated** ——**畳まれると escalated を
# 見落として毎 round 改題する**（10 分ごとに通知が鳴り、読まれなくなる。#1185 の型）。
t_report_sees_escalated_when_created_at_is_empty() {
  fresh r_shift_esc
  REAL_FAIL_BODY > "$P/body"
  MONITOR_ESCALATE_HOURS=6 \
  H_OPEN='[{"number":5,"title":"[monitor] production: data","labels":[{"name":"escalated"}],"comments":[{},{}]}]' \
    run_report "[monitor] production: data" fail "$P/body" || fail "exit $? $(cat "$P/out")"
  # createdAt が無いので経過は測れない。**それでも labels は正しい欄から読めていること。**
  assert_contains "$(cat "$LOG.comment")" "**3 回以上**" "createdAt が空でも comments の数が読める"
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
# #1230: 第 3 の状態（ETL は健全で、意図して止めてある）
test_case "probe: refresh が open で auto-merge 解除なら『止めてある』（#1230）" t_probe_third_state_open_and_disarmed_is_held
test_case "probe: refresh が open で auto-merge armed なら『止まっているとは言えない』（#1227 / #1230）" t_probe_third_state_open_but_armed_is_not_held
test_case "probe: refresh が未マージで閉じられていれば『止めてある』（#1222 のいまの形・#1230）" t_probe_third_state_closed_unmerged_is_held
test_case "probe: 見るのはいちばん新しい refresh の PR 1 本（畳まれた 3 本を誤検出しない・#1230）" t_probe_newest_pr_wins_over_superseded_ones
test_case "probe: main より古い refresh の PR では上書きしない（#1230）" t_probe_pr_older_than_main_does_not_override
test_case "probe: MERGED な refresh の PR では上書きしない（#1230）" t_probe_merged_pr_does_not_override
test_case "probe: refresh の PR が無ければ一字一句同じ『→ ETL 側』（#1230 受け入れ条件 2）" t_probe_no_refresh_pr_keeps_the_exact_old_wording
test_case "probe: deploy 側の 1 行は不変で、main が新しければ gh を叩かない（#1230）" t_probe_deploy_side_wording_and_no_pr_lookup
test_case "probe: main を読めなければ『止めてある』と断定しない（#1056 / #1230）" t_probe_unreadable_main_does_not_claim_held
test_case "probe: PR の一覧が取れなければ両側に倒さず『数えられなかった』（#1056 / #1230）" t_probe_pr_list_unreadable_is_reported_as_unmeasured
test_case "probe: gh が exit 0 で空を返す形を [] と同じ扱いにしない（#1230）" t_probe_pr_list_empty_response_is_unmeasured
test_case "probe: refresh の枝の名前で引く（全 PR の最新を見る形を塞ぐ・#1230）" t_probe_queries_the_refresh_branch_by_name
test_case "probe: 別の枝の PR は『止めてある』の理由にならない（#1230）" t_probe_other_branch_pr_is_not_a_reason
test_case "probe: 『止めてある』の理由に URL・アカウント名・ローカルパスを出さない（#1230）" t_probe_hold_reason_has_no_server_details
test_case "probe: PROBE_REFRESH_BRANCH='' なら gh を叩かず従来どおり（#1230）" t_probe_refresh_branch_can_be_disabled
test_case "probe: 3 つの状態の理由が互いに違う文言である（#1230 受け入れ条件 1）" t_probe_three_states_have_three_distinct_wordings
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

test_case "report: ちょうど閾値（6h）でも扱いが変わる（境界を含む・#1198 R3）" t_report_escalates_exactly_at_the_threshold
test_case "report: 閾値の 1 時間手前（5h）では扱いを変えない（向きを固定・#1198 R3）" t_report_does_not_escalate_one_hour_before
test_case "report: 理由は run.sh が実際に書く - reason: の行から取る（#1198 R14 / M7）" t_report_reason_comes_from_the_real_body_shape
test_case "report: no verdict の本文からも同じ接頭辞で理由が取れる（#1198 R14）" t_report_reason_from_the_no_verdict_body
test_case "run: 本文の理由行は report.sh の抽出が読める形で書かれている（両側を固定・#1198 R14）" t_run_body_reason_line_has_the_prefix_report_reads
test_case "report: 報告回数はコメント数 + 1（1 に固定しない・#1198 R5）" t_report_round_count_grows_with_the_comments
test_case "report: 報告回数は Issue ごとに変わる（定数への変異も殺す・#1198 R5）" t_report_round_count_differs_between_two_issues
test_case "deploy-started: run 一覧が空の応答なら『測れなかった』（ok にしない・#1198 R10b / #1056）" t_deploy_started_empty_response_is_unmeasured
test_case "deploy-started: 正しく答えた空配列は『run が 0 本』——『測れなかった』と区別する（#1198 / #1056）" t_deploy_started_distinguishes_zero_from_unmeasured
test_case "run: 1 回目の probe が死んで判定行が消えた check を ok に倒さない（#1198 X2）" t_run_first_round_died_does_not_close
test_case "run: 判定の検査は両方のラウンドを見る（片側に狭められない・#1198 X2）" t_run_verdict_check_looks_at_both_rounds
test_case "report: labels が空でも TSV の欄がずれない（タブは IFS の空白・#1198 受け入れ条件 3）" t_report_handles_an_issue_with_no_labels
test_case "report: labels も comments も空でも欄がずれない（#1198 受け入れ条件 3）" t_report_handles_an_issue_with_no_labels_and_no_comments
test_case "report: createdAt が空でも escalated を正しい欄から読む（#1198 受け入れ条件 3）" t_report_sees_escalated_when_created_at_is_empty

echo; echo "passed: $PASS  failed: $FAIL"
[[ $FAIL == 0 ]]
