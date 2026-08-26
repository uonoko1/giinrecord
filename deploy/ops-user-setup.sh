#!/usr/bin/env bash
# 運用ユーザー giinops（NOPASSWD sudo、鍵1本のみ）を作り、CI の deploy 鍵（ubuntu）を rsync 専用に縮小する。
# 共用 VPS の他ユーザー・他サイトには触れない。root で1回：
#   sudo bash ops-user-setup.sh "<運用者の公開鍵1行>"
set -euo pipefail
PUBKEY="${1:?usage: ops-user-setup.sh '<ssh public key line>'}"
OPS=giinops
DEPLOY_USER=ubuntu
SITE_ROOT=/var/www/giinrecord

case "$PUBKEY" in ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*) ;; *) echo "public key が不正" >&2; exit 1;; esac

# 1. 運用ユーザー（ログインシェルあり、パスワードなし＝鍵のみ）
# 改名（gikailog → giinrecord）: このスクリプトは冪等に「作る」だけで旧ユーザーを消さない。
# 旧 giinops が残っていると NOPASSWD sudo ユーザーが 2 つ並存するので、動作確認のあと人が消す
# （deluser --remove-home gikaiops && rm -f /etc/sudoers.d/90-gikaiops）。docs/ops/deploy.md「改名の移行」。
if [ "$OPS" != gikaiops ] && id gikaiops >/dev/null 2>&1; then
  echo "!! 旧運用ユーザー gikaiops が残っています。$OPS の動作確認後に削除してください（sudoers も）" >&2
fi
id "$OPS" >/dev/null 2>&1 || adduser --disabled-password --gecos "giinrecord ops" "$OPS"
install -d -m 700 -o "$OPS" -g "$OPS" "/home/$OPS/.ssh"
printf '%s\n' "$PUBKEY" > "/home/$OPS/.ssh/authorized_keys"   # この鍵1本だけ（上書き）
chown "$OPS:$OPS" "/home/$OPS/.ssh/authorized_keys"; chmod 600 "/home/$OPS/.ssh/authorized_keys"
usermod -aG deploygroup "$OPS" 2>/dev/null || true

# 2. NOPASSWD sudo は giinops のみ。ubuntu は変更しない
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$OPS" > "/etc/sudoers.d/90-$OPS"
chmod 440 "/etc/sudoers.d/90-$OPS"; visudo -cf "/etc/sudoers.d/90-$OPS" >/dev/null

# 3. CI deploy 鍵（ubuntu）を rrsync で $SITE_ROOT 以下の rsync 専用に
# 改名（gikailog → giinrecord）: 下の grep は鍵コメント "giinrecord github-actions" にしか当たらない。
# VPS 上の鍵行が旧コメント "gikailog github-actions" のままだと if は偽になり、エラーも出さずに何もしない。
# 鍵コメントと command="/usr/bin/rrsync /var/www/gikailog" は人が先に書き換える（docs/ops/deploy.md「改名の移行」）。
AK="/home/$DEPLOY_USER/.ssh/authorized_keys"
if grep -q 'gikailog github-actions' "$AK" 2>/dev/null; then
  echo "!! $AK の鍵コメントが旧名 'gikailog github-actions' のままです。rrsync 制限は適用されません（docs/ops/deploy.md）" >&2
fi
if grep -q 'giinrecord github-actions' "$AK" && ! grep -q "rrsync $SITE_ROOT" "$AK"; then
  sed -i -E "s#^(restrict[^ ]*) (ssh-ed25519 [^ ]+ giinrecord github-actions deploy)#command=\"/usr/bin/rrsync $SITE_ROOT\",\\1 \\2#" "$AK"
fi
grep -c "rrsync $SITE_ROOT" "$AK" | sed 's/^/deploy key rrsync-restricted lines: /'

echo "done: ssh $OPS@<host> で NOPASSWD sudo が使える。ubuntu の deploy 鍵は rsync($SITE_ROOT) のみ。"
