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
count_lines() { [[ -r "$1" ]] && wc -l < "$1" || echo 0; }
test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

W="$TMP/work"
g() { git -C "$W" "$@"; }
commit() { g add -A; g commit -qm "$1"; }
# new_repo → $W with `main` at a commit holding docs/WORKING_AGREEMENT.md (a bullet list, like the real one)
# The document is long on purpose, for two independent reasons:
#   · a three-line file makes every edit conflict, so a fixture that short would report "conflict" for
#     edits that git merge cleanly in the real 1,000-line agreement file
#   · it has to be bigger than a pipe buffer (64 KiB on Linux). `git show … | grep -q` returns 141 under
#     `set -o pipefail` only when git is still writing when grep closes the pipe. With a 40-line fixture
#     git finishes first and exits 0, so the bug is invisible — measured: the mutation that restores the
#     pipe survived 23/23 against a 40-line file and is caught by this one.
new_repo() {
  rm -rf "$W"; git init -q -b main "$W"
  mkdir -p "$W/docs" "$W/src"
  { echo "# 作業合意"; for i in $(seq 1 40); do echo "- **教訓 $i** 本文本文本文"; done
    # padding, past the pipe buffer; distinct lines so nothing here is mistaken for a duplicate
    for i in $(seq 1 3000); do echo "  埋め草 $i 本文本文本文本文本文本文本文本文本文本文本文本文本文"; done
  } > "$W/docs/WORKING_AGREEMENT.md"
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
run() { set +e; OUT=$(cd "$W" && STALE_BASE_LINES_OUT="${STALE_BASE_LINES_OUT:-}" bash "$SCRIPT" "$@" 2>&1); STATUS=$?; set -e; }

BASE_SHA=""
# stale_branch <name> → branch off the *first* commit (the stale base) and rewrite the doc wholesale,
# exactly what an agent does when it rewrites a section it read before main moved.
stale_branch() {
  branch_from "$BASE_SHA" "$1"
  g checkout -q "$BASE_SHA" -- docs/WORKING_AGREEMENT.md      # the stale reading, rewritten wholesale
  printf -- '- **教訓 私**\n' >> "$W/docs/WORKING_AGREEMENT.md"
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
  { echo "# 作業合意"; echo "- **教訓 X**"; } > "$W/docs/WORKING_AGREEMENT.md"  # drops 教訓 1..40 on purpose
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
# (d) A stale branch that ALSO deletes lines on purpose. The two kinds of deletion must be told apart:
# the 10 lines it deliberately dropped existed at the merge-base and must not be mentioned; main's line,
# which it never saw, must be. This is the distinction the whole check exists for, so it is asserted on
# the message, not just on the exit status.
t_deliberate_deletions_are_not_reported_but_the_unseen_line_is() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**'
  branch_from "$BASE_SHA" topic
  # deletes 教訓 3..12, all of which existed at the merge-base, and nowhere near main's append
  g checkout -q "$BASE_SHA" -- docs/WORKING_AGREEMENT.md
  sed -i '/^- \*\*教訓 \([3-9]\|1[0-2]\)\*\* /d' "$W/docs/WORKING_AGREEMENT.md"
  commit "drop 教訓 3..12 on purpose"
  run
  assert_eq 1 "$STATUS" "exit 1: it does not have main's line"
  assert_contains "$OUT" "教訓 X" "names the line the branch never saw"
  for i in 3 7 12; do
    assert_not_contains "$OUT" "教訓 $i**" "does NOT name 教訓 $i, deleted on purpose from what it saw"
  done
  assert_contains "$OUT" "1 行" "counts only that one line, not the 10 deliberate deletions"
}
# (e) two branches independently write the same new line: main's line is present, nothing is lost
t_same_line_added_on_both_sides_passes() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**'
  branch_from "$BASE_SHA" topic
  g checkout -q "$BASE_SHA" -- docs/WORKING_AGREEMENT.md
  printf -- '- **教訓 X**\n' >> "$W/docs/WORKING_AGREEMENT.md"
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

# --- 2b. the two severities ---------------------------------------------------------------------
# WOULD-LOSE and DIFF-DELETES are different facts and are reported as different facts. Collapsing them
# into one label would make the message say the merge drops lines it actually keeps (measured on the
# reconstructed #531 shape: `git merge --squash` kept all 50).
t_conflicting_file_is_reported_as_would_lose() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**'
  branch_from "$BASE_SHA" topic
  g checkout -q "$BASE_SHA" -- docs/WORKING_AGREEMENT.md
  printf -- '- **教訓 私**\n' >> "$W/docs/WORKING_AGREEMENT.md"   # both sides appended at the end → conflict
  commit "append at the same place"
  run
  assert_eq 1 "$STATUS" "exit 1"
  assert_contains "$OUT" "WOULD-LOSE" "a conflicting file is the severe kind"
  assert_not_contains "$OUT" "DIFF-DELETES" "and only that kind"
  assert_contains "$OUT" "三方マージが落とす: 1 行" "counts it under the merge-drops-them tally"
}
t_cleanly_merging_file_is_reported_as_diff_deletes() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**'                                        # main appends at the end
  branch_from "$BASE_SHA" topic
  g checkout -q "$BASE_SHA" -- docs/WORKING_AGREEMENT.md
  sed -i '1a - **教訓 私**' "$W/docs/WORKING_AGREEMENT.md"          # the branch edits the top → merges clean
  commit "edit far from main's change"
  run
  assert_eq 1 "$STATUS" "exit 1"
  assert_contains "$OUT" "DIFF-DELETES" "a cleanly merging file is the milder kind"
  assert_not_contains "$OUT" "WOULD-LOSE" "and only that kind"
  assert_contains "$OUT" "マージは残すが diff では削除に見える: 1 行" "counts it under the diff tally"
  # and the claim is true: the three-way merge really does keep the line
  assert_eq "1" "$(g show "$(g merge-tree --write-tree origin/main topic | head -1)":docs/WORKING_AGREEMENT.md | grep -c -- '- \*\*教訓 X\*\*')" "the merge result really keeps it"
}
# Duplicate lines are counted as a multiset: main adding a SECOND copy of a line the branch already has
# once is still a line the branch is missing. Counting distinct lines instead would report nothing.
t_a_second_copy_of_an_existing_line_counts() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 1** 本文本文本文'                            # a line identical to one already there
  branch_from "$BASE_SHA" topic
  g checkout -q "$BASE_SHA" -- docs/WORKING_AGREEMENT.md
  sed -i '1a - **教訓 私**' "$W/docs/WORKING_AGREEMENT.md"
  commit "edit far from main's change"
  run
  assert_eq 1 "$STATUS" "exit 1 — main added a second copy and the branch has only the first"
  assert_contains "$OUT" "1 行" "counts the missing copy"
}

