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

# ---- site.conf の location を**全部**数え上げる（#499）----
# 以前はここが `/`・`/assets/`・`/data/`・`/fonts/` の**4パス決め打ち**（allowlist）だった。
# **新しく足された location は一度も叩かれない**ので、そこで add_header 継承が消えていても
# 13 passed / 0 failed になる——レビュアーが実配信で確認した（#499）。
# allowlist をやめ、site.conf に書いてある location をすべて機械的に拾って、
# 「そのパスを実際に叩く」まで持っていく。**知らない書き方が出てきたら黙って飛ばさず落とす。**
#
# 拾い方: 行頭（インデントを許す）の `location` に続く修飾子とパス。nginx の location は
#   location [ = | ~ | ~* | ^~ ] uri { ... }
# の形。ここで扱えるのは `=`（完全一致）・`^~` と修飾子なし（前方一致）まで。
# 正規表現（`~` `~*`）は「どのパスを叩けば当たるか」を機械的に決められないので、**明示的に落とす**
# （そのときは、このファイルに叩くパスを足すこと）。
LOCATIONS=$(grep -Eo '^[[:space:]]*location[[:space:]]+[^{]*' "$CONF" | sed -E 's/^[[:space:]]*location[[:space:]]+//; s/[[:space:]]+$//')
if [ -z "$LOCATIONS" ]; then echo "FAIL site.conf から location を1つも拾えなかった"; exit 1; fi

# **この数え上げ自身の検査**（#451「検査器のテストが無いと、検査が死んでも緑」）。
# 上の grep が壊れて 1 つしか拾えなくなっても、下のループは黙って回り、**全部 pass する**。
# それでは allowlist をやめた意味が無いので、**独立な数え方**で数えた location の数と突き合わせる。
# 独立にした点: 上は「行頭の location 行」を**行単位**で拾う。下は `{` の**出現**を数える
# （コメント行の "location" を除いてから）。同じ壊れ方をしないように、拾う対象をずらしてある。
WANT_LOCS=$(sed -E 's/^[[:space:]]*#.*$//' "$CONF" | grep -c 'location[^;]*{' || true)
GOT_LOCS=$(printf '%s\n' "$LOCATIONS" | grep -c . || true)
if [ "$GOT_LOCS" != "$WANT_LOCS" ]; then
  echo "FAIL location の数え上げが壊れている: 拾えた $GOT_LOCS 個 / site.conf にある $WANT_LOCS 個"
  echo "     拾えたもの: $(printf '%s\n' "$LOCATIONS" | tr '\n' '|')"
  exit 1
fi
echo "ok   site.conf の location を $GOT_LOCS 個すべて拾った（独立な数え方と一致）"; PASS=$((PASS+1))

# location の指定 -> 実際に叩く URL パス。前方一致の location にはプローブ用のファイルを置く。
PROBE_PATHS=()
ROOT="$TMP/html"
mkdir -p "$ROOT/members/m_1"
echo '<html lang="ja"><title>トップ ・ 議員レコード</title>' > "$ROOT/index.html"
echo '<html lang="ja"><title>議員 ・ 議員レコード</title>'   > "$ROOT/members/m_1/index.html"
echo '<html lang="ja"><title>ページが見つかりません ・ 議員レコード</title>' > "$ROOT/__spa-fallback.html"

