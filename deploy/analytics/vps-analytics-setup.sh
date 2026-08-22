#!/usr/bin/env bash
# One-time VPS setup for cookie-less analytics (Issue #58). Needs sudo once; everything after runs as ubuntu.
#   ssh sakura-vps 'sudo bash -s' < deploy/analytics/vps-analytics-setup.sh
#
# What it does:
#   1. installs gawk (aggregate.sh uses gawk's match(s, re, arr))
#   2. defines the IP-less log_format "noip" (http{} context)
#   3. points the seiji-kiroku server block(s) at a dedicated access log using that format
#   4. lets ubuntu read /var/log/nginx (group adm) and copies the scripts to ~ubuntu/seiji-kiroku-analytics
#   5. installs /etc/cron.d/seiji-kiroku-analytics: 00:10 daily, as ubuntu, aggregates yesterday
set -euo pipefail
DEPLOY_USER=ubuntu
SITE_CONF=/etc/nginx/sites-available/seiji-kiroku.conf
ACCESS_LOG=/var/log/nginx/seiji-kiroku.access.log
TOOLS="/home/$DEPLOY_USER/seiji-kiroku-analytics"

command -v gawk >/dev/null || { apt-get update -qq && apt-get install -y -qq gawk; }

cat > /etc/nginx/conf.d/seiji-kiroku-noip-log.conf <<'CONF'
# Access-log format WITHOUT the client IP and WITHOUT the user agent (seiji-kiroku, Issue #58).
log_format noip '- - [$time_local] "$request" $status $body_bytes_sent "$http_referer" "-"';
CONF

# Add `access_log ... noip;` after every `root /var/www/seiji-kiroku/site;` (80 and certbot's 443 block).
if ! grep -q "access_log $ACCESS_LOG noip;" "$SITE_CONF"; then
  sed -i "s#^\(\s*\)root /var/www/seiji-kiroku/site;#&\n\1access_log $ACCESS_LOG noip;#" "$SITE_CONF"
fi
nginx -t && systemctl reload nginx

usermod -aG adm "$DEPLOY_USER"

install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 755 "$TOOLS"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 700 "/home/$DEPLOY_USER/analytics"
# The scripts themselves are rsync'ed/copied separately (see docs/ops/analytics.md); this only sets the cron.
cat > /etc/cron.d/seiji-kiroku-analytics <<CRON
# seiji-kiroku cookie-less analytics: aggregate yesterday's nginx log (no IP) into ~/analytics/YYYY-MM-DD.tsv
10 0 * * * $DEPLOY_USER test -x $TOOLS/daily.sh && $TOOLS/daily.sh >> /home/$DEPLOY_USER/analytics/cron.log 2>&1
CRON
chmod 644 /etc/cron.d/seiji-kiroku-analytics

echo "analytics ready. Copy scripts: scp deploy/analytics/{aggregate,daily}.sh sakura-vps:$TOOLS/ && ssh sakura-vps chmod +x $TOOLS/*.sh"
echo "Note: ubuntu's new adm group membership applies to new logins only."
