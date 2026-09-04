#!/usr/bin/env bash
# Issue #482: Permissions-Policy が無かった。使っていないブラウザ機能を明示的に閉じる。
#
# **なぜ設定ファイルの文字列検査では足りないか**（このテストの存在理由）:
# nginx の `add_header` は**継承されない**。正確には「その階層に add_header が**1つでもあれば**、
# 外側の階層の add_header は**全部**無効になる」。site.conf には Cache-Control を足す location が
# 3つある（/assets/ /data/ /fonts/）ので、**素朴に server 階層へ足しただけでは、
# JS・CSS・JSON・フォントにセキュリティヘッダが1つも付かない**。
# しかも設定ファイルとしては完全に「それらしく」書けるので、grep では絶対に見つからない。
#
# だからここは **本物の nginx を起動して、location ごとに実際のレスポンスヘッダを見る**。
# （deploy/test/nginx-404.test.sh と同じ流儀。packages/etl/test/deploy-docker.test.ts は
#  文字列を固定する係で、こちらは「実際に配信して出るか」を見る係。）
#
#   bash deploy/test/nginx-headers.test.sh
# docker が無い環境では skip する（CI の check ジョブは docker を持つ ubuntu-latest）。
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY=$(cd "$HERE/.." && pwd)
CONF=${SITE_CONF:-$DEPLOY/nginx/site.conf}
IMAGE=${NGINX_TEST_IMAGE:-nginx:1.27-alpine}
PASS=0; FAIL=0

if ! docker info >/dev/null 2>&1; then
  echo "skip nginx-headers.test.sh: docker is not available"
  exit 0
fi

TMP=$(mktemp -d)
NAME="giinrecord-nginx-headers-test-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

# 合成の docroot: 要るのは「location ごとに実在するファイルが1つある」という形だけ。
ROOT="$TMP/html"
mkdir -p "$ROOT"/{members/m_1,assets,data,fonts}
echo '<html lang="ja"><title>トップ ・ 議員レコード</title>' > "$ROOT/index.html"
echo '<html lang="ja"><title>議員 ・ 議員レコード</title>'   > "$ROOT/members/m_1/index.html"
echo '<html lang="ja"><title>ページが見つかりません ・ 議員レコード</title>' > "$ROOT/__spa-fallback.html"
echo 'body{}' > "$ROOT/assets/a.css"
echo '{}'     > "$ROOT/data/meta.json"
printf 'x'    > "$ROOT/fonts/a.woff2"

docker run -d --name "$NAME" -p 127.0.0.1:0:80 \
  -v "$CONF:/etc/nginx/conf.d/default.conf:ro" \
  -v "$ROOT:/usr/share/nginx/html:ro" "$IMAGE" >/dev/null

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

# コンテナが付ける「全応答に出ていてほしい」ヘッダ。
# HSTS はここには**入れない**——TLS を終端しているのはホスト nginx だけで、コンテナは 127.0.0.1 の
# 平文で受けている（deploy/nginx-host-proxy.conf・#387）。コンテナからは付けようがない。
SECURITY_HEADERS=(
  'X-Content-Type-Options: nosniff'
  'X-Frame-Options: DENY'
  'Referrer-Policy: strict-origin-when-cross-origin'
  'Content-Security-Policy: default-src'
  'Permissions-Policy: '
)

# assert_headers <path> <なぜ>: そのパスの応答に上の全部が出ているか
assert_headers() {
  local path=$1 why=$2 h bad=0 want
  h=$(curl -sSI "$BASE$path" | tr -d '\r')
  for want in "${SECURITY_HEADERS[@]}"; do
    case "$h" in *"$want"*) ;; *) echo "    x $path に \"$want\" が無い"; bad=1;; esac
  done
  if [ "$bad" = 0 ]; then PASS=$((PASS+1)); echo "ok   $path  ($why)"
  else FAIL=$((FAIL+1)); echo "FAIL $path  ($why)"; fi
}

echo "-- 全 location でセキュリティヘッダ 5 種が出る（add_header 継承の罠 #482）"
assert_headers /                 "server 階層そのまま"
assert_headers /members/m_1/     "プリレンダー済みページ"
assert_headers /compare          "#104: location = /compare"
# ↓ ここが本命。add_header Cache-Control を持つ location（site.conf の /assets/ /data/ /fonts/）。
#   server 階層にだけ書くと、この 3 つで**セキュリティヘッダが全部消える**。
assert_headers /assets/a.css     "#482 本命: add_header Cache-Control を持つ location"
assert_headers /data/meta.json   "#482 本命: add_header Cache-Control を持つ location"
assert_headers /fonts/a.woff2    "#482 本命: add_header Cache-Control を持つ location"
assert_headers /__health         "location = /__health（return 200）"

echo "-- エラー応答にも出る（always）"
assert_headers /this-does-not-exist/ "404。always が付いているか"
assert_headers /__spa-fallback.html  "internal → 404"

echo "-- Cache-Control は消えていない（ヘッダを足して既存を壊していないか）"
t_cache_control() {
  local bad=0 got
  for pair in "/assets/a.css:max-age=31536000" "/data/meta.json:max-age=3600" "/fonts/a.woff2:max-age=604800"; do
    local path=${pair%%:*} want=${pair#*:}
    got=$(curl -sSI "$BASE$path" | tr -d '\r' | grep -i '^cache-control:' || true)
    case "$got" in *"$want"*) ;; *) echo "    x $path の Cache-Control が [$got]（$want を期待）"; bad=1;; esac
  done
  if [ "$bad" = 0 ]; then PASS=$((PASS+1)); echo "ok   3 つの location の Cache-Control が残っている"
  else FAIL=$((FAIL+1)); echo "FAIL Cache-Control"; fi
}
t_cache_control

echo "-- Permissions-Policy の中身（閉じた機能が実際に閉じているか）"
t_permissions_policy_value() {
  local pp bad=0 f
  pp=$(curl -sSI "$BASE/" | tr -d '\r' | grep -i '^permissions-policy:' || true)
  if [ -z "$pp" ]; then FAIL=$((FAIL+1)); echo "FAIL Permissions-Policy が無い"; return; fi
  # 使っていないと数えた機能（PR 本文に数え方あり）は allowlist が**空** = `feature=()`
  for f in accelerometer autoplay camera display-capture encrypted-media fullscreen geolocation \
           gyroscope magnetometer microphone midi payment picture-in-picture \
           publickey-credentials-get screen-wake-lock usb xr-spatial-tracking; do
    case "$pp" in *"$f=()"*) ;; *) echo "    x $f=() が無い"; bad=1;; esac
  done
  # `*` や `self` で開けたものがあってはいけない（このサイトはどれも使っていない）
  case "$pp" in *'=(self'*|*'=*'*) echo "    x 開いている機能がある: $pp"; bad=1;; esac
  if [ "$bad" = 0 ]; then PASS=$((PASS+1)); echo "ok   閉じた機能はすべて空 allowlist（feature=() の形）"
  else FAIL=$((FAIL+1)); echo "FAIL Permissions-Policy の中身: $pp"; fi
}
t_permissions_policy_value

echo "-- Server ヘッダにバージョンが出ない（#386 の回帰よけ）"
t_server_tokens() {
  local s; s=$(curl -sSI "$BASE/" | tr -d '\r' | grep -i '^server:' || true)
  if [ "$s" = "Server: nginx" ]; then PASS=$((PASS+1)); echo "ok   $s"
  else FAIL=$((FAIL+1)); echo "FAIL Server ヘッダ: [$s]"; fi
}
t_server_tokens

echo "-- $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
