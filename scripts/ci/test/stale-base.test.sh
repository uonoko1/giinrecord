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
TMP=$(mktemp -d); trap '__rc=$?; rm -rf "$TMP" || echo "warn: cleanup left $TMP behind (not a test failure)" >&2; exit $__rc' EXIT
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
  merged_tree=$(head -1 < <(g merge-tree --write-tree origin/main topic))
  assert_eq "1" "$(grep -c -- '- \*\*教訓 X\*\*' < <(g show "$merged_tree":docs/WORKING_AGREEMENT.md))" "the merge result really keeps it"
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

# Everyone here works in a `git worktree` (the working agreement requires it), where `.git` is a FILE,
# not a directory. `mkdir -p .git` fails there, so the default path for the at-risk lines has to come
# from git. Measured before the fix: `mkdir: cannot create directory '.git': File exists`, and the file
# the failure message points at was never written.
t_works_inside_a_git_worktree() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**'
  local wt="$TMP/wt"; rm -rf "$wt"
  g worktree add -q --detach "$wt" "$BASE_SHA" 2>/dev/null
  [[ -f "$wt/.git" ]] || fail "the fixture is not a worktree (.git must be a file)"
  ( cd "$wt" && git checkout -q "$BASE_SHA" -- docs/WORKING_AGREEMENT.md       && printf -- '- **教訓 私**\n' >> docs/WORKING_AGREEMENT.md       && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -qm "in a worktree" )
  set +e; OUT=$(cd "$wt" && bash "$SCRIPT" refs/remotes/origin/main HEAD 2>&1); STATUS=$?; set -e
  assert_eq 1 "$STATUS" "detects it from inside a worktree: $OUT"
  assert_not_contains "$OUT" "mkdir:" "does not fail to write the lines file"
  assert_contains "$OUT" "教訓 X" "names the line"
  local lines; lines=$(cd "$wt" && git rev-parse --git-dir)/stale-base-lines.tsv
  assert_eq 1 "$(count_lines "$lines")" "wrote the at-risk lines where the message says they are"
  g worktree remove --force "$wt" 2>/dev/null || true
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
# `|` を含むパス（#554 のレビューが見つけた）。`sed "s|^|$path\t|"` だとここで sed が死に、
# `set -e` のせいで**メッセージも一覧ファイルも出ないまま** exit 1 になる——落ちたことは分かるが
# 「何が危ないか」が消える。この検査がいちばん価値を出す場面で黙る形なので、見本を置く。
t_paths_with_a_pipe_still_report() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  local odd='docs/a|b.md'
  g checkout -q main
  printf -- '- **元の行**\n' > "$W/$odd"
  commit "add odd path"
  BASE_SHA=$(g rev-parse HEAD)
  printf -- '- **main が足した行**\n' >> "$W/$odd"
  commit "main adds to odd path"
  g update-ref refs/remotes/origin/main main
  branch_from "$BASE_SHA" topic
  printf -- '- **枝が足した行**\n' >> "$W/$odd"
  commit "branch adds"
  STALE_BASE_LINES_OUT="$W/lines.tsv" run
  assert_eq 1 "$STATUS" "a path with a pipe is still caught: $OUT"
  assert_contains "$OUT" "$odd" "the odd path is named in the message"
  assert_contains "$(cat "$W/lines.tsv" 2>/dev/null || echo MISSING)" "$odd" \
    "the lines file is written for a path with a pipe"
}

t_missing_head_ref_is_an_error_too() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**'
  stale_branch topic
  run main refs/heads/no-such-head
  assert_eq 2 "$STATUS" "an unresolvable head must not be reported as clean"
  assert_contains "$OUT" "no-such-head" "names the ref it could not resolve"
}

# --- #836: the branch is UP TO DATE with the base and still drops the base's lines -------------
# Measured on the real incidents: PR #832 removed 17 lines of docs/WORKING_AGREEMENT.md that #820/#824
# had added (286 lines across 3 files in total, by `--numstat` over all files), and PR #761 removed 33
# lines across 2 files that #762 had added — still absent from main today. In BOTH, the
# branch had been rebased **before it was ever pushed**, so the merge-base was already the base tip and
# `gained` was empty: the default mode printed `ok`. Nothing in refs or the API distinguishes that from
# a deliberate deletion (measured: the fork point, the author dates and the pre-force-push head are all
# destroyed or unavailable). What IS still true of both is that the PR takes more of the base's lines
# out of a file than it puts back — a NET deletion — while the file survives. That is what this mode
# measures. Over the last 60 merged PRs it fires on 4 and both real incidents are among them.
t_net_deletions_catches_a_rebased_branch_that_dropped_the_bases_lines() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**' '- **教訓 Y**'
  # the branch is a DESCENDANT of the base tip (what `git rebase` / "Update branch" leaves behind) …
  branch_from main topic
  # … and yet its copy of the file is the pre-move one plus its own line: the rebase was resolved
  # "take my side". The merge-base IS the base tip, so the default mode has nothing to compare.
  g checkout -q "$BASE_SHA" -- docs/WORKING_AGREEMENT.md
  printf -- '- **教訓 私**\n' >> "$W/docs/WORKING_AGREEMENT.md"
  commit "my lesson, main's two lines gone"
  run
  assert_eq 0 "$STATUS" "precondition: the default mode is blind here (that is the bug) — $OUT"
  run --net-deletions
  assert_eq 1 "$STATUS" "a net deletion of the base's lines must not pass: $OUT"
  assert_contains "$OUT" "docs/WORKING_AGREEMENT.md" "names the file"
  assert_contains "$OUT" "教訓 X" "names a line it is about to lose"
}

t_net_deletions_stays_quiet_for_a_rewrite_that_puts_back_at_least_as_much() {
  # A section rewritten in place (the #740 shape: a resolved decision replacing the old text) removes
  # lines but adds at least as many. That is a deliberate edit and must stay quiet, or the check fires
  # on everything and nobody reads it (measured: the naive "any deletion" rule fires on 39 of 60 PRs).
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**'
  branch_from main topic
  g checkout -q "$BASE_SHA" -- docs/WORKING_AGREEMENT.md
  printf -- '- **書き換え 1**\n- **書き換え 2**\n- **書き換え 3**\n' >> "$W/docs/WORKING_AGREEMENT.md"
  commit "rewrote the section"
  run --net-deletions
  assert_eq 0 "$STATUS" "a rewrite that adds more than it removes must stay quiet: $OUT"
}

t_net_deletions_allows_deleting_a_whole_file() {
  # Deleting a file outright is a deliberate act and is visible in `git diff --stat`; this mode is about
  # a file that SURVIVES while quietly losing the base's lines. Requiring the file to exist in head is
  # what keeps a legitimate removal from being reported here.
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**'
  branch_from main topic
  g rm -q docs/WORKING_AGREEMENT.md
  commit "drop the doc on purpose"
  run --net-deletions
  assert_eq 0 "$STATUS" "deleting the file outright is not this mode's business: $OUT"
}

t_net_deletions_is_not_confused_by_a_behind_branch() {
  # Being BEHIND main is normal and must stay quiet here too: the branch simply does not have the base's
  # newest lines yet, and a three-way merge puts them back. Firing on it would fail every open PR the
  # moment main moves — the same trap the default mode documents.
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  branch_from main topic
  printf -- '- **教訓 私**\n' >> "$W/docs/WORKING_AGREEMENT.md"
  commit "my lesson"
  main_moves '- **教訓 X**' '- **教訓 Y**' '- **教訓 Z**'
  run --net-deletions
  assert_eq 0 "$STATUS" "a branch that is merely behind main must stay quiet: $OUT"
}

t_net_deletions_counts_every_line_it_reports() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**' '- **教訓 Y**' '- **教訓 Z**'
  branch_from main topic
  g checkout -q "$BASE_SHA" -- docs/WORKING_AGREEMENT.md
  commit "all three gone"
  run --net-deletions
  assert_eq 1 "$STATUS" "three lost lines must fail: $OUT"
  assert_contains "$OUT" "3 行" "reports the number it measured, not a vague warning: $OUT"
}

t_net_deletions_rejects_an_unresolvable_ref() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  run --net-deletions refs/heads/no-such-base
  assert_eq 2 "$STATUS" "an unresolvable base must not be reported as clean"
  assert_contains "$OUT" "no-such-base" "names the ref it could not resolve"
}

# --- #836: `cut … | head -20 | sed` dies of SIGPIPE under `set -o pipefail` ---------------------
# `head -20` closes the pipe after 20 lines, `cut` takes SIGPIPE, and `set -o pipefail` makes the whole
# pipeline report 141 — `set -e` then kills the script with **no message and no lines file at all**.
# Found by running the new mode against the real PR #761, whose diff contains a 769-line woff2 blob:
# exit 141, zero bytes of output. A check that dies silently on a big file is worse than no check.
# The trigger is the SIZE of the reported list, so the fixture has to produce more than 20 lost lines
# AND enough data that `cut` is still writing when `head` exits — a 25-line file is not enough
# (measured: `cut` finishes first and exits 0, so the bug is invisible). Both modes share the spelling,
# so both are asserted here; the default mode had the same latent bug and had simply never met a file
# large enough.
# 200 lost lines is NOT enough: at 23,892 bytes `cut` finishes before `head` exits and the pipeline
# reports 0 (measured). The report has to exceed the 64 KiB pipe buffer. Measured thresholds for
# this exact line shape: 200 lines / 23,892 B → exit 0; 2,000 lines / 240,893 B → exit 141.
LOSTY=2000
t_a_long_report_does_not_die_of_sigpipe_default_mode() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  local many=(); local i
  for i in $(seq 1 $LOSTY); do many+=("- **教訓 多 $i** 本文本文本文本文本文本文本文本文本文本文本文本文本文本文本文本文"); done
  main_moves "${many[@]}"
  stale_branch topic
  run
  assert_eq 1 "$STATUS" "a long report must still fail, not die of SIGPIPE (got $STATUS)"
  assert_contains "$OUT" "$LOSTY 行" "the count survives a report longer than 20 lines: $OUT"
  assert_contains "$OUT" "ほか $((LOSTY - 20)) 行" "says how many it truncated"
}

t_a_long_report_does_not_die_of_sigpipe_net_deletions() {
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  local many=(); local i
  for i in $(seq 1 $LOSTY); do many+=("- **教訓 多 $i** 本文本文本文本文本文本文本文本文本文本文本文本文本文本文本文本文"); done
  main_moves "${many[@]}"
  branch_from main topic
  g checkout -q "$BASE_SHA" -- docs/WORKING_AGREEMENT.md
  commit "all of main's lines gone"
  run --net-deletions
  assert_eq 1 "$STATUS" "a long report must still fail, not die of SIGPIPE (got $STATUS)"
  assert_contains "$OUT" "$LOSTY 行が減り" "the count survives a report longer than 20 lines: $OUT"
}

