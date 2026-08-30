#!/usr/bin/env bash
# Daily cron entry point (runs as ROOT from /etc/cron.d, installed by vps-analytics-setup.sh; can also be run
# by hand as ubuntu against a readable log). Aggregates yesterday's page views into
# $ANALYTICS_OUT/YYYY-MM-DD.tsv (date/page/referrer/pv only) and hands that single file to $ANALYTICS_OWNER
# with mode 600. Nothing else is exposed: ubuntu gets no read access to /var/log/nginx.
#
#   usage: daily.sh [YYYY-MM-DD]      (default: yesterday, in the server's local time = nginx $time_local)
#   env:   ANALYTICS_LOG    nginx access log (default /var/log/nginx/giinrecord.access.log)
#          ANALYTICS_OUT    output dir (default $HOME/analytics)
#          ANALYTICS_OWNER  user who owns the TSV (default: current user; cron sets ubuntu)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="${ANALYTICS_LOG:-/var/log/nginx/giinrecord.access.log}"
OUT_DIR="${ANALYTICS_OUT:-$HOME/analytics}"
OWNER="${ANALYTICS_OWNER:-$(id -un)}"
DAY="${1:-$(date -d yesterday +%F)}"
# chown only works as root; a manual run by ubuntu simply keeps its own ownership.
CHOWN=(); [ "$(id -u)" = 0 ] && CHOWN=(-o "$OWNER" -g "$OWNER")

# Root writes into a directory owned by $OWNER, so never follow a symlink there and never open files with `>`
# in it: the TSV is built in a private temp file and placed with install(1), which unlinks the destination first.
if [ -L "$OUT_DIR" ]; then echo "daily.sh: refusing symlinked $OUT_DIR" >&2; exit 1; fi
[ -d "$OUT_DIR" ] || install -d -m 700 "${CHOWN[@]}" "$OUT_DIR"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# logrotate (daily, delaycompress) may have moved yesterday's lines into .1 or .2.gz; the date filter
# in aggregate.sh picks only the requested day, and each line lives in exactly one file.
{
  [ -f "$LOG" ] && cat "$LOG"
  [ -f "$LOG.1" ] && cat "$LOG.1"
  [ -f "$LOG.2.gz" ] && zcat "$LOG.2.gz"
  true
} | bash "$HERE/aggregate.sh" "$DAY" > "$TMP"

install "${CHOWN[@]}" -m 600 "$TMP" "$OUT_DIR/$DAY.tsv"

# Keep only aggregates; no raw log copies are ever written here.
echo "analytics: $DAY -> $OUT_DIR/$DAY.tsv ($(($(wc -l < "$OUT_DIR/$DAY.tsv") - 1)) rows)"
