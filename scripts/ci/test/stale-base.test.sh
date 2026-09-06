#!/usr/bin/env bash
# Tests for scripts/ci/stale-base.sh (Issue #536): a PR branched off an old `main` silently deletes the
# lines main gained in the meantime. The check is NOT "there are deletions" — deliberate deletions are
# legitimate. It is "lines that only exist on main **after** the merge-base are missing from the branch".
# Runs against throw-away git repos under mktemp (no network, no gh).
#   bash scripts/ci/test/stale-base.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../stale-base.sh"
PASS=0; FAIL=0
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_eq() { [[ "$2" == "$1" ]] || fail "$3: expected [$1] got [$2]"; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in: $1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "$3: expected NOT to contain [$2] in: $1"; }
test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

W="$TMP/work"
g() { git -C "$W" "$@"; }
commit() { g add -A; g commit -qm "$1"; }
# new_repo → $W with `main` at a commit holding docs/WORKING_AGREEMENT.md (a bullet list, like the real one)
new_repo() {
  rm -rf "$W"; git init -q -b main "$W"
  mkdir -p "$W/docs" "$W/src"
  printf -- '- **教訓 A**\n- **教訓 B**\n- **教訓 C**\n' > "$W/docs/WORKING_AGREEMENT.md"
  printf 'export const a = 1;\nexport const b = 2;\n' > "$W/src/app.ts"
  commit base
  # `origin/main` is what CI compares against; make it a real remote-tracking ref
  g update-ref refs/remotes/origin/main main
}
# main_moves <text...> → append lines to docs/WORKING_AGREEMENT.md on main and move origin/main
main_moves() {
  g checkout -q main
  printf -- '%s\n' "$@" >> "$W/docs/WORKING_AGREEMENT.md"
  commit "main adds"
  g update-ref refs/remotes/origin/main main
}
branch_from() { g checkout -q -b "$2" "$1"; }
run() { set +e; OUT=$(cd "$W" && bash "$SCRIPT" "$@" 2>&1); STATUS=$?; set -e; }

BASE_SHA=""
# stale_branch <name> → branch off the *first* commit (the stale base) and rewrite the doc wholesale,
# exactly what an agent does when it rewrites a section it read before main moved.
stale_branch() {
  branch_from "$BASE_SHA" "$1"
  printf -- '- **教訓 A**\n- **教訓 B**\n- **教訓 C**\n- **教訓 私**\n' > "$W/docs/WORKING_AGREEMENT.md"
  commit "my lesson"
}

# --- 1. the case this exists for -------------------------------------------------------------
t_stale_base_deleting_main_lines_fails() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X（PO がその日書いた）**' '- **教訓 Y**'
  stale_branch topic
  run
  assert_eq 1 "$STATUS" "exit 1"
  assert_contains "$OUT" "docs/WORKING_AGREEMENT.md" "names the file"
  assert_contains "$OUT" "教訓 X（PO がその日書いた）" "names the lost line"
  assert_contains "$OUT" "教訓 Y" "names every lost line, not just the first"
  assert_contains "$OUT" "rebase" "says how to fix it"
}
# The trap the PO's first command fell into: a deleted line that itself starts with `-` shows up as
# `^--` in a diff, so `grep -c '^-[^-]'` counts 0. Bullet lists are exactly that shape.
t_bullet_lines_are_not_missed() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **箇条書きだけの追記**'
  stale_branch topic
  run
  assert_eq 1 "$STATUS" "exit 1"
  assert_contains "$OUT" "箇条書きだけの追記" "a lost line starting with '-' is still reported"
}
t_lost_line_starting_with_plus_is_not_missed() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '+++ これも消える'
  stale_branch topic
  run
  assert_eq 1 "$STATUS" "exit 1"
  assert_contains "$OUT" "+++ これも消える" "a lost line starting with '+' is still reported"
}

