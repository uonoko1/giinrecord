#!/usr/bin/env bash
# Tests for scripts/ci/shellcheck.sh (Issue #154): one list of shell targets shared by CI and local runs.
# `--list` enumerates every *.sh and every extensionless file with a bash/sh shebang under scripts/ and
# deploy/ (node_modules ignored); the default mode passes that list to shellcheck -x. Runs against a
# throw-away tree under mktemp with a stub shellcheck on PATH.
#   bash scripts/ci/test/shellcheck.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../shellcheck.sh"
REPO=$(cd "$HERE/../../.." && pwd)
PASS=0; FAIL=0
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_eq() { [[ "$2" == "$1" ]] || fail "$3: expected [$1] got [$2]"; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in: $1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "$3: expected NOT to contain [$2] in: $1"; }
test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

# make_tree → $TMP/tree with the shapes the enumeration must handle
make_tree() {
  local t="$TMP/tree"; rm -rf "$t"
  mkdir -p "$t/scripts/po/test/fake-bin" "$t/scripts/ci" "$t/deploy/monitor" "$t/deploy/node_modules/x" "$t/apps"
  echo 'echo hi' > "$t/scripts/ci/a.sh"                                    # .sh without shebang → still a target
  printf '#!/usr/bin/env bash\necho x\n' > "$t/deploy/monitor/run.sh"
  printf '#!/usr/bin/env bash\necho gh\n' > "$t/scripts/po/test/fake-bin/gh" # extensionless, bash shebang
  printf '#!/bin/sh\necho s\n' > "$t/deploy/posix"                          # extensionless, sh shebang
  printf '#!/usr/bin/env node\nconsole.log(1)\n' > "$t/scripts/po/tool"     # other interpreter → not a target
  echo 'plain text' > "$t/deploy/README.md"
  printf '#!/usr/bin/env bash\n' > "$t/deploy/node_modules/x/skip.sh"       # node_modules → ignored
  printf '#!/usr/bin/env bash\n' > "$t/apps/outside.sh"                     # outside scripts/ and deploy/
  mkdir -p "$t/bin"
  cat > "$t/bin/shellcheck" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$STUB_LOG"
exit "${STUB_EXIT:-0}"
STUB
  chmod +x "$t/bin/shellcheck"
}

run_list() { LIST=$(cd "$TMP/tree" && bash "$SCRIPT" --list); }

t_list_contents() {
  make_tree; run_list
  assert_eq "deploy/monitor/run.sh
deploy/posix
scripts/ci/a.sh
scripts/po/test/fake-bin/gh" "$LIST" "sorted, relative, exactly the shell files"
}

t_list_excludes() {
  make_tree; run_list
  assert_not_contains "$LIST" "node_modules" "node_modules skipped"
  assert_not_contains "$LIST" "scripts/po/tool" "non-shell shebang skipped"
  assert_not_contains "$LIST" "README" "non-script skipped"
  assert_not_contains "$LIST" "apps/" "only scripts/ and deploy/"
}

t_runs_shellcheck_with_list() {
  make_tree
  set +e
  ( cd "$TMP/tree" && PATH="$TMP/tree/bin:$PATH" STUB_LOG="$TMP/args" bash "$SCRIPT" ) > "$TMP/out" 2>&1
  local status=$?
  set -e
  assert_eq 0 "$status" "exit"
  assert_eq "-x
deploy/monitor/run.sh
deploy/posix
scripts/ci/a.sh
scripts/po/test/fake-bin/gh" "$(cat "$TMP/args")" "shellcheck -x <targets>"
}

t_propagates_failure() {
  make_tree
  set +e
  ( cd "$TMP/tree" && PATH="$TMP/tree/bin:$PATH" STUB_LOG="$TMP/args" STUB_EXIT=1 bash "$SCRIPT" ) > "$TMP/out" 2>&1
  local status=$?
  set -e
  assert_eq 1 "$status" "non-zero exit from shellcheck propagates"
}

t_real_repo_matches_ci_globs() {
  # The list in this repo must cover everything the former ci.yml globs did (and the real fake-bin/gh).
  local list; list=$(cd "$REPO" && bash "$SCRIPT" --list)
  local f
  for f in scripts/po/*.sh scripts/po/test/run.sh scripts/po/test/fake-bin/gh scripts/po/test/*.test.sh \
           scripts/ci/*.sh scripts/ci/test/*.sh scripts/*.sh deploy/*.sh deploy/analytics/*.sh deploy/monitor/*.sh deploy/test/*.sh; do
    [[ -e "$REPO/$f" ]] || continue
    assert_contains "$list"$'\n' "$f"$'\n' "covers $f"
  done
}

test_case "--list: every *.sh and bash/sh-shebang file under scripts/ and deploy/" t_list_contents
test_case "--list: node_modules, other interpreters, non-scripts, other dirs excluded" t_list_excludes
test_case "default: runs shellcheck -x with the list" t_runs_shellcheck_with_list
test_case "default: shellcheck failure fails the script" t_propagates_failure
test_case "real repo: list covers the former ci.yml globs" t_real_repo_matches_ci_globs
echo "$PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]