# The conflicted-file list is matched whole-line. A substring match would let a conflicting `a.md`
# stand in for a cleanly merging `a.md.bak` and report the wrong severity for it.
t_conflicted_paths_are_matched_whole_line() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  g checkout -q main
  cp "$W/docs/WORKING_AGREEMENT.md" "$W/docs/WORKING_AGREEMENT.md.bak"
  commit "a file whose name contains another file's name"
  g update-ref refs/remotes/origin/main main
  BASE_SHA=$(g rev-parse HEAD)
  # main appends to both; only the shorter name will conflict
  g checkout -q main
  printf -- '- **教訓 X**\n' >> "$W/docs/WORKING_AGREEMENT.md"
  printf -- '- **教訓 X**\n' >> "$W/docs/WORKING_AGREEMENT.md.bak"
  commit "main appends to both"
  g update-ref refs/remotes/origin/main main
  branch_from "$BASE_SHA" topic
  g checkout -q "$BASE_SHA" -- docs/WORKING_AGREEMENT.md docs/WORKING_AGREEMENT.md.bak
  printf -- '- **教訓 私**\n' >> "$W/docs/WORKING_AGREEMENT.md"   # end of file → conflicts
  sed -i '1a - **教訓 私**' "$W/docs/WORKING_AGREEMENT.md.bak"     # top of file → merges clean
  commit "conflict in the short name, clean merge in the long one"
  run
  assert_eq 1 "$STATUS" "exit 1"
  assert_contains "$OUT" "[WOULD-LOSE] docs/WORKING_AGREEMENT.md:" "the conflicting file is WOULD-LOSE"
  assert_contains "$OUT" "[DIFF-DELETES] docs/WORKING_AGREEMENT.md.bak:" "the cleanly merging one is not"
}

