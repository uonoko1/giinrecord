#!/usr/bin/env bash
# One-time VPS setup for the SHARED host (Issue #85; staging Issue #127). Run as:
#   ssh sakura-vps 'sudo bash -s <domain> [port]' < deploy/vps-setup.sh
#     port 8081 (default) = production: gikailog.jp         → /var/www/gikailog/site,    sites-available/gikailog.conf
#     port 8082           = staging:    staging.gikailog.jp → /var/www/gikailog/staging, sites-available/gikailog-staging.conf
#
# What it does (and nothing more):
#   1. creates the web root — the rsync target of the deploy workflows, owned by the deploy user,
#      bind-mounted read-only into the web / web-staging container
#   2. writes the host nginx server block: proxy_pass http://127.0.0.1:<port> + (certbot) TLS only.
#      The body is deploy/nginx-host-proxy.conf with SERVER_NAMES / PORT / LOG_NAME substituted
#   3. defines the IP-less access-log format the block references (same file the analytics setup writes)
#   4. reloads nginx and prints the docker compose commands for a human to run
#
# Deliberately NOT done here:
#   - installing anything (docker, packages). Docker is installed by a human with sudo (deploy/README.md)
#   - giving the deploy user ($DEPLOY_USER, the CI rsync key) any docker privilege: membership in the
#     docker group is root-equivalent, and a leaked deploy key must stay a leaked *file copy* key
#   - touching any other site's server block, certificate or log on this shared host
#
# Tests source this file with VPS_SETUP_NO_MAIN=1 and call render_host_proxy (deploy/test/render-host-proxy.sh).
set -euo pipefail
DEPLOY_USER=ubuntu

# site_vars <port>: sets NAME (conf + log name) and SITE_DIR for the port; rejects anything but 8081/8082.
site_vars() {
  case "$1" in
    8081) NAME=gikailog; SITE_DIR=/var/www/gikailog/site ;;
    8082) NAME=gikailog-staging; SITE_DIR=/var/www/gikailog/staging ;;
    *) echo "vps-setup.sh: port must be 8081 (production) or 8082 (staging), got '$1'" >&2; return 1 ;;
  esac
}

# render_host_proxy <domain> <port>: the server block for the host nginx on stdout.
# The heredoc is deploy/nginx-host-proxy.conf verbatim (the test checks they are identical).
# Production answers for www.<domain> too (the container redirects it to the apex); staging has no www.
render_host_proxy() {
  local domain=$1 port=$2 names
  site_vars "$port"
  if [ "$port" = 8081 ]; then names="$domain www.$domain"; else names="$domain"; fi
  sed -e "s/SERVER_NAMES/$names/" -e "s/PORT/$port/" -e "s/LOG_NAME/$NAME/" <<'CONF'
server {
    listen 80;
    listen [::]:80;
    server_name SERVER_NAMES;
    access_log /var/log/nginx/LOG_NAME.access.log noip;

    location / {
        proxy_pass http://127.0.0.1:PORT;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
CONF
}

main() {
  local DOMAIN PORT SITE_CONF
  DOMAIN="${1:?usage: vps-setup.sh <domain> [port: 8081 (production, default) | 8082 (staging)]}"
  PORT="${2:-8081}"
  site_vars "$PORT"
  SITE_CONF=/etc/nginx/sites-available/$NAME.conf

  install -d -o "$DEPLOY_USER" -g deploygroup -m 2775 /var/www/gikailog "$SITE_DIR"

  cat > /etc/nginx/conf.d/gikailog-noip-log.conf <<'CONF'
# Access-log format WITHOUT the client IP and WITHOUT the user agent (gikailog, Issue #58).
log_format noip '- - [$time_local] "$request" $status $body_bytes_sent "$http_referer" "-"';
CONF

  # Keep certbot's 443 block if one exists (re-running after TLS was issued must not drop TLS).
  if [ -f "$SITE_CONF" ] && grep -q "listen 443" "$SITE_CONF"; then
    echo "$SITE_CONF already has a TLS block (certbot); not rewriting it. Edit by hand if the proxy block changed." >&2
  else
    render_host_proxy "$DOMAIN" "$PORT" > "$SITE_CONF"
  fi
  ln -sfn "$SITE_CONF" "/etc/nginx/sites-enabled/$NAME.conf"
  nginx -t && systemctl reload nginx

  cat <<MSG
host nginx ready: $DOMAIN -> http://127.0.0.1:$PORT (container). Site root: $SITE_DIR (owner $DEPLOY_USER).

Next, as a user WITH docker privileges (not $DEPLOY_USER):
  1. install docker + compose plugin (https://docs.docker.com/engine/install/ubuntu/), if not yet present
  2. git clone https://github.com/uonoko1/gikailog.git /opt/gikailog   (only deploy/ is used)
  3. docker compose -f /opt/gikailog/deploy/docker-compose.yml up -d
  4. curl -sI http://127.0.0.1:$PORT/ | head -1      # HTTP/1.1 200 once a deploy workflow has rsynced a build
Then DNS A record $DOMAIN -> this host, and: sudo certbot --nginx -d $DOMAIN --redirect
MSG
}

if [ -z "${VPS_SETUP_NO_MAIN:-}" ]; then main "$@"; fi
