#!/usr/bin/env bash
# 運用ユーザー giinops（コマンド限定の NOPASSWD sudo、鍵1本のみ）を作り、CI の deploy 鍵（ubuntu）を rsync 専用に縮小する。
# 共用 VPS の他ユーザー・他サイトには触れない。root で1回：
#   sudo bash ops-user-setup.sh "<運用者の公開鍵1行>"
#   テスト: deploy/test/ops-user-setup.test.sh（OPS_SETUP_PREFIX で全パスを一時ディレクトリ配下に、adduser 等はスタブ）
set -euo pipefail
PUBKEY="${1:?usage: ops-user-setup.sh '<ssh public key line>'}"
OPS=giinops
DEPLOY_USER=ubuntu
SITE_ROOT=/var/www/giinrecord
CHECKOUT=/opt/giinrecord   # deploy/ を bind mount 元として持つ root 所有の checkout
PREFIX="${OPS_SETUP_PREFIX:-}"   # テスト専用。本番は空

case "$PUBKEY" in ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*) ;; *) echo "public key が不正" >&2; exit 1;; esac

# 1. 運用ユーザー（ログインシェルあり、パスワードなし＝鍵のみ）
# 改名（gikailog → giinrecord）: このスクリプトは冪等に「作る」だけで旧ユーザーを消さない。
# 旧 gikaiops が残っていると sudo 可能な運用ユーザーが 2 つ並存するので、動作確認のあと人が消す
# （deluser --remove-home gikaiops && rm -f /etc/sudoers.d/90-gikaiops）。docs/ops/deploy.md「改名の移行」。
if [ "$OPS" != gikaiops ] && id gikaiops >/dev/null 2>&1; then
  echo "!! 旧運用ユーザー gikaiops が残っています。$OPS の動作確認後に削除してください（sudoers も）" >&2
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
# nginx（ホスト側・共用）: 検証と reload、自サイトの conf だけ
$OPS ALL=(ALL) NOPASSWD: /usr/sbin/nginx -t
$OPS ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload nginx
$OPS ALL=(ALL) NOPASSWD: /usr/bin/systemctl status nginx
$OPS ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/nginx/sites-available/giinrecord.conf
$OPS ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/nginx/sites-available/giinrecord-staging.conf
$OPS ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/nginx/snippets/giinrecord-cloudflare-allow.conf
# 旧ドメイン（gikailog.jp）の 301 conf。名前が旧称なだけで現役（docs/ops/deploy.md「消さないもの」）
$OPS ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/nginx/sites-available/gikailog.conf
$OPS ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/nginx/sites-available/gikailog-staging.conf
# staging のログ掃除（本番ログは対象外。集計は analytics の担当）
$OPS ALL=(ALL) NOPASSWD: /usr/bin/rm -f /var/log/nginx/giinrecord-staging.access.log
$OPS ALL=(ALL) NOPASSWD: /usr/bin/rm -f /var/log/nginx/giinrecord-staging.error.log
# deploy/ の反映（#325 の学び：release.yml は deploy/ を運ばない。docs/ops/deploy.md）。
# git は -C で対象を固定して pull だけ。docker compose は -f でこの compose ファイルに固定する
$OPS ALL=(ALL) NOPASSWD: /usr/bin/git -C $CHECKOUT pull
$OPS ALL=(ALL) NOPASSWD: /usr/bin/docker compose -f $CHECKOUT/deploy/docker-compose.yml up -d --force-recreate
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