# ---- 拾った URI を、プローブの置き先に使う前に検査する（#505）----
# **何が起きていたか**: 下の `mkdir -p "$ROOT$pfx"` は、site.conf の location を**そのまま**
# パスとして連結していた。`location /../../escaped/` を書くと $ROOT の外に書き、
# **17 passed / 0 failed（exit 0）のまま** cleanup の `rm -rf "$TMP"` では消えないゴミが残る。
# `..` は根を超えると根で止まるので、`../` を並べれば**書ける場所ならどこにでも**届く
# （実測: 10 段並べると /tmp に着地した）。
#
# **攻撃経路ではない。** site.conf は自分たちが書くファイルで、外部から `..` を注入される経路は無い。
# 実害は「テスト実行が $TMP の外にゴミを残す」程度。**それでも塞ぐ**のは、検査が意図しない場所を
# 読み書きしうる状態だと、**レビューで見えない形の間違い**を許すから
# （作業合意「防御は不可能にすることではなく、隠れて通れなくすること」）。
#
# **`..` を弾く1行では足りない**（作業合意 #333「denylist ではなく allowlist」）。
# `..` だけを禁じても、絶対パス風・`~`・シェルメタ文字・空白・グロブはそのまま流れる。
# 綴りの変種と「まだ知らない危険な形」に denylist は原理的に勝てない。
# だから**通してよい形を書き出して照合する**。増えた瞬間に落ちる = レビューが強制される。
#
# 通す形: 先頭が `/`、以降は `[A-Za-z0-9._-]` と `/` のみ。nginx の location URI として
# このサイトが実際に使うのはこの範囲（`/` `/compare` `/__spa-fallback.html` `/assets/` `/data/`
# `/fonts/` `/__health`）。**`.` は許すが `..` は下で別に禁じる**（`__probe.txt` や
# `/__spa-fallback.html` に `.` が要るため、`.` ごと禁じると正しい形まで落ちる）。
# パーセントエンコード（`%2e%2e`）は許さない — 上の文字集合に `%` が入っていないので弾かれる。
# **`~` は URL としては予約外の普通の字だが、ここでは許さない**: site.conf は 1 つも使っておらず、
# 許すと `$ROOT/~/...` という**シェルが展開しうる名前**のディレクトリを掘る。
# 「今は引用しているから安全」ではなく、**形そのものを拒む**（実測: 許したままだと
# `/~/pbi505/` が 15 形中ただ 1 つ素通りした）。
#
# **経路が2つあるので、それぞれ別々に釘を打つ**（作業合意 #485）:
#   (1) 入口 = URI の形（この関数）
#   (2) 出口 = 実際の書き先が $ROOT の下に収まっているか（下の assert_under_root）
# (1) だけだと、将来 (1) を緩めたときに黙って外へ書ける。(2) だけだと、$ROOT の中に
# `/~/` や `/*/` のような意図しない名前を掘るのを止められない。
#
# **変異で確かめた結果**（deploy/test/nginx-headers-probe-safety.test.sh で測定）:
# **片方の釘だけを外しても落ちない。これは穴ではなく、二重化そのもの**である。
#   - `..` の判定だけ消す        → もう一方（assert_under_root）が
#     「プローブ置き先が docroot の外に出る」で捕まえ、**何も作られない**（実測）
#   - assert_under_root を殺す   → allowlist が「.. は traversal になる」で捕まえる（実測）
#   - assert_safe_uri の `exit 1` だけ消す → assert_under_root の `exit 1` が止める（実測）
# **両方を同時に外すと、元の穴がそのまま戻る**: `location /../../rev502-escaped/` で
# **17 passed, 0 failed（exit 0）／/tmp/rev502-escaped が残る**（実測）。
# つまりどちらも死んだコードではなく、**片方が破れたときの受け皿**として効いている。
assert_safe_uri() {
  local uri=$1 kind=$2
  case "$uri" in
    /*) ;;
    *)  echo "FAIL 安全でない location [$uri]（$kind）: URI が / で始まっていない"; FAIL=$((FAIL+1)); exit 1 ;;
  esac
  # allowlist（完全一致）。1 文字でも外の字が混ざれば落ちる。
  case "$uri" in
    *[!/A-Za-z0-9._-]*)
      echo "FAIL 安全でない location [$uri]（$kind）: 許した文字は / A-Z a-z 0-9 . _ - だけ"
      echo "     プローブの置き先にそのまま使うので、シェルメタ文字・空白・グロブ・改行は拒む（#505）"
      FAIL=$((FAIL+1)); exit 1 ;;
  esac
  # `.` は許すが、パス要素としての `..` は禁じる（traversal そのもの）。
  case "/$uri/" in
    *"/../"*)
      echo "FAIL 安全でない location [$uri]（$kind）: パス要素の .. は traversal になる（#505）"
      FAIL=$((FAIL+1)); exit 1 ;;
  esac
}

# 出口側の釘。実際に触る前に、$ROOT の下に収まるかを**パスの正規化**で確かめる。
# 入口の allowlist を将来緩めても、ここが独立に止める。
# `realpath -m` は存在しないパスも正規化する（`..` を畳む）。
assert_under_root() {
  local target=$1 uri=$2 resolved root_resolved
  resolved=$(realpath -m "$target")
  root_resolved=$(realpath -m "$ROOT")
  case "$resolved/" in
    "$root_resolved"/*) ;;
    *) echo "FAIL location [$uri] のプローブ置き先が docroot の外に出る: $resolved は $root_resolved の下にない（#505）"
       FAIL=$((FAIL+1)); exit 1 ;;
  esac
}

while IFS= read -r loc; do
  case "$loc" in
    "= "*)   uri=${loc#= }
             # 完全一致はファイルを置かない（curl で叩くだけ）が、**叩く URL にそのまま入る**ので
             # 同じ allowlist を通す。ここを素通しすると `= /../../x` が curl に渡る。
             assert_safe_uri "$uri" "完全一致"
             PROBE_PATHS+=("$uri") ;;
    "^~ "*|"/"*)                                       # 前方一致: 配下に実ファイルを1つ置いて叩く
      pfx=${loc#^~ }
      assert_safe_uri "$pfx" "前方一致"
      case "$pfx" in
        /) PROBE_PATHS+=("/") ;;
        */) assert_under_root "$ROOT${pfx}__probe.txt" "$pfx"
            mkdir -p "$ROOT$pfx"; printf 'x' > "$ROOT${pfx}__probe.txt"; PROBE_PATHS+=("${pfx}__probe.txt") ;;
        *)  assert_under_root "$ROOT$pfx" "$pfx"
            mkdir -p "$(dirname "$ROOT$pfx")"; printf 'x' > "$ROOT$pfx"; PROBE_PATHS+=("$pfx") ;;
      esac ;;
    *) echo "FAIL 未対応の location 指定 [$loc]。叩くパスを deploy/test/nginx-headers.test.sh に足すこと"; exit 1 ;;
  esac
