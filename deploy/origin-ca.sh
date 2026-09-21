#!/usr/bin/env bash
# Cloudflare Origin CA 証明書を VPS に置き、Authenticated Origin Pulls（mTLS）を有効にする（Issue #943）。
#
#   bash deploy/origin-ca.sh --keys /path/to/keys.txt   ← **ファイルのパスを渡す**
#   bash deploy/origin-ca.sh < /path/to/keys.txt        ← 標準入力でもよい（tty が要らない場面）
#
# **秘密鍵そのものを引数にも環境変数にも渡さない**——`ps` に出るため（#163 と同じ方針）。
# **パスは `ps` に出るが、パスは秘密ではない**（中身が 600 なら読めない）。
#
# **なぜ `--keys` が要るか**: `ssh host 'sudo bash …' < keys.txt` は**動かない**。
# 標準入力を鍵が占有するので `sudo` がパスワードを読めず
# `sudo: a terminal is required to read the password` で落ちる（ユーザーの実機で実測）。
# **`run-remote.sh` の docblock にある #419 と同じ罠である。**
#
# **鍵ファイルの形式**（ゾーンごとに 1 ブロック。順不同、余分な空行は無視）:
#
#   ### zone giinrecord.jp
#   <Cloudflare が出した Origin 証明書の PEM をまるごと>
#   <同じゾーンの秘密鍵の PEM をまるごと>
#   ### zone gikailog.jp
#   （同じ形）
#
# PEM の境界行（`BEGIN`/`END` の行）は Cloudflare の画面から出てくるものをそのまま使う。
# **ここに逐語で書き写さない**: `-----BEGIN ... PRIVATE KEY-----` という 1 行は、それ自体が
# gitleaks と `forbidden-patterns` の `private-key` 規則に当たる。実際 PR #944 の CI は、
# 鍵が 1 本も入っていないこの説明文だけで 3 本落ちた。**規則を緩めるのではなく書かない**
# （`scripts/ci/issue-secrets.sh` が版番号で踏んだのと同じ形）。
# 鍵と証明書の見分けは下の parse が実際の境界行でやっているので、説明を省いても動作は変わらない。
# RSA 形式（`RSA PRIVATE KEY`）でもよい。Cloudflare は既定で ECC を出す。
#
# やること（**冪等。何度でも再実行できる**）:
#   1. 入力を検証する（ゾーン名・証明書と鍵の対応・鍵と証明書の公開鍵が一致するか）
#   2. /etc/ssl/cloudflare/<zone>/{origin.pem,origin.key} に置く（key は 600、root:root）
#   3. Cloudflare の Origin Pull CA を /etc/ssl/cloudflare/origin-pull-ca.pem に置く（**同梱。取りに行かない**）
#   4. **まだ nginx は切り替えない**——`--apply` を付けたときだけ切り替える
#
#   bash deploy/origin-ca.sh --apply < keys.txt   ← 置く＋nginx を Origin CA と mTLS に切り替える
#
# **なぜ 2 段階か**: 切り替えると **Cloudflare 経由以外の接続が TLS の時点で落ちる**。
# **DNS プロキシが OFF のまま切り替えるとサイトが落ちる**ので、置くだけと切り替えるを分ける。
#
# 安全装置:
#   - **同居している他サイトの server block を 1 バイトも変えない**ことを、書き換えの前後で検査する
#   - `nginx -t` が通らなければ**元に戻す**（切り替え前の conf を退避してある）
#   - reload は graceful なので**古いワーカーが証明書を返す**。検証はリトライする（隣接プロジェクトの実測）
#   - ゾーン名は**完全一致の allowlist**（`../../etc/nginx` のような値で任意パスに書けないように）
set -euo pipefail

APPLY=0
KEYS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --keys)  KEYS="${2:?--keys にパスが要る}"; shift 2 ;;
    *) echo "origin-ca: 知らない引数 '$1'" >&2; exit 2 ;;
  esac
done

PREFIX="${ORIGIN_CA_PREFIX:-}"          # テスト用。全パスをこの下に寄せる
SSL_DIR="$PREFIX/etc/ssl/cloudflare"
NGINX_DIR="$PREFIX/etc/nginx"

# **完全一致の allowlist**（パス検証。変数でパスを組み立てる前に弾く）
zone_ok() { case "$1" in giinrecord.jp|gikailog.jp) return 0 ;; *) return 1 ;; esac; }

