#!/usr/bin/env bash
# VPS-side health check (Issue #135). Runs as ROOT from /etc/cron.d/gikailog-monitor every 5 minutes
# (installed by deploy/monitor/setup.sh). No SaaS, no agent: a few local commands, one log file, and — only when
# something is wrong twice in a row — a GitHub Issue through the REST API with curl.
#
# Checks (name → what fails):
#   container-web / container-web-staging   docker healthcheck of gikailog-web-1 / gikailog-web-staging-1 is not "healthy"
#   nginx                                   host nginx is not `systemctl is-active`
#   disk                                    filesystem of the web root is used more than MONITOR_DISK_MAX % (85)
#   site-production / site-staging          rsync target missing, or its data/meta.json older than MONITOR_STALE_HOURS (48)
#
# Outputs:
#   $MONITOR_LOG (/var/log/gikailog-monitor.log, root 600): one line per run, "<UTC time> OK" or "<UTC time> FAIL <check>: <why>; …"
#   $MONITOR_LATEST_DIR/latest.json (~ubuntu/monitor/latest.json, owner ubuntu, 600): {"checkedAt","ok","failures"}
#   GitHub Issue "[monitor] vps: <check>" (label monitor) after 2 consecutive failing runs; closed again on recovery.
#   Dedup: the issue number is kept in $MONITOR_STATE_DIR (root); if that is lost, open issues with the same title
#   are adopted instead of duplicated.
#
# Reporting is fail-soft: no token file ($MONITOR_TOKEN_FILE, root 600, fine-grained PAT with issues:write only) or a
# failing API call only logs a line; the check result and the exit status do not depend on GitHub.
# Nothing here prints an IP, a hostname, a username or a path into an Issue: bodies name only the check and the time.
#   Tests: deploy/test/monitor-health.test.sh (docker/systemctl/df/curl are stubs, paths come from the env below)
set -euo pipefail

LOG="${MONITOR_LOG:-/var/log/gikailog-monitor.log}"
STATE_DIR="${MONITOR_STATE_DIR:-/var/lib/gikailog-monitor}"
TOKEN_FILE="${MONITOR_TOKEN_FILE:-/etc/gikailog/monitor.token}"
SITE_DIR="${MONITOR_SITE_DIR:-/var/www/gikailog/site}"
STAGING_DIR="${MONITOR_STAGING_DIR:-/var/www/gikailog/staging}"
LATEST_DIR="${MONITOR_LATEST_DIR:-/home/ubuntu/monitor}"
OWNER="${MONITOR_OWNER:-ubuntu}"
REPO="${MONITOR_REPO:-uonoko1/gikailog}"
API="${MONITOR_API:-https://api.github.com}"
DISK_MAX="${MONITOR_DISK_MAX:-85}"
STALE_HOURS="${MONITOR_STALE_HOURS:-48}"
FAILS_BEFORE_REPORT="${MONITOR_FAILS_BEFORE_REPORT:-2}"
NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
NOW_EPOCH=$(date +%s)

FAILED=()            # check names that failed this run
declare -A WHY=()    # check name → short reason (for the log only)
failure() { FAILED+=("$1"); WHY[$1]=$2; }
ALL_CHECKS=(container-web container-web-staging nginx disk site-production site-staging)

# ---- checks -------------------------------------------------------------------------------------------------------
check_container() { # check_container <check> <container name>
  local status
  status=$(docker inspect -f '{{.State.Health.Status}}' "$2" 2>/dev/null || true)
  [ "$status" = healthy ] || failure "$1" "health=${status:-absent}"
}
check_nginx() {
  local s
  s=$(systemctl is-active nginx 2>/dev/null || true)
  [ "$s" = active ] || failure nginx "${s:-unknown}"
}
check_disk() {
  local used
  # df -P: POSIX one-line-per-filesystem output; column 5 is "NN%"
  used=$(df -P "${SITE_DIR%/*}" 2>/dev/null | awk 'NR==2 {sub("%", "", $5); print $5}')
  if [ -z "$used" ]; then failure disk "df failed"; return; fi
  [ "$used" -le "$DISK_MAX" ] || failure disk "${used}% used"
}
check_site() { # check_site <check> <dir>
  local meta="$2/data/meta.json" mtime age_h
  if [ ! -d "$2" ]; then failure "$1" "directory missing"; return; fi
  if [ ! -f "$meta" ]; then failure "$1" "data/meta.json missing"; return; fi
  mtime=$(stat -c %Y "$meta")
  age_h=$(( (NOW_EPOCH - mtime) / 3600 ))
  [ "$age_h" -le "$STALE_HOURS" ] || failure "$1" "data ${age_h}h old"
}

check_container container-web gikailog-web-1
check_container container-web-staging gikailog-web-staging-1
check_nginx
check_disk
check_site site-production "$SITE_DIR"
check_site site-staging "$STAGING_DIR"

