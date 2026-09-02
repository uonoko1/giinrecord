#!/usr/bin/env bash
# 運用ユーザー giinops（コマンド限定の NOPASSWD sudo、鍵1本のみ）を作り、CI の deploy 鍵（ubuntu）を rsync 専用に縮小する。
# 共用 VPS の他ユーザー・他サイトには触れない。root で:
#   初回:       sudo bash ops-user-setup.sh "<運用者の公開鍵1行>"
#   再実行:     sudo bash ops-user-setup.sh          ← 鍵は既にあるものを使う（allowlist の更新だけ）
#   テスト: deploy/test/ops-user-setup.test.sh（OPS_SETUP_PREFIX で全パスを一時ディレクトリ配下に、adduser 等はスタブ）
set -euo pipefail
OPS=giinops
DEPLOY_USER=ubuntu
SITE_ROOT=/var/www/giinrecord
CHECKOUT=/opt/giinrecord   # deploy/ を bind mount 元として持つ root 所有の checkout
PREFIX="${OPS_SETUP_PREFIX:-}"   # テスト専用。本番は空

# 鍵は引数で渡す。**allowlist を更新するだけの再実行では省略できる**（既にある鍵をそのまま使う）。
# 鍵をコマンドラインに置くと、sudo が /var/log/auth.log にコマンド全体を記録するので
# **公開鍵が平文でログに残る**（秘密ではないが、残す理由も無い）。ps とシェル履歴にも出る。
# allowlist の更新（#375 のような）はこの理由で毎回鍵を渡し直す必要が無い。
PUBKEY="${1:-}"
if [ -z "$PUBKEY" ]; then
  EXISTING="$PREFIX/home/$OPS/.ssh/authorized_keys"
  [ -r "$EXISTING" ] || { echo "usage: ops-user-setup.sh '<ssh public key line>'（初回は鍵が要ります）" >&2; exit 2; }
  PUBKEY=$(head -n1 "$EXISTING")
  echo "既にある鍵をそのまま使います（$EXISTING の1行目）。鍵を差し替えるときは引数で渡してください。" >&2
fi
# **1行だけ**を受け取る。複数行を渡すと authorized_keys が壊れる（`>` で上書きするため）
case "$PUBKEY" in
  *$'\n'*) echo "public key は1行で渡してください（複数行は authorized_keys を壊します）" >&2; exit 1;;
  ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*) ;;
  *) echo "public key が不正" >&2; exit 1;;
esac

# 1. 運用ユーザー（ログインシェルあり、パスワードなし＝鍵のみ）
# 改名（gikailog → giinrecord）: このスクリプトは冪等に「作る」だけで旧ユーザーを消さない。
# 旧 gikaiops が残っていると sudo 可能な運用ユーザーが 2 つ並存するので、動作確認のあと人が消す
# （deluser --remove-home gikaiops && rm -f /etc/sudoers.d/90-gikaiops）。docs/ops/deploy.md「改名の移行」。
# 警告は「残っています」では読み流される（#336：実際に読み流し、NOPASSWD:ALL を持つ旧ユーザーが
# 生きたまま数日放置された）。**旧ユーザーが実際に何を許可されているかを調べて**、危険なら言い切る。
LEGACY_OPS=gikaiops
if [ "$OPS" != "$LEGACY_OPS" ] && id "$LEGACY_OPS" >/dev/null 2>&1; then
  legacy_sudo=$(sudo -n -l -U "$LEGACY_OPS" 2>/dev/null || true)
  if printf '%s' "$legacy_sudo" | grep -Eq 'NOPASSWD:[[:space:]]*ALL'; then
    cat >&2 <<WARN
!! 危険: 旧運用ユーザー $LEGACY_OPS が **NOPASSWD: ALL**（無制限の root）を持ったまま生きています。
!! $OPS をどれだけ絞っても、$LEGACY_OPS にログインできる鍵があれば迂回されます（#336）。
!! $OPS の動作確認ができ次第、次を実行してください:
!!     sudo rm -f /etc/sudoers.d/[0-9][0-9]-$LEGACY_OPS
!!     sudo deluser --remove-home $LEGACY_OPS
WARN
  else
    echo "!! 旧運用ユーザー $LEGACY_OPS が残っています。$OPS の動作確認後に削除してください（sudoers も）" >&2
  fi
fi
id "$OPS" >/dev/null 2>&1 || adduser --disabled-password --gecos "giinrecord ops" "$OPS"
install -d -m 700 "$PREFIX/home/$OPS/.ssh"
[ -n "$PREFIX" ] || chown "$OPS:$OPS" "/home/$OPS/.ssh"
printf '%s\n' "$PUBKEY" > "$PREFIX/home/$OPS/.ssh/authorized_keys"   # この鍵1本だけ（上書き）
[ -n "$PREFIX" ] || chown "$OPS:$OPS" "/home/$OPS/.ssh/authorized_keys"
chmod 600 "$PREFIX/home/$OPS/.ssh/authorized_keys"
usermod -aG deploygroup "$OPS" 2>/dev/null || true

