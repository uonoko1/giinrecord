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
# /compare は何も無い、/__spa-fallback.html はある」という形だけ。
ROOT="$TMP/html"
mkdir -p "$ROOT"/{members/m_1,coverage,assemblies,rollcalls,assets,data}
echo '<html lang="ja"><title>トップ ・ 議員レコード</title>' > "$ROOT/index.html"
for d in members members/m_1 coverage assemblies rollcalls; do
  echo "<html lang=\"ja\"><title>$d ・ 議員レコード</title>" > "$ROOT/$d/index.html"
done
echo '<html lang="ja"><title>ページが見つかりません ・ 議員レコード</title><meta name="robots" content="noindex">' > "$ROOT/__spa-fallback.html"
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
  if [ "$bad" = 0 ]; then PASS=$((PASS+1)); echo "ok   404 の本文は SPA fallback（lang=ja・サイト名・noindex）"
  else FAIL=$((FAIL+1)); echo "FAIL 404 の本文"; fi
}
t_body

# ---- fallback 自体は直接取れない（同じ中身が 2 つの URL で索引されるのを防ぐ） ----
assert_status /__spa-fallback.html 404 "#325: internal。直接は取れない"

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
