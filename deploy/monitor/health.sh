#!/usr/bin/env bash
# VPS-side health check (Issue #135). Runs as ROOT from /etc/cron.d/giinrecord-monitor every 5 minutes
# (installed by deploy/monitor/setup.sh). No SaaS, no agent: a few local commands, one log file, and — only when
# something is wrong twice in a row — a GitHub Issue through the REST API with curl.
#
# Checks (name → what fails):
#   container-web / container-web-staging   docker healthcheck of giinrecord-web-1 / giinrecord-web-staging-1 is not "healthy"
#   nginx                                   host nginx is not `systemctl is-active`
#   disk                                    filesystem of the web root is used more than MONITOR_DISK_MAX % (85)
#   site-production / site-staging          rsync target missing, or its data/meta.json older than MONITOR_STALE_HOURS (48)
#   checkout-owner                          /opt/giinrecord に root 以外が所有するファイルがある（#333 の前提が崩れた）
#   analytics                               直近 MONITOR_ANALYTICS_DAYS 日ぶんの PV 集計が、ぜんぶ 0 か、1 つも無い（#1184）
#
# Outputs:
#   $MONITOR_LOG (/var/log/giinrecord-monitor.log, root 600): one line per run, "<UTC time> OK" or "<UTC time> FAIL <check>: <why>; …"
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

LOG="${MONITOR_LOG:-/var/log/giinrecord-monitor.log}"
STATE_DIR="${MONITOR_STATE_DIR:-/var/lib/giinrecord-monitor}"
TOKEN_FILE="${MONITOR_TOKEN_FILE:-/etc/giinrecord/monitor.token}"
SITE_DIR="${MONITOR_SITE_DIR:-/var/www/giinrecord/site}"
STAGING_DIR="${MONITOR_STAGING_DIR:-/var/www/giinrecord/staging}"
LATEST_DIR="${MONITOR_LATEST_DIR:-/home/ubuntu/monitor}"
OWNER="${MONITOR_OWNER:-ubuntu}"
REPO="${MONITOR_REPO:-uonoko1/giinrecord}"
API="${MONITOR_API:-https://api.github.com}"
DISK_MAX="${MONITOR_DISK_MAX:-85}"
STALE_HOURS="${MONITOR_STALE_HOURS:-48}"
CHECKOUT_DIR="${MONITOR_CHECKOUT_DIR:-/opt/giinrecord}"
ANALYTICS_DIR="${MONITOR_ANALYTICS_DIR:-/home/ubuntu/analytics}"
ANALYTICS_DAYS="${MONITOR_ANALYTICS_DAYS:-3}"
FAILS_BEFORE_REPORT="${MONITOR_FAILS_BEFORE_REPORT:-2}"
NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
NOW_EPOCH=$(date +%s)

FAILED=()            # check names that failed this run
declare -A WHY=()    # check name → short reason (for the log only)
failure() { FAILED+=("$1"); WHY[$1]=$2; }
ALL_CHECKS=(container-web container-web-staging nginx disk site-production site-staging checkout-owner analytics)

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
# #333: giinops の sudo allowlist（git pull / docker compose up を root で実行できる）が安全なのは、
# $CHECKOUT_DIR 配下を giinops が1バイトも書けないという前提の上でだけ。書けるファイルが1つでもあれば
# .git/config の core.pager や docker-compose.yml を書き換えて root を取れる。前提そのものを監視する。
check_checkout_owner() {
  local n
  [ -d "$CHECKOUT_DIR" ] || return 0   # この VPS に checkout が無い構成なら何も言わない
  n=$(find "$CHECKOUT_DIR" ! -user root 2>/dev/null | head -20 | grep -c . || true)
  [ "$n" = 0 ] || failure checkout-owner "${n}+ files not owned by root"
}
# #1184: PV の計器が 39 日間、無言で壊れていた。VPS に設置済みの daily.sh が改名前のログ名
# （存在しないファイル）を読み、0 行の TSV を書いて exit 0 で成功を報告していた。cron は毎日発火し、
# TSV も毎日できていたので、どの計器も赤くならなかった。**「0 件」と「測れなかった」が
# 区別されていなかった**（#757 / #1158 と同じ型）。
#
# daily.sh 側は非 0 で落ちるようにしたが、**その非 0 は cron ログに入るだけで誰も読まない**。
# 声になるのはここだけなので、連続 0 行をこの check が見る。新しい入口は作らない（#1110 の軸——
# 入口が増えると入口自身の死を誰も見なくなる）。
#
# 判定は TSV の **pv の値**。行数ではない。0 の日の TSV もヘッダ＋要約行で必ず 2 行在るので、
# 行数で見ると永遠に 0 にならない——それが 39 日の片方の原因そのものだった。
#
# 「連続」で見る理由: 小さなサイトの静かな 1 日に pv=0 は在りうる。1 日で Issue を開けば騒がしくなり、
# 騒がしい監視は読まれなくなる。逆に $ANALYTICS_DAYS 日ぜんぶ 0 なら、それは静かな日ではない。
# （この check 自体も 2 回連続で初めて Issue になるので、実際には日数×2 回ぶんの余裕が在る。）
#
# TSV が 1 つも無いのも異常にする: cron が走っていない／daily.sh が exit 3 している状態で、
# 「0 件」ではなく「測れていない」。**どちらも黙らせない**が、集計を置かない構成
# （staging など）では何も言わない（checkout-owner と同じ扱い）。
check_analytics() {
  local day tsv pv found=0 nonzero=0 i=0
  [ -d "$ANALYTICS_DIR" ] || return 0   # 集計を置かない構成なら何も言わない
  while [ "$i" -lt "$ANALYTICS_DAYS" ]; do
    day=$(date -u -d "$i days ago" +%F); i=$((i + 1))
    tsv="$ANALYTICS_DIR/$day.tsv"
    [ -f "$tsv" ] || continue
    found=$((found + 1))
    # 要約行（aggregate.sh が 2 行目に置く `# <date>	pv=N	pages=M	per-page=X`）から pv を読む。
    # 要約行が無い旧い TSV でも読めるように、本文の pv 列（4 列目）の合計にも落ちる。
    pv=$(sed -n 's/^#.*\bpv=\([0-9][0-9]*\).*/\1/p' "$tsv" | head -1)
    [ -n "$pv" ] || pv=$(awk -F '\t' 'NR>1 && $0 !~ /^#/ { s += $4 } END { print s + 0 }' "$tsv")
    [ "$pv" -gt 0 ] && nonzero=$((nonzero + 1))
  done
  if [ "$found" = 0 ]; then
    failure analytics "no TSV in the last ${ANALYTICS_DAYS}d"
  elif [ "$nonzero" = 0 ]; then
    failure analytics "0 page views in ${found}/${ANALYTICS_DAYS} measured days"
  fi
}
check_site() { # check_site <check> <dir>
  local meta="$2/data/meta.json" mtime age_h
  if [ ! -d "$2" ]; then failure "$1" "directory missing"; return; fi
  if [ ! -f "$meta" ]; then failure "$1" "data/meta.json missing"; return; fi
  mtime=$(stat -c %Y "$meta")
  age_h=$(( (NOW_EPOCH - mtime) / 3600 ))
  [ "$age_h" -le "$STALE_HOURS" ] || failure "$1" "data ${age_h}h old"
}

check_container container-web giinrecord-web-1
check_container container-web-staging giinrecord-web-staging-1
check_nginx
check_disk
check_site site-production "$SITE_DIR"
check_site site-staging "$STAGING_DIR"
check_checkout_owner
check_analytics

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
