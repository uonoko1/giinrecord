# VPS deploy (shared nginx host)

The site is static files served by the existing nginx. No Node, no database, no cron on the VPS.

## One-time setup (needs sudo)

```sh
# 1. nginx server block + web root (DOMAIN is the hostname you will point at the VPS)
ssh sakura-vps 'sudo bash -s seiji-kiroku.daichisakai.net' < deploy/vps-setup.sh
# 2. DNS: A record  seiji-kiroku.daichisakai.net -> 160.16.86.160
# 3. TLS (after DNS propagates)
ssh sakura-vps 'sudo certbot --nginx -d seiji-kiroku.daichisakai.net --redirect'
```

## Continuous deploy

`.github/workflows/deploy.yml` runs on every push to `main`: build → `rsync --delete` to `/var/www/seiji-kiroku/site/` as user `ubuntu` with a dedicated, restricted deploy key (`restrict,no-pty`).

GitHub Environment `production` secrets (already set): `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KNOWN_HOSTS`.

To rotate the key: `ssh-keygen -t ed25519 -C "seiji-kiroku github-actions deploy"`, replace the line tagged `seiji-kiroku github-actions` in `~ubuntu/.ssh/authorized_keys`, update `DEPLOY_SSH_KEY`.
