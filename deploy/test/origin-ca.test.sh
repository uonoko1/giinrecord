#!/usr/bin/env bash
# deploy/origin-ca.sh の振る舞いの検査（Issue #958）。
#   bash deploy/test/origin-ca.test.sh
#
# **なぜ要るか**: origin-ca.sh は**本番 VPS の nginx 設定を書き換えて reload する**。
# それなのに PR #944 の時点で**振る舞いを主張する検査が 0 本**だった。拾えていたのは
# `nginx-reload.test.sh` の grep 規則（deploy/ 全体を見る）が `nginx -t && …` を偶然拾ったからで、
# このスクリプトを狙った検査ではない。そして実際に**2 回、「黙って何もしない」形で壊れた**:
#   1. conf 名を `<zone>.conf` と決め打ちして 4 本とも見つからず、「変更なし」で exit 0 した
#      （ユーザーが実行して何も変わらず、外から issuer を見て初めて気づいた）
#   2. `ssh host 'sudo bash …' < keys.txt` が `sudo: a terminal is required` で落ちた（#419 と同じ罠）
# どちらも「落ちる」ではなく「**成功したように見える**」壊れ方である。
#
# **鍵と証明書はこのファイルにも fixtures にも置かない。**
# `mktemp -d` の中で `openssl` にその場で作らせ、終わったら消す。実在の鍵は 1 本も要らない。
# `openssl` は**スタブにしない**——公開鍵の一致と SAN の判定は openssl が実際に答えるからこそ意味がある。
# スタブにするのは `nginx` と `systemctl` だけ（`nginx-reload.test.sh` と同じ形）。
#
# **PEM の境界行をこのファイルに逐語で書かない**: `BEGIN`+`PRIVATE KEY` の 1 行は、鍵が 1 本も
# 入っていなくても gitleaks と `forbidden-patterns` の `private-key` 規則に当たる（PR #944 の CI が
# 説明文だけで 3 本落ちた）。必要な箇所は下の `key_begin_line()` のように**分割して組み立てる**。
#
# 検算（#757）: どのケースも**母数を出す**。「0 件」と「数えていない」を出力で区別できるようにする。
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY=$(cd "$HERE/.." && pwd)
SCRIPT="$DEPLOY/origin-ca.sh"

