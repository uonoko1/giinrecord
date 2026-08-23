#!/usr/bin/env bash
# Tests for scripts/ci/released-ref.sh (Issue #134): `resolve` prints the ref deploy-data.yml should build
# (refs/tags/released if the remote has it, else main) and `overlay` replaces data/ with data/ from another ref.
# Runs against a throw-away git repo + bare "origin" under mktemp (no network).
#   bash scripts/ci/test/released-ref.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../released-ref.sh"
PASS=0; FAIL=0
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_eq() { [[ "$2" == "$1" ]] || fail "$3: expected [$1] got [$2]"; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in: $1"; }
test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

# make_repo → bare $TMP/remote with main: commit A (data/a.json=1, data/old.json, src=1)
#             then commit B (data/a.json=2, +data/new.json, -data/old.json, src=2). Sets $A / $B.
make_repo() {
  rm -rf "$TMP/remote" "$TMP/src" "$TMP/work"
  git init -q -b main "$TMP/src"
  ( cd "$TMP/src"
    mkdir -p data src
    echo 1 > data/a.json; echo 1 > src/app.ts; echo stale > data/old.json
    git add -A && git commit -qm A
    echo 2 > data/a.json; echo new > data/new.json; git rm -q data/old.json; echo 2 > src/app.ts
    git add -A && git commit -qm B )
  git clone -q --bare "$TMP/src" "$TMP/remote"
  A=$(git -C "$TMP/src" rev-parse HEAD~1); B=$(git -C "$TMP/src" rev-parse HEAD)
}
tag_released() { git -C "$TMP/src" tag -f released "$1" >/dev/null; git -C "$TMP/src" push -q -f "$TMP/remote" refs/tags/released; }
# checkout <ref> → $TMP/work is a depth-1 checkout of <ref> with remote origin (what actions/checkout produces)
checkout() {
  rm -rf "$TMP/work"; git init -q "$TMP/work"
  git -C "$TMP/work" remote add origin "$TMP/remote"
  git -C "$TMP/work" fetch -q --depth=1 origin "$1" && git -C "$TMP/work" checkout -q FETCH_HEAD
}
run() { set +e; OUT=$(cd "$TMP/work" && bash "$SCRIPT" "$@" 2>&1); STATUS=$?; set -e; }

t_resolve_main_without_tag() {
  make_repo; checkout main; run resolve
  assert_eq 0 "$STATUS" "exit"; assert_eq main "$OUT" "prints main"
}
t_resolve_tag_sha() {
  make_repo; tag_released "$A"; checkout main; run resolve
  assert_eq 0 "$STATUS" "exit"; assert_eq "$A" "$OUT" "prints the tagged sha"
}
t_overlay_replaces_data_only() {
  make_repo; tag_released "$A"; checkout "$A"; run overlay main
  assert_eq 0 "$STATUS" "exit: $OUT"
  assert_eq 2 "$(cat "$TMP/work/data/a.json")" "data updated from main"
  assert_eq new "$(cat "$TMP/work/data/new.json")" "file added on main appears"
  [[ ! -e "$TMP/work/data/old.json" ]] || fail "file deleted on main must not survive"
  assert_eq 1 "$(cat "$TMP/work/src/app.ts")" "code stays at the released ref"
  assert_eq "$B" "$(tail -c 41 <<< "$OUT" | tr -d '\n')" "prints the sha data/ came from"
}
t_overlay_noop_when_empty() {
  make_repo; checkout "$A"; run overlay ""
  assert_eq 0 "$STATUS" "exit"; assert_eq 1 "$(cat "$TMP/work/data/a.json")" "data untouched"
  assert_contains "$OUT" "skip" "says it skipped"
}
t_overlay_fails_on_missing_ref() {
  make_repo; checkout "$A"; run overlay nope
  [[ $STATUS != 0 ]] || fail "must fail on an unknown ref"
  assert_eq 1 "$(cat "$TMP/work/data/a.json")" "data untouched on failure"
}
t_usage() { make_repo; checkout main; run bogus; [[ $STATUS != 0 ]] || fail "unknown command must fail"; assert_contains "$OUT" "usage" "usage"; }

test_case "resolve → main when refs/tags/released is absent" t_resolve_main_without_tag
test_case "resolve → sha of refs/tags/released when present" t_resolve_tag_sha
test_case "overlay main → data/ becomes main's (adds+deletes), code untouched" t_overlay_replaces_data_only
test_case "overlay '' → no-op" t_overlay_noop_when_empty
test_case "overlay <unknown ref> → fails, data untouched" t_overlay_fails_on_missing_ref
test_case "unknown command → usage" t_usage
echo "passed $PASS, failed $FAIL"; [[ $FAIL == 0 ]]
