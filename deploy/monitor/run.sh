#!/usr/bin/env bash
# One monitoring round for one environment (Issue #135), called by .github/workflows/monitor.yml:
#   run.sh <environment> <origin>        e.g. run.sh production https://gikailog.jp
# probe.sh once; if anything failed, wait MONITOR_RETRY_SLEEP (60) seconds and probe again. A check counts as failed
# only when it failed in BOTH rounds ("2 consecutive failures" within a single run — the schedule fires every
# 10 minutes, so the previous run's outcome is not needed and a blip never opens an Issue). Then every check is
# reported through report.sh: failed → Issue "[monitor] <environment>: <check>" (deduplicated), passed → close it if
# one is open. Exit 1 when something was reported as failed (the workflow run shows red too).
# Issue bodies: environment, check, the probe's reason, and the link to this run. Nothing about the server.
#   Tests: deploy/test/monitor-probe.test.sh (curl/openssl/gh/sleep are stubs)
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ENV_NAME=${1:-}; ORIGIN=${2:-}
if [ -z "$ENV_NAME" ] || [ -z "$ORIGIN" ]; then echo "usage: run.sh <environment> <origin>" >&2; exit 2; fi
RETRY_SLEEP=${MONITOR_RETRY_SLEEP:-60}
CHECKS=(http data tls)

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

bash "$HERE/probe.sh" "$ORIGIN" > "$TMP/r1" || true
echo "round 1:"; sed 's/^/  /' "$TMP/r1"
if grep -q '^fail ' "$TMP/r1"; then
  sleep "$RETRY_SLEEP"
  bash "$HERE/probe.sh" "$ORIGIN" > "$TMP/r2" || true
  echo "round 2:"; sed 's/^/  /' "$TMP/r2"
else
  cp "$TMP/r1" "$TMP/r2"
fi

run_url=""
if [ -n "${GITHUB_SERVER_URL:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ] && [ -n "${GITHUB_RUN_ID:-}" ]; then
  run_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
fi

EXIT=0
for check in "${CHECKS[@]}"; do
  title="[monitor] $ENV_NAME: $check"
  r1=$(grep "^fail $check " "$TMP/r1" || true)
  r2=$(grep "^fail $check " "$TMP/r2" || true)
  if [ -n "$r1" ] && [ -n "$r2" ]; then
    EXIT=1
    reason=${r2#fail "$check" }
    cat > "$TMP/body.$check" <<BODY
External check **${check}** of **${ENV_NAME}** (${ORIGIN}) failed twice in a row, ${RETRY_SLEEP}s apart.

- reason: \`${reason}\`
- first seen: $(date -u +%Y-%m-%dT%H:%M:%SZ)
${run_url:+- run: $run_url}

What the check means and what to do: \`docs/ops/monitoring.md\`. This Issue is closed automatically once the check passes again.
BODY
    bash "$HERE/report.sh" "$title" fail "$TMP/body.$check"
  else
    bash "$HERE/report.sh" "$title" ok
  fi
done
exit $EXIT
