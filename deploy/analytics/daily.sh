#!/usr/bin/env bash
# Daily cron entry point (runs as the `ubuntu` user, installed by vps-analytics-setup.sh).
# Aggregates yesterday's page views into ~/analytics/YYYY-MM-DD.tsv (date/page/referrer/pv only).
#
#   usage: daily.sh [YYYY-MM-DD]      (default: yesterday, in the server's local time = nginx $time_local)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="${ANALYTICS_LOG:-/var/log/nginx/seiji-kiroku.access.log}"
OUT_DIR="${ANALYTICS_OUT:-$HOME/analytics}"
DAY="${1:-$(date -d yesterday +%F)}"

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

# logrotate (daily, delaycompress) may have moved yesterday's lines into .1 or .2.gz; the date filter
# in aggregate.sh picks only the requested day, and each line lives in exactly one file.
{
  [ -f "$LOG" ] && cat "$LOG"
  [ -f "$LOG.1" ] && cat "$LOG.1"
  [ -f "$LOG.2.gz" ] && zcat "$LOG.2.gz"
  true
} | bash "$HERE/aggregate.sh" "$DAY" > "$OUT_DIR/$DAY.tsv.tmp"
mv "$OUT_DIR/$DAY.tsv.tmp" "$OUT_DIR/$DAY.tsv"

# Keep only aggregates; no raw log copies are ever written here.
echo "analytics: $DAY -> $OUT_DIR/$DAY.tsv ($(($(wc -l < "$OUT_DIR/$DAY.tsv") - 1)) rows)"