t_net_deletions_skips_binary_files() {
  # A binary blob has no "lines"; `sort` over it produces an artifact count and the message itself comes
  # out binary (measured on the real PR #761: the woff2 subset reported "769 行が減り、762 行しか
  # 戻っていません", and `grep` on the output needed `-a` to read it). Nothing about a re-generated font
  # subset is a lost lesson, so it must not be reported at all.
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  printf 'AAAA\n\000\001\002BBBB\nCCCC\n\000DDDD\nEEEE\n' > "$W/docs/blob.bin"
  commit "add a binary file"
  g update-ref refs/remotes/origin/main main
  branch_from main topic
  printf 'AAAA\n\000\001\002BBBB\n' > "$W/docs/blob.bin"   # strictly fewer "lines": a net deletion
  commit "shrink the binary"
  run --net-deletions
  assert_eq 0 "$STATUS" "a binary file must not be reported as losing lines: $OUT"
  assert_not_contains "$OUT" "blob.bin" "does not name a binary file"
}

# --- #836: the CI wiring itself -----------------------------------------------------------------
# #504's rule: a check inside one file cannot defend that file, so the demand that CI actually RUN it
# lives here. Measured while writing this: removing the `--net-deletions` line from ci.yml left all
# 1,542 etl tests and all of this file's cases green — nothing anywhere noticed. The pr-closes tests
# record the same trap and its shape: asserting that the file NAME appears is not enough, because the
# `test -f` line keeps the name alive. Assert the line that RUNS it.
t_net_deletions_is_wired_into_ci() {
  local wf="$HERE/../../../.github/workflows/ci.yml"
  local body; body=$(cat "$wf")
  assert_contains "$body" 'bash scripts/ci/stale-base.sh --net-deletions' \
    "ci.yml が --net-deletions を実行している（#836）"
  # The default mode must stay too: --net-deletions is a SECOND check, not a replacement. The default
  # mode names the exact lines and is the only one that is exact for the un-rebased shape.
  # shellcheck disable=SC2016  # ci.yml の中の**文字どおりの**文字列を探している
  assert_contains "$body" 'bash scripts/ci/stale-base.sh "refs/remotes/origin/$BASE_REF" "$HEAD_SHA"' \
    "引数なしの検査は置き換えずに残っている（#536）"
  assert_contains "$body" 'test -f scripts/ci/stale-base.sh' \
    "スクリプトの存在自体をワークフローが要求する（#504）"
}

# --- #1162: 2 つのモードは**別の job**に在る ----------------------------------------------------
# **check-run 名は job 名である。** 同じ job の step は check run を共有するので、
# `scripts/po/merge-when-green.sh --allow-nonrequired-red` を 1 回使うと
# **その job の step が全部一緒に通る。**
#
# **`--net-deletions` は「赤いまま人が PR 本文を読んで判断する契約」の検査**
# （このファイルの上の方と `stale-base.sh:148` に書いてある。先例 #794 は赤のまま main に在る）。
# **既定モード（#536）はそうではない**——main が足した行が消えているのだから、通してはいけない。
#
# **上の `t_net_deletions_is_wired_into_ci` は、2 つの起動が ci.yml の
# どこかに在ることしか見ていない。** 同じ job に戻しても緑のままである（**実測**: #1162 の
# 実装前の main がまさにその形で、この検査は 40/40 緑だった）。**だからこれが別に要る。**
#
# job の切り出しは**インデント規則**で行う（`jobs:` の直下の深さの鍵が job 名）。
# 正規表現で YAML の構文を推測しない（作業合意「言語の構造は、その言語の実装に解かせる」の
# bash で可能な範囲——ここは「2 スペースの鍵」という単一の規則だけで足りる）。
# `run:` の中のコメントは落とさない（落とすとコマンドが切れる）。
#
# **深さ 2 のコメントは、どの job の本文でもない**（次の job の見出しコメントである）。
# **最初に書いたときはこれを前の job に数えてしまい**、`stale-base-net-deletions` の
# 見出しコメント（`--net-deletions` の語を含む）が `stale-base` の本文に混ざって、
# **この検査が落ちた**（実測: `passed 40, failed 1`）。**落ちたのは実装ではなく切り出しだった。**
# だから `in_job` は**深さ 4 以上の行だけ**で保ち、深さ 2 のコメントで一旦切る。
ci_job_body() {
  local wf=$1 job=$2
  awk -v job="$job" '
    /^jobs:[[:space:]]*$/ { in_jobs=1; next }
    in_jobs && /^[^[:space:]]/ { in_jobs=0 }
    !in_jobs { next }
    # 深さ 2 のコメント = 次の job の見出し。どの job の本文でもないので in_job を落とす。
    /^  #/ { in_job=0; next }
    /^[[:space:]]*$/ { if (in_job) print; next }
    {
      # この job ブロックの深さは 2（ci.yml の jobs: 直下）
      if ($0 ~ /^  [A-Za-z_][A-Za-z0-9_-]*:[[:space:]]*$/) {
        name=$0; sub(/^  /,"",name); sub(/:[[:space:]]*$/,"",name)
        in_job = (name == job) ? 1 : 0
        next
      }
      if (in_job) print
    }
  ' "$wf"
}

# job 本文のうち、**実行される行だけ**を返す（#1161 で踏んだ偽陽性）。
#
# **`ci_job_body` は生の行を返す**（`run:` の中身を壊さないための意図的な設計）。
# そのため下の `assert_not_contains "$sb" '--net-deletions'` は**コメント行にも当たる。**
#
# **実測（2026-10-04、#1161）**: `--data-freshness` の step を必須側の job に移し、
# その見出しコメントに「既定モードと `--net-deletions` はどちらも通った」と**事実の説明を
# 1 行書いただけ**で `passed 63, failed 1`。**コードは 1 行も変えていない。**
# しかもメッセージは「必須側の job に --net-deletions が同居している」と、**事実でないこと**を言う。
#
# **同じ偽陽性を `packages/etl/test/branch-protection-jobs.test.ts` は既に塞いでいる**
# （#1187 のレビューが見つけ、`executableLinesOf` を入れた）。**こちらの層には入っていなかった**
# ——**2 層のうち片方だけが直っていた。** 同じ規則をここにも置く。
#
# **行頭（インデントのみを除いた先頭）が `#` の行を落とす。それだけにする。**
# **行中の `#` は落とさない**——`run:` の中では `#` はシェルのコメントだが、
# `bash foo.sh --flag "a#b"` のような形もあり、**YAML の層では判定できない。**
# **落としすぎる側（偽陰性）には倒さない。**
ci_job_exec_lines() { grep -v '^[[:space:]]*#' || true; }

t_1162_two_modes_live_in_different_jobs() {
  local wf="$HERE/../../../.github/workflows/ci.yml"
  local sb nd
  # **コメント行を落とす**（上の `ci_job_exec_lines` に実測を書いた）。
  # **母数は落とす前の本文で見る**——落としすぎて空になったら、下の assert は全部
  # 「含まない」で緑になるので、`runs-on` が残っていることを先に確かめる。
  sb=$(ci_job_body "$wf" stale-base | ci_job_exec_lines)
  nd=$(ci_job_body "$wf" stale-base-net-deletions | ci_job_exec_lines)
  # 母数（#757）: 本文が取れていなければ、下の assert_not_contains は全部「含まない」で緑になる。
  # **先に「取れているか」を見る。**
  assert_contains "$sb" 'runs-on' "job stale-base の本文が取れている（取れていなければ以降は無意味）"
  assert_contains "$nd" 'runs-on' "job stale-base-net-deletions の本文が取れている"
  # **必須側（stale-base）に `--net-deletions` が在ってはいけない。**
  assert_not_contains "$sb" '--net-deletions' \
    "必須側の job に --net-deletions が同居していない（#1162。同居すると赤 1 回で両方通る）"
  # **必須外（stale-base-net-deletions）に既定モードが在ってはいけない。**
  # shellcheck disable=SC2016  # ci.yml の中の**文字どおりの**文字列を探している
  assert_not_contains "$nd" 'stale-base.sh "refs/remotes/origin/$BASE_REF"' \
    "必須外の job に既定モード（#536）が同居していない（#1162）"
  # それぞれが自分のモードを持っていること（**痩せたら落とす**、#499）。
  assert_contains "$nd" 'bash scripts/ci/stale-base.sh --net-deletions' \
    "必須外の job が --net-deletions を走らせている"
  # shellcheck disable=SC2016
  assert_contains "$sb" 'bash scripts/ci/stale-base.sh "refs/remotes/origin/$BASE_REF" "$HEAD_SHA"' \
    "必須側の job が既定モードを走らせている"
  # **割った job も自分で fetch する**（別プロセスなので、もう一方の `git fetch` は効かない）。
  assert_contains "$nd" 'git fetch --quiet origin' \
    "割った job は自分で fetch する（#1162。しないと base ref が解決できず exit 2 になる）"
  # **#504: この job だけが残った形でも no-op にならないよう、存在要求も両方に在る。**
  assert_contains "$nd" 'test -f scripts/ci/stale-base.sh' \
    "割った job もスクリプトの存在を自分で要求する（#504）"
  assert_contains "$sb" 'test -f scripts/ci/stale-base.sh' \
    "必須側の job もスクリプトの存在を要求する（#504）"
  # **両方が PR でだけ走ること**（片方の `if:` が消えると push でも走り、main への push で
  # base と head が同じになって意味を失う）。
  assert_contains "$sb" "github.event_name == 'pull_request'" "必須側は PR でだけ走る"
  assert_contains "$nd" "github.event_name == 'pull_request'" "必須外も PR でだけ走る"
}

t_net_deletions_is_not_confused_by_a_diverged_branch() {
  # The real shape of an open PR: the branch is BEHIND main (main moved on) **and** AHEAD of it (it has
  # its own commits). Comparing the head against the base TIP then counts everything main gained since
  # the fork as "lost", which is normal and is the DEFAULT mode's business, not this one.
  # Found by running this check against this very branch: it reported 620 lines across 4 files purely
  # because origin/main had moved. A check that fires on every open PR the moment main moves is a check
  # nobody reads — the exact trap stale-base.sh's own header warns about.
  # The branch must also REMOVE some of its own lines, or "added >= lost" hides the bug: with a pure
  # append the branch's own additions outnumber what main gained and the rule stays quiet by accident.
  # Measured on this branch when the bug was live: 620 lines across 4 files, all of them main's.
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  branch_from main topic
  # a normal edit: drop two of the base's own lines and add one (a net deletion of lines the branch HAD)
  g show "$BASE_SHA:docs/WORKING_AGREEMENT.md" | sed '2,3d' > "$W/docs/WORKING_AGREEMENT.md"
  printf -- '- **教訓 私**\n' >> "$W/docs/WORKING_AGREEMENT.md"
  commit "my lesson"
  main_moves '- **教訓 X**' '- **教訓 Y**' '- **教訓 Z**'   # main moves AFTER the branch was cut
  # `main_moves` leaves the repo checked out on main, so HEAD would be main and the comparison would be
  # main against itself — a fixture that silently proves nothing. Go back to the branch, and name it
  # explicitly rather than relying on the checkout.
  g checkout -q topic
  run --net-deletions origin/main topic
  assert_eq 1 "$STATUS" "precondition: it does fire, and must report only the branch's own 2 lines: $OUT"
  assert_contains "$OUT" "2 行が減り" "main's 3 new lines must NOT be counted as this branch's doing: $OUT"
  assert_not_contains "$OUT" "教訓 X" "a line main gained after the fork is the default mode's business"
}

