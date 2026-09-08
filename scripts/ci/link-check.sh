#!/usr/bin/env bash
# Issue #646: 一次資料 URL の死活を、ETL とは別に定期で確かめる。
#
#   bash scripts/ci/link-check.sh                 # data/assemblies を歩いて全 URL を確かめる
#   bash scripts/ci/link-check.sh --list          # 確かめる URL を1行ずつ出すだけ（叩かない）
#   bash scripts/ci/link-check.sh --urls <file>   # URL 一覧をファイルから読む（テスト用）
#
# なぜ要るか: 地方議会の ETL は月1回（local-assemblies.yml、毎月5日）。島根が
# ugoki/saikin/ → ugoki/gikai_kako/ に URL を移したとき、本番には 404 の一次資料リンクが
# 3件出たまま、次の ETL（翌月5日）まで誰も気づかなかった。ETL 自体は落ちるが、
# 「走らないと落ちない」。monitor.yml はサイトの死活を見るが、一次資料の URL は見ていない。
#
# 出力: 1 URL 1行、`ok <url> <code>` / `fail <url> <code>`（末尾に summary 行）。何か落ちたら exit 1。
#
# ── 設計上、意図的にやらないこと ──────────────────────────────────────────────
#   * **data/ を書き換えない。** 404 の移動先が正しいかを判断するのは ETL か人間の仕事で、
#     リンクチェッカーの仕事ではない。このスクリプトは data/ を読むだけ。
#   * **1回の 404 で騒がない。** 一時的な障害と恒久的な移動を、HTTP のステータスだけでは
#     区別できない。落ちた URL だけを LINK_CHECK_RETRY_SLEEP 秒後にもう一度叩き、
#     **2回とも落ちたものだけ**を fail として報告する（deploy/monitor/run.sh と同じ形）。
#   * **並列に叩かない。** 相手は自治体のサーバー。1本ずつ、LINK_CHECK_INTERVAL（既定 1）秒
#     以上あけて、UA を名乗って叩く（packages/etl/src/sources/local/polite-fetch.ts と同じ姿勢）。
#
# ── HEAD ではなく GET で確かめる理由 ─────────────────────────────────────────
#   HEAD を拒む（405 / 403 を返す）サーバーは珍しくない。**利用者がリンクを踏んで見るのは
#   GET の結果**なので、GET で確かめる。本文は捨てる（-o /dev/null）が、PDF を丸ごと
#   落とすのは相手にもこちらにも重いので --max-filesize で頭だけ取り、
#   **サイズ超過による中断（curl 63）は「届いた」＝ ok として扱う**（HTTP のステータスは
#   もう受け取っている）。
#
# 環境変数:
#   LINK_CHECK_INTERVAL      リクエストの間隔（秒、既定 1）
#   LINK_CHECK_RETRY_SLEEP   1回目に落ちた URL を叩き直すまでの待ち（秒、既定 60）
#   LINK_CHECK_TIMEOUT       1リクエストの上限（秒、既定 30）
#   LINK_CHECK_UA            User-Agent（既定は下の UA_DEFAULT）
#   LINK_CHECK_DATA_DIR      走査するディレクトリ（既定 data/assemblies）
#   Tests: scripts/ci/test/link-check.test.sh（curl と sleep はスタブ）
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)

UA_DEFAULT='giinrecord-linkcheck/1.0 (+https://giinrecord.jp)'
UA=${LINK_CHECK_UA:-$UA_DEFAULT}
INTERVAL=${LINK_CHECK_INTERVAL:-1}
RETRY_SLEEP=${LINK_CHECK_RETRY_SLEEP:-60}
TIMEOUT=${LINK_CHECK_TIMEOUT:-30}
DATA_DIR=${LINK_CHECK_DATA_DIR:-$ROOT/data/assemblies}
MAX_BYTES=${LINK_CHECK_MAX_BYTES:-65536}

MODE=check
URL_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --list) MODE=list; shift ;;
    --urls) URL_FILE=${2:-}; [ -n "$URL_FILE" ] || { echo "usage: link-check.sh --urls <file>" >&2; exit 2; }; shift 2 ;;
    *) echo "usage: link-check.sh [--list] [--urls <file>]" >&2; exit 2 ;;
  esac
done

