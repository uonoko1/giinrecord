#!/usr/bin/env bash
# Tests for scripts/dev/mutate.sh (Issue #542). Every case builds a throw-away git repo under mktemp
# with uncommitted work in it, so a harness that reaches for `git checkout` / `git reset --hard` /
# `git stash` shows up as a failing assertion here rather than as somebody's lost afternoon.
#   bash scripts/dev/test/mutate.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../mutate.sh"
PASS=0; FAIL=0; FAILED=()
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_eq()           { [[ "$2" == "$1" ]] || fail "$3: expected [$1] got [$2]"; }
assert_ne()           { [[ "$2" != "$1" ]] || fail "$3: expected NOT [$1]"; }
assert_contains()     { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in:
$1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "$3: expected NOT to contain [$2] in:
$1"; }
test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"
  else FAIL=$((FAIL+1)); FAILED+=("$name"); echo "FAIL $name"; fi
}

md5() { md5sum "$1" | cut -d' ' -f1; }

# repo → fresh git repo in $R: one committed file (src/app.ts) plus uncommitted work of both kinds
#   src/dirty.ts   modified-but-tracked   (what `git checkout -- .` destroys)
#   src/new.ts     untracked              (what `git clean` destroys)
#   src/staged.ts  staged-but-uncommitted (what `git reset --hard` destroys)
repo() {
  R="$TMP/repo"; rm -rf "$R"; mkdir -p "$R/src"
  git -C "$R" init -q -b main
  printf 'export const keep = "ORIGINAL";\nconst n = 1;\n' > "$R/src/app.ts"
  printf 'committed\n' > "$R/src/dirty.ts"
  printf 'committed\n' > "$R/src/staged.ts"
  git -C "$R" add -A && git -C "$R" commit -qm init
  printf 'MY UNCOMMITTED EDIT\n' > "$R/src/dirty.ts"
  printf 'MY UNTRACKED FILE\n'   > "$R/src/new.ts"
  printf 'MY STAGED EDIT\n'      > "$R/src/staged.ts"; git -C "$R" add src/staged.ts
}
# run <args...> → STATUS / OUT (stdout+stderr), run from inside $R
run() { set +e; OUT=$( (cd "$R" && bash "$SCRIPT" "$@") 2>&1 ); STATUS=$?; set -e; }

# assert_work_intact <label> → the three kinds of uncommitted work are still there, byte for byte
assert_work_intact() {
  assert_eq 'MY UNCOMMITTED EDIT' "$(cat "$R/src/dirty.ts" 2>/dev/null)" "$1: tracked-modified survives"
  assert_eq 'MY UNTRACKED FILE'   "$(cat "$R/src/new.ts"   2>/dev/null)" "$1: untracked survives"
  assert_eq 'MY STAGED EDIT'      "$(cat "$R/src/staged.ts" 2>/dev/null)" "$1: staged survives"
}

# ---- 受け入れ条件1: 未コミットの作業がある状態で変異を当てても、その作業が消えない -------------
t_apply_keeps_uncommitted_work() {
  repo; run apply src/app.ts 's/ORIGINAL/MUTANT/'
  assert_eq 0 "$STATUS" "apply exits 0: $OUT"
  assert_contains "$(cat "$R/src/app.ts")" MUTANT "the mutation is applied"
  assert_work_intact apply
}
t_restore_keeps_uncommitted_work() {
  repo; run apply src/app.ts 's/ORIGINAL/MUTANT/'; run restore
  assert_eq 0 "$STATUS" "restore exits 0: $OUT"
  assert_work_intact restore
}

# ---- 受け入れ条件2: 変異を当てて戻したあと、対象ファイルが元に戻っている（md5） ---------------
t_restore_is_byte_identical() {
  repo; local before; before=$(md5 "$R/src/app.ts")
  run apply src/app.ts 's/ORIGINAL/MUTANT/'
  assert_ne "$before" "$(md5 "$R/src/app.ts")" "md5 changes while mutated"
  run restore
  assert_eq "$before" "$(md5 "$R/src/app.ts")" "md5 back to the original after restore"
}
# 対象ファイルが未コミットの編集だった場合でも、コミット版ではなく「当てる直前の中身」に戻る。
# これが git checkout との決定的な違い。
t_restore_returns_uncommitted_content_not_head() {
  repo; run apply src/dirty.ts 's/EDIT/MUTANT/'
  assert_contains "$(cat "$R/src/dirty.ts")" MUTANT "mutation lands on the dirty file"
  run restore
  assert_eq 'MY UNCOMMITTED EDIT' "$(cat "$R/src/dirty.ts")" "restores the uncommitted content, not HEAD"
}
t_restore_leaves_no_save_files() {
  repo; run apply src/app.ts 's/ORIGINAL/MUTANT/'
  assert_eq 0 "$STATUS" "apply exits 0: $OUT"
  assert_eq 1 "$(find "$R" -name '*.mutate-sv' | wc -l)" "apply leaves exactly one save file"
  run restore
  assert_eq 0 "$STATUS" "restore exits 0: $OUT"
  assert_eq "" "$(find "$R" -name '*.mutate-sv' -print)" "no leftover save files"
}

