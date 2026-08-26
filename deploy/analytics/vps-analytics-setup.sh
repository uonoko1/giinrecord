#!/usr/bin/env bash
# One-time VPS setup for cookie-less analytics (Issue #58). Needs sudo once.
#   ssh "${VPS_SSH_HOST:-sakura-vps}" 'sudo bash -s' < deploy/analytics/vps-analytics-setup.sh
#
# What it does:
#   1. installs gawk (aggregate.sh uses gawk's match(s, re, arr))
#   2. defines the IP-less log_format "noip" (http{} context)
#   3. checks the giinrecord server block logs to the dedicated IP-less access log (written by vps-setup.sh)
#   4. creates the root-owned script dir /usr/local/lib/giinrecord-analytics and ~ubuntu/analytics (700)
#   5. installs /etc/cron.d/giinrecord-analytics: 00:10 daily, as ROOT, aggregates yesterday and hands
#      only the TSV to ubuntu (install -o ubuntu -m 600)
#   6. installs /etc/logrotate.d/giinrecord-analytics (Issue #288): the cron log below matched no logrotate
#      config and grew without bound. Names that one file only — the VPS is shared with other sites, and a
#      glob under /var/log would rotate their logs too. Kept byte-identical to deploy/analytics/logrotate.conf
#      (this script is also run piped over stdin, `sudo bash -s`, so it cannot read a file from the checkout);
#      deploy/test/logrotate.test.sh fails if the two drift apart.
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
SITE_CONF=/etc/nginx/sites-available/giinrecord.conf
ACCESS_LOG=/var/log/nginx/giinrecord.access.log
TOOLS=/usr/local/lib/giinrecord-analytics
OUT_DIR="/home/$OWNER/analytics"
CRON_LOG=/var/log/giinrecord-analytics.log

command -v gawk >/dev/null || { apt-get update -qq && apt-get install -y -qq gawk; }

cat > /etc/nginx/conf.d/giinrecord-noip-log.conf <<'CONF'
# Access-log format WITHOUT the client IP and WITHOUT the user agent (giinrecord, Issue #58).
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
cat > /etc/cron.d/giinrecord-analytics <<CRON
# giinrecord cookie-less analytics: aggregate yesterday's nginx log (no IP) into $OUT_DIR/YYYY-MM-DD.tsv.
# Runs as root (reads /var/log/nginx); daily.sh hands the TSV to $OWNER with mode 600 and nothing else.
ANALYTICS_OUT=$OUT_DIR
ANALYTICS_OWNER=$OWNER
10 0 * * * root test -x $TOOLS/daily.sh && $TOOLS/daily.sh >> $CRON_LOG 2>&1
CRON
chmod 644 /etc/cron.d/giinrecord-analytics

# Rotation for $CRON_LOG (Issue #288). Mode 644: logrotate skips configs that are group/other-writable.
cat > /etc/logrotate.d/giinrecord-analytics <<'LOGROTATE'
# logrotate for the analytics cron log (Issue #288). Installed to /etc/logrotate.d/giinrecord-analytics by
# deploy/analytics/vps-analytics-setup.sh; checked by deploy/test/logrotate.test.sh.
#
# This is the *cron output* of daily.sh (one line per daily run, plus any error it printed) — not the nginx
# access log, which /etc/logrotate.d/nginx already rotates. It matched no logrotate config either.
#
# The VPS is shared with other sites, so exactly one file is named here — never a glob under /var/log.
#
# Size and retention, from the log itself (measured 2026-08-27): 221 bytes since it was created on
# 2026-08-23, i.e. ~55 bytes/day at one cron run per day (10 0 * * *). At that rate a year is a few tens of
# KB, so retention here is about keeping the record, not about disk: monthly x 12 matches the monitor log so
# both roll on the same rhythm and one operator note covers both. maxsize 32M is the same runaway guard
# (a daily.sh that starts erroring on every line).
/var/log/giinrecord-analytics.log {
    monthly
    maxsize 32M
    rotate 12
    missingok
    notifempty
    compress
    delaycompress
    # Written by root's cron and 600 root:root while live; su root root keeps the archives off the adm group.
    su root root
    create 0600 root root
}
LOGROTATE
chmod 644 /etc/logrotate.d/giinrecord-analytics

echo "analytics ready. Install scripts (root-owned, so the root cron never runs anything ubuntu can edit):"
echo "  scp deploy/analytics/{aggregate,daily}.sh \"\${VPS_SSH_HOST:-sakura-vps}\":/tmp/ && ssh \"\${VPS_SSH_HOST:-sakura-vps}\" 'sudo install -o root -g root -m 755 /tmp/aggregate.sh /tmp/daily.sh $TOOLS/ && rm /tmp/aggregate.sh /tmp/daily.sh'"
}

# Tests source this file with ANALYTICS_SETUP_NO_MAIN=1 to use reload_nginx() alone
if [ -z "${ANALYTICS_SETUP_NO_MAIN:-}" ]; then main "$@"; fi
