#!/usr/bin/env bash
# Host-nginx setup for one site on the SHARED host (Issue #85; staging #127; idempotent + safety checks #141). Run as:
#   ssh "${VPS_SSH_HOST:-sakura-vps}" 'sudo bash -s <domain> [port]' < deploy/vps-setup.sh
#     port 8081 (default) = production: giinrecord.jp         → /var/www/giinrecord/site,    sites-available/giinrecord.conf
#     port 8083           = staging:    staging.giinrecord.jp → /var/www/giinrecord/staging, sites-available/giinrecord-staging.conf
#   The domain must NOT start with "staging." for 8081 and MUST start with "staging." for 8083 (#141: a staging
#   setup run with the production domain once rewrote the production conf).
#
# What it does (and nothing more):
#   1. creates the web root — the rsync target of the deploy workflows, owned by the deploy user,
#      bind-mounted read-only into the web / web-staging container
#   2. writes the host nginx server blocks for this site (deploy/nginx-host-proxy.conf with SERVER_NAMES / DOMAIN /
#      PORT / LOG_NAME substituted): :80 → 301 https://<domain> (www too), :443 TLS → proxy_pass http://127.0.0.1:<port>
#        - staging (8083) only, Issue #163: the 443 `location /` includes /etc/nginx/snippets/giinrecord-cloudflare-allow.conf
#          (Cloudflare ranges, deploy/cloudflare-allowlist.sh; a deny-all placeholder is written when it is missing) and
#          returns 403 without the Cf-Access-Jwt-Assertion header. A certbot-managed staging conf gets the same two
#          lines inserted into its location / (ensure_staging_cf_gate). Production never gets either.
#        - no certificate yet (/etc/letsencrypt/live/<domain>/fullchain.pem missing): only a plain :80 proxy block is
#          written so that `certbot certonly --nginx` can serve the challenge; re-run after certbot for the real blocks
#        - the conf is already managed by certbot (`# managed by Certbot`, i.e. the hosts set up before #141):
#          it is NOT rewritten — only the proxy_pass port is kept in sync. server_name, certificate, redirects stay
#        - every server block written here carries `error_log /var/log/nginx/<name>.error.log crit;` (Issue #189) so
#          connection-level failures (which log the client IP) stay out of the shared host's global error log; a
#          certbot-managed conf (production or staging) gets the line inserted after each access_log (ensure_error_log)
#   3. defines the IP-less access-log format the blocks reference (same file the analytics setup writes)
#   4. reloads nginx (only if `nginx -t` passes; otherwise exit 1) and prints the next steps for a human
#
# Deliberately NOT done here:
#   - installing anything (docker, packages). Docker is installed by a human with sudo (deploy/README.md)
#   - giving the deploy user ($DEPLOY_USER, the CI rsync key) any docker privilege: membership in the
#     docker group is root-equivalent, and a leaked deploy key must stay a leaked *file copy* key
#   - running certbot (go-live.sh / staging-setup.sh do, and skip it when the certificate exists)
#   - touching any other site's server block, certificate or log on this shared host
#
# Tests: deploy/test/vps-setup.test.sh (VPS_SETUP_PREFIX roots every path in a temp dir; install/nginx/systemctl are
# stubs), deploy/test/render-host-proxy.sh and deploy/test/nginx-reload.test.sh source this file with VPS_SETUP_NO_MAIN=1.
set -euo pipefail

# 全パスの接頭辞（テスト専用。本番では空）
PREFIX="${VPS_SETUP_PREFIX:-}"
DEPLOY_USER=ubuntu

# reload_nginx: test the config, reload only if it passes, otherwise stop the script with exit 1.
# `nginx -t && systemctl reload nginx` must NOT be used: under set -e a failing `nginx -t` is swallowed
# (it is not the last command of the && list) and the script carries on with a broken, un-reloaded config.
reload_nginx() {
  if nginx -t; then
    systemctl reload nginx
  else
    echo "!! nginx -t failed; nginx NOT reloaded. Fix the config and re-run." >&2
    exit 1
  fi
}

# site_vars <port>: sets NAME (conf + log name) and SITE_DIR for the port; rejects anything but 8081/8083.
site_vars() {
  case "$1" in
    8081) NAME=giinrecord; SITE_DIR=/var/www/giinrecord/site ;;
    8083) NAME=giinrecord-staging; SITE_DIR=/var/www/giinrecord/staging ;;
    *) echo "vps-setup.sh: port must be 8081 (production) or 8083 (staging), got '$1'" >&2; return 1 ;;
  esac
}

