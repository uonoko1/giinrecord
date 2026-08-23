#!/usr/bin/env bash
# 運用ユーザー gikaiops（NOPASSWD sudo、鍵1本のみ）を作り、CI の deploy 鍵（ubuntu）を rsync 専用に縮小する。
# 共用 VPS の他ユーザー・他サイトには触れない。root で1回：
#   sudo bash ops-user-setup.sh "<運用者の公開鍵1行>"
set -euo pipefail
PUBKEY="${1:?usage: ops-user-setup.sh '<ssh public key line>'}"
OPS=gikaiops
DEPLOY_USER=ubuntu
SITE_ROOT=/var/www/gikailog

case "$PUBKEY" in ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*) ;; *) echo "public key が不正" >&2; exit 1;; esac

# 1. 運用ユーザー（ログインシェルあり、パスワードなし＝鍵のみ）
id "$OPS" >/dev/null 2>&1 || adduser --disabled-password --gecos "gikailog ops" "$OPS"
install -d -m 700 -o "$OPS" -g "$OPS" "/home/$OPS/.ssh"
printf '%s\n' "$PUBKEY" > "/home/$OPS/.ssh/authorized_keys"   # この鍵1本だけ（上書き）
chown "$OPS:$OPS" "/home/$OPS/.ssh/authorized_keys"; chmod 600 "/home/$OPS/.ssh/authorized_keys"
usermod -aG deploygroup "$OPS" 2>/dev/null || true

# 2. NOPASSWD sudo は gikaiops のみ。ubuntu は変更しない
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$OPS" > "/etc/sudoers.d/90-$OPS"
chmod 440 "/etc/sudoers.d/90-$OPS"; visudo -cf "/etc/sudoers.d/90-$OPS" >/dev/null

# 3. CI deploy 鍵（ubuntu）を rrsync で $SITE_ROOT 以下の rsync 専用に
AK="/home/$DEPLOY_USER/.ssh/authorized_keys"
if grep -q 'gikailog github-actions' "$AK" && ! grep -q "rrsync $SITE_ROOT" "$AK"; then
  sed -i -E "s#^(restrict[^ ]*) (ssh-ed25519 [^ ]+ gikailog github-actions deploy)#command=\"/usr/bin/rrsync $SITE_ROOT\",\\1 \\2#" "$AK"
fi
grep -c "rrsync $SITE_ROOT" "$AK" | sed 's/^/deploy key rrsync-restricted lines: /'

echo "done: ssh $OPS@<host> で NOPASSWD sudo が使える。ubuntu の deploy 鍵は rsync($SITE_ROOT) のみ。"
