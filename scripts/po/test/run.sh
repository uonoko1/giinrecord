#!/usr/bin/env bash
# Minimal test runner for scripts/po/*.sh (no bats). Each test runs a script with a fake `gh`
# placed first on PATH; assertions check exit status, stdout/stderr and the recorded gh calls.
#   bash scripts/po/test/run.sh            # run all
#   bash scripts/po/test/run.sh merge      # run tests whose name contains "merge"
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PO_DIR=$(dirname "$HERE")
FILTER=${1:-}
PASS=0; FAIL=0; FAILED=()

# ---- harness -------------------------------------------------------------------------------
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
# shellcheck disable=SC2034  # read by the sourced *.test.sh files
STATUS=0; OUT=""; ERR=""; LOG=""

# run_script <handler-file> <script> [args...]  → sets STATUS, OUT, ERR, LOG
run_script() {
  local handler=$1 script=$2; shift 2
  : > "$TMP/gh.log"
  echo 0 > "$TMP/counter"
  set +e
  PATH="$HERE/fake-bin:$PATH" FAKE_GH_LOG="$TMP/gh.log" FAKE_GH_HANDLER="$handler" FAKE_COUNTER="$TMP/counter" \
    POLL_INTERVAL=0 POLL_MAX=5 PO_REPO=uonoko1/seiji-kiroku \
    bash "$PO_DIR/$script" "$@" > "$TMP/out" 2> "$TMP/err"
  # shellcheck disable=SC2034
  STATUS=$?
  set -e
  # shellcheck disable=SC2034
  OUT=$(cat "$TMP/out")
  # shellcheck disable=SC2034
  ERR=$(cat "$TMP/err")
  # shellcheck disable=SC2034
  LOG=$(cat "$TMP/gh.log")
}

# handler <<'EOF' ... EOF → writes a handler file defining `handle`, echoes its path
handler() { local f="$TMP/handler.$RANDOM$RANDOM.sh"; cat > "$f"; echo "$f"; }

# bump → increments a per-run counter (for polling handlers); prints the new value
bump() { local n; n=$(( $(cat "$FAKE_COUNTER") + 1 )); echo "$n" > "$FAKE_COUNTER"; echo "$n"; }
export -f bump

assert_eq()           { [[ "$2" == "$1" ]] || fail "$3: expected [$1] got [$2]"; }
assert_contains()     { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in:
$1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "$3: expected NOT to contain [$2] in:
$1"; }
fail() { CURRENT_FAILED=1; echo "    x $1"; }

test_case() {
  local name=$1; shift
  [[ -z "$FILTER" || "$name" == *"$FILTER"* ]] || return 0
  CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"
  else FAIL=$((FAIL+1)); FAILED+=("$name"); echo "FAIL $name"; fi
}

# ---- tests ---------------------------------------------------------------------------------
for t in "$HERE"/*.test.sh; do
  # shellcheck source=/dev/null
  source "$t"
done

echo
echo "passed: $PASS  failed: $FAIL"
if [[ $FAIL -gt 0 ]]; then printf '  - %s\n' "${FAILED[@]}"; exit 1; fi
