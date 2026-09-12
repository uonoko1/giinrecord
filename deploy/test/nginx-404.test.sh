#!/usr/bin/env bash
# Issue #325: 存在しない URL が HTTP 200 を返し、SPA fallback（lang="en" / <title>Loading...</title>）が出ていた。
# 直したのは deploy/nginx/site.conf の try_files。ここは「設定ファイルの文字列」ではなく
# **本物の nginx を起動して実際のステータスコード**を見る（packages/etl/test/deploy-docker.test.ts は文字列を固定する係）。
#
# なぜ実機で見るか: try_files を =404 にすると、プリレンダー済みの全ページを壊す書き方がいくつもある
# （error_page の位置、location の優先順位、internal の付け方）。どれも文字列としては「それらしく」書けるので、
# 起動して叩くまで壊れているか分からない。deploy/test/nginx-reload.test.sh と同じ流儀で、ここでは docker の
# nginx に site.conf をそのまま食わせ、合成の docroot（プリレンダー済みページの形だけを真似たもの）で確かめる。
#
#   bash deploy/test/nginx-404.test.sh
# docker が無い環境では skip する（CI の check ジョブは docker を持つ ubuntu-latest）。
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY=$(cd "$HERE/.." && pwd)
CONF="$DEPLOY/nginx/site.conf"
IMAGE=${NGINX_TEST_IMAGE:-nginx:1.27-alpine}
PASS=0; FAIL=0

if ! docker info >/dev/null 2>&1; then
  echo "skip nginx-404.test.sh: docker is not available"
  exit 0
fi

TMP=$(mktemp -d)
NAME="giinrecord-nginx-404-test-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

# 合成の docroot: 本物のビルドは要らない。要るのは「プリレンダー済みページはディレクトリ + index.html、
# /compare は何も無い、/__spa-fallback.html と /__not-found/index.html はある」という形だけ。
ROOT="$TMP/html"
mkdir -p "$ROOT"/{members/m_1,coverage,assemblies,rollcalls,assets,data,__not-found}
echo '<html lang="ja"><title>トップ ・ 議員レコード</title>' > "$ROOT/index.html"
for d in members members/m_1 coverage assemblies rollcalls; do
  echo "<html lang=\"ja\"><title>$d ・ 議員レコード</title>" > "$ROOT/$d/index.html"
done
# /__spa-fallback.html は本物のビルドでもルート `/` の <title>（「議員レコード」のみ）で「見つかりません」
# を含まない（apps/web/app/root.tsx の HydrateFallback。#104 で /compare の 200 本文として使う）。
# ここで「見つかりません」を書いてしまうと、error_page 404 が誤って /__spa-fallback.html を指す
# 退行を、下の t_body / assert_status が検出できなくなる（実測: 誤って書いていたときは 21/21 green のまま通った）。
echo '<html lang="ja"><title>議員レコード</title><meta name="robots" content="noindex">' > "$ROOT/__spa-fallback.html"
# Issue #610: 404 の本文は catch-all のプリレンダー済み HTML（JS 無しでも「見つかりません」を含む）。
# /__spa-fallback.html はルート `/` だけをレンダーした殻なので、404 の本文には使えない。
echo '<html lang="ja"><title>ページが見つかりません ・ 議員レコード</title><meta name="robots" content="noindex">見つかりません' > "$ROOT/__not-found/index.html"
echo 'body{}' > "$ROOT/assets/a.css"
echo '{}' > "$ROOT/data/meta.json"

docker run -d --name "$NAME" -p 127.0.0.1:0:80 \
  -v "$CONF:/etc/nginx/conf.d/default.conf:ro" \
  -v "$ROOT:/usr/share/nginx/html:ro" "$IMAGE" >/dev/null

# nginx -t（deploy/test/nginx-reload.test.sh と同じ規律: 設定が通らないなら先へ進まない）
if ! docker exec "$NAME" nginx -t >"$TMP/nginx-t" 2>&1; then
  echo "FAIL nginx -t"; cat "$TMP/nginx-t"; exit 1
fi
echo "ok   nginx -t（site.conf が構文として通る）"; PASS=$((PASS+1))

PORT=$(docker port "$NAME" 80/tcp | head -1 | sed 's/.*://')
BASE="http://127.0.0.1:$PORT"
for _ in $(seq 1 50); do
  curl -sS -o /dev/null "$BASE/__health" 2>/dev/null && break
  sleep 0.2
done

status() { curl -sS -o "$TMP/body" -w '%{http_code}' "$BASE$1" 2>/dev/null || echo 000; }

# assert_status <path> <expected> <なぜ>
assert_status() {
  local path=$1 want=$2 why=$3 got
  got=$(status "$path")
  if [ "$got" = "$want" ]; then
    PASS=$((PASS+1)); echo "ok   $path -> $got  ($why)"
  else
    FAIL=$((FAIL+1)); echo "FAIL $path -> $got, expected $want  ($why)"
  fi
}

# ---- プリレンダー済みルートは 200 のまま（#325 で壊しやすい所。これが本題の半分） ----
assert_status /                    200 "プリレンダー済み: index.html"
assert_status /members/            200 "プリレンダー済み"
assert_status /members/m_1/        200 "プリレンダー済みの議員ページ"
assert_status /coverage/           200 "プリレンダー済み"
assert_status /assemblies/         200 "プリレンダー済み"
assert_status /rollcalls/          200 "プリレンダー済み"
assert_status /assets/a.css        200 "静的アセット"
assert_status /data/meta.json      200 "外形監視が読む"
assert_status /__health            200 "コンテナの healthcheck"

