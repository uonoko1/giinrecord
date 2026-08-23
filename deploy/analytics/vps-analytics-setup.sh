#!/usr/bin/env bash
# One-time VPS setup for cookie-less analytics (Issue #58). Needs sudo once.
#   ssh "${VPS_SSH_HOST:-sakura-vps}" 'sudo bash -s' < deploy/analytics/vps-analytics-setup.sh
#
# What it does:
#   1. installs gawk (aggregate.sh uses gawk's match(s, re, arr))
#   2. defines the IP-less log_format "noip" (http{} context)
#   3. checks the gikailog server block logs to the dedicated IP-less access log (written by vps-setup.sh)
#   4. creates the root-owned script dir /usr/local/lib/gikailog-analytics and ~ubuntu/analytics (700)
#   5. installs /etc/cron.d/gikailog-analytics: 00:10 daily, as ROOT, aggregates yesterday and hands
#      only the TSV to ubuntu (install -o ubuntu -m 600)
#
# Deliberately NOT done: adding ubuntu to the adm group. ubuntu is the CI deploy-key user (deploy-site.yml rsync);
# adm would let a leaked key read every log on the shared VPS (other sites' access logs with IP/UA, auth.log,
# syslog). Likewise root never executes anything under ubuntu's writable home: scripts are copied into
# $TOOLS by sudo install (see docs/ops/analytics.md), so a leaked key cannot escalate via the cron either.
#   Tests: deploy/test/nginx-reload.test.sh (sourced with ANALYTICS_SETUP_NO_MAIN=1; nginx/systemctl are stubs)
set -euo pipefail

# reload_nginx: test, reload only on success, else exit 1 (never `nginx -t && systemctl reload` — under set -e
# a failing `nginx -t` inside an && list is swallowed and the script goes on). Same as deploy/vps-setup.sh.
reload_nginx() {
  if nginx -t; then
    systemctl reload nginx
  else
    echo "!! nginx -t failed; nginx NOT reloaded. Fix the config and re-run." >&2
    exit 1
  fi
}

main() {
OWNER=ubuntu
SITE_CONF=/etc/nginx/sites-available/gikailog.conf
ACCESS_LOG=/var/log/nginx/gikailog.access.log
TOOLS=/usr/local/lib/gikailog-analytics
OUT_DIR="/home/$OWNER/analytics"
CRON_LOG=/var/log/gikailog-analytics.log

command -v gawk >/dev/null || { apt-get update -qq && apt-get install -y -qq gawk; }

cat > /etc/nginx/conf.d/gikailog-noip-log.conf <<'CONF'
# Access-log format WITHOUT the client IP and WITHOUT the user agent (gikailog, Issue #58).
log_format noip '- - [$time_local] "$request" $status $body_bytes_sent "$http_referer" "-"';
CONF

# The proxy server block written by deploy/vps-setup.sh already carries `access_log ... noip;`
# (80 block; certbot copies it into the 443 block). Refuse to continue if it is missing rather than
# silently producing empty TSVs.
if ! grep -q "access_log $ACCESS_LOG noip;" "$SITE_CONF"; then
  echo "refusing: $SITE_CONF has no 'access_log $ACCESS_LOG noip;' — run deploy/vps-setup.sh first" >&2; exit 1
fi
reload_nginx

install -d -o root -g root -m 755 "$TOOLS"
if [ -L "$OUT_DIR" ]; then echo "refusing: $OUT_DIR is a symlink" >&2; exit 1; fi
install -d -o "$OWNER" -g "$OWNER" -m 700 "$OUT_DIR"
touch "$CRON_LOG" && chmod 600 "$CRON_LOG"

# The scripts themselves are installed separately with sudo install (see docs/ops/analytics.md); this only sets the cron.
cat > /etc/cron.d/gikailog-analytics <<CRON
# gikailog cookie-less analytics: aggregate yesterday's nginx log (no IP) into $OUT_DIR/YYYY-MM-DD.tsv.
# Runs as root (reads /var/log/nginx); daily.sh hands the TSV to $OWNER with mode 600 and nothing else.
ANALYTICS_OUT=$OUT_DIR
ANALYTICS_OWNER=$OWNER
10 0 * * * root test -x $TOOLS/daily.sh && $TOOLS/daily.sh >> $CRON_LOG 2>&1
CRON
chmod 644 /etc/cron.d/gikailog-analytics

echo "analytics ready. Install scripts (root-owned, so the root cron never runs anything ubuntu can edit):"
echo "  scp deploy/analytics/{aggregate,daily}.sh \"\${VPS_SSH_HOST:-sakura-vps}\":/tmp/ && ssh \"\${VPS_SSH_HOST:-sakura-vps}\" 'sudo install -o root -g root -m 755 /tmp/aggregate.sh /tmp/daily.sh $TOOLS/ && rm /tmp/aggregate.sh /tmp/daily.sh'"
}

# Tests source this file with ANALYTICS_SETUP_NO_MAIN=1 to use reload_nginx() alone
if [ -z "${ANALYTICS_SETUP_NO_MAIN:-}" ]; then main "$@"; fi
