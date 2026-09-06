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
  mkdir -p "$t/bin" "$t/no-shellcheck-bin"
  # A PATH with the tools the script needs but no shellcheck. (Emptying PATH would remove bash itself and
  # test the wrong thing -- the first attempt did exactly that and reported "bash: command not found".)
  local tool tool_path
  for tool in bash find head grep sed sort cat; do
    tool_path=$(command -v "$tool") && ln -sf "$tool_path" "$t/no-shellcheck-bin/$tool"
  done
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

t_rejects_versions_sharing_a_prefix() {
  # #504: "fixed the name" is not "fixed the value". Found by mutation: replacing the comparison with a
  # prefix match ([[ $found != $PINNED* ]]) kept all 11 tests green, yet a shellcheck reporting
  # "0.11.0-rc1-..." then linted all 64 targets. A version string that merely *starts with* the pin is a
  # different shellcheck, so the match has to be the whole string.
  make_tree
  local bogus
  for bogus in "$PINNED-rc1" "$PINNED.1" "0$PINNED"; do
    rm -f "$TMP/args"
    set +e
    ( cd "$TMP/tree" && PATH="$TMP/tree/bin:$PATH" STUB_LOG="$TMP/args" STUB_VERSION="$bogus" \
        bash "$SCRIPT" ) >/dev/null 2>&1
    local status=$?
    set -e
    assert_eq 3 "$status" "exit 3 for [$bogus]"
    if [[ -e "$TMP/args" ]]; then fail "[$bogus] was allowed to lint"; fi
  done
}

t_missing_shellcheck_says_so() {
  # Not "exit 127 from set -e" -- the person who has never installed it must be told what to install.
  make_tree
  set +e
  local out status
  out=$( cd "$TMP/tree" && PATH="$TMP/tree/no-shellcheck-bin" bash "$SCRIPT" 2>&1 )
  status=$?
  set -e
  assert_eq 3 "$status" "exit 3 when shellcheck is absent"
  assert_contains "$out" "$PINNED" "names the version to install"
  assert_contains "$out" "docs/ops/shellcheck.md" "points at the install instructions"
}

# Mutation M6 (measured 2026-09-07): deleting the `curl` that installs shellcheck from ci.yml leaves all
# 12 tests green, and that survival is deliberate rather than a hole. It is not a silent pass: the runner's
# own shellcheck is then a different version, so the very next step exits 3 and CI goes red (verified by
# running shellcheck.sh with 0.9.0 on PATH). The design is fail-closed, so "the install step is missing"
# and "the wrong version linted the repo" cannot be confused -- only the first can happen, and it is loud.
t_ci_installs_from_the_script() {
  # CI must install the version *this script* names, not a number retyped into the workflow: a second copy
  # would drift, and #552 is precisely about two places disagreeing about a version. So the assertion is
  # that ci.yml asks the script (`--pinned-version`) and does not hardcode any shellcheck-v<x.y.z>.
  local wf="$REPO/.github/workflows/ci.yml" body
  body=$(grep -v '^\s*#' "$wf")   # comments may quote versions while explaining why (0.9.0/0.11.0)
  assert_contains "$body" "shellcheck.sh --pinned-version" "ci.yml reads the version from the script"
  if printf '%s' "$body" | grep -qE 'shellcheck-v[0-9]+\.[0-9]+\.[0-9]+'; then
    fail "ci.yml hardcodes a shellcheck version instead of reading it from scripts/ci/shellcheck.sh"
  fi
  # ...and the download must actually be pinned to that version, not a floating "latest".
  if printf '%s' "$body" | grep -q 'shellcheck.*latest'; then
    fail "ci.yml installs a floating 'latest' shellcheck"
  fi
  # The whole "we do not need to pin the install step, because the next step exits 3 on a wrong version"
  # argument rests on that exit 3 reaching CI as a red. Two one-line edits break it and stay green:
  # `bash scripts/ci/shellcheck.sh || true` and `continue-on-error: true` on the step. Both were measured
  # to let 0.9.0 lint the repo with the job still green (#552 review).差分1行で通る変異は、
  # 差分20行の変異よりずっと危険 (#507) — so the swallow is what gets pinned, not the install.
  if printf '%s' "$body" | grep -E 'shellcheck\.sh([^-]|$)[^|]*\|\|[[:space:]]*(true|:)'; then
    fail "ci.yml swallows shellcheck's exit status (|| true / || :) — a wrong version would lint silently"
  fi
  if printf '%s' "$body" | grep -q 'continue-on-error'; then
    fail "ci.yml uses continue-on-error — shellcheck's exit 3 would not turn the job red"
  fi
}

t_pin_is_documented() {
  # #552 asks for the update procedure to be written down, and for it to name the pinned version, so that
  # a bump that skips the doc is visible.
  local doc="$REPO/docs/ops/shellcheck.md"
  [[ -f $doc ]] || { fail "docs/ops/shellcheck.md is missing"; return; }
  assert_contains "$(cat "$doc")" "$PINNED" "the doc names the pinned version"
}

# #571: pinning the version number is not pinning the bytes. GitHub Releases assets can in principle be
# replaced (e.g. a compromised maintainer account), and this binary is placed in /usr/local:bin as root and
# then fed the whole repository. A sha256 check closes that gap.
SHA256=$(cd "$REPO" && bash scripts/ci/shellcheck.sh --pinned-sha256)

