#!/usr/bin/env bash
# External probe of one site origin (Issue #135), run from GitHub Actions (.github/workflows/monitor.yml via run.sh)
# — or by hand: bash deploy/monitor/probe.sh https://giinrecord.jp
#
# Checks → one line per check on stdout, "ok <check>" or "fail <check> <reason>"; exit 1 if anything failed:
#   http   GET /, /members/, /assemblies/ and /data/meta.json answer 200, and every HTML page carries 議員レコード
#          in <title> (a 200 from a default nginx page or a wrong site would otherwise pass)
#          Issue #248: the assembly pages (/assemblies/<id>) are part of this same check, so a 500 or a missing
#          prerender on a local assembly is noticed — and a failure there opens the one "http" Issue, not one per
#          assembly. The list is NOT hard-coded and needs no new deployment artefact: the /assemblies/ page fetched
#          just above already links to every assembly the site publishes, so its href="/assemblies/<id>" links are
#          the paths to probe. A new assembly is monitored from the moment it ships, at no extra request.
#          (data/assemblies/index.json cannot be used: dataset.ts bundles it into a JS chunk at build time and it is
#          never served under /data/ — copy-member-data.ts copies only data/members/*.json and OPS_DATA_FILES — so
#          /data/assemblies/index.json is a 404 in production. Verified against the live site.)
#          At most PROBE_ASSEMBLY_SAMPLE (3) pages are fetched per run, rotating through the list (one step per
#          10-minute slot), which keeps a round at a fixed, small number of requests however many assemblies exist
#          while still covering every assembly within a few rounds. See docs/ops/monitoring.md for the operational
#          target ("every assembly at least once an hour") that decides when the sample size has to grow.
#          A missing prerender is caught by the status check: since #325 nginx answers an unknown path with 404
#          (the SPA shell as the body), so `code != 200` fails it. The check that the page mentions its own id is
#          defence in depth — it catches a wrong page served for the right URL, and it is what would still catch a
#          regression that served the shell with 200 again (the shell's <title> now carries the site name, so the
#          title check alone would pass; deploy/test/monitor-probe.test.sh pins both cases).
#   data   meta.fetchedAt (top-level, the ETL's run time) is at most PROBE_MAX_AGE_HOURS (48) old — the daily ETL +
#          deploy-data.yml is alive
#          Issue #1185: **古いとき、原因が 2 つに分かれるのでどちらかを名指しする。**
#            「main も古い」            → ETL が止まっている（#1175 / #1179 の領域）
#            「main は新しいが出ていない」→ deploy が走っていない／届いていない
#          **実測（#1185 の 93 時間）**: 2026-10-03T22:00Z の本番は fetchedAt `2026-09-29T23:59:47Z`（94h）で、
#          **main の `data/meta.json` も同じ `2026-09-29T23:59:47Z` だった**
#          （`git show 99dac9d7:data/meta.json`）。つまり今回は **前者（ETL 側）**で、
#          `deploy-data.yml` は 09-29〜10-03 の毎日 success していた（`gh run list` で 5/5 本）。
#          **報告がどちら側か言えなければ、見た人は毎回両方を調べ直すことになる。**
#          どこから main を読むかは `PROBE_MAIN_META_URL` が決める（未設定なら読まない。
#          **読まないことも理由に書く**——黙って従来どおりに倒すと、
#          **区別する機能が無言で死んでいても誰も気づかない**。それが #1185 そのものの型）。
#          **読めなかったときに「古くない」と解釈しない**（#1056）: 理由は `main を読めなかった` になり、
#          **ETL 側とも deploy 側とも断定しない。**
#          **本番が健康なときは main を読まない**（10 分ごとに外部へ 1 要求増やす理由が無く、
#          読み先が落ちているだけで監視が赤くなるのも避ける。この経路は fail 時の切り分け専用）。
#          Issue #1230: **2 分岐はどちらも「何かが壊れている」を前提にしていた。第 3 の状態が在る**——
#            「main も古いが、ETL は健全で、日次の PR を意図して止めてある」
#          **#1221 はこれで 70 時間以上「→ ETL 側」と言い続け、壊れていない ETL を指していた。**
#          そこで **`main も古い` のときだけ `data/refresh` の PR の状態を見る**（`refresh_hold_verdict`）。
#          **armed な auto-merge は「止まっている」と言わない**（緑になった瞬間に入るので。#1227）。
#          **数えられなければ「止めてある」にも「ETL 側」にも倒さず、そう書く**（#1056）。
#   tls    the certificate presented for the origin's host is valid for at least PROBE_TLS_MIN_DAYS (14) more days
# Reasons contain only the path, the HTTP status, ages and day counts — never headers, bodies or addresses.
# Issue #163: staging sits behind Cloudflare Access. With CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET set (a
# Cloudflare service token) every request carries CF-Access-Client-Id / CF-Access-Client-Secret. The headers are
# written to a curl config file (mode 600, deleted on exit) and passed with -K: they never appear in argv (ps, logs)
# and are never printed. The tls check then sees Cloudflare's edge certificate, which is what browsers see too.
#   Tests: deploy/test/monitor-probe.test.sh (curl and openssl are stubs)
set -euo pipefail
export LC_ALL=C   # openssl prints English month names; date must parse them whatever the runner locale is