done <<< "$LOCATIONS"

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

# **この配列自身の検査**（#451 / #499 / #504）。`SECURITY_HEADERS=()` に書き換えると、
# assert_headers は**何も見ずに全部 pass する**（実測: 空にすると継承の罠 M2 を入れても 15 passed / 0 failed）。
# 検査の中身が「空でも緑」では、allowlist をやめた意味が無い。
#
# **個数を固定するだけでは足りない**（#504。#499 の適用が「半分だけ」だった）。
# 以前ここは `${#SECURITY_HEADERS[@]} -ne 5` で**個数だけ**を見ていた。空（0 種）も 5→4 も落ちるが、
# **5→5 のすり替えが通る**:
#     -  'X-Frame-Options: DENY'
#     +  'Server: '        # 個数は 5 のまま
# `Server:` はどの応答にも必ず出るので、これと site.conf から `add_header X-Frame-Options` を
# 4 か所削除する変異を組み合わせると **16 passed / 0 failed**。#504 の担当が docker で実配信して確認し、
# **全 7 パス（/ /compare /assets/ /data/ /fonts/ プリレンダー 404）から X-Frame-Options が消えていた。**
# 個数を満たしたまま中身が空洞化する。
#
# **ヘッダ名だけを固定しても足りない**（同じく #504 で実測）。名前を残して値を空にすると:
#     -  'X-Frame-Options: DENY'
#     +  'X-Frame-Options: '   # 名前も個数もそのまま
# `Name: ` は**その名前のどんな値にも前方一致する**ので、site.conf を
# `add_header X-Frame-Options SAMEORIGIN` に変えても **16 passed / 0 failed**（docker で実配信確認）。
#
# だから**配列の要素そのもの（`名前: 値` の文字列全体）を、順序ごと**別の定数と突き合わせる。
# 期待値は**ハードコードする**。SECURITY_HEADERS 側から生成すると自己参照になり、
# **検査対象が痩せれば期待値も一緒に痩せる**（#499 のレビュアーと PO の一致した判断）。
# 同じ理由で site.conf から数えることもしない。
#
# 5 は「コンテナが全応答に付けるセキュリティヘッダ」の数（HSTS はホスト側なので数えない・#387）。
# ヘッダを増減するときは、site.conf のコメントとこの一覧の**両方**を直すこと。
#
# 末尾が `: ` で終わる2つ（CSP・Permissions-Policy）は**わざと前方一致**にしてある。値はここでは見ない:
#   - Content-Security-Policy → packages/etl/test/deploy-docker.test.ts が全文を固定する
#   - Permissions-Policy      → 下の t_permissions_policy_value が 17 機能を1つずつ実配信で見る
# 残る3つ（X-Content-Type-Options / X-Frame-Options / Referrer-Policy）は他に値を見る係が
# いないので、**ここで値まで釘を打つ**。
#
# `exit 1` の前に **`FAIL` を数えてから**落ちる。`exit 1` だけに頼ると、それを消しただけで
# 「FAIL ... と表示しながら 16 passed, 0 failed・exit 0」になる（#504 の担当が変異で実測）。
# 最後の `[ "$FAIL" -eq 0 ]` が二重の受け皿になる = **表示と終了コードが食い違わない**。
REQUIRED_SECURITY_HEADERS=(
  'X-Content-Type-Options: nosniff'
  'X-Frame-Options: DENY'
  'Referrer-Policy: strict-origin-when-cross-origin'
  'Content-Security-Policy: default-src'
  'Permissions-Policy: '
)
if [ "${#SECURITY_HEADERS[@]}" -ne "${#REQUIRED_SECURITY_HEADERS[@]}" ]; then
  echo "FAIL 要求するセキュリティヘッダが ${#REQUIRED_SECURITY_HEADERS[@]} 種でない（${#SECURITY_HEADERS[@]} 種）。増減するなら理由を site.conf のコメントと REQUIRED_SECURITY_HEADERS の両方に書くこと"
  FAIL=$((FAIL+1)); exit 1