# --- 2. legitimate PRs must pass (no false positives) -----------------------------------------
# (a) up-to-date base, pure addition
t_fresh_base_addition_passes() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**'
  branch_from main topic
  printf -- '- **教訓 私**\n' >> "$W/docs/WORKING_AGREEMENT.md"; commit mine
  run
  assert_eq 0 "$STATUS" "exit 0: $OUT"
}
# (b) up-to-date base, deliberate deletion (refactor: a check that is no longer needed)
t_fresh_base_deletion_passes() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**'
  branch_from main topic
  printf -- '- **教訓 X**\n' > "$W/docs/WORKING_AGREEMENT.md"   # drops A/B/C on purpose
  g rm -q src/app.ts
  commit "refactor: drop what we no longer need"
  run
  assert_eq 0 "$STATUS" "exit 0 (deliberate deletion is legitimate): $OUT"
}
# (c) stale base, but the branch only touches files main did not touch
t_stale_base_untouched_files_passes() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**'
  branch_from "$BASE_SHA" topic
  printf 'export const c = 3;\n' > "$W/src/app.ts"; commit "unrelated file"
  run
  assert_eq 0 "$STATUS" "exit 0 (behind main is fine when nothing is lost): $OUT"
}
# (d) stale base, same file, but the branch appends below what it saw and main's lines survive a merge
t_stale_base_deleting_only_its_own_base_lines_passes() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**'
  branch_from "$BASE_SHA" topic
  printf -- '- **教訓 A**\n' > "$W/docs/WORKING_AGREEMENT.md"    # deletes B and C, which it DID see
  commit "drop B and C on purpose"
  run
  assert_eq 0 "$STATUS" "exit 0 (only lines present at the merge-base were removed): $OUT"
}
# (e) two branches independently write the same new line: main's line is present, nothing is lost
t_same_line_added_on_both_sides_passes() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**'
  branch_from "$BASE_SHA" topic
  printf -- '- **教訓 A**\n- **教訓 B**\n- **教訓 C**\n- **教訓 X**\n' > "$W/docs/WORKING_AGREEMENT.md"
  commit "same line, written independently"
  run
  assert_eq 0 "$STATUS" "exit 0: $OUT"
}
# (f) main deleted a file; the branch is stale and still has it. Nothing of main's is lost.
t_main_deleted_a_file_passes() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  g checkout -q main; g rm -q src/app.ts; commit "main removes app.ts"; g update-ref refs/remotes/origin/main main
  branch_from "$BASE_SHA" topic
  printf -- '- **教訓 私**\n' >> "$W/docs/WORKING_AGREEMENT.md"; commit mine
  run
  assert_eq 0 "$STATUS" "exit 0: $OUT"
}

# --- 3. the fix has to work ---------------------------------------------------------------------
t_rebase_makes_it_pass() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**'
  stale_branch topic
  run; assert_eq 1 "$STATUS" "fails before the rebase"
  # what the message tells you to do
  g rebase -q origin/main >/dev/null 2>&1 || g rebase --abort 2>/dev/null || true
  if g diff --quiet origin/main topic 2>/dev/null; then :; fi
  # resolve the conflict the way a rebase does when both sides appended: keep both
  if [[ -e "$W/.git/rebase-merge" || -e "$W/.git/rebase-apply" ]]; then
    printf -- '- **教訓 A**\n- **教訓 B**\n- **教訓 C**\n- **教訓 X**\n- **教訓 私**\n' > "$W/docs/WORKING_AGREEMENT.md"
    g add -A; GIT_EDITOR=true g rebase --continue >/dev/null 2>&1 || true
  fi
  run
  assert_eq 0 "$STATUS" "exit 0 after the rebase: $OUT"
}

# --- 4. the check itself -------------------------------------------------------------------------
t_reports_the_deletion_count_it_measured() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**' '- **教訓 Y**'
  stale_branch topic
  run
  assert_contains "$OUT" "2" "prints how many lines it found"
}
t_base_ref_can_be_overridden() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**'
  stale_branch topic
  run main
  assert_eq 1 "$STATUS" "an explicit base ref works too: $OUT"
}
t_missing_base_ref_is_an_error_not_a_pass() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**'
  stale_branch topic
  run refs/heads/does-not-exist
  [[ $STATUS != 0 ]] || fail "an unresolvable base must not be reported as clean"
  assert_contains "$OUT" "does-not-exist" "names the ref it could not resolve"
}

test_case "古い main から切って、その後 main が足した行を消す枝 → 落ちる" t_stale_base_deleting_main_lines_fails
test_case "消える行が '- ' で始まっても検出する（^-- で除外されない）" t_bullet_lines_are_not_missed
test_case "消える行が '+' で始まっても検出する" t_lost_line_starting_with_plus_is_not_missed
test_case "土台が最新で追記だけ → 通る" t_fresh_base_addition_passes
test_case "土台が最新で意図した削除（リファクタ・ファイル削除） → 通る" t_fresh_base_deletion_passes
test_case "土台は古いが main が触っていないファイルだけ → 通る" t_stale_base_untouched_files_passes
test_case "土台は古いが、消したのは自分が見た行だけ → 通る" t_stale_base_deleting_only_its_own_base_lines_passes
test_case "両方が同じ行を独立に足した → 通る" t_same_line_added_on_both_sides_passes
test_case "main がファイルを消した（枝はまだ持っている） → 通る" t_main_deleted_a_file_passes
test_case "rebase すれば通る" t_rebase_makes_it_pass
test_case "見つけた行数を出す" t_reports_the_deletion_count_it_measured
test_case "base ref を引数で渡せる" t_base_ref_can_be_overridden
test_case "base ref が解決できないときは通さない" t_missing_base_ref_is_an_error_not_a_pass
echo "passed $PASS, failed $FAIL"; [[ $FAIL == 0 ]]