die() { echo "origin-ca: $*" >&2; exit 1; }

IN=$(mktemp); trap 'rm -f "$IN"; rm -rf "${WORK:-}"' EXIT
if [ -n "$KEYS" ]; then
  [ -r "$KEYS" ] || die "鍵ファイルが読めない: $KEYS"
  cat "$KEYS" > "$IN"
else
  [ -t 0 ] && die "鍵の渡し方: --keys <パス>、または標準入力"
  cat > "$IN"
fi
[ -s "$IN" ] || die "鍵ファイルが空"

WORK=$(mktemp -d)

# --- 入力を割る（ゾーンごと） -------------------------------------------------
ZONES=""
# **ゾーン名を先に検証してからファイルを開く**（`../../etc/nginx` のような値で
# awk が任意パスに書きに行くのを防ぐ。検証より先に開くと awk のエラーで落ちて筋が読めない）
grep -n '^### zone ' "$IN" | sed 's/^[0-9]*:### zone //' | while IFS= read -r z; do
  z=${z%%[[:space:]]*}
  zone_ok "$z" || { echo "origin-ca: 知らないゾーン '$z'（許すのは giinrecord.jp と gikailog.jp だけ）" >&2; exit 1; }
done || exit 1

awk -v out="$WORK" '
  /^### zone / { z=$3; sub(/[[:space:]]+$/,"",z); f=out "/" z ".block"; print z > (out "/zones.txt"); next }
  z != "" { print > f }
' "$IN"
[ -f "$WORK/zones.txt" ] || die "'### zone <ドメイン>' の行が 1 つも無い"

