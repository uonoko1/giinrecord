# VPS deploy (shared host: host nginx → web container)

The site is static files. On the VPS they are served by an **nginx container** (`docker compose`, this directory),
and the **host nginx** — which also serves other sites on this shared machine — only terminates TLS and proxies
to the container on loopback. No Node, no database on the VPS. The only cron job is the cookie-less
access-log aggregation (`deploy/analytics/`, see `docs/ops/analytics.md`).

```
internet ──443/80──▶ host nginx (certbot TLS, sites-available/seiji-kiroku.conf)
                       └─ proxy_pass http://127.0.0.1:8080
                            └─▶ web container  nginx:alpine  (deploy/nginx/site.conf: SPA fallback, cache, security headers)
                                   └─ /usr/share/nginx/html  ⇐ bind mount :ro ⇐ /var/www/seiji-kiroku/site  ⇐ rsync from deploy.yml
```

| file | role |
|---|---|
| `docker-compose.yml` | `web` service: `nginx:1.27-alpine`, `127.0.0.1:8080:80`, site mounted read-only, healthcheck, `restart: unless-stopped`. `SITE_DIR` overrides the mount (local/CI) |
| `nginx/site.conf` | config inside the container — the former host server block, unchanged: `try_files … /__spa-fallback.html`, `/assets/` immutable 1y, `/data/` 1h, gzip, `X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy` / CSP |
| `nginx-host-proxy.conf` | host nginx server block (proxy + TLS only). `vps-setup.sh` writes the same text with `DOMAIN` substituted |
| `vps-setup.sh` | one-time, sudo: web root, host server block, `noip` log format, `nginx reload`. **Installs nothing** |
| `analytics/` | IP-less access-log aggregation (unchanged; the log is now written by the host proxy block) |

Who may do what on the shared host:

- **`ubuntu`** = the CI deploy-key user (`deploy.yml` rsync, key restricted with `restrict,no-pty`). It owns
  `/var/www/seiji-kiroku/site` and nothing else. It is **not** in the `docker` group and never will be — docker-group
  membership is root-equivalent, and a leaked deploy key must remain a file-copy key.
- **a human with sudo** installs Docker, runs `docker compose`, runs certbot. None of that is automated.

## One-time setup

```sh
# 1. (human, sudo) host nginx block + web root. Installs nothing. DOMAIN = the hostname that will point here.
ssh sakura-vps 'sudo bash -s DOMAIN' < deploy/vps-setup.sh
# 2. (human, sudo) Docker Engine + compose plugin, if not present: https://docs.docker.com/engine/install/ubuntu/
#    Do NOT add `ubuntu` to the docker group.
# 3. (human with docker privileges) start the container from a checkout of this repo
ssh sakura-vps 'git clone https://github.com/uonoko1/seiji-kiroku.git ~/seiji-kiroku'   # or git pull
ssh sakura-vps 'docker compose -f ~/seiji-kiroku/deploy/docker-compose.yml up -d'
ssh sakura-vps 'curl -sI http://127.0.0.1:8080/ | head -1'                               # 200 once a build was rsynced
# 4. DNS: A record  DOMAIN -> 160.16.86.160
# 5. TLS (after DNS propagates) — certbot edits only sites-available/seiji-kiroku.conf
ssh sakura-vps 'sudo certbot --nginx -d DOMAIN --redirect'
```

Re-running `vps-setup.sh` is safe: once certbot has added the 443 block the script leaves the file alone and says so.

## Continuous deploy (unchanged)

`.github/workflows/deploy.yml` runs on every push to `main` (and after the daily ETL): build → `rsync --delete`
to `/var/www/seiji-kiroku/site/` as user `ubuntu`. The container serves the new files immediately — the
directory is bind-mounted, nothing to restart.

GitHub Environment `production` secrets: `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KNOWN_HOSTS`.
To rotate the key: `ssh-keygen -t ed25519 -C "seiji-kiroku github-actions deploy"`, replace the line tagged
`seiji-kiroku github-actions` in `~ubuntu/.ssh/authorized_keys`, update `DEPLOY_SSH_KEY`.

## Changing nginx config or the image

`nginx/site.conf` and `docker-compose.yml` are read from the repo checkout on the VPS, so a change is: merge →
`git pull` → `docker compose -f deploy/docker-compose.yml up -d` (recreates the container; seconds of downtime
the host proxy answers with 502). Header/cache values are pinned by `packages/etl/test/deploy-docker.test.ts`
and verified on a running container by CI (`docker-web` job) — change the test first.

## Local / CI

Same compose file, your own build:

```sh
pnpm build
SITE_DIR=$PWD/apps/web/build/client docker compose -f deploy/docker-compose.yml up -d --wait
pnpm --filter web smoke -- --url http://127.0.0.1:8080     # pages 200, SPA fallback, headers, Cache-Control
docker compose -f deploy/docker-compose.yml down
```

Operations (logs, restart, failure modes): `docs/ops/deploy.md`.

## ETL container (`docker-compose.etl.yml`, #86)

The ETL is a separate compose file so that it can be layered on the site compose file (#85) or run alone:

```sh
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.etl.yml run --rm etl 221
ETL_UID=$(id -u) ETL_GID=$(id -g) docker compose -f deploy/docker-compose.etl.yml run --rm --build etl 221
```

It writes `data/` and `packages/etl/.cache` through bind mounts as the given uid (non-root; `node` = 1000 by default). Details and the byte-identical check (`scripts/etl-docker-diff.sh`) are in `docs/ops/etl.md`. Nothing here needs docker on the VPS: the deploy user `ubuntu` stays without docker privileges.
