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
SV_EXT=.mutate-sv   # scripts/dev/mutate.sh の退避ファイルの拡張子（同じ値）

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
# 同じファイルを1回の apply / run で2回渡すと、1回目の変異済みファイルを
# 2回目の cp が「退避」として上書きする。戻すとその変異済みの中身が書き戻り、
# しかも find_saves は退避を1つも見つけられない（既に消えている）ので status も気づかない（#577）。
# 1ファイルに複数の変異をかけたいときは `--expr 's/A/X/; s/B/Y/'` のように式を連結するのが
# 正しい使い方なので、同じ解決済みパスの重複は最初から拒否する。
t_apply_refuses_the_same_file_twice_in_one_call() {
  repo; local before; before=$(md5 "$R/src/app.ts")
  run apply src/app.ts 's/ORIGINAL/MUTANT/' src/app.ts 's/const n/const N/'
  assert_ne 0 "$STATUS" "同じファイルを2回渡したら拒否する"
  assert_contains "$OUT" "src/app.ts" "対象のファイルを名指しする"
  assert_eq "$before" "$(md5 "$R/src/app.ts")" "何も当てずに触っていない"
  assert_eq "" "$(find "$R" -name '*'"$SV_EXT" -print)" "退避を作らない（作ってから消すのではなく、最初から作らない）"
}
# 別名（相対パスの書き方違い）で同じファイルを指しても、resolve 後は同じパスになるので拒否する
t_apply_refuses_the_same_file_via_different_spelling() {
  repo; local before; before=$(md5 "$R/src/app.ts")
  run apply ./src/app.ts 's/ORIGINAL/MUTANT/' src/../src/app.ts 's/const n/const N/'
  assert_ne 0 "$STATUS" "解決後に同じパスになるなら拒否する"
  assert_eq "$before" "$(md5 "$R/src/app.ts")" "触っていない"
}
# run 経由でも同じ（コマンドを走らせない）
t_run_refuses_the_same_file_twice() {
  repo
  run run --file src/app.ts --expr 's/ORIGINAL/MUTANT/' --file src/app.ts --expr 's/const n/const N/' -- touch ran
  assert_ne 0 "$STATUS" "run でも拒否する"
  [[ ! -e "$R/ran" ]] || fail "コマンドを走らせない"
  assert_eq "" "$(find "$R" -name '*'"$SV_EXT" -print)" "退避を残さない"
}
# status は元々「戻し忘れ」を検出する道具であって、この拒否の代わりにはしない。
# 拒否した直後は当然、当たったものが無いので status も緑のままでよい。
t_status_is_clean_after_the_refusal() {
  repo
  run apply src/app.ts 's/ORIGINAL/MUTANT/' src/app.ts 's/const n/const N/'
  run status
  assert_eq 0 "$STATUS" "拒否した直後は何も残っていないので status も緑: $OUT"
}
# 既存の正しい使い方1: 別々のファイルに複数の --file / apply は今まで通り通る
t_apply_still_allows_multiple_distinct_files() {
  repo
  run apply src/app.ts 's/ORIGINAL/MUTANT/' src/dirty.ts 's/EDIT/CHANGED/'
  assert_eq 0 "$STATUS" "別ファイルなら通る: $OUT"
  assert_contains "$(cat "$R/src/app.ts")" MUTANT "1つ目が当たる"
  assert_contains "$(cat "$R/src/dirty.ts")" CHANGED "2つ目も当たる"
  run restore
  assert_eq 0 "$STATUS" "戻る: $OUT"
}
# 既存の正しい使い方2: 1ファイルに複数式を "; " で連結するのは今まで通り通る
t_apply_still_allows_semicolon_joined_expr_on_one_file() {
  repo
  run apply src/app.ts 's/ORIGINAL/MUTANT/; s/const n/const N/'
  assert_eq 0 "$STATUS" "連結式は通る: $OUT"
  assert_contains "$(cat "$R/src/app.ts")" MUTANT "1つ目の置換が効く"
  assert_contains "$(cat "$R/src/app.ts")" "const N" "2つ目の置換も効く"
  run restore
  assert_eq 0 "$STATUS" "戻る: $OUT"
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

# ---- 必須1: 受け入れる集合と、回収できる集合を一致させる（レビュー指摘） ---------------------
# find_saves は .git / node_modules を prune するので、そこに当てると退避が孤児になり
# 「戻すものが無い（exit 0）」と嘘をつく。回収できない場所は最初から拒否する。
t_refuses_paths_under_unrecoverable_dirs() {
  repo; mkdir -p "$R/node_modules/pkg"; printf 'ORIGINAL\n' > "$R/node_modules/pkg/index.js"
  local before; before=$(md5 "$R/node_modules/pkg/index.js")
  run apply node_modules/pkg/index.js 's/ORIGINAL/MUTANT/'
  assert_ne 0 "$STATUS" "node_modules 配下は拒否する"
  assert_contains "$OUT" "回収できない" "explains why"
  assert_eq "$before" "$(md5 "$R/node_modules/pkg/index.js")" "触っていない"
  local head; head=$(md5 "$R/.git/config")
  run apply .git/config 's/core/CORE/'
  assert_ne 0 "$STATUS" ".git 配下は拒否する"
  assert_eq "$head" "$(md5 "$R/.git/config")" ".git/config は無傷"
  assert_eq "" "$(find "$R" -name '*'"$SV_EXT" -print)" "孤児の退避を残さない"
}
# run でも同じ（コマンドを走らせない）
t_run_refuses_unrecoverable_dirs() {
  repo; mkdir -p "$R/node_modules/pkg"; printf 'ORIGINAL\n' > "$R/node_modules/pkg/index.js"
  run run --file node_modules/pkg/index.js --expr 's/ORIGINAL/MUTANT/' -- touch ran
  assert_ne 0 "$STATUS" "拒否する"
  assert_eq ORIGINAL "$(cat "$R/node_modules/pkg/index.js")" "当たっていない"
  [[ ! -e "$R/ran" ]] || fail "コマンドを走らせない"
}
# 回収できる集合の側も固定する（拒否が広すぎると道具として使えない）
t_accepts_ordinary_paths() {
  repo; mkdir -p "$R/apps/web/node_modules_like"; printf 'ORIGINAL\n' > "$R/apps/web/node_modules_like/x.ts"
  run apply apps/web/node_modules_like/x.ts 's/ORIGINAL/MUTANT/'
  assert_eq 0 "$STATUS" "紛らわしい名前でも普通のパスは通す: $OUT"
  run restore; assert_eq ORIGINAL "$(cat "$R/apps/web/node_modules_like/x.ts")" "戻る"
}

# ---- 必須2: 古い退避が、あとから書いた本物の作業を上書きしない（レビュー指摘） -----------------
# .mutate-sv は crash を越えて残り、かつ gitignore で git status からも見えない。
# 「当てたときの変異後の中身」でなくなっていたら、それは誰かが後から書いた本物の作業。
t_restore_refuses_when_the_target_changed_since_apply() {
  repo; run apply src/app.ts 's/ORIGINAL/MUTANT/'
  printf 'MY IMPORTANT NEW FEATURE\n' > "$R/src/app.ts"   # 翌日の本物の作業
  run restore
  assert_ne 0 "$STATUS" "上書きせずに拒否する"
  assert_contains "$OUT" "当てたときと違う" "explains why"
  assert_eq 'MY IMPORTANT NEW FEATURE' "$(cat "$R/src/app.ts")" "今日の作業を消さない"
  assert_eq 1 "$(find "$R" -name '*'"$SV_EXT" | wc -l)" "退避も消さない（人が判断できるように残す）"
  assert_contains "$OUT" "$SV_EXT" "退避の場所を教える"
}
# 変異が当たったままなら（＝当てたときの中身のまま）ふつうに戻る
t_restore_still_works_when_untouched() {
  repo; local before; before=$(md5 "$R/src/app.ts")
  run apply src/app.ts 's/ORIGINAL/MUTANT/'; run restore
  assert_eq 0 "$STATUS" "戻る: $OUT"
  assert_eq "$before" "$(md5 "$R/src/app.ts")" "元に戻る"
}
t_status_warns_when_the_target_changed() {
  repo; run apply src/app.ts 's/ORIGINAL/MUTANT/'
  printf 'MY IMPORTANT NEW FEATURE\n' > "$R/src/app.ts"
  run status
  assert_ne 0 "$STATUS" "status も気づく"
  assert_contains "$OUT" "当てたときと違う" "名指しする"
}

# ---- 必須3: Ctrl-C / SIGTERM で戻る（レビュー指摘） -------------------------------------------
# 注意: `setsid ... &` で起動した bash は **SIGINT を無視した状態で生まれる**
#   （バックグラウンド起動の作法。/proc/<pid>/status の SigIgn に INT のビットが立つ）。
#   なので「& で起動して INT を送る」形では、trap があってもなくても変異は残らず、
#   本物の端末の Ctrl-C を試したことにならない。**本物の PTY で確かめるのが t_restores_on_real_ctrl_c。**
#   ここ（TERM / INT）は「シグナルで殺されても退避が残骸にならない」ことを見ている。
t_restores_on_sigint_to_the_process_group() { assert_signal_restores INT; }
t_restores_on_sigterm() { assert_signal_restores TERM; }
# 本物の端末（PTY）で Ctrl-C を送る。trap が実際に走る唯一の形。
# trap 文字列の $1 バグ（kill -s "$1" がシグナル名でなく --file を受け取る）はここでしか出ない。
t_restores_on_real_ctrl_c() {
  command -v python3 >/dev/null || { echo "    - python3 が無いので PTY の検査を飛ばす"; return 0; }
  repo; local before; before=$(md5 "$R/src/app.ts")
  local out; out=$(python3 "$HERE/ctrl-c-probe.py" "$R" "$SCRIPT" 2>&1)
  assert_contains "$out" "当てた" "PTY: 変異が当たった"
  assert_contains "$out" "戻した" "PTY: Ctrl-C で戻した"
  assert_not_contains "$out" "invalid signal specification" "PTY: trap の中の kill が壊れていない"
  assert_not_contains "$out" "戻すものが無い" "PTY: 二重に restore していない"
  assert_eq "$before" "$(md5 "$R/src/app.ts")" "PTY: 元に戻っている"
  assert_eq "" "$(find "$R" -name '*'"$SV_EXT" -print)" "PTY: 退避も片付いている"
}
assert_signal_restores() {
  local sig=$1
  repo; local before; before=$(md5 "$R/src/app.ts")
  local log="$TMP/sig.$sig.log"
  ( cd "$R" && setsid bash "$SCRIPT" run --file src/app.ts --expr 's/ORIGINAL/MUTANT/' -- sleep 30 ) > "$log" 2>&1 &
  local runner=$!
  local waited=0
  until grep -q '当てた' "$log" 2>/dev/null; do
    sleep 0.05; waited=$((waited+1)); [[ $waited -lt 200 ]] || { fail "$sig: 変異が当たらないまま時間切れ"; kill -KILL "$runner" 2>/dev/null; return 0; }
  done
  local pgid; pgid=$(ps -o pgid= -p "$runner" 2>/dev/null | tr -d ' ')
  [[ -n $pgid ]] || { fail "$sig: pgid が取れない"; return 0; }
  kill -"$sig" -- -"$pgid" 2>/dev/null
  wait "$runner" 2>/dev/null || true
  waited=0
  until [[ ! -e "$R/src/app.ts$SV_EXT" ]]; do
    sleep 0.05; waited=$((waited+1)); [[ $waited -lt 100 ]] || break
  done
  assert_eq "$before" "$(md5 "$R/src/app.ts")" "$sig: 戻っている"
  assert_eq "" "$(find "$R" -name '*'"$SV_EXT" -print)" "$sig: 退避も片付いている"
  # trap の中身が壊れていないこと。trap 文字列は「シグナルを受けた時点」で再展開されるので、
  # その中の $1 は cmd_run の第1引数（--file など）になる。kill -s "$1" は必ず失敗する。
  assert_not_contains "$(cat "$log")" "invalid signal specification" "$sig: trap の中で kill が失敗していない"
  assert_not_contains "$(cat "$log")" "戻すものが無い" "$sig: 二重に restore していない"
}

# ---- 必須5-N3: 退避ファイル自身を対象にできない -----------------------------------------------
# 「退避が残っている」拒否より先にこの guard へ届く場所に置く必要がある。
# find_saves は node_modules を刈るので、そこに置けば「退避が残っている」判定には引っかからない。
# （そのまま .mutate-sv を対象にすると、退避が <名前>.mutate-sv.mutate-sv になって復旧が壊れる）
t_refuses_the_save_file_itself() {
  # node_modules は find_saves が刈るので「退避が残っている」判定に引っかからない。
  # （node_modules 配下は別の理由でも拒否されるが、guard のほうが先に効くことを下で確かめる）
  repo; mkdir -p "$R/node_modules/pkg"; printf 'SAVED\n' > "$R/node_modules/pkg/app.ts$SV_EXT"
  # まず「退避が残っている」で止まっていないことを確かめる（fixture が guard に届いている証明）
  run apply "node_modules/pkg/app.ts$SV_EXT" 's/SAVED/MUTANT/'
  assert_ne 0 "$STATUS" "退避ファイル自身は対象にできない"
  assert_not_contains "$OUT" "退避が残っている" "別の理由で止まっていない（guard に届いている）"
  assert_contains "$OUT" "退避ファイル自体" "guard の理由を言う"
  assert_eq SAVED "$(cat "$R/node_modules/pkg/app.ts$SV_EXT")" "触っていない"
  assert_eq "" "$(find "$R" -name "*$SV_EXT$SV_EXT" -print)" "二重の退避を作らない"
}

# ---- 必須5-N4: 戻せなかったら黙って成功しない -------------------------------------------------
# 読み取り専用ディレクトリにして cp を失敗させる。失敗を握り潰すと「戻した」と嘘をつく。
t_restore_fails_loudly_when_the_copy_fails() {
  repo; run apply src/app.ts 's/ORIGINAL/MUTANT/'
  chmod a-w "$R/src"
  run restore
  chmod u+w "$R/src"
  assert_ne 0 "$STATUS" "書き戻しか片付けに失敗したら非ゼロで落ちる"
  assert_contains "$OUT" "mutate:" "何が起きたか mutate 自身の言葉で言う"
  assert_eq 1 "$(find "$R" -name '*'"$SV_EXT" | wc -l)" "退避は残っている（消せていないので）"
}

# ---- 必須5-N5: パーミッションを保つ -----------------------------------------------------------
# mode は cp -p が無くても保たれる（既存ファイルへの cp は宛先の mode を残す）。
# 実際に -p が要るのは mtime のほうで、これが動くとビルドのキャッシュ判定が狂う。
t_preserves_mode_and_mtime() {
  repo; chmod 0755 "$R/src/app.ts"; touch -d '2020-01-01 00:00' "$R/src/app.ts"
  local mode mtime
  mode=$(stat -c '%a' "$R/src/app.ts"); mtime=$(stat -c '%Y' "$R/src/app.ts")
  run apply src/app.ts 's/ORIGINAL/MUTANT/'; run restore
  assert_eq 0 "$STATUS" "restore exits 0: $OUT"
  assert_eq "$mode"  "$(stat -c '%a' "$R/src/app.ts")" "mode が戻る"
  assert_eq "$mtime" "$(stat -c '%Y' "$R/src/app.ts")" "mtime も戻る（cp -p。ビルドのキャッシュが狂わないように）"
}

# ---- run の測定中に変異が外れていたら、その測定結果は無意味（レビュー指摘・低優先） -----------
# 誰かが並行して restore を打つ／コマンド自身が対象を書き戻す、などで変異が外れうる。
# それに気づかず exit 0 を返すと、#514 と同じ「当たっていないのに測った」になる。
t_run_detects_the_mutation_being_undone_midway() {
  repo; local before; before=$(md5 "$R/src/app.ts")
  # コマンドの中で対象を元に戻す＝測定中に変異が外れた状態を作る
  run run --file src/app.ts --expr 's/ORIGINAL/MUTANT/' -- \
    sh -c 'printf "export const keep = \"ORIGINAL\";\nconst n = 1;\n" > src/app.ts'
  assert_ne 0 "$STATUS" "測定中に変異が外れたら exit 0 で済ませない"
  assert_contains "$OUT" "測っている間に" "何が起きたか言う"
  assert_eq "$before" "$(md5 "$R/src/app.ts")" "後片付けはする"
}
# ふつうに走ったときは、この検査で誤って落ちない（厳しすぎる側も固定する）
t_run_does_not_false_positive_on_a_normal_run() {
  repo
  run run --file src/app.ts --expr 's/ORIGINAL/MUTANT/' -- grep -c MUTANT src/app.ts
  assert_eq 0 "$STATUS" "ふつうの run は通る: $OUT"
  assert_not_contains "$OUT" "測っている間に" "誤検出しない"
}

# ---- CI が本当にこのテストを走らせること -------------------------------------------------------
# 「共通の道具を作る」は、CI が走らせて初めて効く。ci.yml の for ループの glob を固定する。
# （scripts/dev/test/ を glob から外すと、この道具の防御が黙って死ぬ）
t_ci_runs_this_test_file() {
  local ci="$HERE/../../../.github/workflows/ci.yml"
  [[ -f $ci ]] || { fail "ci.yml が見つからない: $ci"; return 0; }
  local line; line=$(grep -F 'deploy/test/*.test.sh; do' "$ci" || true)
  assert_ne "" "$line" "ci.yml に bash テストの for ループがある"
  assert_contains "$line" 'scripts/dev/test/*.test.sh' "ci.yml が scripts/dev/test/*.test.sh を走らせる"
}

# 退避ファイルは異常終了すると残る。復旧に要るので消さないが、うっかり commit させない。
t_save_files_are_gitignored() {
  local top; top=$(cd "$HERE/../../.." && pwd)
  [[ -f "$top/.gitignore" ]] || { fail ".gitignore が無い"; return 0; }
  # check-ignore は「無視される」で 0、「されない」で 1 を返す。1 は失敗ではないので拾い直す。
  # cd の失敗まで一緒に握り潰さないよう、|| true ではなく関数に分ける。
  ignores() { local out; out=$(cd "$top" && git check-ignore "$1"); local st=$?; [[ $st -le 1 ]] || return 2; printf '%s' "$out"; }
  assert_ne "" "$(ignores "some/file.ts$SV_EXT")" "*$SV_EXT が .gitignore で無視される"
  # 変異後の md5 を書いた meta も一緒に無視する（残ると diff に出る）
  assert_ne "" "$(ignores "some/file.ts$SV_EXT.md5")" "meta も無視される"
  # 検査が空振りしていないこと（何でも無視される設定なら意味が無い）
  assert_eq "" "$(ignores some/file.ts)" "普通のソースは無視されない"
}

for t in $(declare -F | awk '{print $3}' | grep '^t_'); do test_case "${t#t_}" "$t"; done
echo
echo "passed: $PASS  failed: $FAIL"
if [[ $FAIL -gt 0 ]]; then printf '  - %s\n' "${FAILED[@]}"; exit 1; fi
