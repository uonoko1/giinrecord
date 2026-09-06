#!/usr/bin/env bash
# Tests for the logrotate configs of the monitor / analytics logs (Issue #288).
#
# /var/log/giinrecord-monitor.log and /var/log/giinrecord-analytics.log matched no logrotate config, so they
# grew without bound. The VPS is shared with other sites, so the configs added here must name this project's
# own files and must never rotate anything else — a stray `/var/log/*.log` would take co-tenants' logs with it.
#
# No root: setup.sh is rooted at a temp dir through MONITOR_SETUP_PREFIX; the analytics config is checked as a
# fixture (vps-analytics-setup.sh has no prefix and needs sudo, so it is not executed here).
#   bash deploy/test/logrotate.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY=$(cd "$HERE/.." && pwd)
PASS=0; FAIL=0
ME=$(id -un)

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_eq() { [[ "$2" == "$1" ]] || fail "$3: expected [$1] got [$2]"; }
assert_exists() { [[ -e "$1" ]] || fail "$2: expected $1 to exist"; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in: $1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "$3: expected NOT to contain [$2] in: $1"; }
test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

MONITOR_FIXTURE="$DEPLOY/monitor/logrotate.conf"
ANALYTICS_FIXTURE="$DEPLOY/analytics/logrotate.conf"

# --- the fixtures shipped in the repo -------------------------------------------------------------------

t_fixtures_exist() {
  assert_exists "$MONITOR_FIXTURE" "monitor logrotate fixture"
  assert_exists "$ANALYTICS_FIXTURE" "analytics logrotate fixture"
}

# The one rule the shared VPS makes non-negotiable: only this project's own log files may be named.
# A glob would silently pull in a co-tenant site's logs the next time someone drops a file in /var/log.
t_only_this_projects_logs() {
  local f body
  for f in "$MONITOR_FIXTURE" "$ANALYTICS_FIXTURE"; do
    [[ -e "$f" ]] || { fail "$(basename "$(dirname "$f")"): fixture missing"; continue; }
    body=$(grep -v '^[[:space:]]*#' "$f")
    # every path mentioned before the opening brace must be an explicit /var/log/giinrecord-*.log file
    local paths path
    paths=$(printf '%s\n' "$body" | sed -n '1,/{/p' | tr -d '{' | tr -s ' \t' '\n' | grep '^/' || true)
    [[ -n "$paths" ]] || fail "$f: no log path found"
    while read -r path; do
      [[ -z "$path" ]] && continue
      assert_not_contains "$path" "*" "$f: no wildcard in the rotated path ($path)"
      assert_not_contains "$path" "?" "$f: no glob in the rotated path ($path)"
      case "$path" in
        /var/log/giinrecord-*.log) ;;
        *) fail "$f: rotates a path outside this project: $path" ;;
      esac
    done <<< "$paths"
  done
}

t_retention_is_long_enough_for_incident_review() {
  # Monitor log is the record used to investigate an outage after the fact, so it must cover well over a
  # month. Whatever period/rotate pair is chosen, period x rotate must be >= 180 days of history.
  local body period rotate days
  body=$(grep -v '^[[:space:]]*#' "$MONITOR_FIXTURE")
  rotate=$(printf '%s\n' "$body" | awk '$1=="rotate"{print $2}')
  [[ -n "$rotate" ]] || { fail "monitor: no 'rotate' directive"; return; }
  period=$(head -1 < <(awk '$1=="daily"||$1=="weekly"||$1=="monthly"{print $1}' <<<"$body"))
  case "$period" in
    daily) days=$((rotate)) ;;
    weekly) days=$((rotate*7)) ;;
    monthly) days=$((rotate*30)) ;;
    *) fail "monitor: no rotation period (daily/weekly/monthly)"; return ;;
  esac
  [[ $days -ge 180 ]] || fail "monitor: keeps only $days days; incident review needs >= 180"
}

t_size_cap_bounds_the_worst_case() {
  # Retention alone does not bound disk if a loop starts spamming the log: every config needs a size guard.
  local f
  for f in "$MONITOR_FIXTURE" "$ANALYTICS_FIXTURE"; do
    [[ -e "$f" ]] || continue
    assert_contains "$(grep -v '^[[:space:]]*#' "$f")" "maxsize" "$(basename "$(dirname "$f")"): maxsize caps a runaway log"
  done
}