# ---- URL を集める ----------------------------------------------------------------------------
# 正規表現ではなく JSON として読む（#451/#472: 構文を推測しない）。data/ の値のうち
# http(s) で始まる文字列がそのまま一次資料の URL（sourceUrl / pdfUrl / sources[].url）。
# どのキーかを列挙しないのは、新しいキーが増えたときに黙って見落とさないため。
collect_urls() {
  # shellcheck disable=SC2016  # 中身は JS。シェルに展開させてはいけないので単一引用符のまま
  node -e '
    const { readdirSync, readFileSync } = require("node:fs");
    const out = new Set();
    const rec = (v) => {
      if (typeof v === "string") { if (/^https?:\/\//.test(v)) out.add(v); }
      else if (Array.isArray(v)) v.forEach(rec);
      else if (v && typeof v === "object") Object.values(v).forEach(rec);
    };
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = `${d}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".json")) rec(JSON.parse(readFileSync(p, "utf8")));
      }
    };
    walk(process.argv[1]);
    process.stdout.write([...out].sort().join("\n") + (out.size ? "\n" : ""));
  ' "$DATA_DIR"
}

if [ -n "$URL_FILE" ]; then
  URLS=$(sed '/^[[:space:]]*$/d' "$URL_FILE")
else
  URLS=$(collect_urls)
fi

if [ "$MODE" = list ]; then printf '%s\n' "$URLS"; exit 0; fi

TOTAL=$(printf '%s\n' "$URLS" | sed '/^$/d' | wc -l | tr -d ' ')
if [ "$TOTAL" = 0 ]; then
  # 0件を「全部 ok」と読むと、走査が壊れたときに永久に緑になる（#500: 入口を固定する）。
  echo "link-check: 確かめる URL が 1 件も見つからない（$DATA_DIR）。走査が壊れている可能性がある" >&2
  exit 2
fi

# ---- 1本叩く --------------------------------------------------------------------------------
# probe <url> → HTTP のステータスを標準出力に出す。接続できなければ 000。
# --max-filesize で頭だけ取る。超過（curl 63）はステータスを受け取ったあとなので成功扱い。
probe() {
  local url=$1 code status
  set +e
  code=$(curl -sS -L --max-time "$TIMEOUT" --max-filesize "$MAX_BYTES" \
    -A "$UA" -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)
  status=$?
  set -e
  # curl の終了コードで「HTTP のステータスを受け取ったか」を決める。
  #   0  ふつうに取れた
  #   63 --max-filesize 超過。**ステータス行はもう受け取っている**（実測: 島根の表決 PDF は
  #      65536 バイトを超えるので毎回これになる。ここを落とすと PDF が全部 fail になる）
  # それ以外（DNS 6・接続 7・タイムアウト 28 …）は**届いていない**ので 000 にする。
  # curl は接続に失敗しても %{http_code} に 000 を出すとは限らないので、
  # code の中身ではなく**終了コードで**決める（#514: 当たっていない検査は無意味）。
  case "$status" in
    0|63) : ;;
    *) code=000 ;;
  esac
  printf '%s' "${code:-000}"
}

# 相手は自治体のサーバー。1本ずつ、間隔をあけて叩く（並列にしない）。
# round <url-list> <outfile> → "<code> <url>" を1行ずつ書く
round() {
  local list=$1 out=$2 url first=1
  : > "$out"
  while IFS= read -r url; do
    [ -n "$url" ] || continue
    if [ "$first" = 1 ]; then first=0; else sleep "$INTERVAL"; fi
    echo "$(probe "$url") $url" >> "$out"
  done <<< "$list"
}

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

round "$URLS" "$TMP/r1"
# 2xx / 3xx（-L で追った先が最終ステータス）を ok とする。それ以外を怪しいとして持ち越す。
BAD1=$(awk '$1 !~ /^[23][0-9][0-9]$/ { print $2 }' "$TMP/r1")

# ---- 2回目（1回目に落ちたものだけ） -----------------------------------------------------------
# 恒久的な移動と一時的な障害を区別できないので、1回の失敗では報告しない。
declare -A FINAL_CODE=()
while read -r code url; do [ -n "$url" ] && FINAL_CODE["$url"]=$code; done < "$TMP/r1"

CONFIRMED=""
if [ -n "$BAD1" ]; then
  echo "link-check: 1回目に $(printf '%s\n' "$BAD1" | wc -l | tr -d ' ') 件が落ちた。${RETRY_SLEEP}s 後に叩き直す" >&2
  sleep "$RETRY_SLEEP"
  round "$BAD1" "$TMP/r2"
  while read -r code url; do
    [ -n "$url" ] || continue
    FINAL_CODE["$url"]=$code
    case "$code" in
      2??|3??) : ;;                                    # 2回目は通った = 一時的。報告しない
      *) CONFIRMED+="$url"$'\n' ;;
    esac
  done < "$TMP/r2"
fi

# ---- 報告 -----------------------------------------------------------------------------------
FAILED=0
while IFS= read -r url; do
  [ -n "$url" ] || continue
  if [ -n "$CONFIRMED" ] && grep -qxF -- "$url" <<< "$CONFIRMED"; then
    echo "fail $url ${FINAL_CODE[$url]}"
    FAILED=1
  else
    echo "ok $url ${FINAL_CODE[$url]}"
  fi
done <<< "$URLS"

NFAIL=$(printf '%s' "$CONFIRMED" | sed '/^$/d' | wc -l | tr -d ' ')
echo "summary: checked=$TOTAL failed=$NFAIL"
exit $FAILED