N=0
while IFS= read -r z; do
  [ -n "$z" ] || continue
  zone_ok "$z" || die "知らないゾーン '$z'（許すのは giinrecord.jp と gikailog.jp だけ）"
  B="$WORK/$z.block"
  [ -s "$B" ] || die "$z: 中身が空"

  # 証明書と鍵を取り出す（**最初の 1 組だけ**。余分が在れば落とす）
  awk '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/' "$B" > "$WORK/$z.crt"
  awk '/-----BEGIN (RSA |EC )?PRIVATE KEY-----/,/-----END (RSA |EC )?PRIVATE KEY-----/' "$B" > "$WORK/$z.key"
  [ -s "$WORK/$z.crt" ] || die "$z: CERTIFICATE が見つからない"
  [ -s "$WORK/$z.key" ] || die "$z: PRIVATE KEY が見つからない"
  [ "$(grep -c -- '-----BEGIN CERTIFICATE-----' "$WORK/$z.crt")" = 1 ] || die "$z: CERTIFICATE が 2 つ以上ある"
  [ "$(grep -c -- '-----BEGIN' "$WORK/$z.key")" = 1 ] || die "$z: PRIVATE KEY が 2 つ以上ある"

  # **鍵と証明書が対か**を確かめる（取り違えを置く前に落とす）
  c=$(openssl x509 -in "$WORK/$z.crt" -noout -pubkey 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')
  k=$(openssl pkey -in "$WORK/$z.key" -pubout 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')
  [ -n "$c" ] && [ "$c" = "$k" ] || die "$z: 証明書と秘密鍵が対になっていない（取り違え？）"

  # **証明書がそのゾーンのものか**（SAN にゾーン名が入っているか）
  san=$(openssl x509 -in "$WORK/$z.crt" -noout -ext subjectAltName 2>/dev/null || true)
  # **`grep -q` をパイプの末尾に置かない**（#527）: `grep -q` は一致した時点で読むのをやめるので、
  # 一致が入力の先頭寄りだと書き手（`echo`）が SIGPIPE で死に、`pipefail` のもとで**一致したのに
  # 偽になる**ことがある。しかも確率的にしか起きない。ヒアストリングにすれば書き手がいない。
  #
  # **部分一致にもしない**: `grep -q "DNS:$z"` は `DNS:notgiinrecord.jp` にも当たる。
  # SAN は `DNS:a, DNS:b` の形なので、前は行頭かカンマ＋空白、後ろは行末かカンマで区切る。
  # ここを緩めると「別ゾーンの証明書を置いてしまう」——このスクリプトが防ぎたいものそのもの。
  zre=$(printf '%s' "$z" | sed 's/[.[\*^$\\]/\\&/g')
  grep -qE "(^|[[:space:],])DNS:(\\*\\.)?${zre}([[:space:],]|$)" <<<"$san" \
    || die "$z: 証明書の SAN に $z が無い（別ゾーンの証明書？）"

  ZONES="$ZONES $z"; N=$((N+1))
done < "$WORK/zones.txt"

[ "$N" -gt 0 ] || die "ゾーンが 0 件"
echo "origin-ca: 入力を検証した（$N ゾーン:$ZONES）"

# --- 置く -------------------------------------------------------------------
install -d -m 755 "$SSL_DIR"
for z in $ZONES; do
  install -d -m 755 "$SSL_DIR/$z"
  install -m 644 "$WORK/$z.crt" "$SSL_DIR/$z/origin.pem"
  install -m 600 "$WORK/$z.key" "$SSL_DIR/$z/origin.key"
  echo "  $z → $SSL_DIR/$z/{origin.pem,origin.key}"
done

# Cloudflare の Origin Pull CA（**同梱**。取りに行くと落ちたときに壊れる）
cat > "$SSL_DIR/origin-pull-ca.pem" <<'CA'
-----BEGIN CERTIFICATE-----
MIIGCjCCA/KgAwIBAgIIV5G6lVbCLmEwDQYJKoZIhvcNAQENBQAwgZAxCzAJBgNV
BAYTAlVTMRkwFwYDVQQKExBDbG91ZEZsYXJlLCBJbmMuMRQwEgYDVQQLEwtPcmln
aW4gUHVsbDEWMBQGA1UEBxMNU2FuIEZyYW5jaXNjbzETMBEGA1UECBMKQ2FsaWZv
cm5pYTEjMCEGA1UEAxMab3JpZ2luLXB1bGwuY2xvdWRmbGFyZS5uZXQwHhcNMTkx
MDEwMTg0NTAwWhcNMjkxMTAxMTcwMDAwWjCBkDELMAkGA1UEBhMCVVMxGTAXBgNV
BAoTEENsb3VkRmxhcmUsIEluYy4xFDASBgNVBAsTC09yaWdpbiBQdWxsMRYwFAYD
VQQHEw1TYW4gRnJhbmNpc2NvMRMwEQYDVQQIEwpDYWxpZm9ybmlhMSMwIQYDVQQD
ExpvcmlnaW4tcHVsbC5jbG91ZGZsYXJlLm5ldDCCAiIwDQYJKoZIhvcNAQEBBQAD
ggIPADCCAgoCggIBAN2y2zojYfl0bKfhp0AJBFeV+jQqbCw3sHmvEPwLmqDLqynI
42tZXR5y914ZB9ZrwbL/K5O46exd/LujJnV2b3dzcx5rtiQzso0xzljqbnbQT20e
ihx/WrF4OkZKydZzsdaJsWAPuplDH5P7J82q3re88jQdgE5hqjqFZ3clCG7lxoBw
hLaazm3NJJlUfzdk97ouRvnFGAuXd5cQVx8jYOOeU60sWqmMe4QHdOvpqB91bJoY
QSKVFjUgHeTpN8tNpKJfb9LIn3pun3bC9NKNHtRKMNX3Kl/sAPq7q/AlndvA2Kw3
Dkum2mHQUGdzVHqcOgea9BGjLK2h7SuX93zTWL02u799dr6Xkrad/WShHchfjjRn
aL35niJUDr02YJtPgxWObsrfOU63B8juLUphW/4BOjjJyAG5l9j1//aUGEi/sEe5
lqVv0P78QrxoxR+MMXiJwQab5FB8TG/ac6mRHgF9CmkX90uaRh+OC07XjTdfSKGR
PpM9hB2ZhLol/nf8qmoLdoD5HvODZuKu2+muKeVHXgw2/A6wM7OwrinxZiyBk5Hh
CvaADH7PZpU6z/zv5NU5HSvXiKtCzFuDu4/Zfi34RfHXeCUfHAb4KfNRXJwMsxUa
+4ZpSAX2G6RnGU5meuXpU5/V+DQJp/e69XyyY6RXDoMywaEFlIlXBqjRRA2pAgMB
AAGjZjBkMA4GA1UdDwEB/wQEAwIBBjASBgNVHRMBAf8ECDAGAQH/AgECMB0GA1Ud
DgQWBBRDWUsraYuA4REzalfNVzjann3F6zAfBgNVHSMEGDAWgBRDWUsraYuA4REz
alfNVzjann3F6zANBgkqhkiG9w0BAQ0FAAOCAgEAkQ+T9nqcSlAuW/90DeYmQOW1
QhqOor5psBEGvxbNGV2hdLJY8h6QUq48BCevcMChg/L1CkznBNI40i3/6heDn3IS
zVEwXKf34pPFCACWVMZxbQjkNRTiH8iRur9EsaNQ5oXCPJkhwg2+IFyoPAAYURoX
VcI9SCDUa45clmYHJ/XYwV1icGVI8/9b2JUqklnOTa5tugwIUi5sTfipNcJXHhgz
6BKYDl0/UP0lLKbsUETXeTGDiDpxZYIgbcFrRDDkHC6BSvdWVEiH5b9mH2BON60z
0O0j8EEKTwi9jnafVtZQXP/D8yoVowdFDjXcKkOPF/1gIh9qrFR6GdoPVgB3SkLc
5ulBqZaCHm563jsvWb/kXJnlFxW+1bsO9BDD6DweBcGdNurgmH625wBXksSdD7y/
fakk8DagjbjKShYlPEFOAqEcliwjF45eabL0t27MJV61O/jHzHL3dknXeE4BDa2j
bA+JbyJeUMtU7KMsxvx82RmhqBEJJDBCJ3scVptvhDMRrtqDBW5JShxoAOcpFQGm
iYWicn46nPDjgTU0bX1ZPpTpryXbvciVL5RkVBuyX2ntcOLDPlZWgxZCBp96x07F
AnOzKgZk4RzZPNAxCXERVxajn/FLcOhglVAKo5H0ac+AitlQ0ip55D2/mf8o72tM
fVQ6VpyjEXdiIXWUq/o=
-----END CERTIFICATE-----
CA
chmod 644 "$SSL_DIR/origin-pull-ca.pem"
openssl x509 -in "$SSL_DIR/origin-pull-ca.pem" -noout -subject >/dev/null 2>&1 \
  || die "同梱の Origin Pull CA が壊れている"
echo "  Origin Pull CA → $SSL_DIR/origin-pull-ca.pem"

if [ "$APPLY" = 0 ]; then
  cat <<'NEXT'

origin-ca: **置いただけ。nginx はまだ切り替えていない。**

  次にやること（この順で）:
    1. sudo bash /tmp/origin-ca.sh --apply --keys /tmp/oca-keys.txt   ← 切り替える
    2. **その後で** Cloudflare の DNS プロキシ（橙色の雲）を ON にする

  **1 の後、DNS プロキシが OFF のままだとサイトは外から見えなくなる**
  （Cloudflare 以外の接続が TLS の時点で落ちるため）。**1 と 2 は続けて行うこと。**
NEXT
  exit 0
fi

# --- 切り替える（--apply） ---------------------------------------------------
command -v nginx >/dev/null || die "nginx が無い"

BACKUP=$(mktemp -d)
cp -a "$NGINX_DIR/sites-available" "$BACKUP/" 2>/dev/null || die "sites-available を退避できない"

# **他サイトの conf を 1 バイトも変えないことを確かめるため、先に md5 を取る**
before=$(find "$NGINX_DIR/sites-available" -type f -print0 | sort -z | xargs -0 md5sum 2>/dev/null)

# **conf の名前はゾーン名ではない**——`vps-setup.sh` の `site_vars` が決めている:
#   giinrecord.jp ゾーン → giinrecord.conf（本番）/ giinrecord-staging.conf
#   gikailog.jp  ゾーン → gikailog.conf（旧ドメインの 301）/ gikailog-staging.conf
# **最初これを `<zone>.conf` と決め打ちして、1 本も見つからず黙って何もしなかった**（ユーザーの実機で実測）。
confs_for_zone() {
  case "$1" in
    giinrecord.jp) echo "$NGINX_DIR/sites-available/giinrecord.conf $NGINX_DIR/sites-available/giinrecord-staging.conf" ;;
    gikailog.jp)   echo "$NGINX_DIR/sites-available/gikailog.conf $NGINX_DIR/sites-available/gikailog-staging.conf" ;;
  esac
}