ORIGIN=${1:-}
MAX_AGE_HOURS=${PROBE_MAX_AGE_HOURS:-48}
TLS_MIN_DAYS=${PROBE_TLS_MIN_DAYS:-14}
TIMEOUT=${PROBE_TIMEOUT:-20}
TITLE_MUST_CONTAIN=${PROBE_TITLE:-議員レコード}
# #1185: main 側の data/meta.json をどこから読むか。**未設定なら読まない**（手元で probe.sh を
# 叩いたときの振る舞いを変えない）。monitor.yml が raw の URL を渡す。
MAIN_META_URL=${PROBE_MAIN_META_URL:-}
# #1230: 日次の ETL が出力を載せる枝の名前（etl.yml の `DATA_BRANCH`）。**この枝の PR の状態が、
# 「main が古いのは故障か、意図して止めてあるのか」を分ける**。空にすれば見に行かない。
REFRESH_BRANCH=${PROBE_REFRESH_BRANCH-data/refresh}
ASSEMBLY_SAMPLE=${PROBE_ASSEMBLY_SAMPLE:-3}   # assembly pages fetched per run (#248); 0 = none

# origin = https://<host> only (no path, no http): the paths are appended here and the host is reused for TLS
if [[ ! "$ORIGIN" =~ ^https://[A-Za-z0-9.-]+$ ]]; then
  echo "usage: probe.sh https://<host>   (got: '${ORIGIN}')" >&2; exit 2
fi
HOST=${ORIGIN#https://}

FAILED=0
ok()   { echo "ok $1"; }
fail() { echo "fail $1 $2"; FAILED=1; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# Cloudflare Access service token (#163) → curl config file; CURL_OPTS holds only "-K <file>", never a value.
CURL_OPTS=()
CF_ID=${CF_ACCESS_CLIENT_ID:-}; CF_SECRET=${CF_ACCESS_CLIENT_SECRET:-}
if [ -n "$CF_ID" ] || [ -n "$CF_SECRET" ]; then
  if [ -z "$CF_ID" ] || [ -z "$CF_SECRET" ]; then
    echo "probe.sh: CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be set together" >&2; exit 2
  fi
  # printable, no quotes / backslashes / newlines: the values go inside a quoted curl config string
  for v in "$CF_ID" "$CF_SECRET"; do
    if [[ ! "$v" =~ ^[A-Za-z0-9._-]+$ ]]; then
      echo "probe.sh: CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET contain unexpected characters (value not shown)" >&2; exit 2
    fi
  done
  CURLRC="$TMP/curlrc"
  ( umask 077; printf 'header = "CF-Access-Client-Id: %s"\nheader = "CF-Access-Client-Secret: %s"\n' "$CF_ID" "$CF_SECRET" > "$CURLRC" )
  CURL_OPTS=(-K "$CURLRC")
fi
unset CF_ID CF_SECRET

# fetch <path> <outfile> → prints the HTTP status (000 when the connection failed)
fetch() {
  local code
  code=$(curl -sS --max-time "$TIMEOUT" "${CURL_OPTS[@]}" -o "$2" -w '%{http_code}' "$ORIGIN$1" 2>/dev/null) || code=000
  printf '%s' "$code"
}
# has_title <file> [needle] → the first <title> contains <needle> (default: the site name)
has_title() {  # #527: パイプの末尾に head/grep -q を置かない（SIGPIPE + pipefail で確率的に偽になる）
  local titles first
  titles=$(grep -o '<title>[^<]*</title>' < <(tr -d '\n' < "$1")) || return 1
  first=$(head -1 <<<"$titles")
  grep -q -F -- "${2:-$TITLE_MUST_CONTAIN}" <<<"$first"
}

# check_page <path> [outfile] → appends to http_reasons unless the page answers 200 and its <title> carries the site
# name. <outfile> keeps the body for the caller (the assembly list is parsed for its links); default is scratch.
check_page() {
  local path=$1 f=${2:-$TMP/page} code
  code=$(fetch "$path" "$f")
  if [ "$code" != 200 ]; then http_reasons+=("$path $code"); return 1; fi
  if ! has_title "$f"; then http_reasons+=("$path title lacks ${TITLE_MUST_CONTAIN}"); return 1; fi
}

# ---- http ----
http_reasons=()
check_page / || true
check_page /members/ || true
ALIST="$TMP/assemblies.html"; assemblies_ok=0
check_page /assemblies/ "$ALIST" && assemblies_ok=1
META="$TMP/meta.json"; meta_code=$(fetch /data/meta.json "$META")
[ "$meta_code" = 200 ] || http_reasons+=("/data/meta.json $meta_code")

# ---- assembly pages (#248) ----
# Where the list comes from: the /assemblies/ page that was just fetched above — its links ARE the assemblies the
# site is publishing. Nothing is hard-coded, so a new assembly is probed from the moment it ships, and it costs no
# extra request. (data/assemblies/index.json is NOT an option: it is bundled into a JS chunk at build time and is
# never served under /data/ — only data/members/*.json and OPS_DATA_FILES are copied there. Probing it would 404
# on every run.) A vanished prerender is caught by the status check: since #325 nginx answers an unknown path
# with 404, and check_page fails on anything but 200. The id check below still catches a 200 that serves the
# shell (or another assembly's page).
if [ "$ASSEMBLY_SAMPLE" -gt 0 ] && [ "$assemblies_ok" = 1 ]; then
  # ids only: the link text is layout-dependent (an id can appear both as "宮城" and "宮城県議会"), the id is not.
  mapfile -t assemblies < <(tr -d '\n' < "$ALIST" \
    | grep -o 'href="/assemblies/[A-Za-z0-9._-]\+"' \
    | sed 's|^href="/assemblies/||; s|"$||' | awk '!seen[$0]++' || true)
  n=${#assemblies[@]}
  if [ "$n" -eq 0 ]; then
    http_reasons+=("/assemblies/ links to no assembly")
  else
    # Rotate through the list (one step per 10-minute slot = one step per run): a run stays at a fixed small
    # number of requests however many assemblies exist, and every assembly is still covered within a few runs.
    # PROBE_NOW pins the slot for the tests and across run.sh's two rounds; the clock provides it otherwise.
    take=$(( ASSEMBLY_SAMPLE < n ? ASSEMBLY_SAMPLE : n ))
    # Step by `take`, not by 1: consecutive runs must probe DISJOINT blocks, or a sample of 3 stepping by 1 would
    # re-probe two thirds of the previous run and take 3x longer to cover everything.
    offset=$(( (${PROBE_NOW:-$(date +%s)} / 600) * take % n ))
    for ((i = 0; i < take; i++)); do
      id=${assemblies[$(( (offset + i) % n ))]}
      # Defence in depth on top of the site name: the page must also mention its own id, so serving the wrong
      # assembly's page (or a future fallback that did carry the site name) is still caught.
      # Deliberately the id, not the name: ids are ASCII ([A-Za-z0-9._-]) and are never HTML- or JSON-escaped, so
      # this stays a plain literal comparison. Matching a name would have to cope with &amp; and friends —
      # "A&B議会" is served as "A&amp;B議会" and a literal grep would report a false failure.
      f="$TMP/page"
      if check_page "/assemblies/$id" "$f" && ! grep -q -F -- "$id" "$f"; then
        http_reasons+=("/assemblies/$id is not this assembly's page")
      fi
    done
  fi
fi
if [ ${#http_reasons[@]} -eq 0 ]; then ok http; else fail http "$(IFS=';'; echo "${http_reasons[*]}")"; fi

# refresh_hold_verdict <main age in hours> → `main も古い` の**理由を 1 つ上書きできるときだけ**一句返す (#1230)。
#
# **なぜ要るか（#1230。#1221 が 70 時間以上これで誤帰属していた）**:
#   `main も古い → ETL 側` は「何かが壊れている」を前提にしている。**壊れていない第 3 の状態が在る**——
#   **ETL は毎晩新しいデータを作っているが、PO がその PR を意図して止めている**。
#   `→ ETL 側 (#1175 / #1179)` を読んだ人は**壊れていない ETL を見に行く**。
#   **誤帰属した監視が何度も空振りすると、次の本物の ETL 故障でも誰も見に行かなくなる**（#1185 の型の逆向き）。
#
# **実測（2026-10-07T15:51Z、`gh pr list --state all --head data/refresh`、母数 57 本 = 全状態）**:
#   MERGED            48 本  ← 正常系。auto-merge が armed で、作られて数分〜十数時間で入る
#   CLOSED 未マージ      4 本  ← #1170 / #1208 / #1220 / #1222。**どれも auto-merge は解除されていた**
#   OPEN               0 本  （測った時点。#1222 が 13:56Z に閉じられた直後）
#   4 本のうち **3 本（#1170 / #1208 / #1220）は「次の refresh が作られる 0.0 時間前」に閉じられていた**
#   ——**次の run が前の PR を畳んだだけ**で、これは正常系の一部である。**それ単体は「止めてある」ではない。**
#   **だから見るのは「いちばん新しい 1 本」だけにする**: 畳まれた 3 本は定義上「いちばん新しい」になれないので、
#   **この規則での誤検出は 4 本中 0 本**になる。残る 1 本（#1222）が、いま #1221 が指している状態そのものである。
#
# **返す句は 4 通りで、どれも「ETL 側」と混ざらないこと**:
#   `refresh #N が open（auto-merge 解除済み）→ 止めてある（ETL 側ではない）`
#   `refresh #N が open（auto-merge 有効）→ 緑になれば入る（止まっているとは言えない）`   ← #1227。**armed は止まっていない**
#   `refresh #N が未マージで閉じられている → 止めてある（ETL 側ではない）`
#   `refresh の PR を数えられなかった (…)`   ← **「止めてある」に倒さない**（#1056。測れていないことを書く）
# **何も言えないときは空文字を返す**。そのとき呼び出し側は**いまと一字一句同じ `→ ETL 側` を出す**（退行させない）。
#
# **main より古い PR では上書きしない。** 閉じた PR を見る規則には、これが唯一の歯止めである——
# **ETL が本当に死んだ直後に誰かが PR を閉じていたら、その 1 本が永久に「止めてある」を言い続ける。**
# 「その PR を入れれば main が新しくなる」のでなければ、止めてあることは鮮度落ちの理由ではない。
#
# gh を使って良いことは**実測で確かめた**（手元の PAT ではなく CI の `secrets.GITHUB_TOKEN` で。#1168 / #1210）:
#   2026-10-07T15:51:31Z、monitor.yml と同じ `permissions: contents: read / issues: write` の job で
#   `gh pr list --state all --head data/refresh --json number,state,autoMergeRequest,createdAt` が
#   **exit 0 で #1222 / #1220 / #1208 … を返した**（`autoMergeRequest` の中身も取れた）。
#   **`pull-requests: read` を足す必要は無い**（public リポジトリ）。同じ job で `gh run list` も exit 0 だった
#   （`deploy-started.sh` が依存している経路）。
# **出力に URL・ホスト名・アカウント名を書かない**（OSS。Issue 本文に載る）。出すのは PR 番号と状態だけ。
refresh_hold_verdict() {
  local main_age=$1 prs newest
  [ "$REFRESH_BRANCH" != "" ] || { echo ""; return 0; }
  # **取れなければ「止めてある」に倒さない**（#1056）。黙って ETL 側に戻すのも駄目で、
  # **区別する機能が死んだことが Issue から読めなくなる**（それが #1185 そのものの型）。
  if ! prs=$(gh pr list --state all --head "$REFRESH_BRANCH" \
      --json number,state,autoMergeRequest,createdAt --limit 20 2>/dev/null); then
    echo "refresh の PR を数えられなかった (一覧を取得できない)"; return 0
  fi
  if [ -z "$prs" ]; then
    echo "refresh の PR を数えられなかった (空の応答)"; return 0
  fi
  # いちばん新しい 1 本だけを見る（上の実測: 畳まれた 3 本を誤検出しないための要点）。
  # `main_age` は「main の fetchedAt が何時間前か」。PR がそれより古ければ入れても main は新しくならない。
  newest=$(printf '%s' "$prs" | python3 -c '
import json,sys,datetime
try:
    rs = json.load(sys.stdin)
except Exception:
    print("UNREADABLE"); sys.exit(0)
if not isinstance(rs, list):
    print("UNREADABLE"); sys.exit(0)
rs = [r for r in rs if r.get("createdAt")]
if not rs:
    print("NONE"); sys.exit(0)
r = max(rs, key=lambda x: x["createdAt"])
try:
    created = datetime.datetime.fromisoformat(r["createdAt"].replace("Z", "+00:00"))
except Exception:
    print("UNREADABLE"); sys.exit(0)
age_h = (datetime.datetime.now(datetime.timezone.utc) - created).total_seconds() / 3600
print("%s %s %s %.4f" % (r.get("number"), r.get("state"), "armed" if r.get("autoMergeRequest") else "disarmed", age_h))
' 2>/dev/null) || newest=UNREADABLE
  case "$newest" in
    UNREADABLE|'') echo "refresh の PR を数えられなかった (応答を解釈できない)"; return 0 ;;
    NONE)          echo ""; return 0 ;;   # PR が 1 本も無い → 言えることが無い。ETL 側のまま
  esac
  local num state auto pr_age_h
  read -r num state auto pr_age_h <<<"$newest"
  # **PR が main より古ければ上書きしない。** 入れても main は新しくならないので、止めてあることは理由ではない。
  if ! awk -v a="$pr_age_h" -v m="$main_age" 'BEGIN { exit !(a < m) }'; then
    echo ""; return 0
  fi
  case "$state" in
    OPEN)
      if [ "$auto" = armed ]; then
        # #1227: **armed は「誰かが緑にした瞬間に入る」ので、止まっているとは言えない。**
        echo "refresh #${num} が open（auto-merge 有効）→ 緑になれば入る（止まっているとは言えない）"
      else
        echo "refresh #${num} が open（auto-merge 解除済み）→ 止めてある（ETL 側ではない）"
      fi ;;
    MERGED) echo "" ;;   # 入っているのに main が古い → 入れた中身の問題。ETL 側のまま
    CLOSED) echo "refresh #${num} が未マージで閉じられている → 止めてある（ETL 側ではない）" ;;
    *)      echo "" ;;
  esac
}

# main_side_verdict <production age in hours> → one short phrase naming WHICH side is broken (#1185).
# **出すのは 3 通りだけで、どれも「分からない」と区別が付くこと**:
#   `main も古い (Nh)`        main の fetchedAt も limit より古い → ETL 側
#   `main は新しい (Nh)`      main は limit 以内 → deploy 側（main に在るのに出ていない）
#   `main を読めなかった (…)`  取れなかった／解釈できなかった／読み先が未設定 → **測れていない**
# **理由に URL やホスト名を出さない**（OSS。Issue 本文に載る）。出すのは時間と、取れなかった理由の種別だけ。
# #1230: `main も古い` のときだけ、**第 3 の状態（意図して止めてある）を上書きできる**。
# **`refresh_hold_verdict` が空を返したら、いまと一字一句同じ `→ ETL 側 (#1175 / #1179)` を出す**（退行させない）。
main_side_verdict() {
  local prod_age=$1 code body fetched ep age
  if [ -z "$MAIN_META_URL" ]; then
    echo "main を読めなかった (読み先が設定されていない: PROBE_MAIN_META_URL)"; return 0
  fi
  body="$TMP/main-meta.json"
  code=$(curl -sS --max-time "$TIMEOUT" -o "$body" -w '%{http_code}' "$MAIN_META_URL" 2>/dev/null) || code=000
  if [ "$code" != 200 ]; then
    echo "main を読めなかった (HTTP $code)"; return 0
  fi
  fetched=$(grep -o '"fetchedAt": *"[^"]*"' "$body" | head -1 | sed 's/.*: *"//; s/"$//')
  ep=''
  if [ -n "$fetched" ]; then ep=$(date -u -d "$fetched" +%s 2>/dev/null || true); fi
  if [ -z "$ep" ]; then
    echo "main を読めなかった (fetchedAt missing or unparseable)"; return 0
  fi
  age=$(( ($(date +%s) - ep) / 3600 ))
  if [ "$age" -gt "$MAX_AGE_HOURS" ]; then
    # #1230: **ここが 2 つに分かれる。** main に新しいデータが無いのは
    #   (a) ETL が作れていない（本物の故障）か、(b) 作れているが**意図して止めてある**かで、**対処が逆**である。
    # **(b) を言えるときだけ上書きし、言えなければ従来どおり (a) を出す**（下の `else` の 1 行は不変）。
    local hold; hold=$(refresh_hold_verdict "$age")
    if [ -n "$hold" ]; then
      echo "main も古い (${age}h); ${hold}"
    else
      # **ETL 側**。main に新しいデータがそもそも無いので、deploy を起動しても何も変わらない。
      echo "main も古い (${age}h) → ETL 側 (#1175 / #1179)"
    fi
  else
    # **deploy 側**。main には ${age}h のデータが在るのに、本番は ${prod_age}h。
    echo "main は新しい (${age}h) のに本番は ${prod_age}h → deploy 側 (deploy-data.yml を起動)"
  fi
}

# ---- data ----
if [ "$meta_code" != 200 ]; then
  fail data "meta.json not fetched ($meta_code)"
else
  # top-level "fetchedAt" comes first in DatasetMeta (docs/DATA_CONTRACT.md); the sources' own fetchedAt follow
  fetched=$(grep -o '"fetchedAt": *"[^"]*"' "$META" | head -1 | sed 's/.*: *"//; s/"$//')
  fetched_epoch=$(date -u -d "$fetched" +%s 2>/dev/null || true)
  if [ -z "$fetched" ] || [ -z "$fetched_epoch" ]; then
    fail data "fetchedAt missing or unparseable"
  else
    age_h=$(( ($(date +%s) - fetched_epoch) / 3600 ))
    if [ "$age_h" -le "$MAX_AGE_HOURS" ]; then
      ok data
    else
      # #1185: 古いときだけ main 側を読み、**どちら側の故障かを名指しする。**
      # **ここで「読めなかった」を「古くない」に倒さないこと**（#1056）。
      fail data "fetchedAt ${age_h}h old (limit ${MAX_AGE_HOURS}h); $(main_side_verdict "$age_h")"
    fi
  fi
fi

# ---- tls ----
not_after=$(openssl s_client -servername "$HOST" -connect "$HOST:443" </dev/null 2>/dev/null \
  | openssl x509 -noout -enddate 2>/dev/null | sed -n 's/^notAfter=//p' || true)
na_epoch=$(date -u -d "$not_after" +%s 2>/dev/null || true)
if [ -z "$not_after" ] || [ -z "$na_epoch" ]; then
  fail tls "certificate expiry not readable"
else
  days=$(( (na_epoch - $(date +%s)) / 86400 ))
  if [ "$days" -ge "$TLS_MIN_DAYS" ]; then ok tls; else fail tls "certificate expires in ${days} days (limit ${TLS_MIN_DAYS})"; fi
fi

exit $FAILED