# --- 3. the fix has to work ---------------------------------------------------------------------
t_rebase_makes_it_pass() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**'
  stale_branch topic
  run; assert_eq 1 "$STATUS" "fails before the rebase"
  # exactly what the message says to do
  set +e; g rebase origin/main >/dev/null 2>&1; set -e
  if [[ -e "$W/.git/rebase-merge" || -e "$W/.git/rebase-apply" ]]; then
    # resolve it the right way: keep BOTH sides (main's 教訓 X and the branch's 教訓 私)
    g checkout -q --theirs docs/WORKING_AGREEMENT.md 2>/dev/null || true
    g show "origin/main:docs/WORKING_AGREEMENT.md" > "$W/docs/WORKING_AGREEMENT.md"
    printf -- '- **教訓 私**\n' >> "$W/docs/WORKING_AGREEMENT.md"
    g add -A; GIT_EDITOR=true g rebase --continue >/dev/null 2>&1
  fi
  [[ -e "$W/.git/rebase-merge" || -e "$W/.git/rebase-apply" ]] && fail "rebase did not finish"
  run
  assert_eq 0 "$STATUS" "exit 0 after the rebase: $OUT"
  assert_contains "$(cat "$W/docs/WORKING_AGREEMENT.md")" "教訓 私" "the branch's own line survived the rebase"
}

# --- 3b. --verify: the only mode that means anything after a rebase ------------------------------
# A rebase moves the merge-base to the base tip, so the default mode asks a question whose answer is
# always "nothing gained since then" — it says ok even when every one of the base's lines is gone.
# These cases pin that: the default mode goes quiet, and --verify does not.
LINES=""
# rebase_taking_our_side → rebase onto origin/main resolving every conflict with the branch's version,
# which is what "resolve by taking my side" produces. $LINES is the file the check wrote.
rebase_taking_our_side() {
  set +e; g rebase -X theirs origin/main >/dev/null 2>&1; set -e
  if [[ -e "$W/.git/rebase-merge" || -e "$W/.git/rebase-apply" ]]; then
    g checkout -q --theirs . 2>/dev/null || true
    g add -A; GIT_EDITOR=true g rebase --continue >/dev/null 2>&1
  fi
}
t_default_mode_goes_quiet_after_a_bad_rebase_but_verify_does_not() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**' '- **教訓 Y**'
  stale_branch topic
  LINES="$TMP/lines.tsv"; STALE_BASE_LINES_OUT="$LINES" run
  assert_eq 1 "$STATUS" "fails first"
  assert_eq 2 "$(count_lines "$LINES")" "wrote both at-risk lines out"
  rebase_taking_our_side
  assert_eq 0 "$(g show HEAD:docs/WORKING_AGREEMENT.md | grep -c -- '教訓 X')" "the bad resolution really dropped main's line"
  # the default mode is now blind: the merge-base moved to the base tip
  run
  assert_eq 0 "$STATUS" "the default mode says ok even though the lines are gone"
  # --verify is not
  run --verify "$LINES"
  assert_eq 1 "$STATUS" "--verify still fails"
  assert_contains "$OUT" "教訓 X" "names the line that is gone"
  assert_contains "$OUT" "教訓 Y" "names every line that is gone"
  assert_contains "$OUT" "2 行が" "counts them"
}
t_verify_passes_when_the_rebase_kept_both_sides() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**' '- **教訓 Y**'
  stale_branch topic
  LINES="$TMP/lines.tsv"; STALE_BASE_LINES_OUT="$LINES" run
  assert_eq 1 "$STATUS" "fails first"
  # the good resolution: main's file plus the branch's own line
  set +e; g rebase origin/main >/dev/null 2>&1; set -e
  if [[ -e "$W/.git/rebase-merge" || -e "$W/.git/rebase-apply" ]]; then
    g show origin/main:docs/WORKING_AGREEMENT.md > "$W/docs/WORKING_AGREEMENT.md"
    printf -- '- **教訓 私**\n' >> "$W/docs/WORKING_AGREEMENT.md"
    g add -A; GIT_EDITOR=true g rebase --continue >/dev/null 2>&1
  fi
  run --verify "$LINES"
  assert_eq 0 "$STATUS" "--verify passes when both sides were kept: $OUT"
  assert_contains "$OUT" "2 行すべて" "says how many it checked"
}
# `git show <rev>:<path> | grep -q` returns 141 under `set -o pipefail` (grep -q closes the pipe, git
# takes SIGPIPE), which reads every present line as missing. This is a real bug that shipped for one
# commit; without a present-line case nothing notices.
t_verify_does_not_report_present_lines_as_missing() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  printf 'docs/WORKING_AGREEMENT.md\t- **教訓 1** 本文本文本文\n' >  "$TMP/present.tsv"
  printf 'docs/WORKING_AGREEMENT.md\t- **教訓 2** 本文本文本文\n' >> "$TMP/present.tsv"
  run --verify "$TMP/present.tsv"
  assert_eq 0 "$STATUS" "lines that ARE in the file must not be reported missing: $OUT"
  assert_contains "$OUT" "2 行すべて" "checked both"
}
t_verify_rejects_an_unreadable_lines_file() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  run --verify "$TMP/no-such-file.tsv"
  assert_eq 2 "$STATUS" "a missing lines file must not read as clean"
  assert_contains "$OUT" "読めません" "says it could not read it"
}
# The failure message names --verify, so the run that emits it must leave the file behind, and a later
# run that finds nothing must not wipe it — that run is exactly the post-rebase one it is written for.
t_a_later_clean_run_does_not_wipe_the_lines_file() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**'
  stale_branch topic
  LINES="$TMP/keep.tsv"; STALE_BASE_LINES_OUT="$LINES" run
  assert_eq 1 "$STATUS" "fails first"
  before=$(count_lines "$LINES")
  rebase_taking_our_side
  STALE_BASE_LINES_OUT="$LINES" run
  assert_eq 0 "$STATUS" "the default mode is quiet now"
  assert_eq "$before" "$(count_lines "$LINES")" "the evidence is still there"
  assert_contains "$OUT" "--verify" "and the ok message points at --verify"
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
# Two guards catch this — `resolve` and, behind it, `git merge-base` failing — and the second one keeps
# the exit status honest on its own. So the message is asserted too, or removing `resolve`'s check goes
# unnoticed (#500: pinning one of two paths is pinning neither).
t_missing_base_ref_is_an_error_not_a_pass() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**'
  stale_branch topic
  run refs/heads/does-not-exist
  assert_eq 2 "$STATUS" "an unresolvable base must not be reported as clean"
  assert_contains "$OUT" "does-not-exist" "names the ref it could not resolve"
  assert_contains "$OUT" "ref を解決できません" "says the ref is what it could not resolve"
  assert_contains "$OUT" "git fetch origin" "says what to run"
  assert_not_contains "$OUT" "fatal:" "does not leak a raw git error instead of its own message"
}
t_missing_head_ref_is_an_error_too() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**'
  stale_branch topic
  run main refs/heads/no-such-head
  assert_eq 2 "$STATUS" "an unresolvable head must not be reported as clean"
  assert_contains "$OUT" "no-such-head" "names the ref it could not resolve"
}

