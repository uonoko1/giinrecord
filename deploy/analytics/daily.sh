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
#   exit:  0  the day was measured and at least one page view was counted
#          3  none of $LOG / $LOG.1 / $LOG.2.gz exists -- there was nothing to read. NO TSV is written.
#          4  the log was read but the day has 0 page views. The TSV IS written (pv=0 pages=0).
#
# Why 3 and 4 are not 0 (Issue #1184). This script reported success for 39 days while measuring nothing:
# the installed copy read a pre-rename log name that no longer existed, and
#   - `[ -f "$LOG" ] && cat "$LOG"` made "the file is not there" a silent no-op, and
#   - aggregate.sh prints the header first, so the TSV was never empty -- always exactly 1 line
# so the cron printed "0 rows" and exited 0 every night. Nothing anywhere went red.
# "There was nothing to read" is not success, and "0 page views" is a measurement that deserves to be
# visible. They get different exit codes because they are different facts: 3 means the instrument is
# broken (wrong path, wrong permissions, nginx not logging), 4 means the instrument worked and the
# answer was zero -- which is possible for a small site on a quiet day, so only a RUN of them is an
# incident. deploy/monitor/health.sh (check `analytics`) is what decides that and opens the Issue.
# A single non-zero exit here only lands in the cron log, which nobody reads -- that is the whole point
# of the monitor check rather than a louder message here.
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

# logrotate (daily, delaycompress) may have moved yesterday's lines into .1 or .2.gz; the date filter
# in aggregate.sh picks only the requested day, and each line lives in exactly one file.
# Collect the sources that actually exist FIRST, so "none of them exist" can be refused before any
# aggregation happens. An empty $LOG counts as nothing to read too: a 0-byte access log means nginx is
# not writing there, which is the same broken instrument.
PLAIN=(); GZ=()
[ -s "$LOG" ] && PLAIN+=("$LOG")
[ -s "$LOG.1" ] && PLAIN+=("$LOG.1")
[ -s "$LOG.2.gz" ] && GZ+=("$LOG.2.gz")
if [ $((${#PLAIN[@]} + ${#GZ[@]})) -eq 0 ]; then
  # Name the configured path (it is already in this file and in the cron) but nothing about its content.
  echo "daily.sh: no such log to read: $LOG (nor .1 / .2.gz). Nothing was measured; no TSV written." >&2
  echo "  The instrument is broken, not quiet. Check: the path above exists and nginx logs to it" >&2
  echo "  (nginx -T | grep access_log), and that this script is the current one from the checkout" >&2
  echo "  (reinstall: see deploy/analytics/vps-analytics-setup.sh / docs/ops/analytics.md)." >&2
  exit 3
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

{
  [ ${#PLAIN[@]} -gt 0 ] && cat "${PLAIN[@]}"
  [ ${#GZ[@]} -gt 0 ] && zcat "${GZ[@]}"
  true
} | bash "$HERE/aggregate.sh" "$DAY" > "$TMP"

install "${CHOWN[@]}" -m 600 "$TMP" "$OUT_DIR/$DAY.tsv"

# Keep only aggregates; no raw log copies are ever written here. The summary line that aggregate.sh puts
# on line 2 is what goes into the cron log, so the cron log carries pv AND pages (#1184) and not just a
# row count -- a row count cannot tell a crawler from a person.
SUMMARY=$(sed -n '2s/^# //p' "$OUT_DIR/$DAY.tsv")
ROWS=$(($(wc -l < "$OUT_DIR/$DAY.tsv") - 2))
echo "analytics: $DAY -> $OUT_DIR/$DAY.tsv ($ROWS rows, $SUMMARY)"

# 0 rows is a measurement, not an error in itself -- but it is also exactly what a broken instrument
# looks like, so it never exits 0. health.sh's `analytics` check is what distinguishes "quiet day" from
# "broken for weeks" by looking at a run of days.
if [ "$ROWS" -le 0 ]; then
  echo "daily.sh: $DAY has 0 rows / 0 page views. Written anyway so the run is on record." >&2
  exit 4
fi