fi
for i in "${!REQUIRED_SECURITY_HEADERS[@]}"; do
  if [ "${SECURITY_HEADERS[$i]}" != "${REQUIRED_SECURITY_HEADERS[$i]}" ]; then
    echo "FAIL SECURITY_HEADERS[$i] が [${SECURITY_HEADERS[$i]}]（[${REQUIRED_SECURITY_HEADERS[$i]}] を期待）"
    echo "     個数を保ったままヘッダ名や値を差し替えると、実配信からそのヘッダが消えても検査は緑になる（#504）"
    FAIL=$((FAIL+1)); exit 1
  fi
done
echo "ok   要求するセキュリティヘッダは ${#REQUIRED_SECURITY_HEADERS[@]} 種、名前も値も一致（空・痩せ・同数すり替えを塞ぐ）"; PASS=$((PASS+1))

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

echo "-- site.conf の全 location でセキュリティヘッダ 5 種が出る（add_header 継承の罠 #482 / allowlist をやめた #499）"
echo "   （site.conf から拾った location: ${#PROBE_PATHS[@]} 個）"
# **叩いた数を数える。** ループが空回りしても「0 件 pass」は緑に見えてしまう（#451）ので、
# 「location の数だけ assert_headers を通った」ことを後で突き合わせる。
PROBED=0
for p in "${PROBE_PATHS[@]}"; do
  assert_headers "$p" "site.conf の location から自動で拾ったパス"
  PROBED=$((PROBED+1))
done
if [ "$PROBED" != "$GOT_LOCS" ]; then
  echo "FAIL location を $GOT_LOCS 個拾ったのに $PROBED 個しか叩いていない"; exit 1
fi
assert_headers /members/m_1/     "プリレンダー済みページ（location / の配下）"

echo "-- エラー応答にも出る（always）"
assert_headers /this-does-not-exist/ "404。always が付いているか"
assert_headers /__spa-fallback.html  "internal → 404"

echo "-- Cache-Control は消えていない（ヘッダを足して既存を壊していないか）"
t_cache_control() {
  local bad=0 got
  for pair in "/assets/__probe.txt:max-age=31536000" "/data/__probe.txt:max-age=3600" "/fonts/__probe.txt:max-age=604800"; do
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