test_case "古い main から切って、その後 main が足した行を消す枝 → 落ちる" t_stale_base_deleting_main_lines_fails
test_case "消える行が '- ' で始まっても検出する（^-- で除外されない）" t_bullet_lines_are_not_missed
test_case "消える行が '+' で始まっても検出する" t_lost_line_starting_with_plus_is_not_missed
test_case "土台が最新で追記だけ → 通る" t_fresh_base_addition_passes
test_case "土台が最新で意図した削除（リファクタ・ファイル削除） → 通る" t_fresh_base_deletion_passes
test_case "土台は古いが main が触っていないファイルだけ → 通る" t_stale_base_untouched_files_passes
test_case "意図した削除は名指ししない／見ていない行だけを名指しする" t_deliberate_deletions_are_not_reported_but_the_unseen_line_is
test_case "両方が同じ行を独立に足した → 通る" t_same_line_added_on_both_sides_passes
test_case "main がファイルを消した（枝はまだ持っている） → 通る" t_main_deleted_a_file_passes
test_case "衝突する側は WOULD-LOSE として出る" t_conflicting_file_is_reported_as_would_lose
test_case "きれいにマージできる側は DIFF-DELETES として出る" t_cleanly_merging_file_is_reported_as_diff_deletes
test_case "同じ行の2本目のコピーも数える（多重集合）" t_a_second_copy_of_an_existing_line_counts
test_case "衝突ファイルの一覧は行全体で照合する（部分一致にしない）" t_conflicted_paths_are_matched_whole_line
test_case "rebase すれば通る" t_rebase_makes_it_pass
test_case "悪い rebase のあと、引数なしは黙るが --verify は黙らない" t_default_mode_goes_quiet_after_a_bad_rebase_but_verify_does_not
test_case "両方残す rebase なら --verify は通る" t_verify_passes_when_the_rebase_kept_both_sides
test_case "--verify は在る行を「無い」と言わない（pipefail の 141）" t_verify_does_not_report_present_lines_as_missing
test_case "--verify は読めない一覧ファイルを通さない" t_verify_rejects_an_unreadable_lines_file
test_case "あとから通った実行が証拠ファイルを消さない" t_a_later_clean_run_does_not_wipe_the_lines_file
test_case "見つけた行数を出す" t_reports_the_deletion_count_it_measured
test_case "base ref を引数で渡せる" t_base_ref_can_be_overridden
test_case "base ref が解決できないときは通さない" t_missing_base_ref_is_an_error_not_a_pass
test_case "head ref が解決できないときも通さない" t_missing_head_ref_is_an_error_too
echo "passed $PASS, failed $FAIL"; [[ $FAIL == 0 ]]