# check_domain <domain> <port>: staging.* only on 8083, never on 8081 (#141).
check_domain() {
  local domain=$1 port=$2
  case "$port:$domain" in
    8083:staging.*) ;;
    8083:*) echo "vps-setup.sh: port 8083 is staging; the domain must start with 'staging.' (got '$domain')" >&2; return 1 ;;
    8081:staging.*) echo "vps-setup.sh: '$domain' looks like staging; production (8081) must not use it. For staging pass port 8083" >&2; return 1 ;;
  esac
}

# server_names <domain> <port>: production answers for www.<domain> too; staging has no www.
server_names() { if [ "$2" = 8081 ]; then echo "$1 www.$1"; else echo "$1"; fi; }

# Issue #163: the staging 443 `location /` only answers requests that come through Cloudflare (IP allow-list from
# deploy/cloudflare-allowlist.sh) AND carry the Cloudflare Access JWT header; everything else is 403/denied.
# Production gets neither. The snippet must exist or nginx -t fails, so a fail-closed placeholder is written when
# it is missing (ensure_cf_snippet).
CF_SNIPPET=/etc/nginx/snippets/giinrecord-cloudflare-allow.conf
CF_GATE_INCLUDE="include $CF_SNIPPET;"
# shellcheck disable=SC2016  # nginx variable, not shell
CF_GATE_403='if ($http_cf_access_jwt_assertion = "") { return 403; }'

# cf_gate_lines <port>: the two directives (indented for the template) on stdout for 8083, nothing for 8081
cf_gate_lines() { if [ "$1" = 8083 ]; then printf '        %s\n        %s\n' "$CF_GATE_INCLUDE" "$CF_GATE_403"; fi; }

# with_cf_gate <port>: stdin → stdout, the CF_GATE placeholder line replaced by cf_gate_lines (deleted for production)
with_cf_gate() {
  local lines; lines=$(cf_gate_lines "$1")
  if [ -n "$lines" ]; then
    awk -v gate="$lines" '$0 == "CF_GATE" { print gate; next } { print }'
  else
    awk '$0 != "CF_GATE"'
  fi
}