# ---- 受け入れ条件3: 変異が当たらなかったとき（パターン不一致）に、それが分かる -----------------
# perl / sed は空振りしても exit 0。ここで落とせなければ、測った結果が全部無意味になる（#514）。
t_no_op_mutation_is_reported() {
  repo; local before; before=$(md5 "$R/src/app.ts")
  run apply src/app.ts 's/NOT-IN-THE-FILE/MUTANT/'
  assert_ne 0 "$STATUS" "a no-op mutation must NOT exit 0"
  assert_contains "$OUT" "変異が当たっていない" "says the mutation did not land"
  assert_contains "$OUT" "src/app.ts" "names the file"
  assert_eq "$before" "$(md5 "$R/src/app.ts")" "file is left as it was"
  assert_eq "" "$(find "$R" -name '*.mutate-sv' -print)" "no save file is left behind on a no-op"
}
# 複数ファイルのうち1つでも空振りしたら、全部戻して落ちる（半端に当たった状態で測らせない）
t_no_op_in_one_of_many_rolls_back_all() {
  repo; local before; before=$(md5 "$R/src/app.ts")
  run apply src/app.ts 's/ORIGINAL/MUTANT/' src/dirty.ts 's/NOT-THERE/X/'
  assert_ne 0 "$STATUS" "must not exit 0"
  assert_contains "$OUT" "変異が当たっていない" "says which one missed"
  assert_contains "$OUT" "src/dirty.ts" "names the file that missed"
  assert_eq "$before" "$(md5 "$R/src/app.ts")" "the file that DID change is rolled back"
  assert_work_intact rollback
}

# ---- 受け入れ条件4: 途中で異常終了しても、退避から復元できる ----------------------------------
# apply したまま殺されても .mutate-sv が残るので、あとから restore で戻せる。
t_restore_after_kill() {
  repo; local before; before=$(md5 "$R/src/app.ts")
  run apply src/app.ts 's/ORIGINAL/MUTANT/'
  # ここでプロセスが死んだ体（apply の子プロセスはもう居ない）
  assert_ne "$before" "$(md5 "$R/src/app.ts")" "still mutated"
  assert_eq 1 "$(find "$R" -name '*.mutate-sv' | wc -l)" "the save file survives the crash"
  run restore
  assert_eq "$before" "$(md5 "$R/src/app.ts")" "restored from the save file"
}
# 変異が当たったままの状態で apply を重ねると、退避を上書きして元が消える。拒否する。
t_apply_refuses_when_a_save_file_exists() {
  repo; local before; before=$(md5 "$R/src/app.ts")
  run apply src/app.ts 's/ORIGINAL/MUTANT/'
  run apply src/app.ts 's/MUTANT/SECOND/'
  assert_ne 0 "$STATUS" "second apply must refuse"
  assert_contains "$OUT" "退避が残っている" "explains why"
  run restore
  assert_eq "$before" "$(md5 "$R/src/app.ts")" "the original is still recoverable"
}
t_status_reports_outstanding_mutation() {
  repo; run apply src/app.ts 's/ORIGINAL/MUTANT/'; run status
  assert_ne 0 "$STATUS" "status exits non-zero while a mutation is outstanding"
  assert_contains "$OUT" "src/app.ts" "names the mutated file"
  repo; run status
  assert_eq 0 "$STATUS" "status exits 0 on a clean tree: $OUT"
}