t_pinned_sha256_is_a_sha256() {
  # --pinned-sha256 prints exactly one 64-hex-digit checksum and nothing else.
  assert_eq 1 "$(printf '%s\n' "$SHA256" | wc -l)" "one line"
  [[ $SHA256 =~ ^[0-9a-f]{64}$ ]] || fail "64 lowercase hex digits: got [$SHA256]"
}

t_download_url_is_pinned_to_github_and_the_version() {
  # #571 review's mutation F: swapping the download host (e.g. an attacker-controlled mirror) must be
  # something a test can catch, not just something curl happens to fail on today. --download-url is the
  # one place the URL is built, so assert it is anchored to github.com/koalaman/shellcheck and to the
  # pinned version (not just interpolated blindly).
  local url; url=$(cd "$REPO" && bash scripts/ci/shellcheck.sh --download-url)
  assert_contains "$url" "https://github.com/koalaman/shellcheck/releases/download/v$PINNED/" \
    "download URL is pinned to the official releases host and the pinned version"
  assert_contains "$url" "shellcheck-v$PINNED.linux.x86_64.tar.xz" "download URL names the pinned asset"
}

t_ci_verifies_sha256_before_using_the_binary() {
  # The whole point: ci.yml must check the downloaded tarball's sha256 against the value this script names,
  # and must do so with something that actually fails the step on mismatch (sha256sum -c, not an echo).
  local wf="$REPO/.github/workflows/ci.yml" body
  body=$(grep -v '^\s*#' "$wf")
  assert_contains "$body" "shellcheck.sh --pinned-sha256" "ci.yml reads the sha256 from the script"
  assert_contains "$body" "sha256sum -c" "ci.yml verifies the checksum with sha256sum -c"
  assert_contains "$body" "shellcheck.sh --download-url" "ci.yml reads the download URL from the script"
  if printf '%s' "$body" | grep -qE '[0-9a-f]{64}'; then
    fail "ci.yml hardcodes a sha256 instead of reading it from scripts/ci/shellcheck.sh"
  fi
}

t_ci_does_not_swallow_the_checksum_check() {
  # Same shape of hole as #552/#563: `sha256sum -c ... || true` or continue-on-error would make a mismatch
  # invisible. Look at the whole shellcheck-install step, not just the checksum line, since the swallow
  # could sit on the step or on a later line in the same run block.
  local wf="$REPO/.github/workflows/ci.yml"
  local step
  step=$(awk '/name: shellcheck \(pinned version/{p=1} p{print} p && /^      - name:/ && !/pinned version/{exit}' "$wf")
  step=$(printf '%s\n' "$step" | grep -v '^\s*#')
  assert_contains "$step" "sha256sum -c" "the install step itself runs the checksum check"
  if printf '%s' "$step" | grep -E 'sha256sum[^|]*\|\|[[:space:]]*(true|:)'; then
    fail "ci.yml swallows the sha256sum exit status (|| true / || :)"
  fi
  if printf '%s' "$step" | grep -q 'continue-on-error'; then
    fail "ci.yml uses continue-on-error on the shellcheck install step"
  fi
}

t_sha256_is_documented() {
  # Mirrors t_pin_is_documented: bumping the version must also bump the sha256, or CI breaks (fail-closed,
  # but the procedure should say so up front rather than making the next bumper discover it by a red run).
  local doc="$REPO/docs/ops/shellcheck.md"
  [[ -f $doc ]] || { fail "docs/ops/shellcheck.md is missing"; return; }
  local content; content=$(cat "$doc")
  assert_contains "$content" "$SHA256" "the doc names the pinned sha256"
  assert_contains "$content" "sha256" "the doc's bump procedure mentions updating the sha256"
}

test_case "--list: every *.sh and bash/sh-shebang file under scripts/ and deploy/" t_list_contents
test_case "--list: node_modules, other interpreters, non-scripts, other dirs excluded" t_list_excludes
test_case "default: runs shellcheck -x with the list" t_runs_shellcheck_with_list
test_case "default: shellcheck failure fails the script" t_propagates_failure
test_case "real repo: list covers the former ci.yml globs" t_real_repo_matches_ci_globs
test_case "--pinned-version: prints a single x.y.z" t_pinned_version_is_a_version
test_case "version pin: a different shellcheck is refused, and nothing is linted (#552)" t_rejects_other_version
test_case "version pin: the pinned shellcheck is accepted and lints the targets (#552)" t_accepts_pinned_version
test_case "version pin: a version that merely starts with the pin is refused too (#552/#504)" t_rejects_versions_sharing_a_prefix
test_case "version pin: a missing shellcheck says what to install (#552)" t_missing_shellcheck_says_so
test_case "version pin: ci.yml installs the version the script names, with no second copy (#552)" t_ci_installs_from_the_script
test_case "version pin: docs/ops/shellcheck.md names the pinned version (#552)" t_pin_is_documented
test_case "sha256 pin: --pinned-sha256 prints a single 64-hex checksum (#571)" t_pinned_sha256_is_a_sha256
test_case "sha256 pin: --download-url is anchored to github.com and the pinned version (#571)" t_download_url_is_pinned_to_github_and_the_version
test_case "sha256 pin: ci.yml verifies the checksum with sha256sum -c, no hardcoded copy (#571)" t_ci_verifies_sha256_before_using_the_binary
test_case "sha256 pin: ci.yml does not swallow a checksum mismatch (#571)" t_ci_does_not_swallow_the_checksum_check
test_case "sha256 pin: docs/ops/shellcheck.md names the pinned sha256 (#571)" t_sha256_is_documented
echo "$PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]