# render_host_proxy <domain> <port>: the full server blocks (:80 redirect + :443 proxy) on stdout.
# The heredoc is deploy/nginx-host-proxy.conf verbatim (the test checks they are identical).
render_host_proxy() {
  local domain=$1 port=$2 names
  site_vars "$port"
  names=$(server_names "$domain" "$port")
  host_proxy_template | sed -e "s/SERVER_NAMES/$names/" -e "s/DOMAIN/$domain/" -e "s/PORT/$port/" -e "s/LOG_NAME/$NAME/" | with_cf_gate "$port"
}
host_proxy_template() {
  cat <<'CONF'
server {
    listen 80;
    listen [::]:80;
    server_name SERVER_NAMES;
    # Issue 386: Server ヘッダからバージョンと OS を消す。http ブロックには置かない（同居サイトに波及する）
    server_tokens off;
    access_log /var/log/nginx/LOG_NAME.access.log noip;
    error_log /var/log/nginx/LOG_NAME.error.log crit;

    location / {
        return 301 https://DOMAIN$request_uri;
    }
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name SERVER_NAMES;
    # Issue 386: Server ヘッダからバージョンと OS を消す。http ブロックには置かない（同居サイトに波及する）
    server_tokens off;
    access_log /var/log/nginx/LOG_NAME.access.log noip;
    error_log /var/log/nginx/LOG_NAME.error.log crit;

    ssl_certificate /etc/letsencrypt/live/DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_timeout 1d;
    ssl_session_cache shared:LOG_NAME:1m;
    ssl_session_tickets off;

    # HSTS（Issue 387）。443 の server ブロックだけ。includeSubDomains と preload は付けない
    # （preload は取り消せない。旧ドメインの 301 が現役なので巻き込めない）。max-age は段階的に上げる
    add_header Strict-Transport-Security "max-age=86400" always;

    location / {
CF_GATE
        proxy_pass http://127.0.0.1:PORT;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
CONF
}

# render_bootstrap_proxy <domain> <port>: the :80-only proxy block used until the certificate exists
# (no redirect — there is nothing to redirect to yet — and no 443 block, which would fail nginx -t without the cert).
render_bootstrap_proxy() {
  local domain=$1 port=$2 names
  site_vars "$port"
  names=$(server_names "$domain" "$port")
  sed -e "s/SERVER_NAMES/$names/" -e "s/PORT/$port/" -e "s/LOG_NAME/$NAME/" <<'BOOT'
# bootstrap block (no certificate yet): re-run deploy/vps-setup.sh after certbot to get the TLS + redirect blocks
server {
    listen 80;
    listen [::]:80;
    server_name SERVER_NAMES;
    # Issue 386: Server ヘッダからバージョンと OS を消す。http ブロックには置かない（同居サイトに波及する）
    server_tokens off;
    access_log /var/log/nginx/LOG_NAME.access.log noip;
    error_log /var/log/nginx/LOG_NAME.error.log crit;

    location / {
        proxy_pass http://127.0.0.1:PORT;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
BOOT
}

# cert_exists <domain>: true once certbot has issued the certificate for <domain>
cert_exists() { [ -f "$PREFIX/etc/letsencrypt/live/$1/fullchain.pem" ]; }

# ensure_cf_snippet: the staging block includes $CF_SNIPPET; until deploy/cloudflare-allowlist.sh has generated it,
# write a placeholder that denies everything (fail closed — staging is unreachable rather than open) so nginx -t passes.
ensure_cf_snippet() {
  local snip="$PREFIX$CF_SNIPPET"
  [ -f "$snip" ] && return 0
  mkdir -p "$(dirname "$snip")"
  printf '# placeholder written by deploy/vps-setup.sh: run deploy/cloudflare-allowlist.sh to generate the real allow-list\ndeny all;\n' > "$snip"
  chmod 644 "$snip"
  echo "!! $CF_SNIPPET did not exist: wrote a deny-all placeholder. Staging stays unreachable until you run deploy/cloudflare-allowlist.sh (docs/ops/staging-access.md)." >&2
}

# ensure_staging_cf_gate <conf>: a certbot-managed staging conf is never rewritten (see write_site_conf), so the
# Cloudflare gate is inserted in place: the two directives go at the top of every `location /` that proxies to the
# staging container (the :80 server certbot writes has no such location). Idempotent: nothing happens when the
# include is already there.
ensure_staging_cf_gate() {
  local conf=$1
  grep -qF "$CF_GATE_INCLUDE" "$conf" && return 0
  local tmp; tmp=$(mktemp)   # not next to the conf: nothing temporary in sites-available/ on the shared host
  awk -v inc="        $CF_GATE_INCLUDE" -v rule="        $CF_GATE_403" '
    /^[[:space:]]*location \/ \{/ { in_loc = 1; buf = $0 "\n"; next }
    in_loc {
      buf = buf $0 "\n"
      if ($0 ~ /proxy_pass http:\/\/127\.0\.0\.1:8083;/) { gate = 1 }
      if ($0 ~ /^[[:space:]]*\}/) {
        if (gate) { sub(/\n/, "\n" inc "\n" rule "\n", buf) }
        printf "%s", buf; in_loc = 0; gate = 0; buf = ""
      }
      next
    }
    { print }
    END { if (in_loc) printf "%s", buf }
  ' "$conf" > "$tmp"
  cat "$tmp" > "$conf"; rm -f "$tmp"
  echo "$conf is managed by Certbot: Cloudflare gate (allow-list include + 403 without Cf-Access-Jwt-Assertion) inserted into location /."
}

# ensure_error_log <conf>: Issue #189 — a certbot-managed conf is never rewritten, so the per-site error_log line is
# inserted after every `access_log … LOG_NAME.access.log noip;` line (one per server block, same indentation).
# Idempotent: nothing happens when the error_log line is already there. Used for production AND staging.
ensure_error_log() {
  local conf=$1 line="error_log /var/log/nginx/$NAME.error.log crit;"
  grep -qF "$line" "$conf" && return 0
  local tmp; tmp=$(mktemp)   # not next to the conf: nothing temporary in sites-available/ on the shared host
  awk -v name="$NAME" -v line="$line" '
    { print }
    $0 ~ ("^[[:space:]]*access_log /var/log/nginx/" name "\\.access\\.log noip;$") {
      indent = $0; sub(/[^[:space:]].*$/, "", indent); print indent line
    }
  ' "$conf" > "$tmp"
  cat "$tmp" > "$conf"; rm -f "$tmp"
  echo "$conf is managed by Certbot: per-site error_log (crit) inserted after each access_log (#189)."
}

# write_site_conf <domain> <port> <conf>: decides between "leave certbot's file alone", full template and bootstrap.
# Issue 386（server_tokens off）は**certbot 管理の conf には入れない**。
# ensure_error_log（#189）と同じ形の挿入関数を書くこともできるが、
# 「certbot 管理の conf は書き換えない（本番の再実行は no-op）」という保証をテストが固定しており、
# 挿入関数を増やすほどその保証が薄れる。#189 は「ログに IP を残さない」という
# プライバシー上の必須要件だったので例外的に入れた。バージョン隠しはそこまでの緊急性が無い。
# 本番ホストが certbot 管理なら、**人が1行足す**（docs/ops/deploy.md に手順を書いた）。
write_site_conf() {
  local domain=$1 port=$2 conf=$3
  if [ -f "$conf" ] && grep -q "managed by Certbot" "$conf"; then
    if grep -q "proxy_pass http://127.0.0.1:$port;" "$conf"; then
      echo "$conf is managed by Certbot (set up before #141): left as is."
    else
      echo "$conf is managed by Certbot: only the proxy_pass port is set to $port (server_name, certificate, redirects untouched)."
      sed -i -E "s#proxy_pass http://127\.0\.0\.1:[0-9]+;#proxy_pass http://127.0.0.1:$port;#" "$conf"
    fi
    if [ "$port" = 8083 ]; then ensure_cf_snippet; ensure_staging_cf_gate "$conf"; fi
    ensure_error_log "$conf"
  elif cert_exists "$domain"; then
    if [ "$port" = 8083 ]; then ensure_cf_snippet; fi
    render_host_proxy "$domain" "$port" > "$conf"
  else
    render_bootstrap_proxy "$domain" "$port" > "$conf"
  fi
}

main() {
  local DOMAIN PORT SITE_CONF
  DOMAIN="${1:?usage: vps-setup.sh <domain> [port: 8081 (production, default) | 8083 (staging, domain staging.*)]}"
  PORT="${2:-8081}"
  site_vars "$PORT"
  check_domain "$DOMAIN" "$PORT"
  SITE_CONF=/etc/nginx/sites-available/$NAME.conf

  install -d -o "$DEPLOY_USER" -g deploygroup -m 2775 "$PREFIX/var/www/giinrecord" "$PREFIX$SITE_DIR"

  cat > "$PREFIX/etc/nginx/conf.d/giinrecord-noip-log.conf" <<'CONF'
# Access-log format WITHOUT the client IP and WITHOUT the user agent (giinrecord, Issue #58).
log_format noip '- - [$time_local] "$request" $status $body_bytes_sent "$http_referer" "-"';
CONF

  write_site_conf "$DOMAIN" "$PORT" "$PREFIX$SITE_CONF"
  ln -sfn "$PREFIX$SITE_CONF" "$PREFIX/etc/nginx/sites-enabled/$NAME.conf"
  reload_nginx

  cat <<MSG
host nginx ready: $DOMAIN -> http://127.0.0.1:$PORT (container). Site root: $SITE_DIR (owner $DEPLOY_USER).

Next, as a user WITH docker privileges (not $DEPLOY_USER):
  1. install docker + compose plugin (https://docs.docker.com/engine/install/ubuntu/), if not yet present
  2. git clone https://github.com/uonoko1/giinrecord.git /opt/giinrecord   (only deploy/ is used)
  3. docker compose -f /opt/giinrecord/deploy/docker-compose.yml up -d --force-recreate
  4. curl -sI http://127.0.0.1:$PORT/ | head -1      # HTTP/1.1 200 once a deploy workflow has rsynced a build
MSG
  if ! cert_exists "$DOMAIN"; then
    # shellcheck disable=SC2046  # server_names is a space-separated list on purpose
    echo "No certificate yet: DNS A record $DOMAIN -> this host, then:  sudo certbot certonly --nginx$(printf ' -d %s' $(server_names "$DOMAIN" "$PORT")) --deploy-hook 'systemctl reload nginx'  and re-run this script for the TLS + redirect blocks."
  fi
}

if [ -z "${VPS_SETUP_NO_MAIN:-}" ]; then main "$@"; fi