# ---- 受け入れ条件5: 他の worktree・他人の git stash に触れない --------------------------------
# 他の worktree のファイルを対象にしようとしたら拒否する（相対でも絶対でも ../ でも）
t_refuses_paths_outside_the_worktree() {
  repo
  local other="$TMP/other-worktree"; rm -rf "$other"; mkdir -p "$other/src"
  printf 'SOMEONE ELSE WORK\n' > "$other/src/app.ts"
  run apply "$other/src/app.ts" 's/SOMEONE/MUTANT/'
  assert_ne 0 "$STATUS" "absolute path outside the worktree is refused"
  assert_contains "$OUT" "この作業ツリーの外" "explains why"
  run apply ../other-worktree/src/app.ts 's/SOMEONE/MUTANT/'
  assert_ne 0 "$STATUS" "../ path outside the worktree is refused"
  assert_eq 'SOMEONE ELSE WORK' "$(cat "$other/src/app.ts")" "the other worktree is untouched"
}
# stash スタックは 1 本しかない（worktree を分けても共有）。触ったら他人のものを奪う。
t_never_touches_the_stash() {
  repo
  printf 'STASHED BY SOMEONE ELSE\n' > "$R/src/dirty.ts"
  git -C "$R" stash -q -u
  local depth_before; depth_before=$(git -C "$R" stash list | wc -l)
  repo_dirty_again() { printf 'MY UNCOMMITTED EDIT\n' > "$R/src/dirty.ts"; printf 'MY UNTRACKED FILE\n' > "$R/src/new.ts"; }
  repo_dirty_again
  run apply src/app.ts 's/ORIGINAL/MUTANT/'
  assert_eq 0 "$STATUS" "apply exits 0: $OUT"
  assert_contains "$(cat "$R/src/app.ts")" MUTANT "the mutation really landed"
  run restore
  assert_eq 0 "$STATUS" "restore exits 0: $OUT"
  assert_eq "$depth_before" "$(git -C "$R" stash list | wc -l)" "stash depth unchanged"
  assert_contains "$(git -C "$R" stash list)" "stash@{0}" "the other person's stash is still there"
}
# ソースそのものを見る。git の破壊的コマンドを一切呼ばないことを固定する。
# （動作テストは「今の引数で消えない」しか言えないが、これは「その道具を持たない」を言う）
t_source_has_no_destructive_git() {
  [[ -f "$SCRIPT" ]] || { fail "the script does not exist: $SCRIPT"; return 0; }
  # コメント行は除く（この禁止の理由そのものをコメントで説明しているため）
  local code; code=$(grep -vE '^[[:space:]]*#' "$SCRIPT")
  local c
  for c in checkout restore reset stash clean; do
    assert_not_contains "$code" "git $c" "no git $c"
  done
  # 検査自身が空振りしていないことを固定する（grep -v で全部消えていたら意味が無い）
  assert_contains "$code" "git rev-parse" "the code side really is being read"
}

# ---- run と使い勝手 --------------------------------------------------------------------------
# run: 当てる → コマンド → 必ず戻す。コマンドが落ちても戻す（変異テストの本番の形）
t_run_restores_even_when_the_command_fails() {
  repo; local before; before=$(md5 "$R/src/app.ts")
  run run --file src/app.ts --expr 's/ORIGINAL/MUTANT/' -- sh -c 'grep -q MUTANT src/app.ts && touch saw-mutant; exit 7'
  assert_eq 7 "$STATUS" "propagates the command's exit status"
  [[ -e "$R/saw-mutant" ]] || fail "the command must have seen the mutated file"
  assert_eq "$before" "$(md5 "$R/src/app.ts")" "restored after a failing command"
  assert_work_intact run-fail
}
t_run_sees_the_mutation_and_restores_after() {
  repo; local before; before=$(md5 "$R/src/app.ts")
  run run --file src/app.ts --expr 's/ORIGINAL/MUTANT/' -- grep -c MUTANT src/app.ts
  assert_eq 0 "$STATUS" "exit 0: $OUT"
  assert_contains "$OUT" 1 "the command saw the mutated file"
  assert_eq "$before" "$(md5 "$R/src/app.ts")" "restored afterwards"
}
# run でも空振りは検出する。コマンドを走らせずに落ちる（無意味な測定をさせない）
t_run_refuses_a_no_op_without_running_the_command() {
  repo
  run run --file src/app.ts --expr 's/NOT-THERE/X/' -- touch ran-the-command
  assert_ne 0 "$STATUS" "must not exit 0"
  assert_contains "$OUT" "変異が当たっていない" "says so"
  [[ ! -e "$R/ran-the-command" ]] || fail "the command must not run when the mutation missed"
}
t_usage_without_args() {
  repo; run
  assert_ne 0 "$STATUS" "no args → non-zero"
  assert_contains "$OUT" apply "usage mentions apply"
  assert_contains "$OUT" restore "usage mentions restore"
}
t_refuses_a_missing_file() {
  repo; run apply src/nope.ts 's/a/b/'
  assert_ne 0 "$STATUS" "missing file → non-zero"
  assert_contains "$OUT" "src/nope.ts" "names it"
}

for t in $(declare -F | awk '{print $3}' | grep '^t_'); do test_case "${t#t_}" "$t"; done
echo
echo "passed: $PASS  failed: $FAIL"
if [[ $FAIL -gt 0 ]]; then printf '  - %s\n' "${FAILED[@]}"; exit 1; fi