t_safe_directives() {
  local f body
  for f in "$MONITOR_FIXTURE" "$ANALYTICS_FIXTURE"; do
    [[ -e "$f" ]] || continue
    body=$(grep -v '^[[:space:]]*#' "$f")
    assert_contains "$body" "missingok" "$(basename "$(dirname "$f")"): missingok (log may not exist yet)"
    assert_contains "$body" "notifempty" "$(basename "$(dirname "$f")"): notifempty"
    assert_contains "$body" "compress" "$(basename "$(dirname "$f")"): compress"
    # The live logs are 600 root:root (monitor.log may name internal hosts; analytics.log is cron output).
    # Rotated copies must keep that, and must not become adm-readable on a shared VPS.
    assert_contains "$body" "create 0600 root root" "$(basename "$(dirname "$f")"): rotated copies stay root-only 600"
    assert_contains "$body" "su root root" "$(basename "$(dirname "$f")"): rotate as root:root, not root:adm"
  done
}

t_no_ip_policy_kept() {
  # Issue #58: nothing here may start logging IPs. These configs only rotate; they must not add a
  # postrotate that reads or re-formats log contents.
  local f
  for f in "$MONITOR_FIXTURE" "$ANALYTICS_FIXTURE"; do
    [[ -e "$f" ]] || continue
    assert_not_contains "$(grep -v '^[[:space:]]*#' "$f")" "postrotate" "$(basename "$(dirname "$f")"): no postrotate script"
  done
}

t_logrotate_accepts_the_configs() {
  # If logrotate is installed, let it parse the real files (debug mode: no writes). Running as a normal user
  # it always reports two errors that are about the environment, not the config -- it cannot read
  # /var/lib/logrotate/status and cannot setuid to root -- so those are filtered out and everything else,
  # including any syntax error ("unknown option", "unexpected"), fails the test.
  command -v logrotate >/dev/null || { echo "    - logrotate not installed; parse check skipped"; return; }
  local f out errs
  for f in "$MONITOR_FIXTURE" "$ANALYTICS_FIXTURE"; do
    [[ -e "$f" ]] || continue
    out=$(logrotate --debug "$f" 2>&1 || true)
    errs=$(printf '%s\n' "$out" | grep 'error:' \
      | grep -v 'state file' | grep -v 'switching euid' || true)
    assert_eq "" "$errs" "$f: logrotate reports no config error"
    # the directives we care about must actually have been understood
    assert_contains "$out" "monthly (12 rotations)" "$f: monthly, keep 12 parsed"
    assert_contains "$out" "33554432" "$f: maxsize 32M parsed"
  done
}

# --- what the setup scripts install ----------------------------------------------------------------------

t_monitor_setup_installs_the_config() {
  local P="$TMP/monitor"
  mkdir -p "$P/etc/cron.d" "$P/etc/logrotate.d" "$P/var/log" "$P/home/$ME"
  MONITOR_SETUP_PREFIX="$P" MONITOR_OWNER="$ME" bash "$DEPLOY/monitor/setup.sh" > "$P/out" 2>&1 \
    || fail "setup.sh exit $?: $(cat "$P/out")"
  local dest="$P/etc/logrotate.d/giinrecord-monitor"
  assert_exists "$dest" "setup.sh installs the logrotate config"
  [[ -e "$dest" ]] || return
  assert_eq "644" "$(stat -c %a "$dest")" "logrotate.d mode (logrotate refuses group/other-writable)"
  local body; body=$(cat "$dest")
  assert_contains "$body" "/var/log/giinrecord-monitor.log" "rotates the monitor log"
  assert_not_contains "$body" "$P" "real paths inside, not the test prefix"
  assert_contains "$(cat "$P/out")" "logrotate" "operator is told the rotation was installed"
}