# --- #1156: data/meta.json の fetchedAt は後退してはいけない --------------------------------------
# **実測で起きた穴**（2026-09-30）。日次 ETL が `main` に `data/` を入れたあと、分岐済みの枝を
# そのままマージすると **`data/` が丸ごと巻き戻る**。それが 4 つのゲートを全部通った:
#   引数なしの検査    main が足した行は枝に在る（枝は data/ を触っていない）        → ok
#   --net-deletions   34 行減って 34 行増える → 差し引き 0                          → ok
#   check             fetchedAt を見る検査が無い                                     → ok
#   レビュー           大きな差分に埋もれる                                          → 通った
# **行数は打ち消せるが、時刻は打ち消せない。** 実測（#1149 / #1127、2026-09-30）:
#   origin/main  "fetchedAt": "2026-09-29T23:59:47.817Z"
#   枝           "fetchedAt": "2026-09-29T00:43:05.576Z"
# `--net-deletions` は「差し引き 0」で通るので、行の数え方を変えても届かない。時刻を直接見る。
#
# write_meta <fetchedAt> — data/meta.json をその時刻で書く
write_meta() {
  mkdir -p "$W/data"
  printf '{\n "fetchedAt": "%s",\n "sessions": [200, 201]\n}\n' "$1" > "$W/data/meta.json"
}
# new_repo_with_data → main が data/meta.json を持つ状態。origin/main も動かす。
new_repo_with_data() {
  new_repo
  write_meta '2026-09-29T00:00:00.000Z'
  commit "data: 初回"
  g update-ref refs/remotes/origin/main main
}

t_freshness_stale_data_fails() {
  # #1149 / #1127 の形そのまま: main の日次 ETL が進み、枝は古い fetchedAt を持ったまま。
  new_repo_with_data; BASE_SHA=$(g rev-parse HEAD)
  branch_from main topic
  printf -- '- **教訓 私**\n' >> "$W/docs/WORKING_AGREEMENT.md"
  commit "my lesson"
  g checkout -q main
  write_meta '2026-09-29T23:59:47.817Z'          # 日次 ETL が main に入る
  commit "data: refresh"
  g update-ref refs/remotes/origin/main main
  g checkout -q topic
  run --data-freshness origin/main topic
  assert_eq 1 "$STATUS" "古い fetchedAt をマージしようとしている枝は落ちる: $OUT"
  assert_contains "$OUT" "2026-09-29T23:59:47.817Z" "母数: main 側の時刻を出す（#757）"
  assert_contains "$OUT" "2026-09-29T00:00:00.000Z" "母数: 枝側の時刻を出す（#757）"
  assert_contains "$OUT" "update-branch" "対処を検査自身が持つ（update-branch）"
  assert_contains "$OUT" "rebase" "対処を検査自身が持つ（rebase）"
}

t_freshness_data_refresh_pr_passes() {
  # ETL 自身の `data: refresh` PR。**fetchedAt が進む**ので通らなければならない。
  new_repo_with_data
  branch_from main topic
  write_meta '2026-09-30T02:02:00.000Z'
  commit "data: refresh 2026-09-30T02:02Z"
  run --data-freshness origin/main topic
  assert_eq 0 "$STATUS" "fetchedAt が進む PR は通る: $OUT"
  assert_contains "$OUT" "ok" "ok と言う"
}

t_freshness_equal_timestamp_passes() {
  # data/ を 1 行も触らない普通の PR。**偽陽性 0** でなければならない（開いている 8 本のうち 6 本がこの形）。
  new_repo_with_data
  branch_from main topic
  printf -- '- **教訓 私**\n' >> "$W/docs/WORKING_AGREEMENT.md"
  commit "my lesson"
  run --data-freshness origin/main topic
  assert_eq 0 "$STATUS" "同じ時刻なら通る: $OUT"
}

t_freshness_missing_field_is_measured_as_unmeasurable() {
  # #1158: この検査は「測れなかった」を言えなければならない。**黙って通さない。**
  # `gh` はレート制限で exit 0 とエラー文字列を返し、`jq` は null を返す——「無い」と「取れなかった」の区別が要る。
  new_repo_with_data
  branch_from main topic
  printf '{\n "sessions": [200]\n}\n' > "$W/data/meta.json"      # fetchedAt が無い
  commit "fetchedAt を落とす"
  run --data-freshness origin/main topic
  assert_eq 1 "$STATUS" "fetchedAt が無いのを ok と言わない: $OUT"
  assert_contains "$OUT" "測れません" "「測れなかった」と言う（「古くない」と扱わない）"
  # **「キーが無い」と「値が日付として読めない」は別の事実で、直し方も違う**（前者は ETL の
  # 出力側、後者は値そのもの）。だから同じ「測れません」で済ませずに、理由を名指しする。
  # **変異で確認済み**: `jq -re` を `jq -r` にすると **exit 1 は保たれる**（`null` が ISO の形の
  # 検査で弾かれて 4 を返すため）が、**メッセージが「日付として解釈できません: null」に化ける**。
  # この assert が無いと、その変異は 51 件すべて緑のまま生き残る（実測）。
  assert_contains "$OUT" "fetchedAt がありません" "「キーが無い」を「値が読めない」と混ぜない"
  assert_not_contains "$OUT" "解釈できません: null" "jq の null をそのまま値として扱っていない"
}

t_freshness_unparseable_timestamp_is_not_a_pass() {
  new_repo_with_data
  branch_from main topic
  write_meta 'きのう'
  commit "日付として読めない値"
  run --data-freshness origin/main topic
  assert_eq 1 "$STATUS" "日付として解釈できない値を ok と言わない: $OUT"
  assert_contains "$OUT" "測れません" "「測れなかった」と言う"
}

t_freshness_non_utc_offset_is_not_compared_as_a_string() {
  # **辞書順の比較が時刻順の比較になるのは、固定長・ゼロ埋め・UTC（`Z`）に限った話である。**
  # オフセット付き（`+09:00`）を通すと前提が崩れる: 下の 2 つは実際の時刻は head のほうが**古い**のに、
  # 文字列としては head のほうが**大きい**（`2026-09-30T08:00:00+09:00` = 2026-09-29T23:00Z < 23:59:47Z）。
  # だから形の検査はここを緩めてはいけない。**変異で確認済み**: `Z$` を `.*$` に緩めると
  # この case だけが落ちる（他の 50 件は全部緑のまま——`きのう` は `T…` の部分で先に弾かれるので、
  # この fixture が無いと「オフセットを通す」変異が生き残る）。
  new_repo_with_data
  g checkout -q main
  write_meta '2026-09-29T23:59:47.817Z'
  commit "data: refresh"
  g update-ref refs/remotes/origin/main main
  branch_from main topic
  write_meta '2026-09-30T08:00:00+09:00'      # = 2026-09-29T23:00:00Z、実時刻は古い。文字列では大きい
  commit "オフセット付きの時刻"
  run --data-freshness origin/main topic
  assert_eq 1 "$STATUS" "UTC 以外の綴りを文字列比較で通さない: $OUT"
  assert_contains "$OUT" "測れません" "「測れなかった」と言う（黙って通さない）"
}

t_freshness_trailing_garbage_after_the_Z_is_not_a_pass() {
  # **形の検査の末尾の `$` が効いていることを固定する**（#1156 の再レビュー）。
  # `^…Z$` の `$` を外すと、**`Z` の後ろに何が付いていても形の検査を通る。**
  # しかもその「何か」は文字列比較で**大きい**側に働くので、実時刻が巻き戻っていても
  # `head > base` になり **rc=0 で緑**になる——`+09:00` を弾く case は `Z` が
  # 無いので先に落ち、ここには届かない。
  # **実測（再レビューの XJ）**: 末尾の `$` を外す変異は、この case が無いと
  # **61 件すべて緑のまま生き残った。**
  new_repo_with_data
  g checkout -q main
  write_meta '2026-09-29T23:59:47.817Z'
  commit "data: refresh"
  g update-ref refs/remotes/origin/main main
  branch_from main topic
  # 実時刻は base と同じ瞬間だが、末尾にゴミが付いている。**文字列としては base より大きい**
  # ので、形の検査が緩むと「進んでいる」と読まれて緑になる。
  write_meta '2026-09-29T23:59:47.817Z-but-actually-rolled-back'
  commit "Z の後ろにゴミが付いた時刻"
  run --data-freshness origin/main topic
  assert_eq 1 "$STATUS" "Z の後ろのゴミを ok と言わない（末尾の \$ が効いている）: $OUT"
  assert_contains "$OUT" "測れません" "「測れなかった」と言う（黙って通さない）"
}

t_freshness_invalid_json_is_not_a_pass() {
  new_repo_with_data
  branch_from main topic
  printf '{ これは JSON ではない\n' > "$W/data/meta.json"
  commit "JSON を壊す"
  run --data-freshness origin/main topic
  assert_eq 1 "$STATUS" "JSON として読めないのを ok と言わない: $OUT"
  assert_contains "$OUT" "測れません" "「測れなかった」と言う"
}

t_freshness_no_meta_on_either_side_is_not_this_checks_business() {
  # data/meta.json がそもそも無いリポジトリ（既存フィクスチャ）では黙る。**両側に無い**のは
  # 比較の対象が無いということで、「測れなかった」ではない。
  new_repo
  branch_from main topic
  printf -- '- **教訓 私**\n' >> "$W/docs/WORKING_AGREEMENT.md"
  commit "my lesson"
  run --data-freshness origin/main topic
  assert_eq 0 "$STATUS" "両側に data/meta.json が無いなら対象外: $OUT"
}

t_freshness_base_has_meta_but_head_deleted_it_is_measured() {
  # base には在るのに head で消えている。**これは「測れなかった」**（黙って通すと、
  # data/meta.json を消すだけでこの検査を無効化できる）。
  new_repo_with_data
  branch_from main topic
  g rm -q data/meta.json
  g commit -qm "data/meta.json を消す"
  run --data-freshness origin/main topic
  assert_eq 1 "$STATUS" "head から消えているのを ok と言わない: $OUT"
  assert_contains "$OUT" "測れません" "「測れなかった」と言う"
}

t_freshness_rejects_an_unresolvable_ref() {
  new_repo_with_data
  run --data-freshness origin/nope HEAD
  assert_eq 2 "$STATUS" "解決できない ref は exit 2（ok と言わない）: $OUT"
  assert_not_contains "$OUT" "ok" "ok と言わない"
}