# ---- クエリ依存でプリレンダーしない SPA ページ（#104）は 200 ----
assert_status '/compare'           200 "#104: クエリ依存・プリレンダー無し。fallback の本文を 200 で返す"
assert_status '/compare?m=m_1,m_2' 200 "#104: クエリ付きでも 200"

# ---- 存在しない URL は 404（#325 の本題） ----
assert_status /this-does-not-exist/ 404 "#325: 存在しない URL"
assert_status /bills/               404 "#325: 未実装のパス"
assert_status /search/              404 "#325: 未実装のパス"
assert_status /members/m_nope/      404 "#325: 実在しない議員 id"
assert_status /compare/extra/       404 "#325: /compare の下は実在しない（前方一致で 200 にしない）"

# ---- 404 の本文（ステータスだけ 404 で、中身は出す） ----
t_body() {
  local got; got=$(status /this-does-not-exist/)
  if [ "$got" != 404 ]; then FAIL=$((FAIL+1)); echo "FAIL 404 本文: status $got"; return; fi
  local body; body=$(cat "$TMP/body")
  local bad=0
  case "$body" in *'lang="ja"'*) ;; *) echo "    x lang=\"ja\" が無い"; bad=1;; esac
  case "$body" in *'議員レコード'*) ;; *) echo "    x <title> にサイト名が無い"; bad=1;; esac
  case "$body" in *'noindex'*) ;; *) echo "    x noindex が無い"; bad=1;; esac
  case "$body" in *'<html'*) ;; *) echo "    x nginx の既定 404 ページ（本文が出ていない）"; bad=1;; esac
  # Issue #610: JS 無しでも「見つかりません」の文字が本文に出ていること。
  # /__spa-fallback.html（ルート `/` だけの殻）を誤って 404 の本文に使うと、ここだけが落ちる。
  case "$body" in *'見つかりません'*) ;; *) echo "    x 「見つかりません」が本文に無い（JS 無しでは読めない = #610）"; bad=1;; esac
  if [ "$bad" = 0 ]; then PASS=$((PASS+1)); echo "ok   404 の本文は JS 無しでも「見つかりません」まで含む（lang=ja・サイト名・noindex）"
  else FAIL=$((FAIL+1)); echo "FAIL 404 の本文"; fi
}
t_body

# ---- fallback / not-found 自体は直接取れない（同じ中身が別の 200 URL としても索引されるのを防ぐ） ----
assert_status /__spa-fallback.html      404 "#325: internal。直接は取れない"
assert_status /__not-found/index.html   404 "#610: internal。直接は取れない"
# Issue #746: **末尾なし・スラッシュ付きも塞ぐ。** #654 は `location = /__not-found/index.html` に
# `internal` を付けただけだったので、`location /` の `try_files $uri $uri/index.html` が
# **`/__not-found` を `/__not-found/index.html` に内部解決して 200 を返していた**
# （`internal` が拒むのは「外部からの要求」だけで、try_files の内部解決は通る）。
# 本番実測（2026-09-13、反映直後）: /__not-found/index.html は 404、**/__not-found と /__not-found/ は 200**
# で本文に「ページが見つかりません」が出ていた = 同じ本文が別の 200 URL としても索引されうる（#325 の再現）。
assert_status /__not-found              404 "#746: 末尾なし。try_files の内部解決に拾わせない"
assert_status '/__not-found/'           404 "#746: スラッシュ付き"
assert_status /__not-found/anything     404 "#746: 配下も 200 にしない"
# **ステータスだけを見ると足りない。** #746 の症状は「**200 で**『ページが見つかりません』を返す」
# ——つまり *同じ本文が、自分自身の URL として索引可能な 200 で二重に存在する* こと。
# 404 の本文に「見つかりません」が出るのは **正しい**（error_page がこの HTML を 404 の本文に使う。#610）ので、
# ここで禁じるのは「200 かつ not-found の本文」の組み合わせだけ。
# **status だけの assert と分けてある理由**: 将来 `return 404 ""` のように本文ごと消す直し方をすると
# status の assert は通るが #610 が壊れる。逆に本文だけ見ると 200 を見逃す。両方見る。
t_not_found_variants_body() {
  local bad=0 path got body
  for path in /__not-found /__not-found/ /__not-found/index.html; do
    got=$(status "$path")
    body=$(cat "$TMP/body")
    if [ "$got" != 200 ]; then continue; fi
    bad=1
    case "$body" in
      *'見つかりません'*) echo "    x $path が 200 で not-found の本文を返している（#746 の症状そのもの）";;
      *) echo "    x $path が 200（内容は別だが、内部用のパスが外から開けている）";;
    esac
  done
  if [ "$bad" = 0 ]; then PASS=$((PASS+1)); echo "ok   #746: /__not-found の 3 つの綴りはどれも 200 で本文を出さない"
  else FAIL=$((FAIL+1)); echo "FAIL #746: /__not-found の綴り違いが 200 を返す"; fi
}
t_not_found_variants_body

# ---- セキュリティヘッダは 404 にも付く ----
t_headers() {
  local h; h=$(curl -sSI "$BASE/this-does-not-exist/" | tr -d '\r')
  local bad=0
  for want in 'X-Content-Type-Options: nosniff' 'X-Frame-Options: DENY' 'Content-Security-Policy:'; do
    case "$h" in *"$want"*) ;; *) echo "    x 404 に $want が無い"; bad=1;; esac
  done
  if [ "$bad" = 0 ]; then PASS=$((PASS+1)); echo "ok   404 にもセキュリティヘッダが付く（add_header ... always）"
  else FAIL=$((FAIL+1)); echo "FAIL 404 のセキュリティヘッダ"; fi
}
t_headers

echo "-- $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