t_monitor_setup_is_idempotent() {
  local P="$TMP/monitor-twice"
  mkdir -p "$P/etc/cron.d" "$P/etc/logrotate.d" "$P/var/log" "$P/home/$ME"
  for _ in 1 2; do
    MONITOR_SETUP_PREFIX="$P" MONITOR_OWNER="$ME" bash "$DEPLOY/monitor/setup.sh" > "$P/out" 2>&1 \
      || fail "setup.sh exit $?: $(cat "$P/out")"
  done
  local dest="$P/etc/logrotate.d/giinrecord-monitor"
  [[ -e "$dest" ]] || { fail "config missing after two runs"; return; }
  # count rule blocks (a path line opening a brace), not comment mentions of the path
  assert_eq "1" "$(grep -cE '^/var/log/giinrecord-monitor\.log[[:space:]]*\{' "$dest")" "config not appended twice"
  assert_eq "1" "$(grep -cE '^[[:space:]]*rotate ' "$dest")" "single rule block after two runs"
}

t_analytics_setup_installs_the_config() {
  # vps-analytics-setup.sh needs root and has no prefix, so assert on its source: it must copy the fixture
  # into /etc/logrotate.d/ rather than leaving the analytics log unrotated.
  local src; src=$(grep -v '^[[:space:]]*#' "$DEPLOY/analytics/vps-analytics-setup.sh")
  assert_contains "$src" "/etc/logrotate.d/giinrecord-analytics" "analytics setup installs its logrotate config"
}

t_analytics_heredoc_matches_the_fixture() {
  # vps-analytics-setup.sh is also run piped over stdin (`sudo bash -s`), so it cannot copy a file from the
  # checkout and carries the config inline. That duplication is only safe while the two stay identical.
  local extracted="$TMP/analytics-heredoc.conf"
  sed -n "/^cat > \\/etc\\/logrotate.d\\/giinrecord-analytics <<'LOGROTATE'$/,/^LOGROTATE$/p" \
    "$DEPLOY/analytics/vps-analytics-setup.sh" | sed '1d;$d' > "$extracted"
  [[ -s "$extracted" ]] || { fail "no logrotate heredoc found in vps-analytics-setup.sh"; return; }
  diff -u "$ANALYTICS_FIXTURE" "$extracted" > "$TMP/heredoc.diff" 2>&1 \
    || fail "heredoc drifted from deploy/analytics/logrotate.conf: $(cat "$TMP/heredoc.diff")"
}

t_setup_scripts_still_parse() {
  bash -n "$DEPLOY/monitor/setup.sh" || fail "monitor/setup.sh bash -n"
  bash -n "$DEPLOY/analytics/vps-analytics-setup.sh" || fail "vps-analytics-setup.sh bash -n"
}

test_case "logrotate: 設定ファイルが deploy/ に存在する" t_fixtures_exist
test_case "logrotate: 自プロジェクトのログだけを名指しし、ワイルドカードを使わない（共用 VPS）" t_only_this_projects_logs
test_case "logrotate: 監視ログは障害調査に足りる期間（180 日以上）保持する" t_retention_is_long_enough_for_incident_review
test_case "logrotate: maxsize で暴走時の上限も押さえる" t_size_cap_bounds_the_worst_case
test_case "logrotate: missingok/notifempty/compress、ローテート後も 600 root:root" t_safe_directives
test_case "logrotate: postrotate でログ内容に触れない（#58 の IP 非記録を維持）" t_no_ip_policy_kept
test_case "logrotate: logrotate 自身が設定を解釈できる" t_logrotate_accepts_the_configs
test_case "monitor/setup.sh: /etc/logrotate.d/giinrecord-monitor を 644 で配置する" t_monitor_setup_installs_the_config
test_case "monitor/setup.sh: 2 回走らせても設定が重複しない" t_monitor_setup_is_idempotent
test_case "vps-analytics-setup.sh: /etc/logrotate.d/giinrecord-analytics を配置する" t_analytics_setup_installs_the_config
test_case "vps-analytics-setup.sh: 埋め込み設定が fixture と一致し続ける" t_analytics_heredoc_matches_the_fixture
test_case "setup スクリプトが bash -n を通る" t_setup_scripts_still_parse

echo; echo "passed: $PASS  failed: $FAIL"
[[ $FAIL == 0 ]]