t_freshness_is_wired_into_ci() {
  # #504: 1 つのファイルの中の検査は、そのファイル自身を守れない。**走らせている行**を assert する
  # （名前が出ているだけでは足りない——`test -f` の行が名前を生かしてしまう）。
  local wf="$HERE/../../../.github/workflows/ci.yml"
  local body; body=$(cat "$wf")
  assert_contains "$body" 'bash scripts/ci/stale-base.sh --data-freshness' \
    "ci.yml が --data-freshness を実行している（#1156）"

  # **#1161 / #1162: 「どこかに在る」だけでは足りない。どの job に在るかが結論を変える。**
  #
  # **check-run 名は job 名である。** `--data-freshness` を
  # `stale-base-net-deletions`（`merge-when-green.sh` の `NONREQUIRED_CHECKS`）に置くと、
  # **`--allow-nonrequired-red` 1 回でこの赤も一緒に通る**——
  # **この検査が止めようとしている `data/` の巻き戻しが、フラグ 1 回で素通りする。**
  #
  # **実測（2026-10-04、本物の `merge-when-green.sh` に ci.yml 由来の check-run 名を食わせた）**:
  #   必須外 job に在るとき（#1187 マージ直後の 767fa157 の ci.yml）
  #       check-run 名 stale-base-net-deletions → rc=0、**`gh pr merge` が呼ばれた**
  #   必須側 job に在るとき（この版）
  #       check-run 名 stale-base               → rc=1、`--allow-nonrequired-red では通せません`、
  #                                                `gh pr merge` は呼ばれない
  #
  # **上の行（`body` への assert）は、この 2 つを区別できない**——
  # 起動の綴りは**どちらの job でも同じ**だからである。
  local sb nd
  sb=$(ci_job_body "$wf" stale-base | ci_job_exec_lines)
  nd=$(ci_job_body "$wf" stale-base-net-deletions | ci_job_exec_lines)
  # 母数（#757）: 本文が取れていなければ、下の 2 つは「含まない / 含む」が偶然決まる。
  assert_contains "$sb" 'runs-on' "job stale-base の本文が取れている（取れていなければ以降は無意味）"
  assert_contains "$nd" 'runs-on' "job stale-base-net-deletions の本文が取れている"
  assert_contains "$sb" 'bash scripts/ci/stale-base.sh --data-freshness' \
    "--data-freshness は**必須側**の job に在る（赤なら答えは常に rebase。#1161／#1162）"
  assert_not_contains "$nd" '--data-freshness' \
    "--data-freshness が必須外の job に在ってはいけない（--allow-nonrequired-red が通してしまう。#1162）"
}

# --- #1156 レビュー: 対象は `data/meta.json` 1 件ではない ------------------------------------------
# **レビュアーが probe 枝で実証した**（2026-09-30）。`data/meta.json` は `data/` の代表ではなかった:
# 月次の 2 本（`districts.yml` cron "0 20 1 * *" / `local-assemblies.yml` cron "0 20 4 * *"）は
# **`data/meta.json` を進めないまま**別の `meta.json` を進める。実測（`2f136cd1` は
# `data/districts/meta.json` だけを触っている）:
#   git diff --numstat origin/main <probe> -- data/  →  54  54  data/districts/meta.json
#   既定モード / --net-deletions / --data-freshness（1 件版）  すべて rc=0（素通り）
# **月次なので巻き戻る幅は 1 か月ぶん。**
#
# **この節の fixture が無いと、対象を 1 件に縮める変異が 51 件すべて緑のまま生き残る**（実測）。
#
# write_meta_at <path> <fetchedAt> — 任意の meta.json をその時刻で書く
write_meta_at() {
  mkdir -p "$W/$(dirname "$1")"
  printf '{\n "fetchedAt": "%s",\n "sessions": [200, 201]\n}\n' "$2" > "$W/$1"
}
# new_repo_with_nested_data → data/meta.json のほかに districts と assemblies を 2 件持つ。
# **本番の形（13 件）に合わせて「入れ子が在る」ことを fixture に持たせる**のが要点で、
# 1 件だけの fixture では「1 件しか見ていない」を検出できない。
new_repo_with_nested_data() {
  new_repo
  write_meta_at data/meta.json                   '2026-09-29T00:00:00.000Z'
  write_meta_at data/districts/meta.json         '2026-09-01T00:00:00.000Z'
  write_meta_at data/assemblies/pref-02/meta.json '2026-09-04T00:00:00.000Z'
  write_meta_at data/assemblies/pref-04/meta.json '2026-09-04T00:00:00.000Z'
  commit "data: 初回（入れ子つき）"
  g update-ref refs/remotes/origin/main main
}

t_freshness_counts_every_meta_json_it_saw() {
  # **母数（#757）**: 見た件数を出力に出す。「4 件見た」と「1 件しか見ていない」が
  # 区別できなければ、対象が静かに縮んでも出力は同じ顔をする。
  new_repo_with_nested_data
  branch_from main topic
  printf -- '- **教訓 私**\n' >> "$W/docs/WORKING_AGREEMENT.md"
  commit "my lesson"
  run --data-freshness origin/main topic
  assert_eq 0 "$STATUS" "全部同じ時刻なら通る: $OUT"
  assert_contains "$OUT" "4 件" "見たファイル数を出す（data/meta.json + districts + assemblies 2 件）"
}

t_freshness_catches_a_rollback_of_districts_only() {
  # **レビュアーの probe そのままの形**: `data/meta.json` は進んでいる（または同じ）のに、
  # `data/districts/meta.json` だけが巻き戻っている。**月次の更新を枝が上書きする形。**
  new_repo_with_nested_data
  branch_from main topic
  printf -- '- **教訓 私**\n' >> "$W/docs/WORKING_AGREEMENT.md"
  commit "my lesson"
  g checkout -q main
  write_meta_at data/districts/meta.json '2026-10-01T00:00:00.000Z'   # 月次が main に入る
  commit "data: districts"
  g update-ref refs/remotes/origin/main main
  g checkout -q topic
  run --data-freshness origin/main topic
  assert_eq 1 "$STATUS" "districts だけの巻き戻しも落とす: $OUT"
  assert_contains "$OUT" "data/districts/meta.json" "どのファイルが古いか名指しする"
  assert_contains "$OUT" "2026-10-01T00:00:00.000Z" "母数: main 側の時刻"
  assert_contains "$OUT" "2026-09-01T00:00:00.000Z" "母数: 枝側の時刻"
  assert_contains "$OUT" "4 件のうち 1 件" "見た件数と古い件数の両方を出す（#757）"
  assert_contains "$OUT" "update-branch" "対処を検査自身が持つ"
}

t_freshness_catches_a_rollback_of_a_nested_assembly_only() {
  # `data/assemblies/<pref>/meta.json` は**もう 1 段深い**。glob が 1 段しか見ていないと
  # ここだけが素通りする（`data/*/meta.json` だけでは当たらない）。
  new_repo_with_nested_data
  branch_from main topic
  printf -- '- **教訓 私**\n' >> "$W/docs/WORKING_AGREEMENT.md"
  commit "my lesson"
  g checkout -q main
  write_meta_at data/assemblies/pref-04/meta.json '2026-10-05T00:00:00.000Z'
  commit "data: local assemblies"
  g update-ref refs/remotes/origin/main main
  g checkout -q topic
  run --data-freshness origin/main topic
  assert_eq 1 "$STATUS" "2 段深い assemblies の巻き戻しも落とす: $OUT"
  assert_contains "$OUT" "data/assemblies/pref-04/meta.json" "入れ子のパスを名指しする"
  assert_not_contains "$OUT" "pref-02" "巻き戻っていない同階層のファイルは挙げない（偽陽性 0）"
}

t_freshness_denominator_grows_when_a_new_meta_json_appears() {
  # **列挙ではなく glob であることを固定する**（レビューの指摘: 列挙だと
  # 新しい `data/*/meta.json` が生えた瞬間に列挙漏れが穴になる = denylist の型）。
  # **新しい meta.json を足したら母数が増えること**を検査する。ここが緑のまま
  # 実装を列挙に戻すと、この case が落ちる。
  new_repo_with_nested_data
  run --data-freshness origin/main main
  assert_contains "$OUT" "4 件" "前提: いま 4 件"
  g checkout -q main
  write_meta_at data/newthing/meta.json '2026-09-29T00:00:00.000Z'
  commit "data: 新しい meta.json が生える"
  g update-ref refs/remotes/origin/main main
  run --data-freshness origin/main main
  assert_contains "$OUT" "5 件" "新しい meta.json が生えたら母数が増える（列挙ではなく glob）"
}

t_freshness_reports_every_stale_file_not_just_the_first() {
  # 複数が同時に巻き戻る形（`update-branch` を長く放置すると起こる）。**全部挙げる。**
  new_repo_with_nested_data
  branch_from main topic
  printf -- '- **教訓 私**\n' >> "$W/docs/WORKING_AGREEMENT.md"
  commit "my lesson"
  g checkout -q main
  write_meta_at data/meta.json                   '2026-09-30T00:00:00.000Z'
  write_meta_at data/districts/meta.json         '2026-10-01T00:00:00.000Z'
  write_meta_at data/assemblies/pref-02/meta.json '2026-10-05T00:00:00.000Z'
  commit "data: 日次 + 月次 2 本が入る"
  g update-ref refs/remotes/origin/main main
  g checkout -q topic
  run --data-freshness origin/main topic
  assert_eq 1 "$STATUS" "落ちる: $OUT"
  assert_contains "$OUT" "4 件のうち 3 件" "古い件数を数える（1 件で打ち切らない）"
  assert_contains "$OUT" "data/meta.json" "1 件目"
  assert_contains "$OUT" "data/districts/meta.json" "2 件目"
  assert_contains "$OUT" "data/assemblies/pref-02/meta.json" "3 件目"
}

t_freshness_nested_file_deleted_in_head_is_unmeasurable() {
  # 入れ子のファイルを消して黙らせる抜け道も塞がっていること（1 件版で塞いだのと同じ性質を、
  # 広げた後も全ファイルについて持つ）。
  new_repo_with_nested_data
  branch_from main topic
  g rm -q data/districts/meta.json
  g commit -qm "districts の meta.json を消す"
  run --data-freshness origin/main topic
  assert_eq 1 "$STATUS" "入れ子のファイルを消しても ok と言わない: $OUT"
  assert_contains "$OUT" "測れません" "「測れなかった」と言う"
  assert_contains "$OUT" "data/districts/meta.json" "どのファイルが測れないか名指しする"
}