# 2. sudo は giinops のみ、しかも**コマンドを固定した allowlist**（ubuntu は変更しない）。
# NOPASSWD:ALL は与えない（#333）：運用鍵1本が漏れたら共用 VPS ごと root を取られる。
# 追加してよいのは「引数まで書ききれるコマンド」だけ。書ききれない＝与えてはいけない
# （例: `bash /tmp/*.sh` のようなワイルドカードは任意コード実行なので NOPASSWD:ALL と同じ）。
# sudoers.d は**全ファイルの和集合**なので、世代違いが1つでも残ると allowlist を締めた意味が消える。
# 実際 91-giinops（手で足された旧世代）に `bash /tmp/*.sh` が残っていた（#333）。生成前に自分の世代を掃除する。
# 掃除するのは "<数字2桁>-<OPS>" だけ。共用ホストの他ファイル（他サイトの sudoers）には触れない。
SUDOERS_DIR="$PREFIX/etc/sudoers.d"
SUDOERS="$SUDOERS_DIR/90-$OPS"
mkdir -p "$SUDOERS_DIR"
for stale in "$SUDOERS_DIR"/[0-9][0-9]-"$OPS"; do
  [ -e "$stale" ] || continue
  [ "$stale" = "$SUDOERS" ] || echo "旧世代の sudoers を削除: $stale" >&2
  rm -f "$stale"   # $SUDOERS 自身も消す（0440 のままだと書き直せないため）
done
install -m 600 /dev/null "$SUDOERS"   # 先に作って権限を確定（他ユーザーに読ませない）。書き終えてから 0440 にする
cat > "$SUDOERS" <<EOF
# giinrecord の運用ユーザー。deploy/ops-user-setup.sh が生成する（サーバー上で手編集しない）。
# 環境は必ずリセットする。ベースの /etc/sudoers に依存せずここで明示する：
# docker-compose.yml の \${SITE_DIR:-...} は SITE_DIR=/ でホスト root を root 権限のコンテナに
# bind mount できてしまうので、環境変数が渡らないことが安全性の前提になっている（#333）。
Defaults:$OPS env_reset, !setenv, use_pty
# nginx（ホスト側・共用）: 検証と reload だけ。
# conf を書く許可（tee）は与えない（#335）。nginx master は root で動くので、conf に任意の内容を
# 書ける者は任意ファイルを HTTP 公開でき、他サイトの TLS 秘密鍵も読め、ログの書き込み先を通じて
# root 権限でファイルを作れる。nginx -t はこれらを検査しない = 実質 root 相当。
# 共用ホストなので影響は自サイトに閉じない。詳しくは docs/ops/deploy.md。
# conf を書く作業（vps-setup.sh / cloudflare-allowlist.sh）は元から root として実行しており、
# この許可を使っていなかった。
$OPS ALL=(ALL) NOPASSWD: /usr/sbin/nginx -t
$OPS ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload nginx
$OPS ALL=(ALL) NOPASSWD: /usr/bin/systemctl status nginx
# staging のログ掃除（本番ログは対象外。集計は analytics の担当）
$OPS ALL=(ALL) NOPASSWD: /usr/bin/rm -f /var/log/nginx/giinrecord-staging.access.log
$OPS ALL=(ALL) NOPASSWD: /usr/bin/rm -f /var/log/nginx/giinrecord-staging.error.log
# deploy/ の反映（#325 の学び：release.yml は deploy/ を運ばない。docs/ops/deploy.md）。
# git は -C で対象を固定して pull だけ。docker compose は -f でこの compose ファイルに固定する
$OPS ALL=(ALL) NOPASSWD: /usr/bin/git -C $CHECKOUT pull
$OPS ALL=(ALL) NOPASSWD: /usr/bin/docker compose -f $CHECKOUT/deploy/docker-compose.yml up -d --force-recreate
# 状態の確認（Issue 375）。読み取り専用で何も変えない。「直せるが見られない」状態を避ける。
# **logs は足さない**: コンテナの nginx ログは IP を含む（docs/ops/analytics.md の方針。
# 集計はホスト側の IP 無しログだけ）。読めてしまうと方針の抜け道になる。
$OPS ALL=(ALL) NOPASSWD: /usr/bin/docker compose -f $CHECKOUT/deploy/docker-compose.yml ps
EOF
chmod 440 "$SUDOERS"; visudo -cf "$SUDOERS" >/dev/null

# 3. CI deploy 鍵（ubuntu）を rrsync で $SITE_ROOT 以下の rsync 専用に
# 改名（gikailog → giinrecord）: 下の grep は鍵コメント "giinrecord github-actions" にしか当たらない。
# VPS 上の鍵行が旧コメント "gikailog github-actions" のままだと if は偽になり、エラーも出さずに何もしない。
# 鍵コメントと command="/usr/bin/rrsync /var/www/gikailog" は人が先に書き換える（docs/ops/deploy.md「改名の移行」）。
AK="$PREFIX/home/$DEPLOY_USER/.ssh/authorized_keys"
if grep -q 'gikailog github-actions' "$AK" 2>/dev/null; then
  echo "!! $AK の鍵コメントが旧名 'gikailog github-actions' のままです。rrsync 制限は適用されません（docs/ops/deploy.md）" >&2
fi
if grep -q 'giinrecord github-actions' "$AK" && ! grep -q "rrsync $SITE_ROOT" "$AK"; then
  sed -i -E "s#^(restrict[^ ]*) (ssh-ed25519 [^ ]+ giinrecord github-actions deploy)#command=\"/usr/bin/rrsync $SITE_ROOT\",\\1 \\2#" "$AK"
fi
echo "deploy key rrsync-restricted lines: $(grep -c "rrsync $SITE_ROOT" "$AK" || true)"

echo "done: ssh $OPS@<host> で allowlist 内のコマンドだけ NOPASSWD sudo できる（sudo -n -l で確認）。"
echo "      ubuntu の deploy 鍵は rsync($SITE_ROOT) のみ。"