PASS=0; FAIL=0; ASSERTIONS=0
fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_eq() { ASSERTIONS=$((ASSERTIONS+1)); [[ "$2" == "$1" ]] || fail "$3: expected [$1] got [$2]"; }
assert_contains() { ASSERTIONS=$((ASSERTIONS+1)); [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in: $1"; }
assert_not_contains() { ASSERTIONS=$((ASSERTIONS+1)); [[ "$1" != *"$2"* ]] || fail "$3: expected NOT to contain [$2] in: $1"; }
assert_ne() { ASSERTIONS=$((ASSERTIONS+1)); [[ "$2" != "$1" ]] || fail "$3: expected NOT [$1]"; }
test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

[ -f "$SCRIPT" ] || { echo "FATAL: $SCRIPT が無い"; exit 1; }
command -v openssl >/dev/null || { echo "FATAL: openssl が要る"; exit 1; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# --- nginx / systemctl のスタブ ------------------------------------------------
# 呼ばれたことを $STUB_LOG に残し、$STUB_NGINX_RC / $STUB_SYSTEMCTL_RC で失敗させられる。
# `..._RC_SEQ` はスペース区切りで「1 回目, 2 回目, …」の終了コード（戻した後の 2 度目の reload を
# 1 度目と区別するために要る）。
BIN="$TMP/bin"; mkdir -p "$BIN"
for cmd in nginx systemctl; do
  UP=$(echo "$cmd" | tr '[:lower:]' '[:upper:]')
  cat > "$BIN/$cmd" <<STUB
#!/usr/bin/env bash
echo "$cmd \$*" >> "\$STUB_LOG"
seq_var="STUB_${UP}_RC_SEQ"
seq="\${!seq_var:-}"
if [ -n "\$seq" ]; then
  n=\$(grep -c "^$cmd " "\$STUB_LOG")
  i=0
  for rc in \$seq; do i=\$((i+1)); [ "\$i" = "\$n" ] && exit "\$rc"; done
  exit 0
fi
rc_var="STUB_${UP}_RC"
exit "\${!rc_var:-0}"
STUB
  chmod +x "$BIN/$cmd"
done

# --- 鍵と証明書をその場で作る ---------------------------------------------------
# gen_pair <出力ディレクトリ> <CN> <SAN のカンマ区切り>  → <dir>/cert.pem, <dir>/key.pem
gen_pair() {
  local dir=$1 cn=$2 san=$3
  mkdir -p "$dir"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout "$dir/key.pem" -out "$dir/cert.pem" -days 2 \
    -subj "/CN=$cn" -addext "subjectAltName=$san" >/dev/null 2>&1
}

# keys_file <出力パス> <ゾーン名> <ペアのディレクトリ> [<ゾーン名2> <ペア2> …]
keys_file() {
  local out=$1; shift
  : > "$out"
  while [ $# -gt 0 ]; do
    printf '### zone %s\n' "$1" >> "$out"
    cat "$2/cert.pem" "$2/key.pem" >> "$out"
    shift 2
  done
}

# 秘密鍵の境界行（BEGIN 側）を**組み立てて**返す。
# このファイルに逐語で書くと private-key 規則に当たるので、分割して連結する（冒頭のコメント参照）。
key_begin_line() { printf -- '-----%s %s %s-----\n' 'BEGIN' 'PRIVATE' 'KEY'; }

# --- nginx の sites-available を作る --------------------------------------------
# vps-setup.sh が実際に書く conf（deploy/vps-setup.sh の site_conf テンプレート）に合わせた形。
# `other-site.conf` は**同居している他サイト**の見立て。1 バイトも変わってはいけない。
write_conf() { # write_conf <パス> <server_name>
  cat > "$1" <<CONF
server {
    listen 80;
    server_name $2;
    location / { return 301 https://$2\$request_uri; }
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $2;
    ssl_certificate /etc/letsencrypt/live/$2/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$2/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:$2:1m;
    location / { proxy_pass http://127.0.0.1:8081; }
}
CONF
}

# make_root <root> [conf の basename …]  → <root>/etc/nginx/sites-available/ に conf を置く
make_root() {
  local root=$1; shift
  mkdir -p "$root/etc/nginx/sites-available"
  local c
  for c in "$@"; do write_conf "$root/etc/nginx/sites-available/$c.conf" "${c%%-*}.example"; done
}

# run_ca <root> <keys ファイル> [追加の引数…] → STATUS, OUT, LOG
run_ca() {
  local root=$1 keys=$2; shift 2
  LOG="$TMP/stub.log"; : > "$LOG"
  set +e
  env PATH="$BIN:$PATH" STUB_LOG="$LOG" ORIGIN_CA_PREFIX="$root" \
    ${STUB_NGINX_RC:+STUB_NGINX_RC="$STUB_NGINX_RC"} \
    ${STUB_NGINX_RC_SEQ:+STUB_NGINX_RC_SEQ="$STUB_NGINX_RC_SEQ"} \
    ${STUB_SYSTEMCTL_RC:+STUB_SYSTEMCTL_RC="$STUB_SYSTEMCTL_RC"} \
    ${STUB_SYSTEMCTL_RC_SEQ:+STUB_SYSTEMCTL_RC_SEQ="$STUB_SYSTEMCTL_RC_SEQ"} \
    bash "$SCRIPT" --keys "$keys" "$@" > "$TMP/out" 2>&1
  STATUS=$?
  set -e
  OUT=$(cat "$TMP/out"); LOG=$(cat "$TMP/stub.log")
}

# md5 の台帳（**母数つき**）。`<件数> <md5> <相対パス>` の行を返す。
confs_digest() { # confs_digest <root>
  local d="$1/etc/nginx/sites-available" n
  n=$(find "$d" -type f | wc -l | tr -d ' ')
  echo "count=$n"
  ( cd "$d" && find . -type f | sort | xargs md5sum )
}

# 共通の下ごしらえ: 正しい鍵一式（2 ゾーン）を 1 度だけ作る（openssl は遅いので使い回す）
GOOD="$TMP/good"
gen_pair "$GOOD/giinrecord" giinrecord.jp "DNS:giinrecord.jp,DNS:*.giinrecord.jp"
gen_pair "$GOOD/gikailog"   gikailog.jp   "DNS:gikailog.jp,DNS:*.gikailog.jp"
keys_file "$TMP/keys-both.txt" giinrecord.jp "$GOOD/giinrecord" gikailog.jp "$GOOD/gikailog"
keys_file "$TMP/keys-giin.txt" giinrecord.jp "$GOOD/giinrecord"

# **落ちるはずの入力**も、ここで 1 度だけ作る（個別のケースと「黙らない」の一斉検査が同じ物を見るため）。
keys_file "$TMP/keys-trav.txt"    "../../etc/nginx/sites-available/giinrecord" "$GOOD/giinrecord"
keys_file "$TMP/keys-unknown.txt" "example.invalid" "$GOOD/giinrecord"
: > "$TMP/keys-empty.txt"
cat "$GOOD/giinrecord/cert.pem" "$GOOD/giinrecord/key.pem" > "$TMP/keys-nohdr.txt"   # '### zone' が無い
{ printf '### zone giinrecord.jp\n'; cat "$GOOD/giinrecord/cert.pem"; } > "$TMP/keys-nokey.txt"
MIXED="$TMP/mixed"; mkdir -p "$MIXED"           # 証明書と鍵の取り違え
cp "$GOOD/giinrecord/cert.pem" "$MIXED/cert.pem"; cp "$GOOD/gikailog/key.pem" "$MIXED/key.pem"
keys_file "$TMP/keys-mismatch.txt" giinrecord.jp "$MIXED"
OTHERSAN="$TMP/othersan"                        # CN は合っているが SAN が別ゾーン
gen_pair "$OTHERSAN" giinrecord.jp "DNS:example.invalid,DNS:*.example.invalid"
keys_file "$TMP/keys-san.txt" giinrecord.jp "$OTHERSAN"

# =================================================================================
# 0. 前提（このテストが本当に対象を動かしているか）
# =================================================================================
t_syntax() {
  bash -n "$SCRIPT" || fail "bash -n が通らない"
  ASSERTIONS=$((ASSERTIONS+1))
}

t_stub_is_used() {
  # スタブが PATH に効いていないと、以降の主張は全部「実行されなかった」になりうる。
  local root="$TMP/r-stub"; rm -rf "$root"; make_root "$root" giinrecord
  run_ca "$root" "$TMP/keys-giin.txt" --apply
  assert_eq 0 "$STATUS" "スタブ下で apply が成功する: $OUT"
  assert_contains "$LOG" "nginx -t" "nginx スタブが呼ばれた（= PATH が効いている）"
  assert_contains "$LOG" "systemctl reload nginx" "systemctl スタブが呼ばれた"
}

# =================================================================================
# 1. 母数（#757）: 切り替える conf が 0 本なら exit 1。「変更なし」で成功しない
# =================================================================================
t_zero_confs_is_failure() {
  local root="$TMP/r-zero"; rm -rf "$root"
  mkdir -p "$root/etc/nginx/sites-available"   # ディレクトリは在るが conf が 1 本も無い
  run_ca "$root" "$TMP/keys-both.txt" --apply
  assert_ne 0 "$STATUS" "conf が 0 本なら exit 0 にしてはいけない（これが実際に起きた壊れ方）"
  assert_contains "$OUT" "1 本も無い" "0 本だと運用者に言う"
  assert_not_contains "$OUT" "変更なし" "「変更なし」で成功したことにしない"
  assert_not_contains "$LOG" "systemctl reload" "0 本のときは reload しない"
  # 母数そのものも見る: 「0 件」と「数えていない」を混同しないため
  # `confs_digest | head -1` は xargs に SIGPIPE を撃つので、本数だけ別に数える
  assert_eq "0" "$(find "$root/etc/nginx/sites-available" -type f | wc -l | tr -d ' ')" \
    "母数（conf の本数）が 0 であること自体を確かめた"
}

t_conf_names_are_not_zone_names() {
  # **実際に起きた壊れ方の再現**: conf 名を `<zone>.conf` と決め打ちすると 1 本も見つからない。
  # 本番の名前は giinrecord.conf / gikailog.conf（vps-setup.sh の site_vars）。
  local root="$TMP/r-names"; rm -rf "$root"
  mkdir -p "$root/etc/nginx/sites-available"
  write_conf "$root/etc/nginx/sites-available/giinrecord.jp.conf" giinrecord.jp   # ゾーン名の形（本番には無い）
  run_ca "$root" "$TMP/keys-giin.txt" --apply
  assert_ne 0 "$STATUS" "ゾーン名の conf しか無いなら見つからないので落ちる"
  assert_contains "$OUT" "1 本も無い" "見つからなかったと言う"

  # 本番の名前なら見つかる（= 決め打ちがゾーン名に戻ったら上と下の両方が動く）
  local root2="$TMP/r-names2"; rm -rf "$root2"; make_root "$root2" giinrecord
  run_ca "$root2" "$TMP/keys-giin.txt" --apply
  assert_eq 0 "$STATUS" "本番の名前（giinrecord.conf）なら切り替わる: $OUT"
  assert_contains "$OUT" "切り替える conf 1 本" "見つけた本数を言う（母数）"
}

t_found_count_is_reported() {
  local root="$TMP/r-count"; rm -rf "$root"
  make_root "$root" giinrecord giinrecord-staging gikailog gikailog-staging
  run_ca "$root" "$TMP/keys-both.txt" --apply
  assert_eq 0 "$STATUS" "4 本そろっていれば成功: $OUT"
  assert_contains "$OUT" "切り替える conf 4 本" "母数を 4 と報告する"
}

# =================================================================================
# 2. ゾーン名の allowlist が**ファイルを開く前に**効く
# =================================================================================
t_zone_allowlist_rejects_path_traversal() {
  local root="$TMP/r-trav"; rm -rf "$root"; make_root "$root" giinrecord
  local keys="$TMP/keys-trav.txt"
  # 罠を仕掛ける: allowlist をすり抜けると awk がこのパスに書きに行く
  local victim="$root/etc/nginx/sites-available/giinrecord.conf"
  local before; before=$(md5sum "$victim" | awk '{print $1}')
  run_ca "$root" "$keys"
  assert_ne 0 "$STATUS" "allowlist にないゾーンは落とす"
  assert_contains "$OUT" "知らないゾーン" "何が悪いか言う"
  assert_eq "$before" "$(md5sum "$victim" | awk '{print $1}')" "allowlist 外のゾーン名でファイルを開かせない"
  # awk の作業ディレクトリ側にも `.block` が生まれていないこと（＝開く前に弾いている）
  assert_not_contains "$OUT" "awk:" "awk のエラーではなく allowlist で弾いている（開く前に効く）"
}

t_zone_allowlist_rejects_unknown_domain() {
  local root="$TMP/r-unknown"; rm -rf "$root"; make_root "$root" giinrecord
  local keys="$TMP/keys-unknown.txt"
  run_ca "$root" "$keys"
  assert_ne 0 "$STATUS" "allowlist にないドメインは落とす"
  assert_contains "$OUT" "知らないゾーン" "何が悪いか言う"
  assert_eq "0" "$(find "$root/etc/ssl" -type f 2>/dev/null | wc -l | tr -d ' ')" "弾いたとき証明書を 1 本も置かない"
}

t_zone_allowlist_accepts_both_zones() {
  # **allowlist が「何も通さない」形で壊れていないか**（通す側も固定する。#484）
  local root="$TMP/r-allow"; rm -rf "$root"; make_root "$root" giinrecord gikailog
  run_ca "$root" "$TMP/keys-both.txt"
  assert_eq 0 "$STATUS" "許したゾーン 2 本は通る: $OUT"
  assert_contains "$OUT" "2 ゾーン" "2 ゾーンと報告する（母数）"
  assert_eq "2" "$(find "$root/etc/ssl/cloudflare" -name origin.pem | wc -l | tr -d ' ')" "2 ゾーンぶん置いた"
}

# =================================================================================
# 3. 証明書と鍵の公開鍵が一致しないと落ちる
# =================================================================================
t_mismatched_key_fails() {
  local root="$TMP/r-mismatch"; rm -rf "$root"; make_root "$root" giinrecord
  # giinrecord の証明書に、gikailog の**鍵**を組み合わせる（＝取り違え。冒頭で作ってある）
  local keys="$TMP/keys-mismatch.txt"
  run_ca "$root" "$keys"
  assert_ne 0 "$STATUS" "証明書と鍵が対でないなら落とす"
  assert_contains "$OUT" "対になっていない" "取り違えだと言う"
  assert_eq "0" "$(find "$root/etc/ssl" -type f 2>/dev/null | wc -l | tr -d ' ')" "対でない鍵を置かない"
}

t_matching_key_passes() {
  # 一致判定が「常に落とす」形で壊れていないか（通る側も固定する）
  local root="$TMP/r-match"; rm -rf "$root"; make_root "$root" giinrecord
  run_ca "$root" "$TMP/keys-giin.txt"
  assert_eq 0 "$STATUS" "対になっている鍵は通る: $OUT"
}

t_key_missing_fails() {
  local root="$TMP/r-nokey"; rm -rf "$root"; make_root "$root" giinrecord
  local keys="$TMP/keys-nokey.txt"
  # 念のため: 鍵の境界行が本当に入っていないことを数える（母数）
  assert_eq "0" "$(grep -c -F -- "$(key_begin_line)" "$keys" || true)" "この入力に秘密鍵は 0 本"
  run_ca "$root" "$keys"
  assert_ne 0 "$STATUS" "鍵が無いなら落とす"
  assert_contains "$OUT" "PRIVATE KEY が見つからない" "何が足りないか言う"
}

# =================================================================================
# 4. SAN にゾーンが入っていないと落ちる
# =================================================================================
t_san_without_zone_fails() {
  local root="$TMP/r-san"; rm -rf "$root"; make_root "$root" giinrecord
  local keys="$TMP/keys-san.txt"   # CN は合っているが SAN が別（冒頭で作ってある）
  run_ca "$root" "$keys"
  assert_ne 0 "$STATUS" "SAN にゾーンが無い証明書は落とす"
  assert_contains "$OUT" "SAN に giinrecord.jp が無い" "別ゾーンの証明書だと言う"
  assert_eq "0" "$(find "$root/etc/ssl" -type f 2>/dev/null | wc -l | tr -d ' ')" "SAN 違いを置かない"
}

t_san_is_not_a_substring_match() {
  # **ここが一番効く**（PR #960 で塞いだ穴）。以前は `grep -q "DNS:$z"` の**部分一致**だったので、
  # `DNS:notgiinrecord.jp` も `DNS:giinrecord.jp.evil.invalid` も「ゾーンの証明書」として通り、
  # **別ゾーン（他人）の証明書を本番に置いてしまう**。このスクリプトが防ぎたいものそのもの。
  # ゾーン名の `.` も正規表現のワイルドカードなので、`giinrecordXjp` の類も塞がっていること。
  #
  # 通るべき 4 通り / 落ちるべき 6 通りを**両方**並べて、母数つきで数える（#757）。
  # 片側だけだと「全部落とす」「全部通す」で壊れたときに気づけない。
  local root="$TMP/r-sanb"
  local -a good=(
    "DNS:giinrecord.jp"                                   # ちょうど一致
    "DNS:*.giinrecord.jp"                                 # ワイルドカード
    "DNS:giinrecord.jp,DNS:*.giinrecord.jp"               # Cloudflare が実際に出す形
    "DNS:other.invalid,DNS:giinrecord.jp"                 # 2 番目に入っている（区切りの後ろ）
  )
  local -a bad=(
    "DNS:notgiinrecord.jp"                                # 前に字がある（前方の部分一致）
    "DNS:giinrecord.jp.evil.invalid"                      # 後ろに続く（後方の部分一致）
    "DNS:giinrecordXjp"                                   # '.' を正規表現として食わせる
    "DNS:*.notgiinrecord.jp"                              # ワイルドカード側の前方一致
    "DNS:giinrecord.jpx,DNS:other.invalid"                # 区切りの直前で 1 字多い
    "DNS:example.invalid"                                 # 無関係
  )
  local passed=0 rejected=0 s d keys
  for s in "${good[@]}"; do
    d="$TMP/sanb-g$passed"; gen_pair "$d" giinrecord.jp "$s"
    keys="$d/keys.txt"; keys_file "$keys" giinrecord.jp "$d"
    rm -rf "$root"; make_root "$root" giinrecord
    run_ca "$root" "$keys"
    if [ "$STATUS" -eq 0 ]; then passed=$((passed+1)); else fail "通るべき SAN が落ちた [$s]: $OUT"; passed=$((passed+1)); fi
  done
  for s in "${bad[@]}"; do
    d="$TMP/sanb-b$rejected"; gen_pair "$d" giinrecord.jp "$s"
    keys="$d/keys.txt"; keys_file "$keys" giinrecord.jp "$d"
    rm -rf "$root"; make_root "$root" giinrecord
    run_ca "$root" "$keys"
    if [ "$STATUS" -ne 0 ]; then
      rejected=$((rejected+1))
      assert_contains "$OUT" "SAN に giinrecord.jp が無い" "落とす理由を言う [$s]"
      assert_eq "0" "$(find "$root/etc/ssl" -type f 2>/dev/null | wc -l | tr -d ' ')" "落としたら置かない [$s]"
    else
      fail "**別ゾーンの証明書が通った** [$s]（部分一致に戻っている）"
    fi
  done
  assert_eq "4" "$passed" "母数: 通るべき SAN 4 通りを検査した"
  assert_eq "6" "$rejected" "母数: 落ちるべき SAN 6 通りをすべて落とした"
}

t_san_wildcard_only_passes() {
  # ワイルドカードだけでも通る（スクリプトが明示的に許している経路）
  local root="$TMP/r-wild"; rm -rf "$root"; make_root "$root" giinrecord
  local d="$TMP/wild"
  gen_pair "$d" giinrecord.jp "DNS:*.giinrecord.jp"
  local keys="$TMP/keys-wild.txt"; keys_file "$keys" giinrecord.jp "$d"
  run_ca "$root" "$keys"
  assert_eq 0 "$STATUS" "ワイルドカードだけの SAN は通る: $OUT"
}

# =================================================================================
# 5. 対象以外の sites-available が 1 行も変わらない（md5 の数え上げ）
# =================================================================================
t_other_sites_untouched() {
  local root="$TMP/r-others"; rm -rf "$root"
  make_root "$root" giinrecord giinrecord-staging gikailog gikailog-staging
  # **同居している他サイト**（共用 VPS。名前は架空のものしか書かない）
  local d="$root/etc/nginx/sites-available"
  write_conf "$d/other-a.conf" a.example
  write_conf "$d/other-b.conf" b.example
  local before_a before_b n_before
  before_a=$(md5sum "$d/other-a.conf" | awk '{print $1}')
  before_b=$(md5sum "$d/other-b.conf" | awk '{print $1}')
  n_before=$(find "$d" -type f | wc -l | tr -d ' ')
  assert_eq "6" "$n_before" "母数: sites-available は 6 本（対象 4 + 他サイト 2）"

  run_ca "$root" "$TMP/keys-both.txt" --apply
  assert_eq 0 "$STATUS" "apply が成功する: $OUT"
  assert_eq "$before_a" "$(md5sum "$d/other-a.conf" | awk '{print $1}')" "他サイト a が 1 バイトも変わらない"
  assert_eq "$before_b" "$(md5sum "$d/other-b.conf" | awk '{print $1}')" "他サイト b が 1 バイトも変わらない"
  assert_eq "$n_before" "$(find "$d" -type f | wc -l | tr -d ' ')" "本数が増減しない（作業ファイルを残さない）"
  # 対象 4 本は**実際に変わっている**こと（＝上の 2 本が不変なのは「何もしていない」からではない）
  local changed=0 c
  for c in giinrecord giinrecord-staging gikailog gikailog-staging; do
    grep -q "ssl_verify_client on;" "$d/$c.conf" && changed=$((changed+1))
  done
  assert_eq "4" "$changed" "対象 4 本には mTLS が入った（不変が「何もしていない」ではない証拠）"
}

t_rewrite_shape() {
  local root="$TMP/r-shape"; rm -rf "$root"; make_root "$root" giinrecord
  run_ca "$root" "$TMP/keys-giin.txt" --apply
  local c="$root/etc/nginx/sites-available/giinrecord.conf"
  assert_eq 0 "$STATUS" "apply が成功する: $OUT"
  assert_contains "$(cat "$c")" "$root/etc/ssl/cloudflare/giinrecord.jp/origin.pem" "Origin CA の証明書を指す"
  assert_contains "$(cat "$c")" "$root/etc/ssl/cloudflare/giinrecord.jp/origin.key" "Origin CA の鍵を指す"
  assert_contains "$(cat "$c")" "ssl_client_certificate $root/etc/ssl/cloudflare/origin-pull-ca.pem" "Origin Pull CA を指す"
  assert_contains "$(cat "$c")" "ssl_verify_client on;" "mTLS を有効にする"
  assert_not_contains "$(cat "$c")" "letsencrypt" "Let's Encrypt の証明書を残さない"
  # 冪等: もう一度掛けても変わらない
  local md5_1; md5_1=$(md5sum "$c" | awk '{print $1}')
  run_ca "$root" "$TMP/keys-giin.txt" --apply
  assert_eq 0 "$STATUS" "2 回目も成功: $OUT"
  assert_eq "$md5_1" "$(md5sum "$c" | awk '{print $1}')" "冪等（2 回目で conf が変わらない）"
  assert_contains "$OUT" "変更なし" "2 回目は「変更なし」と言う（既に切り替わっている）"
  assert_eq "1" "$(grep -c "ssl_verify_client on;" "$c")" "mTLS の行が 2 本に増えない"
}

# =================================================================================
# 6. nginx -t が通らないとき、conf が戻り、reload されない
# =================================================================================
t_nginx_t_fails_restores_and_no_reload() {
  local root="$TMP/r-badconf"; rm -rf "$root"; make_root "$root" giinrecord gikailog
  local d="$root/etc/nginx/sites-available"
  local before; before=$(confs_digest "$root")
  assert_contains "$before" "count=2" "母数: conf 2 本"

  STUB_NGINX_RC=1 run_ca "$root" "$TMP/keys-both.txt" --apply
  unset STUB_NGINX_RC
  assert_ne 0 "$STATUS" "nginx -t が通らないなら落ちる"
  assert_contains "$OUT" "nginx -t が通らないので戻した" "戻したと言う"
  assert_not_contains "$LOG" "systemctl reload" "nginx -t が通らないときは reload しない"
  assert_eq "$before" "$(confs_digest "$root")" "conf が md5 ごと元に戻っている（母数つき）"
  assert_not_contains "$(cat "$d/giinrecord.conf")" "ssl_verify_client" "書き換えが残っていない"
}

# =================================================================================
# 7. 戻した後の reload が失敗したとき、黙って成功しない（PR #944 で直した経路）
#    3 通りの失敗が**それぞれ別の文言で**落ちること。
# =================================================================================
# 経路の並び: nginx -t(1回目) OK → systemctl reload(1回目) NG → 戻す
#             → nginx -t(2回目) → systemctl reload(2回目)
t_reload_fails_restore_ok() {
  # reload 1 回目 NG、戻した conf の nginx -t OK、reload 2 回目 OK → それでも落ちる
  local root="$TMP/r-rl1"; rm -rf "$root"; make_root "$root" giinrecord
  local before; before=$(confs_digest "$root")
  STUB_SYSTEMCTL_RC_SEQ="1 0" run_ca "$root" "$TMP/keys-giin.txt" --apply
  unset STUB_SYSTEMCTL_RC_SEQ
  assert_ne 0 "$STATUS" "reload に失敗したら成功で終わらない"
  assert_contains "$OUT" "reload に失敗したので戻した（戻した設定での reload は成功した）" "1 通り目の文言"
  assert_eq "$before" "$(confs_digest "$root")" "conf が戻っている"
  assert_eq "2" "$(grep -c "^systemctl reload nginx" <<< "$LOG")" "reload は 2 回呼ばれた（1 回目失敗 + 戻した後）"
}

t_reload_fails_and_restored_conf_also_bad() {
  # reload 1 回目 NG、戻した conf の nginx -t も NG
  local root="$TMP/r-rl2"; rm -rf "$root"; make_root "$root" giinrecord
  STUB_SYSTEMCTL_RC_SEQ="1 0" STUB_NGINX_RC_SEQ="0 1" run_ca "$root" "$TMP/keys-giin.txt" --apply
  unset STUB_SYSTEMCTL_RC_SEQ STUB_NGINX_RC_SEQ
  assert_ne 0 "$STATUS" "落ちる"
  assert_contains "$OUT" "戻した conf でも nginx -t が通らない" "2 通り目の文言"
  assert_eq "1" "$(grep -c "^systemctl reload nginx" <<< "$LOG")" "戻した conf が不正なら 2 度目の reload はしない"
}

t_reload_fails_twice() {
  # reload 1 回目 NG、戻した conf の nginx -t OK、reload 2 回目も NG
  local root="$TMP/r-rl3"; rm -rf "$root"; make_root "$root" giinrecord
  STUB_SYSTEMCTL_RC_SEQ="1 1" run_ca "$root" "$TMP/keys-giin.txt" --apply
  unset STUB_SYSTEMCTL_RC_SEQ
  assert_ne 0 "$STATUS" "落ちる"
  assert_contains "$OUT" "戻した conf の reload も失敗した" "3 通り目の文言"
  assert_contains "$OUT" "稼働中の nginx は古い設定のまま" "何が残っているか言う"
  assert_eq "2" "$(grep -c "^systemctl reload nginx" <<< "$LOG")" "2 度目まで試した"
}

t_three_reload_failures_are_distinct() {
  # **3 通りが別の文言であること自体**を固定する（1 つに潰すと、どれが起きたか分からなくなる）。
  local a b c
  local root
  root="$TMP/r-d1"; rm -rf "$root"; make_root "$root" giinrecord
  STUB_SYSTEMCTL_RC_SEQ="1 0" run_ca "$root" "$TMP/keys-giin.txt" --apply; a=$(grep 'origin-ca:' <<< "$OUT" | tail -1)
  root="$TMP/r-d2"; rm -rf "$root"; make_root "$root" giinrecord
  STUB_SYSTEMCTL_RC_SEQ="1 0" STUB_NGINX_RC_SEQ="0 1" run_ca "$root" "$TMP/keys-giin.txt" --apply; b=$(grep 'origin-ca:' <<< "$OUT" | tail -1)
  root="$TMP/r-d3"; rm -rf "$root"; make_root "$root" giinrecord
  STUB_SYSTEMCTL_RC_SEQ="1 1" run_ca "$root" "$TMP/keys-giin.txt" --apply; c=$(grep 'origin-ca:' <<< "$OUT" | tail -1)
  unset STUB_SYSTEMCTL_RC_SEQ STUB_NGINX_RC_SEQ
  assert_eq "3" "$(printf '%s\n%s\n%s\n' "$a" "$b" "$c" | sort -u | wc -l | tr -d ' ')" "3 通りが別々の文言（母数 3）"
  assert_ne "" "$a" "1 通り目の文言が空でない"
  assert_ne "" "$b" "2 通り目の文言が空でない"
  assert_ne "" "$c" "3 通り目の文言が空でない"
}

# =================================================================================
# 8. --apply を付けないと何も書かない
# =================================================================================
t_without_apply_writes_no_conf() {
  local root="$TMP/r-noapply"; rm -rf "$root"
  make_root "$root" giinrecord giinrecord-staging gikailog gikailog-staging
  local before; before=$(confs_digest "$root")
  assert_contains "$before" "count=4" "母数: conf 4 本"
  run_ca "$root" "$TMP/keys-both.txt"
  assert_eq 0 "$STATUS" "--apply 無しは成功で終わる: $OUT"
  assert_eq "$before" "$(confs_digest "$root")" "conf を 1 バイトも変えない（md5 を全件比較）"
  assert_not_contains "$LOG" "systemctl" "systemctl を呼ばない"
  assert_not_contains "$LOG" "nginx" "nginx を呼ばない"
  assert_contains "$OUT" "nginx はまだ切り替えていない" "切り替えていないと言う"
  # 証明書は置いてある（「何もしない」ではなく「置くだけ」）
  assert_eq "2" "$(find "$root/etc/ssl/cloudflare" -name origin.pem | wc -l | tr -d ' ')" "証明書 2 本は置いた"
  assert_eq "600" "$(stat -c '%a' "$root/etc/ssl/cloudflare/giinrecord.jp/origin.key")" "鍵は 600"
  assert_eq "644" "$(stat -c '%a' "$root/etc/ssl/cloudflare/giinrecord.jp/origin.pem")" "証明書は 644"
}

# =================================================================================
# 9. 入力の渡し方（#419 の罠。--keys が無いと sudo がパスワードを読めない）
# =================================================================================
t_keys_flag_and_stdin_both_work() {
  local root="$TMP/r-in1"; rm -rf "$root"; make_root "$root" giinrecord
  run_ca "$root" "$TMP/keys-giin.txt"
  assert_eq 0 "$STATUS" "--keys で渡せる: $OUT"

  # 標準入力でも同じ結果になること（run_ca を使わず直に呼ぶ）
  local root2="$TMP/r-in2"; rm -rf "$root2"; make_root "$root2" giinrecord
  set +e
  env PATH="$BIN:$PATH" STUB_LOG="$TMP/stub.log" ORIGIN_CA_PREFIX="$root2" \
    bash "$SCRIPT" < "$TMP/keys-giin.txt" > "$TMP/out2" 2>&1
  local st=$?
  set -e
  assert_eq 0 "$st" "標準入力でも渡せる: $(cat "$TMP/out2")"
  assert_eq "1" "$(find "$root2/etc/ssl/cloudflare" -name origin.pem | wc -l | tr -d ' ')" "標準入力でも置かれる"
}

t_missing_keys_file_fails() {
  local root="$TMP/r-nofile"; rm -rf "$root"; make_root "$root" giinrecord
  run_ca "$root" "$TMP/does-not-exist.txt"
  assert_ne 0 "$STATUS" "読めないパスは落とす"
  assert_contains "$OUT" "鍵ファイルが読めない" "読めないと言う"
}

t_empty_and_headerless_input_fails() {
  local root="$TMP/r-empty"; rm -rf "$root"; make_root "$root" giinrecord
  run_ca "$root" "$TMP/keys-empty.txt"
  assert_ne 0 "$STATUS" "空の入力は落とす"
  assert_contains "$OUT" "鍵ファイルが空" "空だと言う"

  run_ca "$root" "$TMP/keys-nohdr.txt"
  assert_ne 0 "$STATUS" "'### zone' が無い入力は落とす"
  assert_contains "$OUT" "1 つも無い" "ゾーン行が無いと言う"
  # **#958 で実測した回帰**: 以前ここは出力 0 バイトで exit 1 していた（grep が no-match で 1 を返し、
  # pipefail + `|| exit 1` が die に届く前に殺していた）。**黙って落ちないこと**自体を釘で打つ。
  assert_ne "0" "$(printf '%s' "$OUT" | wc -c | tr -d ' ')" "黙って落ちない（出力が 0 バイトでない）"
}

t_no_silent_failures() {
  # **このスクリプトの壊れ方はいつも「黙る」**（conf が 0 本で exit 0、ゾーン行 0 本で 0 バイト）。
  # 失敗する入力を並べて、**どれも必ず何か言う**ことを母数つきで確かめる。
  local root="$TMP/r-silent"; rm -rf "$root"; make_root "$root" giinrecord
  local -a cases=(
    "$TMP/keys-empty.txt"      # 空
    "$TMP/keys-nohdr.txt"      # '### zone' が無い
    "$TMP/keys-unknown.txt"    # allowlist 外のゾーン
    "$TMP/keys-trav.txt"       # ../../ を含むゾーン名
    "$TMP/keys-mismatch.txt"   # 証明書と鍵が対でない
    "$TMP/keys-san.txt"        # SAN が別ゾーン
    "$TMP/keys-nokey.txt"      # 秘密鍵が無い
  )
  local silent=0 notfailed=0 f
  for f in "${cases[@]}"; do
    [ -f "$f" ] || { fail "前提の入力が無い: $f"; continue; }
    run_ca "$root" "$f"
    [ "$STATUS" -ne 0 ] || notfailed=$((notfailed+1))
    [ -n "$OUT" ] || { silent=$((silent+1)); echo "      (黙ったまま落ちた: $f)"; }
  done
  assert_eq "7" "${#cases[@]}" "母数: 失敗するはずの入力 7 通りを検査した"
  assert_eq "0" "$notfailed" "7 通りすべてが exit 非 0"
  assert_eq "0" "$silent" "7 通りすべてが理由を言う（黙って落ちたものが 0 件）"
}

t_unknown_argument_fails() {
  local root="$TMP/r-arg"; rm -rf "$root"; make_root "$root" giinrecord
  set +e
  env PATH="$BIN:$PATH" STUB_LOG="$TMP/stub.log" ORIGIN_CA_PREFIX="$root" \
    bash "$SCRIPT" --nope < "$TMP/keys-giin.txt" > "$TMP/out3" 2>&1
  local st=$?
  set -e
  assert_eq 2 "$st" "知らない引数は exit 2"
  assert_contains "$(cat "$TMP/out3")" "知らない引数" "何が悪いか言う"
}

# =================================================================================
# 10. このテスト自身に鍵が混ざっていないこと（#944 の再発防止）
# =================================================================================
t_no_pem_material_in_this_file() {
  local self="${BASH_SOURCE[0]}" n
  n=$(grep -c -F -- "$(key_begin_line)" "$self" || true)
  assert_eq "0" "$n" "このテストのソースに秘密鍵の境界行が逐語で 0 本（母数: $(wc -l < "$self") 行を検査）"
  n=$(grep -c -E -- '-----BEGIN( [A-Z]+)* PRIVATE KEY-----' "$self" || true)
  assert_eq "0" "$n" "forbidden-patterns の private-key 規則に当たる行が 0 本"
}

test_case "bash -n が通る" t_syntax
test_case "スタブ（nginx/systemctl）が実際に呼ばれている" t_stub_is_used
test_case "母数(#757): 切り替える conf が 0 本なら exit 1（「変更なし」で成功しない）" t_zero_confs_is_failure
test_case "conf 名はゾーン名ではない（実際に起きた「黙って何もしない」の再現）" t_conf_names_are_not_zone_names
test_case "見つけた conf の本数を報告する（4 本）" t_found_count_is_reported
test_case "ゾーンの allowlist: ../../ を含む値でファイルを開かない" t_zone_allowlist_rejects_path_traversal
test_case "ゾーンの allowlist: 知らないドメインを落とし、何も置かない" t_zone_allowlist_rejects_unknown_domain
test_case "ゾーンの allowlist: 許した 2 ゾーンは通る（通す側も固定）" t_zone_allowlist_accepts_both_zones
test_case "証明書と鍵の公開鍵が一致しないと落ちる（何も置かない）" t_mismatched_key_fails
test_case "一致していれば通る（常に落とす形で壊れていない）" t_matching_key_passes
test_case "秘密鍵が入っていない入力は落ちる" t_key_missing_fails
test_case "SAN にゾーンが無い証明書は落ちる（何も置かない）" t_san_without_zone_fails
test_case "SAN は部分一致ではない（通る 4 / 落ちる 6。別ゾーンの証明書を置かない）" t_san_is_not_a_substring_match
test_case "SAN がワイルドカードだけでも通る" t_san_wildcard_only_passes
test_case "対象以外の sites-available が 1 バイトも変わらない（md5 全件）" t_other_sites_untouched
test_case "書き換えの形（Origin CA + mTLS）と冪等性" t_rewrite_shape
test_case "nginx -t が通らない → conf が戻り、reload しない" t_nginx_t_fails_restores_and_no_reload
test_case "戻した後の reload 失敗(1/3): 戻して reload 成功でも、黙って成功しない" t_reload_fails_restore_ok
test_case "戻した後の reload 失敗(2/3): 戻した conf も nginx -t が通らない" t_reload_fails_and_restored_conf_also_bad
test_case "戻した後の reload 失敗(3/3): 2 度目の reload も失敗" t_reload_fails_twice
test_case "3 通りの失敗がそれぞれ別の文言（母数 3）" t_three_reload_failures_are_distinct
test_case "--apply を付けないと conf を 1 バイトも書かない" t_without_apply_writes_no_conf
test_case "--keys でも標準入力でも渡せる（#419 の罠）" t_keys_flag_and_stdin_both_work
test_case "読めない鍵ファイルは落ちる" t_missing_keys_file_fails
test_case "空の入力・ゾーン行の無い入力は落ちる" t_empty_and_headerless_input_fails
test_case "失敗する入力 7 通りは、どれも黙らずに理由を言う（#958 で実測した回帰）" t_no_silent_failures
test_case "知らない引数は exit 2" t_unknown_argument_fails
test_case "このテスト自身に秘密鍵が 1 本も入っていない" t_no_pem_material_in_this_file

echo; echo "passed: $PASS  failed: $FAIL  assertions: $ASSERTIONS"
[[ $FAIL == 0 ]]
