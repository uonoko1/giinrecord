#!/usr/bin/env bash
# One-time VPS setup for the SHARED host (Issue #85). Run as:
#   ssh sakura-vps 'sudo bash -s <domain>' < deploy/vps-setup.sh
#
# What it does (and nothing more):
#   1. creates the web root /var/www/seiji-kiroku/site — the rsync target of deploy.yml, owned by the
#      deploy user, bind-mounted read-only into the web container
#   2. writes the host nginx server block: proxy_pass http://127.0.0.1:8080 + (certbot) TLS only.
#      The body is deploy/nginx-host-proxy.conf with DOMAIN substituted
#   3. defines the IP-less access-log format the block references (same file the analytics setup writes)
#   4. reloads nginx and prints the docker compose commands for a human to run
#
# Deliberately NOT done here:
#   - installing anything (docker, packages). Docker is installed by a human with sudo (deploy/README.md)
#   - giving the deploy user ($DEPLOY_USER, the CI rsync key) any docker privilege: membership in the
#     docker group is root-equivalent, and a leaked deploy key must stay a leaked *file copy* key
#   - touching any other site's server block, certificate or log on this shared host
set -euo pipefail
DOMAIN="${1:?usage: vps-setup.sh <domain>}"
DEPLOY_USER=ubuntu
SITE_DIR=/var/www/seiji-kiroku/site
SITE_CONF=/etc/nginx/sites-available/seiji-kiroku.conf

install -d -o "$DEPLOY_USER" -g deploygroup -m 2775 /var/www/seiji-kiroku "$SITE_DIR"

cat > /etc/nginx/conf.d/seiji-kiroku-noip-log.conf <<'CONF'
# Access-log format WITHOUT the client IP and WITHOUT the user agent (seiji-kiroku, Issue #58).
log_format noip '- - [$time_local] "$request" $status $body_bytes_sent "$http_referer" "-"';
CONF

# Keep certbot's 443 block if one exists (re-running after TLS was issued must not drop TLS).
if [ -f "$SITE_CONF" ] && grep -q "listen 443" "$SITE_CONF"; then
  echo "$SITE_CONF already has a TLS block (certbot); not rewriting it. Edit by hand if the proxy block changed." >&2
else
  sed "s/DOMAIN/$DOMAIN/" > "$SITE_CONF" <<'CONF'
server {
    listen 80;
    listen [::]:80;
    server_name DOMAIN;
    access_log /var/log/nginx/seiji-kiroku.access.log noip;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
CONF
fi
ln -sfn "$SITE_CONF" /etc/nginx/sites-enabled/seiji-kiroku.conf
nginx -t && systemctl reload nginx

cat <<MSG
host nginx ready: $DOMAIN -> http://127.0.0.1:8080 (web container). Site root: $SITE_DIR (owner $DEPLOY_USER).

Next, as a user WITH docker privileges (not $DEPLOY_USER):
  1. install docker + compose plugin (https://docs.docker.com/engine/install/ubuntu/), if not yet present
  2. git clone https://github.com/uonoko1/seiji-kiroku.git ~/seiji-kiroku   (only deploy/ is used)
  3. docker compose -f ~/seiji-kiroku/deploy/docker-compose.yml up -d
  4. curl -sI http://127.0.0.1:8080/ | head -1      # HTTP/1.1 200 once deploy.yml has rsynced a build
Then DNS A record $DOMAIN -> this host, and: sudo certbot --nginx -d $DOMAIN --redirect
MSG
