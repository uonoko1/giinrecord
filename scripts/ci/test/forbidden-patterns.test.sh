#!/usr/bin/env bash
# Tests for scripts/ci/forbidden-patterns.sh (Issue #133). Each case builds a throw-away git repo with
# tracked files and runs the check there; nothing here touches the real repo. Test data that would itself
# trip the check (fake keys, IPs) is assembled from pieces so this file stays clean.
#   bash scripts/ci/test/forbidden-patterns.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../forbidden-patterns.sh"
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

# repo <name> → fresh git repo in $R with one clean tracked file
repo() {
  R="$TMP/$1"; mkdir -p "$R"
  git -C "$R" init -q
  echo "# clean" > "$R/README.md"
}
# add <relpath> <content> → write + git add (the check only looks at tracked/staged files)
add() { mkdir -p "$R/$(dirname "$1")"; printf '%s\n' "$2" > "$R/$1"; git -C "$R" add -f "$1"; }
# run [env assignments...] → STATUS / OUT
run() {
  set +e
  (cd "$R" && env "$@" bash "$SCRIPT") > "$TMP/out" 2>&1
  STATUS=$?
  set -e
  OUT=$(cat "$TMP/out")
}

# Pieces (so this file never contains a real-looking secret or IP)
DASH="-----"
KEY_HEADER="${DASH}BEGIN OPENSSH PRIVATE KEY${DASH}"
GH_TOKEN="ghp_$(printf 'A%.0s' $(seq 1 36))"
GH_PAT="github_pat_$(printf 'B%.0s' $(seq 1 30))"
AWS_KEY="AKIA$(printf 'C%.0s' $(seq 1 16))"
IP="203.0.113$(printf '.%s' 10)"

t_clean_repo_passes() {
  repo clean; add "src/a.ts" "export const x = 1;"
  run FORBIDDEN_PATTERNS=
  assert_eq 0 "$STATUS" "exit"
  assert_contains "$OUT" "FORBIDDEN_PATTERNS: not configured" "secret absence is logged, not fatal"
}

t_private_key_header_fails() {
  repo key; add "notes/key.txt" "$KEY_HEADER"
  run
  assert_eq 1 "$STATUS" "exit"
  assert_contains "$OUT" "notes/key.txt" "offending file named"
  assert_contains "$OUT" "private-key" "rule named"
}

t_github_tokens_fail() {
  repo gh; add "a.md" "token $GH_TOKEN"; add "b.md" "pat $GH_PAT"
  run
  assert_eq 1 "$STATUS" "exit"
  assert_contains "$OUT" "a.md" "ghp_ found"
  assert_contains "$OUT" "b.md" "github_pat_ found"
}

t_aws_key_fails() {
  repo aws; add "config.yml" "key: $AWS_KEY"
  run
  assert_eq 1 "$STATUS" "exit"
  assert_contains "$OUT" "config.yml" "AWS key id found"
}

t_tracked_env_file_fails_but_example_is_fine() {
  repo env; add ".env.example" "SITE_ORIGIN="
  run; assert_eq 0 "$STATUS" ".env.example alone passes"
  add ".env" "SECRET=x"; add "apps/web/.env.production" "SECRET=y"
  run
  assert_eq 1 "$STATUS" "exit"
  assert_contains "$OUT" ".env" "real .env named"
  assert_contains "$OUT" "apps/web/.env.production" "nested .env.* named"
  assert_not_contains "$OUT" ".env.example" "example not reported"
}

t_ip_outside_deploy_and_docs_ops_fails() {
  repo ip; add "docs/notes.md" "host is $IP"
  run
  assert_eq 1 "$STATUS" "exit"
  assert_contains "$OUT" "docs/notes.md" "IP in docs/ reported"
}

t_ip_inside_deploy_and_docs_ops_is_allowed() {
  repo ipok; add "deploy/README.md" "A record -> $IP"; add "docs/ops/deploy.md" "host $IP"
  run
  assert_eq 0 "$STATUS" "exit (deploy/ and docs/ops/ are exempt from the IP rule)"
}

t_loopback_and_versions_are_not_ips() {
  repo loop; add "src/x.ts" "http://127.0.0.1:8081 and 0.0.0.0 and v1.2.3.4 and 10.0.0.1"
  run
  assert_eq 0 "$STATUS" "exit: loopback, 0.0.0.0, private ranges and version-like strings pass"
}

