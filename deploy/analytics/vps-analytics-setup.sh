#!/usr/bin/env bash
# One-time VPS setup for cookie-less analytics (Issue #58). Needs sudo once.
#   bash deploy/run-remote.sh deploy/analytics/vps-analytics-setup.sh
#
# What it does:
#   1. installs gawk (aggregate.sh uses gawk's match(s, re, arr))
#   2. defines the IP-less log_format "noip" (http{} context)
#   3. checks the giinrecord server block logs to the dedicated IP-less access log (written by vps-setup.sh)
#   4. creates the root-owned script dir /usr/local/lib/giinrecord-analytics and ~ubuntu/analytics (700),
#      and INSTALLS aggregate.sh / daily.sh into it from this checkout (Issue #1184 -- see below)
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
#
# Issue #1184 -- why step 4 installs the scripts instead of printing how to:
#   For 39 days the PV instrument measured nothing and reported success. The scripts on the VPS were the
#   pre-rename copies: deploy/go-live.sh's migrate_legacy() `mv`s /usr/local/lib/<old>-analytics to the new
#   name, so the DIRECTORY was renamed but the daily.sh inside it still read the old access-log name -- and
#   the log itself had been renamed. Nothing re-installed the scripts, because this file only `echo`ed the
#   scp/install command for a human to run, and nobody ran it.
#   The two sibling root-owned copies on this host did not have the hole: deploy/monitor/setup.sh installs
#   health.sh from its own directory, and cloudflare-allowlist.sh --install-cron installs itself. 1 of 3.
#   So this one now does the same thing, and go-live.sh step 8/8 (which runs this script after step 2/8 has
#   `git pull`ed the checkout) re-installs the current scripts on every go-live and every rename.
#   The install is still root-owned 755 from a root-owned path: the root cron must never execute a file a
#   non-root user could edit (that constraint is unchanged, see the adm note above).
#   Tests: packages/etl/test/analytics-daily.test.ts
#
#   Tests: deploy/test/nginx-reload.test.sh (sourced with ANALYTICS_SETUP_NO_MAIN=1; nginx/systemctl are stubs)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
# #1184: install the scripts, do not just explain how. `$HERE` is this checkout, so a go-live (or any
# re-run of this setup) picks up whatever the repository currently says -- including after a rename.
# This script is also run piped over stdin (`sudo bash -s`, see the logrotate note above); in that case
# $HERE is the caller's cwd and the files are not there, so say so loudly rather than leaving the stale
# copies in place and reporting success. Leaving stale copies silently is the whole bug of #1184.
if [ -f "$HERE/aggregate.sh" ] && [ -f "$HERE/daily.sh" ]; then
  install -o root -g root -m 755 "$HERE/aggregate.sh" "$TOOLS/aggregate.sh"
  install -o root -g root -m 755 "$HERE/daily.sh" "$TOOLS/daily.sh"
  echo "installed from this checkout: $TOOLS/{aggregate,daily}.sh"
else
  echo "!! $HERE has no aggregate.sh / daily.sh, so the scripts in $TOOLS were NOT refreshed." >&2
  echo "   (This happens when the setup is piped over stdin.) The cron below will keep running whatever" >&2
  echo "   is already there -- which may be a pre-rename copy that measures nothing (#1184). Run from a" >&2
  echo "   checkout instead:  sudo bash /opt/giinrecord/deploy/analytics/vps-analytics-setup.sh" >&2
  exit 1
fi
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

echo "analytics ready. Scripts are root-owned in $TOOLS (the root cron never runs anything $OWNER can edit)."
echo "Verify the instrument now instead of waiting for tomorrow's cron (#1184 -- 39 days of silent zeros):"
echo "  sudo ANALYTICS_OUT=$OUT_DIR ANALYTICS_OWNER=$OWNER $TOOLS/daily.sh \"\$(date +%F)\""
echo "  # exit 0 = measured, with 'pv=N pages=M' on the line. exit 3 = nothing to read. exit 4 = 0 page views."
echo "  head -2 $OUT_DIR/\$(date +%F).tsv   # line 2 is '# <date> pv=N pages=M per-page=X.XX'"
}

# Tests source this file with ANALYTICS_SETUP_NO_MAIN=1 to use reload_nginx() alone
if [ -z "${ANALYTICS_SETUP_NO_MAIN:-}" ]; then main "$@"; fi
