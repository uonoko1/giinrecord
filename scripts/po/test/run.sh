#!/usr/bin/env bash
# Minimal test runner for scripts/po/*.sh (no bats). Each test runs a script with a fake `gh`
# placed first on PATH; assertions check exit status, stdout/stderr and the recorded gh calls.
#   bash scripts/po/test/run.sh                       # run all
#   bash scripts/po/test/run.sh merge                 # tests whose NAME contains "merge"
#   bash scripts/po/test/run.sh merge-when-green      # ...or whose FILE is merge-when-green.test.sh
#
# **A filter that matches nothing is an error, not a pass** (#1124). It used to print
# `passed: 0  failed: 0` and exit 0 — "0 executed" read exactly like "0 failed" (#757), so
# `run.sh merge-when-green` looked green while running not one line of anything.
# The filter now also matches the *file* a case came from, because `merge-when-green` is the
# obvious thing to type (it is the name of the script under test, and of the file holding its
# tests) and it was never a test name. Both spellings work; neither is silently empty.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PO_DIR=$(dirname "$HERE")
FILTER=${1:-}
PASS=0; FAIL=0; FAILED=()
# **`RAN` counts cases that were selected; `NAMES` remembers every case that exists.**
# Without RAN there is no way to tell "everything passed" from "nothing ran".
RAN=0; NAMES=()
CURRENT_FILE=""    # basename of the *.test.sh being sourced, so the filter can match it

# ---- harness -------------------------------------------------------------------------------
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
# shellcheck disable=SC2034  # read by the sourced *.test.sh files
STATUS=0; OUT=""; ERR=""; LOG=""; LEDGER=""; LEDGER_PATH=""

# board-audit.sh --fix の台帳（#919）。**テストが本物の docs/ops/board-audit-log.tsv を汚さないよう、
# $TMP に向ける。** **毎回消してから走らせる**ので、「書かなかった」を「ファイルが無い」で見られる。
LEDGER_PATH="$TMP/board-audit-log.tsv"

# run_script <handler-file> <script> [args...]  → sets STATUS, OUT, ERR, LOG, LEDGER
run_script() {
  local handler=$1 script=$2; shift 2
  : > "$TMP/gh.log"
  echo 0 > "$TMP/counter"
  rm -f "$LEDGER_PATH"
  set +e
  PATH="$HERE/fake-bin:$PATH" FAKE_GH_LOG="$TMP/gh.log" FAKE_GH_HANDLER="$handler" FAKE_COUNTER="$TMP/counter" FAKE_UNHANDLED="$TMP/unhandled" \
    POLL_INTERVAL=0 POLL_MAX=5 PO_REPO=uonoko1/giinrecord BOARD_AUDIT_LOG="$LEDGER_PATH" \
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
  # shellcheck disable=SC2034
  LEDGER=$(cat "$LEDGER_PATH" 2>/dev/null || true)
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

# A case is selected when the filter is empty, or matches its name, or matches the file it came
# from (`merge-when-green.test.sh`, or the stem `merge-when-green`).
selected() {
  local name=$1
  [[ -z "$FILTER" ]] && return 0
  [[ "$name" == *"$FILTER"* ]] && return 0
  [[ -n "$CURRENT_FILE" && "$CURRENT_FILE" == *"$FILTER"* ]] && return 0
  return 1
}

test_case() {
  local name=$1; shift
  NAMES+=("$name")
  selected "$name" || return 0
  RAN=$((RAN+1))
  CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"
  else FAIL=$((FAIL+1)); FAILED+=("$name"); echo "FAIL $name"; fi
}

# ---- tests ---------------------------------------------------------------------------------
# `PO_TEST_RUN_SH` tells the sourced files they are being sourced by this runner and not run
# directly (#1124: `bash scripts/po/test/merge-when-green.test.sh` printed 200 lines of
# `test_case: command not found` and exited 0).
export PO_TEST_RUN_SH=1
for t in "$HERE"/*.test.sh; do
  CURRENT_FILE=$(basename "$t")
  # shellcheck source=/dev/null
  source "$t"
done
CURRENT_FILE=""

echo
echo "passed: $PASS  failed: $FAIL  (of ${#NAMES[@]} defined)"
if [[ $FAIL -gt 0 ]]; then printf '  - %s\n' "${FAILED[@]}"; exit 1; fi

# **Nothing ran is a failure** (#1124). Reported last so the count above is still visible, and
# with the available names, because "no match" without "here is what exists" just moves the
# guessing one step along.
if [[ $RAN == 0 ]]; then
  echo
  echo "run.sh: フィルタ [$FILTER] に当たるテストが 0 件でした（定義 ${#NAMES[@]} 件、実行 0 件）。" >&2
  echo "  **0 件実行は緑ではありません。** フィルタはテスト名、または *.test.sh のファイル名に当たります。" >&2
  echo "  当たるもの:" >&2
  printf '    %s\n' "${NAMES[@]}" >&2
  exit 1
fi