t_freshness_wiring_does_not_narrow_to_one_file() {
  # #504 の形。**ci.yml が `--data-freshness` を呼んでいるだけでは足りない**——
  # 対象が 1 件に縮んでいないことは、スクリプト側の既定 glob が持つ。
  # ここでは「既定が `data/meta.json` 単独に戻っていない」ことを固定する
  # （実測: 既定を `data/meta.json` 1 件に縮める変異は、この case が無いと 51 件すべて緑のまま通る）。
  local sb; sb=$(cat "$HERE/../stale-base.sh")
  # 既定は**深さに依存しない正規表現**であること。`data/meta.json` 直打ちに縮んでいないこと。
  assert_contains "$sb" '([^/]+/)*meta' "既定の対象が深さに依存しない式になっている"
  assert_not_contains "$sb" 'STALE_BASE_META_RE:-^data/meta\.json$}' \
    "既定が data/meta.json 1 件に縮んでいない"
  # **シェルの glob に頼っていないこと。** クォート無しの変数を pathspec に渡すと、
  # **シェルが作業ツリーに対して先に展開する**——本番では 13 件出るので正しく見えるが、
  # ツリーを読んでいない（実体が無ければ黙って縮む）。実測でこの形を踏んだので固定する。
  #
  # **逐語で変数名まで書かない。** 最初はこの行が `--name-only "$1" -- $` を禁じていたが、
  # `df_paths` が引数を `local tree=$1` で受けるように変わった瞬間に**空振りになった**
  # （`"$1"` という綴りがソースから消えたので、禁じた形が二度と現れない＝常に緑）。
  # 見るべきは変数名ではなく「`ls-tree` に pathspec を渡していない」ことなので、
  # `--name-only` のあとに `--` が続かないことを、綴りに依存しない形で見る。
  # **コメント行は除く。** 上の解説が「こう書くと駄目」の例として
  # `git ls-tree -r -- <pathspec>` を逐語で持っているので、素朴に grep すると
  # **解説そのものに当たって常に落ちる**（実測でそうなった）。見たいのは実行される行だけ。
  local lstree_lines
  lstree_lines=$(printf '%s\n' "$sb" \
    | LC_ALL=C grep -v '^[[:space:]]*#' \
    | LC_ALL=C grep -F 'ls-tree' | LC_ALL=C grep -F ' -- ' || :)
  assert_eq "" "$lstree_lines" \
    "ls-tree に pathspec を渡していない（git の * は / を跨がず、クォート無しならシェルが作業ツリーで展開する）"
}

t_freshness_default_args_are_origin_main_and_head() {
  # **レビューの X1/X2**: 既定の引数値（`origin/main` と `HEAD`）が 1 件もテストされていない
  # ——`DF_BASE=${1:-origin/main}` / `DF_HEAD=${2:-HEAD}` を別の値に変えても全件緑だった。
  # CI は引数を明示して渡すので CI の正しさには届かないが、**手元で引数なしで叩くのが
  # 既定の使い方**なので固定する。
  new_repo_with_nested_data
  branch_from main topic
  printf -- '- **教訓 私**\n' >> "$W/docs/WORKING_AGREEMENT.md"
  commit "my lesson"
  g checkout -q main
  write_meta_at data/districts/meta.json '2026-10-01T00:00:00.000Z'
  commit "data: districts"
  g update-ref refs/remotes/origin/main main
  g checkout -q topic          # HEAD = topic（引数を渡さない）
  run --data-freshness         # 引数なし = origin/main と HEAD
  assert_eq 1 "$STATUS" "引数なしで origin/main と HEAD を比べる: $OUT"
  assert_contains "$OUT" "data/districts/meta.json" "既定の引数でも同じ答えを出す"
  assert_contains "$OUT" "origin/main" "既定の base は origin/main"
}

t_freshness_works_in_a_bare_repo_without_an_index() {
  # **作業ツリーも index も無いリポジトリで、本物の巻き戻しを見つけられること**（再レビューの (c)）。
  #
  # なぜこの fixture が要るか: `git ls-tree` を `git ls-files` に差し替える変異は、
  # ふつうの fixture では**ほぼ捕まらない**（実測 2/62、しかもその 2 件は `git` シムの
  # 副産物で、実質 0 件）。`ls-files` は index を読み、fixture では index がツリーと
  # 一致しているので**偶然同じ答えになる**。
  #
  # **bare なリポジトリでは答えが分かれる**（実測）:
  #   git ls-tree -r --name-only main   → data/meta.json, data/districts/meta.json
  #   git ls-files                      → **何も出ない（index が無い）**
  # そのため `ls-files` 版は本物の巻き戻しを
  #   「対象外 — どちらにも対象の meta.json がありません」**rc=0（緑）**
  # にする（実測）。**(a) と同型の「測れなかったが緑になる」穴。**
  # ここを固定すると、`ls-files` 化の変異が初めて本当に捕まる。
  #
  # （`git ls-files --with-tree=<tree>` ならツリーを読むので bare でも答えは一致する。
  #  つまり差し替えが**必ず**穴になるわけではないが、素朴な `ls-files` は穴になる。）
  local bare="$TMP/bare"
  rm -rf "$bare"; mkdir -p "$bare"
  # まず普通のリポジトリを作る: main が月次で districts を進め、topic は進める前の枝。
  new_repo_with_nested_data
  branch_from main topic
  g checkout -q main
  write_meta_at data/districts/meta.json '2026-10-01T00:00:00.000Z'
  commit "data: districts（月次）"
  g update-ref refs/remotes/origin/main main
  # bare に clone する。**作業ツリーも index も無い。**
  git clone -q --bare "$W" "$bare/repo.git"
  git -C "$bare/repo.git" update-ref refs/remotes/origin/main refs/heads/main
  assert_eq "true" "$(git -C "$bare/repo.git" rev-parse --is-bare-repository)" "前提: bare である"
  assert_eq "" "$(git -C "$bare/repo.git" ls-files)" "前提: index が無い（ls-files は何も見ない）"
  set +e
  OUT=$(cd "$bare/repo.git" && bash "$SCRIPT" --data-freshness refs/remotes/origin/main topic 2>&1); STATUS=$?
  set -e
  assert_eq 1 "$STATUS" "bare でも本物の巻き戻しを見つける（ツリーを読んでいる）: $OUT"
  assert_contains "$OUT" "data/districts/meta.json" "どのファイルが古いか名指しする"
  assert_not_contains "$OUT" "対象外" "「対象の meta.json がありません」と言って黙らない"
}

t_freshness_unlistable_tree_is_not_zero_targets() {
  # **`|| :` が `ls-tree` の失敗まで飲んでいないこと。**
  # `ls-tree | tr | grep || :` と一息に書くと、`grep` の「0 件」（pipefail で rc=1）を
  # 通すための `|| :` が **`ls-tree` の失敗も飲む**。すると「ツリーを列挙できなかった」が
  # 「対象 0 件」に化け、`DF_SEEN -eq 0` の枝が**「対象外」と言って exit 0** する——
  # #1158 で塞いだ「測れなかったを通さない」と同じ穴が、列挙の側に開く。
  #
  # 到達性: 本番の SHA は `df_resolve`（`rev-parse --verify <ref>^{commit}`）を通っているので、
  # ここで `ls-tree` が失敗するにはオブジェクトの欠損が要る（ref の操作では作れなかった）。
  # **だから `git` の shim で `ls-tree` だけを失敗させて、穴の有無そのものを測る。**
  new_repo_with_nested_data
  local shim="$W/.shim" real_git
  real_git=$(command -v git)
  mkdir -p "$shim"
  { echo '#!/usr/bin/env bash'
    echo '# ls-tree だけを失敗させ、ほかは本物の git に渡す shim。'
    echo '# 本物の git は絶対パスで呼ぶ（PATH 経由だと自分自身に戻って無限再帰する）。'
    # shellcheck disable=SC2016  # shim の**中身**なので、ここで展開してはいけない
    echo 'if [[ ${1:-} == ls-tree ]]; then echo "fatal: simulated object store failure" >&2; exit 128; fi'
    # shellcheck disable=SC2016  # 同じ理由。"$@" は shim が実行されるときに展開される
    printf 'exec %q "$@"\n' "$real_git"
  } > "$shim/git"
  chmod +x "$shim/git"
  set +e
  OUT=$(cd "$W" && PATH="$shim:$PATH" bash "$SCRIPT" --data-freshness origin/main main 2>&1); STATUS=$?
  set -e
  assert_eq 1 "$STATUS" "ツリーを列挙できないなら exit 1（「対象 0 件」として通さない）: $OUT"
  assert_not_contains "$OUT" "対象外" "「対象外」と言って黙らない"
  assert_not_contains "$OUT" "後退していません" "成功の断定をしない"
}