# ---- log + latest.json --------------------------------------------------------------------------------------------
log() { printf '%s %s\n' "$NOW_ISO" "$*" >> "$LOG"; }
if [ ${#FAILED[@]} -eq 0 ]; then
  log "OK"
else
  line=""
  for c in "${FAILED[@]}"; do line+="${line:+; }$c: ${WHY[$c]}"; done
  log "FAIL $line"
fi

write_latest() {
  local tmp json="" c chown=()
  # Root writes into a directory owned by $OWNER: never follow a symlink there, never `>` into it (mktemp + install).
  if [ -L "$LATEST_DIR" ]; then echo "health.sh: refusing symlinked $LATEST_DIR" >&2; return 1; fi
  [ "$(id -u)" = 0 ] && chown=(-o "$OWNER" -g "$OWNER")
  [ -d "$LATEST_DIR" ] || install -d -m 700 "${chown[@]}" "$LATEST_DIR"
  for c in "${FAILED[@]+"${FAILED[@]}"}"; do json+="${json:+, }\"$c\""; done
  tmp=$(mktemp)
  printf '{"checkedAt": "%s", "ok": %s, "failures": [%s]}\n' "$NOW_ISO" "$([ ${#FAILED[@]} -eq 0 ] && echo true || echo false)" "$json" > "$tmp"
  install "${chown[@]}" -m 600 "$tmp" "$LATEST_DIR/latest.json"
  rm -f "$tmp"
}
LATEST_OK=0; write_latest || LATEST_OK=1

# ---- GitHub Issues (fail-soft) ------------------------------------------------------------------------------------
mkdir -p "$STATE_DIR"
TOKEN=""
if [ -r "$TOKEN_FILE" ]; then TOKEN=$(head -c 512 "$TOKEN_FILE" | tr -d '[:space:]'); fi
[ -n "$TOKEN" ] || log "note: no token at $TOKEN_FILE; Issues are not reported (see docs/ops/monitoring.md)"

api() { # api <method> <path> [json-file] → prints the response body; returns non-zero on transport/HTTP error
  local method=$1 path=$2 data=${3:-} out code
  out=$(mktemp)
  code=$(curl -sS --max-time 20 -o "$out" -w '%{http_code}' -X "$method" \
    -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" \
    ${data:+-H "Content-Type: application/json" -d "@$data"} "$API$path" 2>/dev/null) || code=000
  case "$code" in
    2*) cat "$out"; rm -f "$out" ;;
    *) rm -f "$out"; log "note: API $method $path: ${code/000/curl failed}"; return 1 ;;
  esac
}
json_number_for_title() { # stdin: issues JSON array; $1: title → number of the first issue with that exact title
  if command -v python3 >/dev/null; then
    TITLE="$1" python3 -c 'import json,os,sys
for i in json.load(sys.stdin):
    if i.get("title") == os.environ["TITLE"]: print(i["number"]); break'
  elif command -v jq >/dev/null; then
    jq -r --arg t "$1" 'map(select(.title == $t)) | .[0].number // empty'
  else
    log "note: neither python3 nor jq: cannot deduplicate by title"
  fi
}
number_from_response() { grep -o '"number": *[0-9]*' | head -1 | grep -o '[0-9]*$'; }
title_for() { printf '[monitor] vps: %s' "$1"; }

open_issue() { # open_issue <check>  (idempotent: adopts an existing open issue with the same title)
  local check=$1 title num body tmp
  title=$(title_for "$check")
  num=$(api GET "/repos/$REPO/issues?labels=monitor&state=open&per_page=100" | json_number_for_title "$title" || true)
  if [ -z "$num" ]; then
    tmp=$(mktemp)
    body="VPS check \`$check\` has failed on $FAILS_BEFORE_REPORT consecutive runs (first reported $NOW_ISO).\n\nWhat the check means and what to do: docs/ops/monitoring.md. This issue is closed automatically when the check passes again."
    printf '{"title": "%s", "labels": ["monitor"], "body": "%s"}\n' "$title" "$body" > "$tmp"
    num=$(api POST "/repos/$REPO/issues" "$tmp" | number_from_response || true)
    rm -f "$tmp"
  fi
  if [ -n "$num" ]; then echo "$num" > "$STATE_DIR/issue.$check"; log "issue #$num open for $check"; fi
}
close_issue() { # close_issue <check> <number>
  local tmp
  tmp=$(mktemp)
  printf '{"body": "Recovered: check %s passed at %s."}\n' "$1" "$NOW_ISO" > "$tmp"
  api POST "/repos/$REPO/issues/$2/comments" "$tmp" >/dev/null || true
  printf '{"state": "closed", "state_reason": "completed"}\n' > "$tmp"
  if api PATCH "/repos/$REPO/issues/$2" "$tmp" >/dev/null; then rm -f "$STATE_DIR/issue.$1"; log "issue #$2 closed for $1"; fi
  rm -f "$tmp"
}

for check in "${ALL_CHECKS[@]}"; do
  fails_file="$STATE_DIR/fails.$check"; issue_file="$STATE_DIR/issue.$check"
  if [[ " ${FAILED[*]+"${FAILED[*]}"} " == *" $check "* ]]; then
    n=$(( $(cat "$fails_file" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$fails_file"
    if [ "$n" -ge "$FAILS_BEFORE_REPORT" ] && [ ! -f "$issue_file" ] && [ -n "$TOKEN" ]; then open_issue "$check"; fi
  else
    rm -f "$fails_file"
    if [ -f "$issue_file" ] && [ -n "$TOKEN" ]; then close_issue "$check" "$(tr -d '[:space:]' < "$issue_file")"; fi
  fi
done

[ "$LATEST_OK" = 0 ] && [ ${#FAILED[@]} -eq 0 ]