# **1 本も無ければ落とす**（黙って「変更なし」で終わると、切り替わったと誤解する）
found=0
for z in $ZONES; do
  for c in $(confs_for_zone "$z"); do [ -f "$c" ] && found=$((found+1)); done
done
[ "$found" -gt 0 ] || die "切り替える conf が 1 本も無い（sites-available を確かめること）"
echo "origin-ca: 切り替える conf $found 本"

changed=0
for z in $ZONES; do
  for conf in $(confs_for_zone "$z"); do
    [ -f "$conf" ] || continue
    tmp=$(mktemp)
    # Let's Encrypt の証明書を Origin CA に差し替え、mTLS を足す（**冪等**：既に入っていれば足さない）
    awk -v pem="$SSL_DIR/$z/origin.pem" -v key="$SSL_DIR/$z/origin.key" -v ca="$SSL_DIR/origin-pull-ca.pem" '
      /ssl_certificate_key[[:space:]]/ { print "    ssl_certificate_key " key ";"; next }
      /ssl_certificate[[:space:]]/     { print "    ssl_certificate " pem ";"; next }
      /ssl_client_certificate|ssl_verify_client/ { next }      # 既存を落として書き直す（冪等）
      /ssl_session_cache|ssl_protocols|listen .*443/ && !done {
        print
        print "    ssl_client_certificate " ca ";"
        print "    ssl_verify_client on;"
        done=1; next
      }
      { print }
    ' "$conf" > "$tmp"
    if ! cmp -s "$conf" "$tmp"; then cp "$tmp" "$conf"; changed=$((changed+1)); echo "  切り替えた: $conf"; fi
    rm -f "$tmp"
  done
