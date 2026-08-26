#!/usr/bin/env bash
# One-time (idempotent) VPS setup of the self-hosted monitoring (Issue #135). Root, from a checkout of this repo:
#   sudo bash /opt/giinrecord/deploy/monitor/setup.sh
#
# What it does — and nothing else (no packages, no nginx change, no docker change, no new sudo rights):
#   1. /usr/local/lib/giinrecord-monitor/health.sh   root-owned copy of deploy/monitor/health.sh (the root cron must never
#                                                   execute a file a non-root user could edit)
#   2. /etc/giinrecord/ (700)                         place for monitor.token — a fine-grained PAT with Issues: write on
#                                                   this repository only. The PO creates it and copies it here (600).
#                                                   Never created or printed by this script; health.sh fails soft without it.
#   3. /var/log/giinrecord-monitor.log (600)          the check log;  /var/lib/giinrecord-monitor/ (700) open-issue state
#   4. ~ubuntu/monitor/ (700, owner ubuntu)         health.sh installs latest.json there, 600, owner ubuntu
#   5. /etc/cron.d/giinrecord-monitor                 */5 minutes, as root
#
# MONITOR_SETUP_PREFIX roots every path at a temp dir for the tests (deploy/test/monitor-setup.test.sh);
# MONITOR_OWNER overrides the deploy user (default ubuntu).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PREFIX=${MONITOR_SETUP_PREFIX:-}
OWNER=${MONITOR_OWNER:-ubuntu}

TOOLS=/usr/local/lib/giinrecord-monitor
TOKEN_DIR=/etc/giinrecord
TOKEN_FILE=$TOKEN_DIR/monitor.token
LOG=/var/log/giinrecord-monitor.log
STATE_DIR=/var/lib/giinrecord-monitor
LATEST_DIR=/home/$OWNER/monitor
CRON=/etc/cron.d/giinrecord-monitor

# chown only as root (the tests run as a normal user inside $PREFIX)
CHOWN_ROOT=(); CHOWN_OWNER=()
if [ "$(id -u)" = 0 ]; then CHOWN_ROOT=(-o root -g root); CHOWN_OWNER=(-o "$OWNER" -g "$OWNER"); fi

# Refuse before touching anything: root will later write into $LATEST_DIR, which $OWNER owns.
if [ -L "$PREFIX$LATEST_DIR" ]; then echo "refusing: $LATEST_DIR is a symlink" >&2; exit 1; fi

install -d "${CHOWN_ROOT[@]}" -m 755 "$PREFIX$TOOLS"
install "${CHOWN_ROOT[@]}" -m 755 "$HERE/health.sh" "$PREFIX$TOOLS/health.sh"

install -d "${CHOWN_ROOT[@]}" -m 700 "$PREFIX$TOKEN_DIR"
install -d "${CHOWN_ROOT[@]}" -m 700 "$PREFIX$STATE_DIR"
install -d "${CHOWN_OWNER[@]}" -m 700 "$PREFIX$LATEST_DIR"
[ -f "$PREFIX$LOG" ] || install "${CHOWN_ROOT[@]}" -m 600 /dev/null "$PREFIX$LOG"
chmod 600 "$PREFIX$LOG"

# Real paths in the cron file even under the test prefix: the file is a fixture of what lands on the VPS.
cat > "$PREFIX$CRON" <<CRON
# giinrecord self-hosted monitoring (Issue #135): containers healthy, disk, nginx, rsync targets fresh.
# Runs as root every 5 minutes; writes $LOG and $LATEST_DIR/latest.json (owner $OWNER, 600);
# opens/closes GitHub Issues through the token in $TOKEN_FILE (fail-soft when absent). docs/ops/monitoring.md
MONITOR_OWNER=$OWNER
*/5 * * * * root test -x $TOOLS/health.sh && $TOOLS/health.sh >> $LOG 2>&1
CRON
chmod 644 "$PREFIX$CRON"

echo "monitoring installed: $TOOLS/health.sh, $CRON (every 5 min, root), log $LOG, latest.json in $LATEST_DIR"
if [ -f "$PREFIX$TOKEN_FILE" ]; then
  chmod 600 "$PREFIX$TOKEN_FILE"
  echo "token: $TOKEN_FILE present (mode 600). Issues will be opened on failures."
else
  cat <<MSG
token: $TOKEN_FILE is absent — checks run and log, but health.sh fails soft (no GitHub Issues) until it exists.
  1. GitHub → Settings → Developer settings → Fine-grained tokens → only this repository, permission Issues: Read and write, nothing else
  2. paste it (one line) as root:   umask 077; printf '%s\n' '<token>' > $TOKEN_FILE
  The token is never read by anything but root's cron; never commit it, never put it in docs.
MSG
fi
