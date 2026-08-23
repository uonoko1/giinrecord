#!/usr/bin/env bash
# Tests for the nginx reload guard in the deploy scripts (Issue #133). Under `set -e`,
# `nginx -t && systemctl reload nginx` silently skips the reload when the config is broken (the failing
# command is not the last of the && list, so errexit ignores it) and the script goes on as if it succeeded.
# Every script that reloads nginx must use reload_nginx(): test, reload only on success, exit 1 otherwise.
#   bash deploy/test/nginx-reload.test.sh
# shellcheck disable=SC2016  # the bash -c bodies below take the script path as $1 on purpose
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY=$(cd "$HERE/.." && pwd)
PASS=0; FAIL=0

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"; mkdir -p "$BIN"
for cmd in nginx systemctl; do
  cat > "$BIN/$cmd" <<STUB
#!/usr/bin/env bash
echo "$cmd \$*" >> "\$STUB_LOG"
if [ -n "\${STUB_HANDLER:-}" ]; then "\$STUB_HANDLER" "$cmd" "\$@"; fi
STUB
  chmod +x "$BIN/$cmd"
done
cat > "$TMP/nginx-broken" <<'H'
#!/usr/bin/env bash
# nginx -t → "configuration file test failed"
if [[ "$1 $2" == "nginx -t" ]]; then echo "nginx: [emerg] unexpected end of file" >&2; exit 1; fi
H
chmod +x "$TMP/nginx-broken"

fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_eq() { [[ "$2" == "$1" ]] || fail "$3: expected [$1] got [$2]"; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in: $1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "$3: expected NOT to contain [$2] in: $1"; }
test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

# run_reload <script> <NO_MAIN var> [handler] → STATUS, LOG, OUT. Sources the script (main() not run) and
# calls reload_nginx inside `set -e`, followed by a marker that must not be reached on failure.
run_reload() {
  local script=$1 guard=$2 handler=${3:-}
  LOG="$TMP/stub.log"; : > "$LOG"
  set +e
  env "$guard=1" PATH="$BIN:$PATH" STUB_LOG="$LOG" STUB_HANDLER="$handler" \
    bash -c 'set -euo pipefail; source "$1"; reload_nginx; echo REACHED-AFTER-RELOAD' _ "$script" > "$TMP/out" 2>&1
  STATUS=$?
  set -e
  OUT=$(cat "$TMP/out"); LOG=$(cat "$LOG")
}

# Each script that reloads nginx: <path> <NO_MAIN guard variable>
SCRIPTS=(
  "$DEPLOY/vps-setup.sh VPS_SETUP_NO_MAIN"
  "$DEPLOY/analytics/vps-analytics-setup.sh ANALYTICS_SETUP_NO_MAIN"
)

t_reload_on_success() {
  local entry script guard
  for entry in "${SCRIPTS[@]}"; do
    read -r script guard <<< "$entry"
    run_reload "$script" "$guard"
    assert_eq 0 "$STATUS" "$(basename "$script"): exit $OUT"
    assert_contains "$LOG" "nginx -t" "$(basename "$script"): config tested"
    assert_contains "$LOG" "systemctl reload nginx" "$(basename "$script"): reloaded"
    assert_contains "$OUT" "REACHED-AFTER-RELOAD" "$(basename "$script"): script continues"
  done
}

t_no_reload_and_exit_1_on_broken_config() {
  local entry script guard
  for entry in "${SCRIPTS[@]}"; do
    read -r script guard <<< "$entry"
    run_reload "$script" "$guard" "$TMP/nginx-broken"
    assert_eq 1 "$STATUS" "$(basename "$script"): exit"
    assert_not_contains "$LOG" "systemctl" "$(basename "$script"): NO reload on a broken config"
    assert_not_contains "$OUT" "REACHED-AFTER-RELOAD" "$(basename "$script"): script stops"
    assert_contains "$OUT" "nginx -t failed" "$(basename "$script"): operator is told"
  done
}

t_no_and_list_pattern_left() {
  # The pattern itself must be gone from every deploy script (fix-www.sh already used if/else).
  local hits
  hits=$(grep -rn -E '^[^#]*nginx -t *&&' "$DEPLOY" --include='*.sh' | grep -v '/test/' || true)
  assert_eq "" "$hits" "no 'nginx -t && ...' left in deploy scripts"
}

t_sourcing_runs_nothing() {
  local entry script guard
  for entry in "${SCRIPTS[@]}"; do
    read -r script guard <<< "$entry"
    LOG="$TMP/stub.log"; : > "$LOG"
    env "$guard=1" PATH="$BIN:$PATH" STUB_LOG="$LOG" bash -c 'set -euo pipefail; source "$1"' _ "$script" > "$TMP/out" 2>&1 \
      || fail "$(basename "$script"): sourcing with the guard must succeed: $(cat "$TMP/out")"
    assert_eq "" "$(cat "$LOG")" "$(basename "$script"): sourcing with the guard runs nothing"
  done
}

test_case "bash -n on every deploy script" bash -c 'for f in "$@"; do bash -n "$f" || exit 1; done' _ "$DEPLOY"/*.sh "$DEPLOY"/analytics/*.sh
test_case "reload_nginx: nginx -t OK → systemctl reload nginx, script continues" t_reload_on_success
test_case "reload_nginx: nginx -t fails → no reload, exit 1, message" t_no_reload_and_exit_1_on_broken_config
test_case "no 'nginx -t && ...' list remains in deploy/" t_no_and_list_pattern_left
test_case "*_NO_MAIN=1: sourcing runs nothing" t_sourcing_runs_nothing

echo; echo "passed: $PASS  failed: $FAIL"
[[ $FAIL == 0 ]]
