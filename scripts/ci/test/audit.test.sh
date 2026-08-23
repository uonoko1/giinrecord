#!/usr/bin/env bash
# Tests for scripts/ci/audit.sh (Issue #133): `pnpm audit` high+ gate with an ignore list. pnpm is a stub on
# PATH that prints canned JSON; the ignore file is written per case.
#   bash scripts/ci/test/audit.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../audit.sh"
PASS=0; FAIL=0
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"; mkdir -p "$BIN"
cat > "$BIN/pnpm" <<'STUB'
#!/usr/bin/env bash
echo "pnpm $*" >> "$STUB_LOG"
cat "$STUB_JSON"
exit "${STUB_EXIT:-1}"
STUB
chmod +x "$BIN/pnpm"

fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_eq() { [[ "$2" == "$1" ]] || fail "$3: expected [$1] got [$2]"; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in: $1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "$3: expected NOT to contain [$2] in: $1"; }
test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

# advisory <ghsa> <severity> <module> → one JSON advisory object
advisory() { printf '"%s":{"github_advisory_id":"%s","severity":"%s","module_name":"%s","title":"t %s","patched_versions":">=9"}' "$RANDOM$RANDOM" "$1" "$2" "$3" "$1"; }
# audit_json <advisory-json...> → writes the stub's JSON
audit_json() { local IFS=,; printf '{"advisories":{%s},"metadata":{"vulnerabilities":{}}}\n' "$*" > "$TMP/audit.json"; }
# ignore <lines...> → writes the ignore file
ignore() { printf '%s\n' "$@" > "$TMP/ignore.txt"; }
run() { # run [STUB_EXIT]
  : > "$TMP/stub.log"
  set +e
  PATH="$BIN:$PATH" STUB_LOG="$TMP/stub.log" STUB_JSON="$TMP/audit.json" STUB_EXIT="${1:-1}" \
    AUDIT_IGNORE_FILE="$TMP/ignore.txt" AUDIT_TODAY="2026-08-23" bash "$SCRIPT" > "$TMP/out" 2>&1
  STATUS=$?
  set -e
  OUT=$(cat "$TMP/out")
}

t_clean() {
  audit_json; ignore; run 0
  assert_eq 0 "$STATUS" "exit"
  assert_contains "$(cat "$TMP/stub.log")" "pnpm audit --json --audit-level=high" "pnpm audit called at high"
  assert_contains "$OUT" "audit: clean" "summary"
}

t_high_fails() {
  audit_json "$(advisory GHSA-aaaa-bbbb-cccc high leftpad)"; ignore; run
  assert_eq 1 "$STATUS" "exit"
  assert_contains "$OUT" "GHSA-aaaa-bbbb-cccc" "advisory id"
  assert_contains "$OUT" "leftpad" "module"
}

t_critical_fails() {
  audit_json "$(advisory GHSA-aaaa-bbbb-dddd critical foo)"; ignore; run
  assert_eq 1 "$STATUS" "exit"
}

t_moderate_passes() {
  # pnpm --audit-level=high already exits 0 for moderate-only; the wrapper must not second-guess it
  audit_json "$(advisory GHSA-aaaa-bbbb-eeee moderate foo)"; ignore; run 0
  assert_eq 0 "$STATUS" "exit"
}

t_ignored_with_justification_passes() {
  audit_json "$(advisory GHSA-aaaa-bbbb-cccc high leftpad)"
  ignore "# comment" "" "GHSA-aaaa-bbbb-cccc 2026-12-31 leftpad is only used at build time on trusted input (#133)"
  run
  assert_eq 0 "$STATUS" "exit"
  assert_contains "$OUT" "ignored GHSA-aaaa-bbbb-cccc" "ignore reported"
  assert_contains "$OUT" "leftpad is only used" "justification echoed"
}

t_expired_ignore_fails() {
  audit_json "$(advisory GHSA-aaaa-bbbb-cccc high leftpad)"
  ignore "GHSA-aaaa-bbbb-cccc 2026-08-22 expired yesterday"
  run
  assert_eq 1 "$STATUS" "exit"
  assert_contains "$OUT" "expired" "reason"
}

t_ignore_without_justification_is_invalid() {
  audit_json "$(advisory GHSA-aaaa-bbbb-cccc high leftpad)"
  ignore "GHSA-aaaa-bbbb-cccc 2026-12-31"
  run
  assert_eq 1 "$STATUS" "exit"
  assert_contains "$OUT" "justification" "reason"
}

t_partial_ignore_still_fails_on_the_rest() {
  audit_json "$(advisory GHSA-aaaa-bbbb-cccc high leftpad)" "$(advisory GHSA-ffff-gggg-hhhh high other)"
  ignore "GHSA-aaaa-bbbb-cccc 2026-12-31 fine because reasons"
  run
  assert_eq 1 "$STATUS" "exit"
  assert_contains "$OUT" "GHSA-ffff-gggg-hhhh" "remaining advisory reported"
}

t_missing_ignore_file_is_fine() {
  audit_json; rm -f "$TMP/ignore.txt"; run 0
  assert_eq 0 "$STATUS" "exit"
}

t_pnpm_failure_without_json_fails() {
  echo "not json" > "$TMP/audit.json"; ignore; run 1
  assert_eq 1 "$STATUS" "exit (registry down etc. must not pass silently)"
}

test_case "audit.sh: bash -n" bash -n "$SCRIPT"
test_case "no advisories → pass" t_clean
test_case "high advisory → fail, id and module named" t_high_fails
test_case "critical advisory → fail" t_critical_fails
test_case "moderate only (pnpm exit 0) → pass" t_moderate_passes
test_case "ignored id with expiry + justification → pass, justification echoed" t_ignored_with_justification_passes
test_case "expired ignore → fail" t_expired_ignore_fails
test_case "ignore line without justification → fail" t_ignore_without_justification_is_invalid
test_case "one ignored, one not → fail on the remaining one" t_partial_ignore_still_fails_on_the_rest
test_case "no ignore file → fine" t_missing_ignore_file_is_fine
test_case "pnpm output not JSON → fail" t_pnpm_failure_without_json_fails

echo; echo "passed: $PASS  failed: $FAIL"
[[ $FAIL == 0 ]]