done

after=$(find "$NGINX_DIR/sites-available" -type f -print0 | sort -z | xargs -0 md5sum 2>/dev/null)
# **対象以外が変わっていないこと**を数える（同居している他サイトを壊していない証拠）
others=$(diff <(echo "$before") <(echo "$after") | grep '^[<>]' | grep -cvE "(giinrecord|gikailog)" || true)
[ "$others" -eq 0 ] || { cp -a "$BACKUP/sites-available/." "$NGINX_DIR/sites-available/"; die "対象以外の conf が $others 行変わった。戻した。"; }

if [ "$changed" -eq 0 ]; then echo "origin-ca: 変更なし（既に切り替わっている）"; exit 0; fi

if ! nginx -t 2>&1; then
  cp -a "$BACKUP/sites-available/." "$NGINX_DIR/sites-available/"
  die "nginx -t が通らないので戻した"
fi
# **戻すときの reload を `nginx -t && systemctl reload nginx` で書かない**（#133 の規則。
# `set -e` のもとで `&&` の左が落ちると errexit が見逃し、reload を飛ばしたまま先へ進む）。
# ここは全体で一番効かせたい 1 行である: 戻した conf が反映されなければ、戻していないのと同じ。
# 失敗したら黙らず、何が残っているかを言って落ちる。
if ! systemctl reload nginx; then
  cp -a "$BACKUP/sites-available/." "$NGINX_DIR/sites-available/"
  if ! nginx -t; then
    die "reload に失敗し、戻した conf でも nginx -t が通らない。$BACKUP を手で確かめること"
  fi
  if ! systemctl reload nginx; then
    die "reload に失敗し、戻した conf の reload も失敗した。稼働中の nginx は古い設定のまま。$BACKUP を手で確かめること"
  fi
  die "reload に失敗したので戻した（戻した設定での reload は成功した）"
fi

# **reload は graceful。古いワーカーが古い証明書を返すのでリトライする**（隣接プロジェクトの実測）
ok=0
for _ in 1 2 3 4 5; do
  sleep 2
  issuer=$(echo | openssl s_client -connect 127.0.0.1:443 -servername giinrecord.jp 2>/dev/null \
           | openssl x509 -noout -issuer 2>/dev/null || true)
  case "$issuer" in *CloudFlare*|*Cloudflare*) ok=1; break ;; esac
done
[ "$ok" = 1 ] && echo "origin-ca: 切り替わった（origin が Cloudflare Origin CA を返している）" \
              || echo "::warning::origin-ca: 5 回見たが Origin CA を確認できなかった。nginx -t は通っている。手で確かめること"

cat <<'NEXT'

origin-ca: **次に Cloudflare の DNS プロキシ（橙色の雲）を ON にすること。**
  **今この瞬間、Cloudflare 以外からの接続は TLS の時点で落ちる。**
  giinrecord.jp / www / staging と gikailog.jp / www / staging の 6 レコードすべて。
NEXT