t_freshness_too_many_args_is_usage_not_a_pass() {
  # **レビューの X4**: 引数個数のガード。3 つ渡したら usage（exit 2）で、**ok と言わない**。
  new_repo_with_nested_data
  run --data-freshness origin/main main extra
  assert_eq 2 "$STATUS" "引数が多すぎるときは exit 2: $OUT"
  # `ok` の部分一致で見てはいけない: usage の `[<base-ref>]` に `ok` は無いが `--net-deletions`
  # 等の綴りに紛れる余地が在り、**部分一致は「アドレスは値として数える」の罠そのもの**。
  # この検査が言ってはいけないのは「後退していません」（成功の断定）なので、それを見る。
  assert_not_contains "$OUT" "後退していません" "成功の断定をしない"
  assert_contains "$OUT" "usage" "使い方を出す"
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

# --- #1191: 形の厳しさが比較の正しさを支えている。その関係を機械が守る ---------------------------
# **#1161 のレビューと PO が、素通りする変異を 2 件実測した**（どちらも 64/64 緑）:
#
#   ZB  `Z$` → `Z?$`（`Z` を任意にする）
#       base（origin/main）  2026-10-04T01:29:00.000Z
#       head（枝）           2026-10-04T10:00:00.000     ← Z 無しの裸の表記。JST なら UTC 01:00（28 分の後退）
#       辞書順:  "2026-10-04T10:00:00.000" < "2026-10-04T01:29:00.000Z"  → **false** → 後退を見逃す（緑）
#
#   YE  `DF_RE` の先頭の `^` を外す
#       対象が 13 件 → **15 件**になり、`apps/web/app/test-fixtures/data/meta.json` が入る。
#       この fixture の fetchedAt は `+09:00` なので「測れなかった」側に落ち、
#       **両側同値なのに全 PR が永久に赤**になる（#1147 と同じ型）。
#
# **注意（PO が最初にここで誤判定した）**: **同日・同時刻帯の Z 無しは辞書順でも小さいので検出できる。**
# 破綻するのは**時差が絡む形**——「Z 無しの値が、base より文字列として大きいが、実時刻は古い」。
# だから下の fixture は **JST を名乗る裸の表記**（UTC より 9 時間先に見える値）で測る。
# 「Z を外す変異が落ちる」だけでは母数にならない。

t_freshness_1191_naive_local_time_cannot_read_as_newer() {
  # **ZB を捕まえる case。** `Z` を任意にする変異で、**本物の巻き戻しが緑になる**ことを固定する。
  #
  # 既存の 2 case はどちらもここに届かない（#1161 レビューの実測）:
  #   · `+09:00` を弾く case  → **`Z` が無いので先に落ちて**ここに来ない（`Z?$` でも同じ）
  #   · 「`Z` の後ろのゴミ」の case → `Z?$` でも `Z` の後ろは弾かれるので何も変わらない
  # **1 か所で綴る**（`write_meta` と下の母数の判定で同じ値を使う。写すとずれる）。
  local base_t='2026-10-04T01:29:00.000Z'
  # **実時刻は base より 28 分古い**（JST 10:00 = UTC 01:00）。だが**文字列としては大きい**
  # （"10" > "01"）。形の検査が `Z` を任意にした瞬間に「進んでいる」と読まれて緑になる。
  local head_t='2026-10-04T10:00:00.000'
  new_repo_with_data
  g checkout -q main
  write_meta "$base_t"
  commit "data: refresh"
  g update-ref refs/remotes/origin/main main
  branch_from main topic
  write_meta "$head_t"
  commit "タイムゾーンの無い裸の時刻"
  run --data-freshness origin/main topic
  assert_eq 1 "$STATUS" "タイムゾーンの無い裸の時刻を ok と言わない（Z が必須。#1191）: $OUT"
  assert_contains "$OUT" "測れません" "「測れなかった」と言う（黙って通さない）"
  assert_contains "$OUT" "$head_t" "どの値が読めなかったか名指しする"
  # **母数（#757）: この fixture が「辞書順では検出できない」側であることを、この case 自身が示す。**
  # ここが真なら fixture が弱く、`Z` を任意にする変異は辞書順の比較だけで捕まってしまう
  # ——つまり**形の検査を測っていない**。PO が最初に踏んだ誤判定がこれ。
  if [[ $head_t < $base_t ]]; then
    fail "fixture が弱い: 裸の値が辞書順で base より小さい。時差ぶん大きく見える値でなければ形の検査を測れない"
  fi
}

t_freshness_1191_a_legitimate_Z_value_still_passes() {
  # **両側で判断する（#1234 の教訓）。** 片側（裸の値を弾く）を塞いで、もう片側
  # （正当な `Z` 付きが通る）を壊すのが、このリポジトリが繰り返し踏んでいる形である。
  # 形の検査を `Z` を**必須より厳しく**した（例えば `Z` を 2 つ要求する、`.` を必須にする）
  # 変異は、上の case では捕まらない——**この case が捕まえる。**
  new_repo_with_data
  g checkout -q main
  write_meta '2026-10-04T01:29:00.000Z'
  commit "data: refresh"
  g update-ref refs/remotes/origin/main main
  branch_from main topic
  write_meta '2026-10-04T02:00:00.000Z'            # 正当に進んでいる
  commit "data: refresh（枝が進める）"
  run --data-freshness origin/main topic
  assert_eq 0 "$STATUS" "正当な Z 付きの時刻は通る（厳しくしすぎていない。#1191）: $OUT"
  assert_not_contains "$OUT" "測れません" "正当な値を「測れなかった」にしない"
  # 小数部の無い形（`…:00Z`）も正当である。`(\.[0-9]+)?` の `?` を外す変異をここで捕まえる。
  new_repo_with_data
  g checkout -q main
  write_meta '2026-10-04T01:29:00Z'
  commit "data: refresh（小数部なし）"
  g update-ref refs/remotes/origin/main main
  branch_from main topic
  write_meta '2026-10-04T02:00:00Z'
  commit "data: refresh（小数部なし・進む）"
  run --data-freshness origin/main topic
  assert_eq 0 "$STATUS" "小数部の無い Z 付きも通る（#1191）: $OUT"
  assert_not_contains "$OUT" "測れません" "小数部なしを「測れなかった」にしない"
}

t_freshness_1191_lexicographic_order_equals_chronological_order() {
  # **#1189 と同じ型の穴を塞ぐ。** 「形を厳しく見ているから辞書順の比較でよい」という関係は、
  # これまで `stale-base.sh:183-185` の**コメントにしか無かった。** 形の検査が緩んだ瞬間に
  # 比較が壊れるのに、その関係式を機械が見ていなかった。
  #
  # ここで**関係式そのものを測る**: **この検査が比較に使う鍵について、
  # 辞書順の比較と実時刻の比較が一致すること。**
  # 比較用の `date -u -d` は**このテストの中だけで使う**（本番の経路には持ち込まない。
  # ロケールとエラー時の exit 0 を持ち込む分だけ弱いという `:183-185` の判断を尊重する）。
  #
  # **実装をここに写さない。** 本番の `stale-base.sh` から `df_read` と `df_cmp_key` を
  # **そのまま読み込んで**使う。逐語で写すと、本番側を緩めてもここが古い版を持ったまま
  # 緑になる（＝関係式を測れない）。
  local sb; sb=$(cat "$HERE/../stale-base.sh")
  # `df_read` の形の検査と `df_cmp_key` を、本番のソースから切り出して実行可能にする。
  # 切り出せなければ以降は無意味なので、母数（#757）として先に見る。
  local shim="$TMP/relshim.sh"
  # 形の検査の**正規表現そのもの**を本番の行から取り出す（`if` 文を書き換えるのではなく、
  # 式だけを抜く。逐語で写さないので、本番側を緩めればここも一緒に緩む＝関係式を測れる）。
  local shape_re
  # **パイプの末尾に `head` を置かない**（#527）。`pipefail` のもとで `head` が先に閉じると
  # 書き手が SIGPIPE で死に、**入力の大きさ次第で確率的に失敗する**。
  # （`stale-base.sh` 自身のヘッダが同じ罠を記録している: 40 行の fixture では再現せず、
  # パイプバッファ 64 KiB を超えて初めて出る。いまの `stale-base.sh` は 64 KiB 未満なので
  # 手元では一度も落ちなかったが、ファイルが育てば落ちる。）
  # `head` をやめて、`grep` 自身に 1 行で止めさせる。入力は here-string で渡す。
  #
  # **`-m 1` は「マッチ 1 件」ではなく「マッチした行 1 行」の上限である**（再レビュー 6。実測）:
  #     $ grep -m 1 -oE '\^\[0-9\]\{4\}[^ ]*\$' <<<'x ^[0-9]{4}-AAA$ y ^[0-9]{4}-BBB$'
  #     ^[0-9]{4}-AAA$
  #     ^[0-9]{4}-BBB$      ← **1 行から 2 行出る**
  # **いまは 1 行しか出ない**が、その根拠は `-m 1` ではなく
  # **「`stale-base.sh` の中でこの式に当たる行が 1 本しかない」**ことである
  # （2 本目が生えたら 2 行出て `DF_SHAPE_RE` の生成が壊れるが、そのときは下の probe
  # ——切り出した `df_cmp_key` が期待の鍵を返すか——が「測れていない」と言って落ちる）。
  #
  # **`set -euo pipefail` のもとで裸の `var=$(cmd)` は書けない**（再レビュー 2。PO が再現）:
  #     $ bash -c 'set -euo pipefail; x=$(grep -m1 -oE "NOPE" <<<"abc"); echo reached'
  #     （"reached" は出ない。rc=1）
  # 式が見つからない経路——つまり**本番側の形の検査が書き換わって読み出せない経路**で、
  # 下に書いてあった `fail "…読み出せなかった…"` に**一度も到達せず、
  # `passed N, failed M` のサマリ行ごと消えていた**（後続の case も走らなかった）。
  # 「測れなかったと言えない」のは #757 / #1158 で繰り返し直してきた型なので、
  # **`if !` で受けて `fail` して `return` する**（母数を必ず出す側に倒す）。
  if ! shape_re=$(LC_ALL=C grep -m 1 -oE '\^\[0-9\]\{4\}[^ ]*\$' <<<"$sb") || [[ -z $shape_re ]]; then
    fail "stale-base.sh から日付の形の正規表現を読み出せなかった（以降の判定は無意味）"; return
  fi
  {
    printf 'set -uo pipefail\n'
    # 取り出した式を、変数経由で `=~` に渡す関数にする（式の中のメタ文字は展開させない）。
    printf 'DF_SHAPE_RE=%q\n' "$shape_re"
    # shellcheck disable=SC2016  # `$1` / `$DF_SHAPE_RE` は**生成するファイルの中で**展開される
    printf 'df_shape_ok() { [[ $1 =~ $DF_SHAPE_RE ]]; }\n'
    # df_cmp_key の本体（本番の定義をそのまま取る）
    printf '%s\n' "$sb" | LC_ALL=C sed -n '/^  df_cmp_key() {$/,/^  }$/p' | LC_ALL=C sed 's/^  //'
  } > "$shim"
  # 母数（#757）: 切り出せたか。どちらかが欠けていれば、下の判定は「通る」ではなく「測れていない」。
  if ! LC_ALL=C grep -q 'df_shape_ok()' "$shim"; then
    fail "stale-base.sh から形の検査を切り出せなかった（以降の判定は無意味）"; return
  fi
  if ! LC_ALL=C grep -q 'df_cmp_key()' "$shim"; then
    fail "stale-base.sh から df_cmp_key を切り出せなかった（以降の判定は無意味）"; return
  fi
  # 切り出したものが**動くこと**も見る（sed が空振りして空の関数ができていないか）。
  local probe
  probe=$(bash -c 'source "$1"; df_shape_ok "2026-10-04T01:29:00.000Z" && df_cmp_key "2026-10-04T01:29:00.000Z"' _ "$shim" 2>&1) || probe=""
  if [[ $probe != 2026-10-04T01:29:00.000000000 ]]; then
    fail "切り出した df_cmp_key が期待の鍵を返さない（得た値: [$probe]。以降の判定は無意味）"; return
  fi

  # 候補: 正当な UTC 表記（小数部の有無・桁数を混ぜる）と、**時差ぶん大きく見える裸の表記**。
  # 裸の表記が受理されると照合が必ず破れる（辞書順と実時刻が食い違うため）。
  local cands=(
    '2026-10-04T01:29:00.000Z'
    '2026-10-04T01:29:00Z'            # ← 小数部なし。生の値で比べると .000Z と大小が逆転する
    '2026-10-04T01:29:00.5Z'
    '2026-10-04T01:29:00.500Z'
    '2026-10-04T01:29:00.999Z'
    '2026-10-04T01:29:01Z'
    '2026-10-04T02:00:00.000Z'
    '2026-10-05T00:00:00.000Z'
    '2026-10-04T10:00:00.000'         # 裸（JST なら UTC 01:00）。受理されたら関係式が破れる
    '2026-10-04T10:00:00.000+09:00'   # オフセット付き。同じく破れる
    # **桁数とセパレータが崩れた綴り**（再レビュー 1）。ここが denylist だったのが穴だった:
    # 上の 2 つは「UTC でない」形しか置いておらず、**`{2}` を `+` に緩める変異と
    # `T` を `.` に緩める変異が、本物の巻き戻しを緑で通していた**（実測 2026-10-08）:
    #   `[0-9]{2}` → `[0-9]+` : base 2026-10-04T01:29:00Z / head 2026-9-04T01:29:00Z
    #                           ＝ **1 か月の後退**が rc=0（ok と報告された）
    #   `T` → `.`             : base "2026-10-04 23:00:00Z" / head 2026-10-04T01:29:00Z
    #                           ＝ **22 時間の後退**が rc=0
    # どちらも `df_cmp_key` の `${v:0:19}` が**形の検査が長さを固定していること**に
    # 寄りかかっているために起きる（桁が崩れると 19 文字が別の場所で切れる）。
    # **これらはいまの形の検査では受理されないので `accepted` に入らず、現行は緑のまま。
    # 緩めた瞬間に受理されて関係式が破れ、赤くなる**（allowlist 側に倒した）。
    '2026-9-04T01:29:00Z'             # 月が 1 桁（`{2}`→`+` で受理。19 文字目が Z になる）
    '2026-10-04 01:29:00Z'            # T が空白（`T`→`.` で受理。' '(0x20) < 'T'(0x54)）
    '2026-10-0401:29:00Z'             # T が無い（`T`→`T?` で受理。date も読めない＝測れない側で赤）
  )
  # 受理された値だけを集める（**本番の形の検査**で判定する）。
  local accepted=() v
  for v in "${cands[@]}"; do
    if bash -c 'source "$1"; df_shape_ok "$2"' _ "$shim" "$v"; then accepted+=("$v"); fi
  done
  # 母数（#757）: 受理が 2 件未満なら比較の組が作れず、この case は何も測っていない。
  if [[ ${#accepted[@]} -lt 2 ]]; then
    fail "形の検査が受理した値が ${#accepted[@]} 件しかない（比較の組が作れない。測れていない）"; return
  fi
  # **裸の表記・オフセット付きは受理されてはいけない**（ZB の側。ここでも固定する）。
  for v in '2026-10-04T10:00:00.000' '2026-10-04T10:00:00.000+09:00'; do
    if [[ " ${accepted[*]} " == *" $v "* ]]; then
      fail "形の検査が UTC でない綴りを受理した（辞書順 = 時刻順 の前提が崩れる）: $v"
    fi
  done
  # **桁数とセパレータが崩れた綴りも受理されてはいけない**（再レビュー 1）。
  # `df_cmp_key` の `${v:0:19}` は**形の検査が長さを固定していること**に寄りかかっている。
  # 桁が崩れると 19 文字が別の場所で切れ、鍵が時刻を表さなくなる。
  # （この loop が無くても下の関係式が破れて赤くなるが、**原因が名指しで出るほうがよい**。）
  for v in '2026-9-04T01:29:00Z' '2026-10-04 01:29:00Z' '2026-10-0401:29:00Z'; do
    if [[ " ${accepted[*]} " == *" $v "* ]]; then
      fail "形の検査が桁数／セパレータの崩れた綴りを受理した（\${v:0:19} が別の場所で切れる）: $v"
    fi
  done

  # **関係式**: 受理された任意の 2 値 a, b について
  #     ( df_cmp_key a < df_cmp_key b を辞書順で判定 )  ==  ( a の実時刻 < b の実時刻 )
  local pairs=0 a b ka kb lex chrono ea eb
  for a in "${accepted[@]}"; do
    ka=$(bash -c 'source "$1"; df_cmp_key "$2"' _ "$shim" "$a")
    if ! ea=$(date -u -d "$a" +%s%N 2>/dev/null) || [[ -z $ea ]]; then
      fail "形の検査が受理した値を date が読めない（関係式を測れない）: $a"; continue
    fi
    for b in "${accepted[@]}"; do
      [[ $a == "$b" ]] && continue
      kb=$(bash -c 'source "$1"; df_cmp_key "$2"' _ "$shim" "$b")
      if ! eb=$(date -u -d "$b" +%s%N 2>/dev/null) || [[ -z $eb ]]; then continue; fi
      pairs=$((pairs+1))
      if [[ $ka < $kb ]]; then lex=lt; else lex=ge; fi
      if [[ $ea -lt $eb ]]; then chrono=lt; else chrono=ge; fi
      if [[ $lex != "$chrono" ]]; then
        fail "辞書順 = 時刻順 が破れている: [$a]($ka) vs [$b]($kb) 辞書順=$lex 実時刻=$chrono"
      fi
    done
  done
  # 母数（#757）: 比べた組の数。0 組なら上の loop は何も判定していない。
  if [[ $pairs -lt 20 ]]; then
    fail "比べた組が $pairs 件しかない（小数部の有無を混ぜた組が足りず、何も測れていない疑いが在る）"
  fi
}

t_freshness_1191_sub_second_rollback_is_detected() {
  # **関係式のテストが見つけた 3 件目の穴**（#1191 の本文には無かった。2026-10-08 実測）。
  # 形の検査は小数部を任意（`(\.[0-9]+)?`）にしているので、**小数部の有無が混ざると
  # 生の値の辞書順が時刻順から外れる**——`.`(0x2E) < `Z`(0x5A) なので:
  #   "2026-10-04T01:29:00.000Z" < "2026-10-04T01:29:00Z"   ← **同じ瞬間なのに大小が付く**
  # 実測: base `…00.500Z` / head `…00Z` は **0.5 秒の後退なのに緑**だった。
  # **穴は 1 秒未満に限られる**（秒が繰り上がれば生の比較でも検出できる）ので #1156 の
  # 日次 ETL の巻き戻しには届かないが、**不変条件は破れている。**
  # `df_cmp_key` の正規化を外す変異を、この case が捕まえる。
  # **1 か所で綴る**（`write_meta`・母数の判定・報告の assert が同じ値を使う）。
  local base_t='2026-10-04T01:29:00.500Z'
  local head_t='2026-10-04T01:29:00Z'          # **0.5 秒の後退。小数部が無い綴り**
  new_repo_with_data
  g checkout -q main
  write_meta "$base_t"
  commit "data: refresh（小数部あり）"
  g update-ref refs/remotes/origin/main main
  branch_from main topic
  write_meta "$head_t"
  commit "小数部の無い綴りで 0.5 秒戻る"
  # 母数（#757）: この fixture が「生の辞書順では検出できない」側であることを、case 自身が示す。
  # ここが検出できてしまうなら fixture が弱く、正規化を測っていない。
  if [[ $head_t < $base_t ]]; then
    fail "fixture が弱い: 生の辞書順でも検出できてしまう（正規化を測れない）"
  fi
  run --data-freshness origin/main topic
  assert_eq 1 "$STATUS" "1 秒未満の後退も検出する（固定長の鍵で比較している。#1191）: $OUT"
  assert_contains "$OUT" "古い" "後退として報告する（「測れません」ではない）"
  # **報告は生の綴りで出す**（正規化した `…000000000` を出すと、利用者が data/meta.json を
  # grep して突き合わせられない。比較用と表示用を分けてある）。
  assert_contains "$OUT" "$base_t" "base 側を原文の綴りで出す"
  assert_not_contains "$OUT" "000000000" "正規化した鍵を利用者に見せない（表示は原文）"
}

t_freshness_1191_target_set_is_anchored_at_the_repo_root() {
  # **YE を捕まえる case。** `DF_RE` の先頭の `^` を外すと、対象の**集合が変わる**。
  # 本物のツリーでは 13 件 → 15 件になり、`apps/web/app/test-fixtures/data/meta.json`
  # （`fetchedAt` が `+09:00`）が入って、**両側同値なのに全 PR が永久に赤**になる
  # ——#1147 と同じ型（マージ直前に必ず赤くなる検査は運用を止める）。
  #
  # **件数そのもの（13）を固定しない。** `data/` が増えたら 13 は正当に動く。
  # 見るのは**「集合が変わった」**こと: **`data/` で始まらないパスは対象外**であること。
  #
  # **fixture は「実物が出す行」から採る**（#1189 の教訓）。本物のツリーに在る
  # `apps/web/app/test-fixtures/data/meta.json` と同じ形・同じ `+09:00` を使う。
  new_repo_with_data
  mkdir -p "$W/apps/web/app/test-fixtures/data"
  # **fixture は fixture として正しい。** `+09:00` のまま置く（UTC に書き換えて済ませない。
  # 対象の式が拾ってはいけないのが筋）。両側同値なので、対象に入れば必ず「測れません」で赤になる。
  printf '{\n "fetchedAt": "2025-04-01T03:00:00+09:00",\n "sessions": [1]\n}\n' \
    > "$W/apps/web/app/test-fixtures/data/meta.json"
  commit "web の test-fixtures（data/ の下ではない）"
  g update-ref refs/remotes/origin/main main
  branch_from main topic
  printf -- '- **教訓 私**\n' >> "$W/docs/WORKING_AGREEMENT.md"
  commit "my lesson"
  run --data-freshness origin/main topic
  # 両側同値の fixture しか増えていないので、**通らなければならない。**
  assert_eq 0 "$STATUS" "data/ で始まらないパスを対象にしない（^ が効いている。#1191）: $OUT"
  assert_not_contains "$OUT" "測れません" "リポジトリ直下の data/ 以外の meta.json を測ろうとしない"
  assert_not_contains "$OUT" "test-fixtures" "対象の集合に test-fixtures が入っていない"
  # **母数（#757）: 集合の大きさを名指しで固定する。** 1 件（`data/meta.json`）だけが対象であり、
  # `^` を外すと 2 件になる。**件数を出力から読むので、集合が変わったことが直接見える。**
  assert_contains "$OUT" "1 件" "対象は data/meta.json の 1 件だけ（^ を外すと 2 件になる）"
}

# --- 5. Issue #565: a stale local `origin/main` (no `git fetch` run) must not report `ok` ------------
# `origin` here is a real remote (a second on-disk repo), so `git ls-remote origin` works exactly as it
# does against GitHub, only against `file://`-speed instead of the network — no network, no `gh`, per the
# header comment. `new_repo_with_real_remote` replaces `new_repo`'s bare `update-ref` with an actual clone.
new_repo_with_real_remote() {
  local remote="$TMP/remote"; rm -rf "$remote"
  git init -q -b main "$remote"
  mkdir -p "$remote/docs" "$remote/src"
  { echo "# 作業合意"; for i in $(seq 1 40); do echo "- **教訓 $i** 本文本文本文"; done
    for i in $(seq 1 3000); do echo "  埋め草 $i 本文本文本文本文本文本文本文本文本文本文本文本文本文"; done
  } > "$remote/docs/WORKING_AGREEMENT.md"
  printf 'export const a = 1;\nexport const b = 2;\n' > "$remote/src/app.ts"
  git -C "$remote" add -A; git -C "$remote" commit -qm base
  rm -rf "$W"
  git clone -q "$remote" "$W"
  g checkout -q -b main origin/main 2>/dev/null || g checkout -q main
}
# remote_advances <text...> → push new lines to the real `origin`, WITHOUT touching $W's `origin/main`
# tracking ref — this is exactly "someone else merged to main and I have not fetched".
remote_advances() {
  local remote="$TMP/remote"
  printf -- '%s\n' "$@" >> "$remote/docs/WORKING_AGREEMENT.md"
  git -C "$remote" add -A; git -C "$remote" commit -qm "main adds"
}

t_stale_tracking_ref_without_fetch_is_not_reported_as_ok() {
  new_repo_with_real_remote; BASE_SHA=$(g rev-parse HEAD)
  branch_from "$BASE_SHA" topic
  printf -- '- **教訓 私**\n' >> "$W/docs/WORKING_AGREEMENT.md"
  commit "my lesson"
  remote_advances '- **教訓 X（fetch していないと見えない）**'
  # $W's origin/main tracking ref is still at $BASE_SHA: nobody ran `git fetch`.
  run origin/main
  # Exit status is asserted, not just message content: a mutant that turns the warning into a silent
  # `exit 0` (skipping the rest of the script, so `stale-base: ok` never even gets printed) must still
  # be caught. Content-only assertions passed against that mutant — measured, this is why both are here.
  assert_eq 1 "$STATUS" "must fail, not merely avoid saying ok: $OUT"
  assert_not_contains "$OUT" "stale-base: ok" \
    "must not say ok when the local origin/main is behind the real remote"
  assert_contains "$OUT" "fetch" "tells the caller to fetch"
}

t_fetched_tracking_ref_stays_quiet() {
  new_repo_with_real_remote; BASE_SHA=$(g rev-parse HEAD)
  branch_from "$BASE_SHA" topic
  printf -- '- **教訓 私**\n' >> "$W/docs/WORKING_AGREEMENT.md"
  commit "my lesson"
  remote_advances '- **教訓 X**'
  g fetch -q origin
  run origin/main
  assert_eq 1 "$STATUS" "still catches the real staleness after fetching: $OUT"
  assert_not_contains "$OUT" "fetch していない" "a freshly-fetched origin/main is not accused of being stale"
}

# CI passes the full `refs/remotes/origin/$BASE_REF` form (.github/workflows/ci.yml), not the short
# `origin/main` this test file otherwise uses. Both spellings must go through the same #565 check.
t_full_refs_remotes_form_is_also_checked() {
  new_repo_with_real_remote; BASE_SHA=$(g rev-parse HEAD)
  branch_from "$BASE_SHA" topic
  printf -- '- **教訓 私**\n' >> "$W/docs/WORKING_AGREEMENT.md"
  commit "my lesson"
  remote_advances '- **教訓 X**'
  g fetch -q origin
  run refs/remotes/origin/main
  assert_eq 1 "$STATUS" "the refs/remotes/ form is checked the same way after fetching: $OUT"
  assert_not_contains "$OUT" "fetch していない" "freshly fetched: no stale warning"
}

t_no_registered_remote_is_not_treated_as_stale() {
  # The existing fixtures (`new_repo`) never register a remote named `origin` — `refs/remotes/origin/main`
  # is written directly with `update-ref`. That must keep working exactly as before: no remote to compare
  # against is not evidence of staleness, and must not turn into a spurious warning or a network attempt.
  new_repo; BASE_SHA=$(g rev-parse HEAD)
  main_moves '- **教訓 X**'
  branch_from "$BASE_SHA" topic
  g checkout -q "$BASE_SHA" -- docs/WORKING_AGREEMENT.md
  g show origin/main:docs/WORKING_AGREEMENT.md > "$W/docs/WORKING_AGREEMENT.md"
  commit "up to date"
  run
  assert_eq 0 "$STATUS" "no origin remote registered: falls back to the old behaviour: $OUT"
  assert_not_contains "$OUT" "fetch していない" "does not fabricate a staleness warning with nothing to check against"
}

test_case "fetch していないローカルの origin/main は ok と言わない（#565）" t_stale_tracking_ref_without_fetch_is_not_reported_as_ok
test_case "fetch 済みなら黙る（#565、偽陽性なし）" t_fetched_tracking_ref_stays_quiet
test_case "CI が渡す refs/remotes/origin/main 形式でも同じ検査が働く（#565）" t_full_refs_remotes_form_is_also_checked
test_case "origin という remote が登録されていない環境では従来どおり動く（既存フィクスチャ）" t_no_registered_remote_is_not_treated_as_stale
test_case "git worktree の中でも動く（.git はファイル）" t_works_inside_a_git_worktree
test_case "見つけた行数を出す" t_reports_the_deletion_count_it_measured
test_case "base ref を引数で渡せる" t_base_ref_can_be_overridden
test_case "base ref が解決できないときは通さない" t_missing_base_ref_is_an_error_not_a_pass
test_case "head ref が解決できないときも通さない" t_missing_head_ref_is_an_error_too
test_case "パスに | が入っても、名指しと一覧ファイルが出る" t_paths_with_a_pipe_still_report
test_case "土台が最新なのに base の行を差し引きで消す枝 → 落ちる（#836）" t_net_deletions_catches_a_rebased_branch_that_dropped_the_bases_lines
test_case "同じ量以上を書き戻す書き換えは黙る（#836。何にでも火が点く検査にしない）" t_net_deletions_stays_quiet_for_a_rewrite_that_puts_back_at_least_as_much
test_case "ファイルごと消すのはこのモードの対象外（#836）" t_net_deletions_allows_deleting_a_whole_file
test_case "main に遅れているだけの枝は黙る（#836）" t_net_deletions_is_not_confused_by_a_behind_branch
test_case "--net-deletions は数えた行数を出す（#836）" t_net_deletions_counts_every_line_it_reports
test_case "--net-deletions も解決できない ref を通さない（#836）" t_net_deletions_rejects_an_unresolvable_ref
test_case "20 行を超える報告で SIGPIPE で死なない（引数なし、#836）" t_a_long_report_does_not_die_of_sigpipe_default_mode
test_case "20 行を超える報告で SIGPIPE で死なない（--net-deletions、#836）" t_a_long_report_does_not_die_of_sigpipe_net_deletions
test_case "--net-deletions はバイナリを対象にしない（#836）" t_net_deletions_skips_binary_files
test_case "wiring: ci.yml が --net-deletions を呼び、引数なしの検査も残っている（#836／#504）" t_net_deletions_is_wired_into_ci
test_case "1162: 2 つのモードは別の job に在る（check-run 名を分けてある）" t_1162_two_modes_live_in_different_jobs
test_case "枝が main と分岐している（遅れ かつ 進んでいる）だけでは黙る（#836）" t_net_deletions_is_not_confused_by_a_diverged_branch
test_case "main より古い fetchedAt をマージしようとする枝 → 落ちる（#1156）" t_freshness_stale_data_fails
test_case "ETL 自身の data: refresh PR は通る（fetchedAt が進む、#1156）" t_freshness_data_refresh_pr_passes
test_case "data/ を触らない普通の PR は通る（偽陽性 0、#1156）" t_freshness_equal_timestamp_passes
test_case "fetchedAt が無い → 「測れません」と言って落ちる（#1158）" t_freshness_missing_field_is_measured_as_unmeasurable
test_case "日付として解釈できない → 「測れません」と言って落ちる（#1158）" t_freshness_unparseable_timestamp_is_not_a_pass
test_case "JSON として読めない → 「測れません」と言って落ちる（#1158）" t_freshness_invalid_json_is_not_a_pass
test_case "UTC 以外の綴り（+09:00）は文字列比較の前提を崩すので通さない（#1156）" t_freshness_non_utc_offset_is_not_compared_as_a_string
test_case "Z の後ろにゴミが付いた時刻を通さない（末尾の \$ が効いている、再レビュー XJ）" t_freshness_trailing_garbage_after_the_Z_is_not_a_pass
test_case "両側に data/meta.json が無いなら対象外（#1156）" t_freshness_no_meta_on_either_side_is_not_this_checks_business
test_case "base に在って head で消えている → 「測れません」（消せば黙る穴を作らない、#1156）" t_freshness_base_has_meta_but_head_deleted_it_is_measured
test_case "--data-freshness も解決できない ref を通さない（#1156）" t_freshness_rejects_an_unresolvable_ref
test_case "wiring: ci.yml が --data-freshness を呼ぶ（#1156／#504）" t_freshness_is_wired_into_ci
test_case "見た meta.json の件数を出す（母数、#757／#1156 レビュー）" t_freshness_counts_every_meta_json_it_saw
test_case "districts だけの巻き戻し（月次）も落とす（#1156 レビュー）" t_freshness_catches_a_rollback_of_districts_only
test_case "2 段深い assemblies だけの巻き戻しも落とす（#1156 レビュー）" t_freshness_catches_a_rollback_of_a_nested_assembly_only
test_case "新しい meta.json が生えたら母数が増える（列挙ではなく glob、#1156 レビュー）" t_freshness_denominator_grows_when_a_new_meta_json_appears
test_case "古いものを全部挙げる（1 件で打ち切らない、#1156 レビュー）" t_freshness_reports_every_stale_file_not_just_the_first
test_case "入れ子のファイルを消しても「測れません」（黙らせる穴を塞ぐ、#1156 レビュー）" t_freshness_nested_file_deleted_in_head_is_unmeasurable
test_case "既定の対象が 1 件に縮んでいない（#504 の形、#1156 レビュー）" t_freshness_wiring_does_not_narrow_to_one_file
test_case "引数なしなら origin/main と HEAD（レビューの X1/X2）" t_freshness_default_args_are_origin_main_and_head
test_case "bare（index が無い）でも本物の巻き戻しを見つける（再レビュー (c)、ls-files 化を捕まえる）" t_freshness_works_in_a_bare_repo_without_an_index
test_case "ツリーを列挙できないのを「対象 0 件」として通さない（|| : が ls-tree の失敗を飲まない）" t_freshness_unlistable_tree_is_not_zero_targets
test_case "引数が多すぎるときは usage で落ちる（レビューの X4）" t_freshness_too_many_args_is_usage_not_a_pass
test_case "タイムゾーンの無い裸の時刻が、Z 付きより新しく読まれない（#1191 ZB）" t_freshness_1191_naive_local_time_cannot_read_as_newer
test_case "正当な Z 付きの時刻は通る（厳しくしすぎていない。両側で判断する。#1191）" t_freshness_1191_a_legitimate_Z_value_still_passes
test_case "辞書順 = 時刻順 の前提を機械が守る（コメントだけに在った関係式。#1191／#1189）" t_freshness_1191_lexicographic_order_equals_chronological_order
test_case "1 秒未満の後退も検出する（小数部の有無で辞書順が逆転する。#1191）" t_freshness_1191_sub_second_rollback_is_detected
test_case "対象の集合はリポジトリ直下の data/ に固定（^ が効いている。#1191 YE）" t_freshness_1191_target_set_is_anchored_at_the_repo_root
echo "passed $PASS, failed $FAIL"; [[ $FAIL == 0 ]]
