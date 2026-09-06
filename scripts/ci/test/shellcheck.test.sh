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
if [[ ${1:-} == --version ]]; then
  printf 'ShellCheck - shell script analysis tool\nversion: %s\n' "${STUB_VERSION:-0.0.0}"
  exit 0
fi
printf '%s\n' "$@" > "$STUB_LOG"
exit "${STUB_EXIT:-0}"
STUB
  chmod +x "$t/bin/shellcheck"
}

run_list() { LIST=$(cd "$TMP/tree" && bash "$SCRIPT" --list); }

# The pinned version the script demands (read from the repo, not retyped here: retyping it would make this
# test pass while the repo says something else).
PINNED=$(cd "$REPO" && bash scripts/ci/shellcheck.sh --pinned-version)

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
  ( cd "$TMP/tree" && PATH="$TMP/tree/bin:$PATH" STUB_LOG="$TMP/args" STUB_VERSION="$PINNED" bash "$SCRIPT" ) > "$TMP/out" 2>&1
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
  ( cd "$TMP/tree" && PATH="$TMP/tree/bin:$PATH" STUB_LOG="$TMP/args" STUB_EXIT=1 STUB_VERSION="$PINNED" bash "$SCRIPT" ) > "$TMP/out" 2>&1
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

t_pinned_version_is_a_version() {
  # --pinned-version prints exactly one x.y.z and nothing else: CI and humans both read this to install it.
  assert_eq 1 "$(printf '%s\n' "$PINNED" | wc -l)" "one line"
  [[ $PINNED =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "x.y.z: got [$PINNED]"
}

t_rejects_other_version() {
  # The whole point of #552: a different shellcheck must not silently lint the repo. 0.9.0 and 0.11.0
  # genuinely disagree (measured: `i+=1` is SC2324 from 0.10.0 on, clean in 0.9.0), so "some shellcheck
  # ran and said nothing" is not the same claim as "the pinned shellcheck said nothing".
  make_tree
  rm -f "$TMP/args"   # the stub only creates this when it is asked to lint; a stale file from an earlier
                      # test case would make "was not called" unreadable (the fixture, not the code)
  set +e
  local out status
  out=$( cd "$TMP/tree" && PATH="$TMP/tree/bin:$PATH" STUB_LOG="$TMP/args" STUB_VERSION="0.0.1-not-pinned" \
           bash "$SCRIPT" 2>&1 )
  status=$?
  set -e
  assert_eq 3 "$status" "exit 3 on a version mismatch"
  assert_contains "$out" "0.0.1-not-pinned" "says which version was found"
  assert_contains "$out" "$PINNED" "says which version is required"
  if [[ -e "$TMP/args" ]]; then fail "did not lint with the wrong version: shellcheck was invoked"; fi
}

t_accepts_pinned_version() {
  # ...and the pinned one must be accepted, or the pin would just be a way to never run shellcheck.
  make_tree
  set +e
  ( cd "$TMP/tree" && PATH="$TMP/tree/bin:$PATH" STUB_LOG="$TMP/args" STUB_VERSION="$PINNED" bash "$SCRIPT" ) >/dev/null 2>&1
  local status=$?
  set -e
  assert_eq 0 "$status" "exit 0 with the pinned version"
  assert_contains "$(cat "$TMP/args")" "deploy/posix" "linted the targets"
}

t_ci_installs_the_pinned_version() {
  # CI must install the version the script demands. If ci.yml pins 0.10.0 while the script wants 0.11.0,
  # CI fails loudly (t_rejects_other_version) rather than linting with the wrong one -- but the point of
  # this test is that a version bump touching only one of the two files is caught here, before CI.
  local wf="$REPO/.github/workflows/ci.yml"
  grep -qF "shellcheck-v$PINNED" "$wf" || fail "ci.yml does not install shellcheck-v$PINNED"
}

t_pin_is_documented() {
  # #552 asks for the update procedure to be written down, and for it to name the pinned version, so that
  # a bump that skips the doc is visible.
  local doc="$REPO/docs/ops/shellcheck.md"
  [[ -f $doc ]] || { fail "docs/ops/shellcheck.md is missing"; return; }
  assert_contains "$(cat "$doc")" "$PINNED" "the doc names the pinned version"
}

test_case "--list: every *.sh and bash/sh-shebang file under scripts/ and deploy/" t_list_contents
test_case "--list: node_modules, other interpreters, non-scripts, other dirs excluded" t_list_excludes
test_case "default: runs shellcheck -x with the list" t_runs_shellcheck_with_list
test_case "default: shellcheck failure fails the script" t_propagates_failure
test_case "real repo: list covers the former ci.yml globs" t_real_repo_matches_ci_globs
test_case "--pinned-version: prints a single x.y.z" t_pinned_version_is_a_version
test_case "version pin: a different shellcheck is refused, and nothing is linted (#552)" t_rejects_other_version
test_case "version pin: the pinned shellcheck is accepted and lints the targets (#552)" t_accepts_pinned_version
test_case "version pin: ci.yml installs the version the script demands (#552)" t_ci_installs_the_pinned_version
test_case "version pin: docs/ops/shellcheck.md names the pinned version (#552)" t_pin_is_documented
echo "$PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]
