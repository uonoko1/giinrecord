# VPS deploy (shared nginx host)

The site is static files served by the existing nginx. No Node, no database on the VPS. The only cron job is the cookie-less access-log aggregation (`deploy/analytics/`, see `docs/ops/analytics.md`).

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

## ETL container (`docker-compose.etl.yml`, #86)

The ETL is a separate compose file so that it can be layered on the site compose file (#85) or run alone:

```sh
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.etl.yml run --rm etl 221
ETL_UID=$(id -u) ETL_GID=$(id -g) docker compose -f deploy/docker-compose.etl.yml run --rm --build etl 221
```

It writes `data/` and `packages/etl/.cache` through bind mounts as the given uid (non-root; `node` = 1000 by default). Details and the byte-identical check (`scripts/etl-docker-diff.sh`) are in `docs/ops/etl.md`. Nothing here needs docker on the VPS: the deploy user `ubuntu` stays without docker privileges.
