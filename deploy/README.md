# VPS setup (さくらのVPS, smallest plan)

The VPS serves static files only. No Node, no database, no cron.

```sh
# as root, once
apt-get update && apt-get install -y caddy rsync
adduser --disabled-password --gecos "" deploy
mkdir -p /srv/seiji-kiroku/site && chown -R deploy:deploy /srv/seiji-kiroku
install -m 700 -d /home/deploy/.ssh
# paste the PUBLIC half of the GitHub Actions deploy key:
echo 'ssh-ed25519 AAAA... github-actions' > /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys
cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit the domain first
systemctl enable --now caddy
```

GitHub repository secrets (Settings → Environments → production):

| secret | value |
|---|---|
| `DEPLOY_SSH_KEY` | private half of the deploy key (`ssh-keygen -t ed25519 -C github-actions`) |
| `DEPLOY_HOST` | VPS IP or hostname |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan -H <host>` |

Harden SSH: `PasswordAuthentication no`, `PermitRootLogin no`, and `ufw allow 22,80,443/tcp`.
