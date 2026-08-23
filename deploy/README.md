# VPS deploy (shared host: host nginx → web containers)

The site is static files. On the VPS they are served by **nginx containers** (`docker compose`, this directory) —
one for production, one for staging (Issue #127) — and the **host nginx**, which also serves other sites on this
shared machine, only terminates TLS and proxies to the containers on loopback. No Node, no database on the VPS.
The only cron job is the cookie-less access-log aggregation (`deploy/analytics/`, see `docs/ops/analytics.md`).

```
internet ──443/80──▶ host nginx (certbot TLS)
                       ├─ gikailog.jp          sites-available/gikailog.conf          proxy_pass http://127.0.0.1:8081
                       │     └─▶ web          nginx:alpine  /var/www/gikailog/site    ⇐ rsync: release.yml (manual), deploy-data.yml (daily data)
                       └─ staging.gikailog.jp  sites-available/gikailog-staging.conf  proxy_pass http://127.0.0.1:8083
                             └─▶ web-staging  nginx:alpine  /var/www/gikailog/staging ⇐ rsync: deploy-staging.yml (every push to main), deploy-data.yml
                       both containers: deploy/nginx/site.conf (SPA fallback, cache, security headers; X-Robots-Tag noindex for Host staging.gikailog.jp)
```

| file | role |
|---|---|
| `docker-compose.yml` | `web` (`127.0.0.1:8081:80`, `/var/www/gikailog/site`) and `web-staging` (`127.0.0.1:8083:80`, `/var/www/gikailog/staging`): `nginx:1.27-alpine`, site mounted read-only, healthcheck, `restart: unless-stopped`. `SITE_DIR` / `STAGING_SITE_DIR` override the mounts (local/CI) |
| `nginx/site.conf` | config inside both containers — the former host server block, unchanged: `try_files … /__spa-fallback.html`, `/assets/` immutable 1y, `/data/` 1h, gzip, `X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy` / CSP. Plus a `map $host` that adds `X-Robots-Tag: noindex, nofollow` only for `staging.gikailog.jp` |
| `nginx-host-proxy.conf` | host nginx server blocks template: `:80` → 301 `https://DOMAIN` (www included), `:443` TLS → proxy. `vps-setup.sh <domain> [port]` writes the same text with `SERVER_NAMES` / `DOMAIN` / `PORT` / `LOG_NAME` substituted |
| `vps-setup.sh` | one-time, sudo: web root, host server block, `noip` log format, `nginx -t` → reload (exit 1 on a broken config). Port `8081` (default) = production, `8083` = staging. **Installs nothing** |
| `go-live.sh` | production go-live, root, idempotent (docker install, `/opt/gikailog` checkout, compose up, `vps-setup.sh`, certbot, analytics) |
| `staging-setup.sh` | staging go-live, root, idempotent, after production exists: staging web root, compose up, `cloudflare-allowlist.sh --install-cron`, `vps-setup.sh staging.gikailog.jp 8083`, certbot |
| `cloudflare-allowlist.sh` | Issue #163: `/etc/nginx/snippets/gikailog-cloudflare-allow.conf` (`allow` Cloudflare's ips-v4/v6, `deny all`) from strictly validated ranges, atomic write, `nginx -t` gate with rollback, `--install-cron` = weekly root cron. Included by the **staging** 443 block only, which also returns 403 without `Cf-Access-Jwt-Assertion` (staging is behind Cloudflare Access: `docs/ops/staging-access.md`) |
| `analytics/` | IP-less access-log aggregation of `gikailog.access.log` (production only; staging logs to `gikailog-staging.access.log` and is not aggregated) |

Who may do what on the shared host:

- **`ubuntu`** = the CI deploy-key user (`deploy-site.yml` rsync, key restricted with `restrict,no-pty`). It owns
  `/var/www/gikailog/site` and `/var/www/gikailog/staging` and nothing else. It is **not** in the `docker` group and
  never will be — docker-group membership is root-equivalent, and a leaked deploy key must remain a file-copy key.
- **a human with sudo** installs Docker, runs `docker compose`, runs certbot. None of that is automated.

## One-time setup

The VPS is addressed by the ssh alias in `$VPS_SSH_HOST` (default `sakura-vps`, defined in your own
`~/.ssh/config`); its IP address is deliberately not written anywhere in this repository (Issue #133) — the
site is reachable as `gikailog.jp` once DNS is live.

### production

All of this (plus the `seiji-kiroku` → `gikailog` path migration, Issue #119) is automated by `deploy/go-live.sh`
(`ssh -t "$VPS_SSH_HOST" 'sudo bash -s gikailog.jp' < deploy/go-live.sh`); the steps below are the manual equivalent.

```sh
VPS_SSH_HOST="${VPS_SSH_HOST:-sakura-vps}"
# 1. (human, sudo) host nginx block + web root. Installs nothing. DOMAIN = the hostname that will point here.
ssh "$VPS_SSH_HOST" 'sudo bash -s DOMAIN' < deploy/vps-setup.sh
# 2. (human, sudo) Docker Engine + compose plugin, if not present: https://docs.docker.com/engine/install/ubuntu/
#    Do NOT add `ubuntu` to the docker group.
# 3. (human with docker privileges) start the containers from a checkout of this repo
ssh "$VPS_SSH_HOST" 'git clone https://github.com/uonoko1/gikailog.git /opt/gikailog'   # or git pull
ssh "$VPS_SSH_HOST" 'docker compose -f /opt/gikailog/deploy/docker-compose.yml up -d --force-recreate'
ssh "$VPS_SSH_HOST" 'curl -sI http://127.0.0.1:8081/ | head -1'                               # 200 once a build was rsynced
# 4. DNS: A record  DOMAIN -> the VPS (address from the hosting panel; never commit it)
# 5. TLS (after DNS propagates) — certonly: certbot does not edit nginx config (the template owns the redirects)
ssh "$VPS_SSH_HOST" "sudo certbot certonly --nginx -d DOMAIN -d www.DOMAIN --deploy-hook 'systemctl reload nginx'"
# 6. (human, sudo) again: now that the certificate exists it writes the :80 redirect + :443 proxy blocks
ssh "$VPS_SSH_HOST" 'sudo bash -s DOMAIN' < deploy/vps-setup.sh
```

Re-running `vps-setup.sh` is safe (idempotent, Issue #141): without a certificate it writes a plain `:80` proxy block, with one the
full template (`:80` → 301 https, `:443` proxy); a conf that certbot manages (hosts set up before #141) is left alone except for the
`proxy_pass` port. `go-live.sh` / `staging-setup.sh` validate the domain, check the port with `ss -tln`, always `--force-recreate`
the containers and skip certbot when the certificate exists — see `docs/ops/deploy.md`.

### staging (Issue #127)

Two human actions, nothing else:

```sh
# 1. DNS: A record  staging.gikailog.jp -> the VPS (same address as gikailog.jp; never commit it)
# 2. (root, once; needs a TTY for certbot) staging web root, web-staging container, host proxy block on :8083, TLS
ssh -t "$VPS_SSH_HOST" 'sudo bash -s' < deploy/staging-setup.sh
```

Then on GitHub: Environment `staging` with the same `DEPLOY_*` secrets as `production` (and `production-data`, see
below), and the first `Deploy (staging)` run fills `/var/www/gikailog/staging`.

## Continuous deploy

All three workflows call the reusable `.github/workflows/deploy-site.yml` (build with `SITE_ORIGIN` → `rsync --delete`
to `/var/www/gikailog/<target_dir>/` as user `ubuntu`). The containers serve the new files immediately — the
directories are bind-mounted, nothing to restart.

| workflow | trigger | environment | builds | rsync target |
|---|---|---|---|---|
| `deploy-staging.yml` | every push to `main` | `staging` | `SITE_ORIGIN=https://staging.gikailog.jp` (robots `Disallow: /`, `<meta name=robots content=noindex>`) | `staging/` |
| `release.yml` | Actions → Release → Run workflow, input `ref` (default `main`) | `production` — **required reviewers** = the approve button | `vars.SITE_ORIGIN` | `site/` |
| `deploy-data.yml` | dispatched by `etl.yml` / `districts.yml` after the data PR merges (+ 06:30 JST safety net) | `staging` and `production-data` (no reviewers) | `main` | both |

GitHub Environment secrets (identical in `staging`, `production`, `production-data`): `DEPLOY_SSH_KEY`, `DEPLOY_HOST`,
`DEPLOY_USER`, `DEPLOY_KNOWN_HOSTS`. To rotate the key: `ssh-keygen -t ed25519 -C "gikailog github-actions deploy"`,
replace the line tagged `gikailog github-actions` in `~ubuntu/.ssh/authorized_keys`, update `DEPLOY_SSH_KEY` everywhere.

## Changing nginx config or the image

`nginx/site.conf` and `docker-compose.yml` are read from the repo checkout on the VPS, so a change is: merge →
`git pull` → `docker compose -f deploy/docker-compose.yml up -d` (recreates both containers; seconds of downtime
the host proxy answers with 502). Header/cache values are pinned by `packages/etl/test/deploy-docker.test.ts`
and verified on running containers by CI (`docker-web` job, ports 8081 and 8083) — change the test first.

## Local / CI

Same compose file, your own build:

```sh
pnpm build
SITE_DIR=$PWD/apps/web/build/client STAGING_SITE_DIR=$PWD/apps/web/build/client docker compose -f deploy/docker-compose.yml up -d --wait
pnpm --filter web smoke -- --url http://127.0.0.1:8081     # pages 200, SPA fallback, headers, Cache-Control
pnpm --filter web smoke -- --url http://127.0.0.1:8083
curl -sI -H 'Host: staging.gikailog.jp' http://127.0.0.1:8083/ | grep -i x-robots-tag   # noindex, nofollow
docker compose -f deploy/docker-compose.yml down
```

Operations (logs, restart, failure modes, release procedure): `docs/ops/deploy.md`.

## ETL container (`docker-compose.etl.yml`, #86)

The ETL is a separate compose file so that it can be layered on the site compose file (#85) or run alone:

```sh
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.etl.yml run --rm etl 221
ETL_UID=$(id -u) ETL_GID=$(id -g) docker compose -f deploy/docker-compose.etl.yml run --rm --build etl 221
```

It writes `data/` and `packages/etl/.cache` through bind mounts as the given uid (non-root; `node` = 1000 by default). Details and the byte-identical check (`scripts/etl-docker-diff.sh`) are in `docs/ops/etl.md`. Nothing here needs docker on the VPS: the deploy user `ubuntu` stays without docker privileges.