t_secret_patterns_fail_and_are_not_echoed() {
  repo secret; add "docs/a.md" "see othersite.example and more"
  run FORBIDDEN_PATTERNS=$'othersite\\.example\nanother-host'
  assert_eq 1 "$STATUS" "exit"
  assert_contains "$OUT" "docs/a.md" "file named"
  assert_not_contains "$OUT" "othersite" "the pattern itself is never printed (it is the secret)"
  assert_not_contains "$OUT" "another-host" "no pattern leaks into the log"
}

t_secret_patterns_pass_when_absent() {
  repo secretok; add "docs/a.md" "nothing to see"
  run FORBIDDEN_PATTERNS=$'othersite\\.example\n\n   \nanother-host'
  assert_eq 0 "$STATUS" "exit (blank lines in the secret are ignored)"
  assert_contains "$OUT" "FORBIDDEN_PATTERNS: 2 pattern(s)" "count logged, patterns not"
}

t_secret_patterns_crlf_still_match() {
  repo crlf; add "docs/a.md" "see othersite.example here"
  run FORBIDDEN_PATTERNS=$'othersite\\.example\r\nanother-host\r\n'
  assert_eq 1 "$STATUS" "exit (CRLF line endings in the secret must not disable the check)"
  assert_contains "$OUT" "docs/a.md" "file named"
  assert_contains "$OUT" "FORBIDDEN_PATTERNS: 2 pattern(s)" "count ignores the CR"
}

t_secret_patterns_invalid_regex_is_an_error_not_clean() {
  repo badre; add "docs/a.md" "see othersite.example here"
  run FORBIDDEN_PATTERNS=$'othersite\\.example\n(unclosed['
  assert_eq 2 "$STATUS" "exit (grep error must fail the check, never report clean)"
  assert_not_contains "$OUT" "forbidden-patterns: clean" "not clean"
  assert_contains "$OUT" "grep failed" "error reported"
  assert_not_contains "$OUT" "unclosed" "the broken pattern is not echoed either"
}

t_untracked_files_are_ignored() {
  repo untracked; printf '%s\n' "$KEY_HEADER" > "$R/scratch.txt"   # not git-added
  run
  assert_eq 0 "$STATUS" "exit"
}

t_data_dir_is_skipped() {
  repo data; add "data/big.json" "{\"ip\":\"$IP\"}"
  run
  assert_eq 0 "$STATUS" "exit (data/ is the ETL output, never scanned for IPs)"
}

test_case "forbidden-patterns.sh: bash -n" bash -n "$SCRIPT"
test_case "clean repo passes; unset FORBIDDEN_PATTERNS is logged as not configured" t_clean_repo_passes
test_case "private key header → fail" t_private_key_header_fails
test_case "ghp_ / github_pat_ tokens → fail" t_github_tokens_fail
test_case "AWS access key id → fail" t_aws_key_fails
test_case "tracked .env / .env.* → fail; .env.example allowed" t_tracked_env_file_fails_but_example_is_fine
test_case "IP address outside deploy/ and docs/ops/ → fail" t_ip_outside_deploy_and_docs_ops_fails
test_case "IP address inside deploy/ or docs/ops/ → allowed" t_ip_inside_deploy_and_docs_ops_is_allowed
test_case "loopback / 0.0.0.0 / private ranges / version strings are not IPs" t_loopback_and_versions_are_not_ips
test_case "FORBIDDEN_PATTERNS hit → fail without echoing the pattern" t_secret_patterns_fail_and_are_not_echoed
test_case "FORBIDDEN_PATTERNS absent → pass; blank lines ignored" t_secret_patterns_pass_when_absent
test_case "FORBIDDEN_PATTERNS with CRLF line endings still matches" t_secret_patterns_crlf_still_match
test_case "FORBIDDEN_PATTERNS with an invalid regex → error, not clean" t_secret_patterns_invalid_regex_is_an_error_not_clean
test_case "untracked files are ignored" t_untracked_files_are_ignored
test_case "data/ is skipped" t_data_dir_is_skipped

echo; echo "passed: $PASS  failed: $FAIL"
[[ $FAIL == 0 ]]
