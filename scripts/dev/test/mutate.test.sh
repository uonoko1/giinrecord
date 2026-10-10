#!/usr/bin/env bash
# Tests for scripts/dev/mutate.sh (Issue #542). Every case builds a throw-away git repo under mktemp
# with uncommitted work in it, so a harness that reaches for `git checkout` / `git reset --hard` /
# `git stash` shows up as a failing assertion here rather than as somebody's lost afternoon.
#   bash scripts/dev/test/mutate.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../mutate.sh"
PASS=0; FAIL=0; FAILED=()
TMP=$(mktemp -d); cleanup() { local __rc=$?; rm -rf "$TMP" || echo "warn: cleanup left $TMP behind (not a test failure)" >&2; exit "$__rc"; }; trap cleanup EXIT
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

# ---- #1114 の余波: 「退避が在るのに trap が無い瞬間」が実在した -------------------------------
# 上の 2 本は「当てた」がログに出てから kill する。そこには **ログに出るより前** の窓が映らない。
#   退避を作る cp → 変異を当てる perl → 「当てた」の echo → （show_diff）→ trap の設置
# ログの合図は 3 番目なので、1〜2 番目で殺されたときのことを 1 本も見ていなかった。
# 実測（#1114 の枝 f7a4e002 と、その基点 5775056f の両方）:
#   「当てた」で kill      … 基点 16/16 緑、この枝 24 回中 6 回赤（show_diff が窓を広げた）
#   退避が現れた瞬間に kill … 基点 10 回中 9 回赤、この枝 10 回中 10 回赤
# **窓は show_diff が作ったのではなく、最初から在った。** show_diff は幅を広げて、
# 既存のテストに見える所まで持ってきただけ。だから直し方は「echo の前に動かす」ではなく
# 「退避を作る前に trap を仕掛ける」でなければならない（幅を狭めるのではなく窓を無くす）。
#
# この検査は disk を busy-wait で見張り、**退避が現れた瞬間**に kill する。
# trap が cp より後に在るかぎり、ほぼ必ず赤になる（上の実測どおり）。
t_restores_when_killed_the_instant_the_save_appears() {
  repo; local before; before=$(md5 "$R/src/app.ts")
  local log="$TMP/sig.early.log"
  ( cd "$R" && setsid bash "$SCRIPT" run --file src/app.ts --expr 's/ORIGINAL/MUTANT/' -- sleep 30 ) > "$log" 2>&1 &
  local runner=$!
  # sleep を挟まない。挟むと窓を通り過ぎてしまい、この検査が何も見なくなる。
  local spun=0
  until [[ -e "$R/src/app.ts$SV_EXT" ]]; do
    spun=$((spun+1)); [[ $spun -lt 4000000 ]] || { fail "early: 退避が現れないまま時間切れ"; kill -KILL "$runner" 2>/dev/null; return 0; }
  done
  local pgid; pgid=$(ps -o pgid= -p "$runner" 2>/dev/null | tr -d ' ')
  [[ -n $pgid ]] || { fail "early: pgid が取れない"; return 0; }
  kill -TERM -- -"$pgid" 2>/dev/null
  wait "$runner" 2>/dev/null || true
  local waited=0
  until [[ ! -e "$R/src/app.ts$SV_EXT" ]]; do
    sleep 0.05; waited=$((waited+1)); [[ $waited -lt 100 ]] || break
  done
  assert_eq "$before" "$(md5 "$R/src/app.ts")" "early: 退避が現れた瞬間に殺されても戻っている"
  assert_eq "" "$(find "$R" -name '*'"$SV_EXT" -print)" "early: 退避も残っていない"
  assert_not_contains "$(cat "$log")" "invalid signal specification" "early: trap の中で kill が失敗していない"
}

# ---- #1255: trap は「仕掛けてあっても走らない」ことがある -------------------------------------
# #1114 で trap を cp より前に出して「退避が在るのに handler が無い瞬間」は消した。
# それでも #1251 の CI で同じ落ち方（**変異が残り、退避も残る**）が出た。
#
# 実測（この枝で特定した。手順は下の t_... の上に書いてある）:
#   退避が現れた瞬間に SIGTERM   60 回中 1 回赤 / 80 回中 1 回赤 / 200 回中 3 回赤
#   赤い回の標準エラーは必ずこれ 1 行だけ:
#     mutate.sh: trap: line 2: unexpected EOF while looking for matching `)'
#   DEBUG trap で追うと、**on_signal には一度も入っていない**。
#   bash は trap の「文字列」をシグナルを受けた時点で parse し直すが、
#   その時点でパーサが $( ) の途中だと、trap の本体を「$( ) の続き」として読んでしまい、
#   閉じ括弧が無いまま EOF に達して落ちる。**handler は走らない。**
#
# trap の本体の形を変えても逃げられない（この枝で測った。各回 setsid + プロセスグループへ TERM）:
#   "on_signal TERM"（いまの形）   40 回中 1 回 parse error
#   on_signal（引数なしの裸）      40 回中 0 回 → N を増やすと **150 回中 5 回**
#   "{ on_signal TERM; }"          40 回中 1 回 parse error
#   "(on_signal TERM)"             40 回中 1 回 parse error
# **どの綴りでも起きる。** つまり「trap の書き方を直す」では塞げない。
#
# **#1255 が「測っていない」と書いていた、窓の幅を決める違いも測った。**
# 予想は「CI runner は手元より遅いので窓が広い」だったが、**逆だった**。
# 同じ機械・同じハーネスで CPU 数だけを変えて基点（origin/main）を測ると:
#   taskset -c 0      （1 CPU）   100 回中 0 回赤
#   taskset -c 0,1    （2 CPU）   150 回中 1 回赤
#   制限なし          （16 CPU）  200 回中 3 回赤
# **効くのは遅さではなく並列度である。** 撃つ側と撃たれる側が同時に走れないと、
# 「$( ) の途中」という一瞬にシグナルを届けられない。だから 1 CPU では再現しない。
# （この検査は SIGKILL で撃つので、どちらの条件でも同じ結果になる。それが狙いである。）
#
# だから設計を変える: **死にかけのシェル自身に戻させない。**
# 退避を作る前に、別プロセスの見張りを立てる。見張りは親の死を待ち、
# 親が自分で戻せていなければ（＝退避がまだ在れば）代わりに戻す。
# 見張りは親とは別の bash なので、親のパーサがどんな状態で死のうと関係ない。

# **この検査は機械の速さに依存しない**（受け入れ条件3）。SIGKILL は trap を一切走らせないので、
# 「窓の中で殺せたかどうか」という運の要素が無い。**どの機械でも必ず同じ結果になる。**
# そして SIGKILL は TERM の parse 失敗より厳しい条件なので、ここが緑なら TERM の経路も戻る
# （TERM で handler が走らなかったときに残るのは、SIGKILL とまったく同じ状態である）。
t_restores_even_when_the_shell_is_sigkilled() {
  repo; local before; before=$(md5 "$R/src/app.ts")
  local log="$TMP/sig.kill.log"
  ( cd "$R" && setsid bash "$SCRIPT" run --file src/app.ts --expr 's/ORIGINAL/MUTANT/' -- sleep 30 ) > "$log" 2>&1 &
  local runner=$!
  # ここは「当てた」を待つ。窓を狙う必要が無い（KILL はどこで撃っても trap が走らない）ので、
  # 待てるだけ待ってから確実に撃つ。これが速さに依存しない理由。
  local waited=0
  until grep -q '当てた' "$log" 2>/dev/null; do
    sleep 0.05; waited=$((waited+1)); [[ $waited -lt 200 ]] || { fail "kill: 変異が当たらないまま時間切れ"; kill -KILL "$runner" 2>/dev/null; return 0; }
  done
  assert_contains "$(cat "$R/src/app.ts")" MUTANT "kill: 撃つ前に変異は当たっている"
  local pgid; pgid=$(ps -o pgid= -p "$runner" 2>/dev/null | tr -d ' ')
  [[ -n $pgid ]] || { fail "kill: pgid が取れない"; return 0; }
  kill -KILL -- -"$pgid" 2>/dev/null
  wait "$runner" 2>/dev/null || true
  # 見張りは親が死んでから動くので、ここだけは待つ。待つ上限は固定で、
  # 「時間切れ」は赤として扱う（遅い機械で緑に化けないように、黙って抜けない）。
  waited=0
  until [[ ! -e "$R/src/app.ts$SV_EXT" ]]; do
    sleep 0.05; waited=$((waited+1))
    [[ $waited -lt 200 ]] || { fail "kill: 10 秒待っても退避が消えない（見張りが戻していない）"; break; }
  done
  assert_eq "$before" "$(md5 "$R/src/app.ts")" "kill: SIGKILL で殺されても戻っている"
  assert_eq "" "$(find "$R" -name '*'"$SV_EXT" -print)" "kill: 退避も残っていない"
  assert_eq "" "$(find "$R" -name "*$SV_EXT.md5" -print)" "kill: meta も残っていない"
}

# 見張りが「親が自分で戻した後」に二度と触らないこと。
# ここを外すと、run が正常に終わった直後に見張りが古い退避を書き戻し、
# **この道具が防ごうとしている事故（人の作業を黙って上書きする）を道具自身が起こす。**
t_the_watchdog_does_not_touch_anything_after_a_normal_run() {
  repo; local before; before=$(md5 "$R/src/app.ts")
  run run --file src/app.ts --expr 's/ORIGINAL/MUTANT/' -- true
  assert_eq 0 "$STATUS" "正常な run は 0: $OUT"
  assert_eq "$before" "$(md5 "$R/src/app.ts")" "run の直後は戻っている"
  # run が戻した後、その場所に「今日の作業」を書く。見張りが生きていれば、これを上書きする。
  printf 'MY IMPORTANT NEW FEATURE\n' > "$R/src/app.ts"
  local mine; mine=$(md5 "$R/src/app.ts")
  sleep 1
  assert_eq "$mine" "$(md5 "$R/src/app.ts")" "見張りは run の後に書き戻さない"
  assert_eq "" "$(find "$R" -name '*'"$SV_EXT" -print)" "退避も作り直さない"
  assert_work_intact watchdog-after-normal-run
}

# 見張りは run のときだけ立てる。apply は「当てたまま残す」のが仕様なので、
# 見張りが立つと apply の直後に変異が戻されてしまう（仕様が壊れる）。
t_apply_has_no_watchdog() {
  repo
  run apply src/app.ts 's/ORIGINAL/MUTANT/'
  assert_eq 0 "$STATUS" "apply は 0: $OUT"
  sleep 1
  assert_contains "$(cat "$R/src/app.ts")" MUTANT "apply の変異は残ったまま（見張りが戻していない）"
  assert_eq 1 "$(find "$R" -name '*'"$SV_EXT" | wc -l)" "退避も残ったまま"
  run restore
  assert_eq 0 "$STATUS" "あとから restore で戻せる: $OUT"
}

# 見張りを足したことで、**退避が正当に残る経路**が 1 つできた:
# run の最後の restore が stale（その場所に人の作業が書かれている）で拒否すると、退避は残る。
# このとき見張りを解除してしまうと、最後の砦が消える。だから解除の条件は
# 「親が終わったら」ではなく「戻っていたら」にしてある。
# **そして見張り自身も同じ restore を呼ぶので、同じ理由で同じように拒否しなければならない。**
# ここで見張りが上書きしたら、この道具が防ごうとしている事故を道具自身が起こす。
t_the_watchdog_refuses_to_overwrite_work_written_during_the_run() {
  repo
  # 測っている間に、対象ファイルを「今日の作業」で上書きするコマンドを渡す。
  # run の restore は stale を見て拒否し、退避を残す（既存の仕様）。
  run run --file src/app.ts --expr 's/ORIGINAL/MUTANT/' -- \
      bash -c 'printf "MY IMPORTANT NEW FEATURE\n" > src/app.ts'
  assert_ne 0 "$STATUS" "stale なら run は 0 を返さない: $OUT"
  assert_eq 'MY IMPORTANT NEW FEATURE' "$(cat "$R/src/app.ts")" "run は今日の作業を消さない"
  assert_eq 1 "$(find "$R" -name '*'"$SV_EXT" | wc -l)" "退避は残る（人が判断できるように）"
  # 親はもう終わっている。見張りが生きていれば、ここで上書きしうる。
  sleep 1
  assert_eq 'MY IMPORTANT NEW FEATURE' "$(cat "$R/src/app.ts")" "見張りも今日の作業を消さない"
  assert_eq 1 "$(find "$R" -name '*'"$SV_EXT" | wc -l)" "見張りは退避も消さない"
  assert_work_intact watchdog-stale
}

# ---- #1259 レビュー: stale 拒否で残った見張りが、後から来た run の退避を戻してしまった ---------
# **最初の実装は #1255 と同じ落ち方を新しく作っていた。**
# stop_watchdog が「退避が 1 つでも残っていれば印を消さない」だったので、
# stale 拒否（人の作業が在るので上書きしない）のあとに**見張りが生き残った**。
# その見張りは `mutate.sh restore` を木全体に打つので、**後から来た別の run の退避**を戻す。
# 戻された run は「測っている間に変異が外れた」と言って非 0 で終わり、退避を木に残す
# ──**#1255 が開かれた落ち方そのもの**である。
#
# レビューが母数つきで測った率: この枝 23/150（15.3%）・1 CPU 9/100、`main` は両方 0。
# 手元でも A（stale 拒否）→ 人が片付ける → B（ふつうの run）で **20 回中 5 回**出た
# （`main` は 0/20）。
#
# **この検査は確率に頼らない。** 見張りの起床を待って競争させるのではなく、
# 「見張りがこれから restore を打つ」状態を作ってから、**別のファイルに新しい退避を置く**。
# 見張りが木全体を対象にしていれば必ずそれを戻す。対象が自分の run のファイルに
# 限られていれば、何回走らせても触らない。どちらに転ぶかは機械の速さで変わらない。
t_a_leftover_watchdog_does_not_restore_a_later_runs_save() {
  repo
  # A: stale 拒否の run。親を sleep で生かしておき、退避が現れてから終わらせる
  # （こうすると、親が終わった瞬間に見張りが「印が在る／親が死んだ」を見る）。
  ( cd "$R" && bash "$SCRIPT" run --file src/app.ts --expr 's/ORIGINAL/MUTANT/' -- \
      bash -c 'printf "MY WORK\n" > src/app.ts; sleep 1' ) >/dev/null 2>&1 &
  local apid=$!
  local w=0
  until [[ -e "$R/src/app.ts$SV_EXT" ]]; do
    sleep 0.01; w=$((w+1)); [[ $w -lt 500 ]] || { fail "leftover: A の退避が現れないまま時間切れ"; break; }
  done
  wait "$apid" 2>/dev/null || true
  # 人が A の退避を片付ける（stale 拒否は「人が判断する」ための状態なので、これが正しい後始末）
  rm -f "$R/src/app.ts$SV_EXT" "$R/src/app.ts$SV_EXT.md5"
  printf 'export const keep = "ORIGINAL";\nconst n = 1;\n' > "$R/src/app.ts"
  # B の代わり: **A とは別のファイル**に、新しい run の退避と同じものを置く。
  # A の見張りがこれを戻したら、それは「他人の run を壊した」ことである。
  printf 'B ORIGINAL\n' > "$R/src/b.ts"
  cp -p "$R/src/b.ts" "$R/src/b.ts$SV_EXT"
  printf 'B MUTANT\n' > "$R/src/b.ts"
  md5 "$R/src/b.ts" > "$R/src/b.ts$SV_EXT.md5"
  # 見張りが起きるのを待つ。戻されなければ（＝直っていれば）上限まで待って抜ける。
  w=0
  until [[ ! -e "$R/src/b.ts$SV_EXT" ]]; do
    sleep 0.05; w=$((w+1)); [[ $w -lt 60 ]] || break
  done
  assert_eq 'B MUTANT' "$(cat "$R/src/b.ts")" "leftover: 残った見張りは後から来た run の変異を戻さない"
  assert_eq 1 "$(find "$R" -name '*'"$SV_EXT" | wc -l)" "leftover: その退避も消さない"
  assert_work_intact leftover-watchdog
}

# 上と同じことを、**印（flag）が残るか**という一段手前で固定する。
# 親が EXIT まで来たなら、退避が残っていても印は消えなければならない
# （退避が残る経路は「stale 拒否」と「cp 失敗」の 2 つで、どちらも親が判断を下して
# 終わっている。見張りが要るのは「判断を下す前に死んだ」ときだけである）。
# TMPDIR を専用の場所に向けて、**この run が作った印だけ**を数える。
t_a_stale_refusal_still_releases_the_watchdog() {
  repo
  local flags="$TMP/flags.$$"; rm -rf "$flags"; mkdir -p "$flags"
  set +e
  OUT=$( (cd "$R" && TMPDIR="$flags" bash "$SCRIPT" run --file src/app.ts --expr 's/ORIGINAL/MUTANT/' -- \
      bash -c 'printf "MY WORK\n" > src/app.ts') 2>&1 ); STATUS=$?
  set -e
  assert_ne 0 "$STATUS" "stale なら run は 0 を返さない: $OUT"
  assert_eq 1 "$(find "$R" -name '*'"$SV_EXT" | wc -l)" "退避は残る（人が判断できるように）"
  # 親が終わった時点で印は消えている。見張りが自分で消すのを待たずに数える
  # （見張りが消してから数えると、残っていても 0 に見えてこの検査が何も見なくなる）。
  assert_eq 0 "$(find "$flags" -name 'mutate-watchdog.*' | wc -l)" \
    "stale 拒否でも親は見張りの印を残さない（残すと後の run を壊す）"
}

# 見張りは `cd -- "$top"` してから自分自身を呼び直す。だから $0 が相対パスのままだと、
# cd の後にそれは別の場所を指し、`bash "$self" restore` は **127 で死ぬ**。
# 呼び出しは `|| true` で握り潰されているので、**最後の砦が一言も言わずに不在になる。**
# リポジトリ内の呼び出しは全部絶対パスなので未発現だったが、`|| true` が在る以上は
# 発現しても気づけない（#1259 のレビュー）。
# ここは **サブディレクトリから相対パスで呼んで SIGKILL する**。絶対パスに正規化していないと
# 見張りが戻せず、退避が残る。
t_the_watchdog_survives_being_invoked_by_a_relative_path() {
  repo; local before; before=$(md5 "$R/src/app.ts")
  # リポジトリの中に mutate.sh の複製を置き、サブディレクトリから相対パスで呼ぶ。
  # （$SCRIPT を直接相対で呼ぶと、この検査が置かれている場所に依存してしまう）
  mkdir -p "$R/tools"
  cp -p "$SCRIPT" "$R/tools/mutate.sh"
  local log="$TMP/relpath.log"
  ( cd "$R/src" && setsid bash ../tools/mutate.sh run --file app.ts --expr 's/ORIGINAL/MUTANT/' -- sleep 30 ) \
    > "$log" 2>&1 &
  local runner=$!
  local waited=0
  until grep -q '当てた' "$log" 2>/dev/null; do
    sleep 0.05; waited=$((waited+1))
    [[ $waited -lt 200 ]] || { fail "relpath: 変異が当たらないまま時間切れ"; kill -KILL "$runner" 2>/dev/null; return 0; }
  done
  local pgid; pgid=$(ps -o pgid= -p "$runner" 2>/dev/null | tr -d ' ')
  [[ -n $pgid ]] || { fail "relpath: pgid が取れない"; return 0; }
  kill -KILL -- -"$pgid" 2>/dev/null
  wait "$runner" 2>/dev/null || true
  waited=0
  until [[ ! -e "$R/src/app.ts$SV_EXT" ]]; do
    sleep 0.05; waited=$((waited+1))
    [[ $waited -lt 200 ]] || { fail "relpath: 10 秒待っても退避が消えない（相対パスで見張りが死んでいる）"; break; }
  done
  assert_eq "$before" "$(md5 "$R/src/app.ts")" "relpath: 相対パスで呼ばれても見張りが戻す"
  assert_eq "" "$(find "$R/src" -name '*'"$SV_EXT" -print)" "relpath: 退避も残っていない"
}

# 設計を読む側。見張りが「親の死」を待っていること、親とは別プロセスであることを、
# ソースから直接固定する。behavioral な検査が通り過ぎても、ここは機械の速さに依存しない。
t_the_watchdog_is_a_separate_process_that_outlives_the_shell() {
  local src="$HERE/../mutate.sh"
  local body; body=$(sed -n '/^start_watchdog() {/,/^}/p' "$src")
  assert_ne "" "$body" "見張りを立てる関数（start_watchdog）が在る"
  assert_contains "$body" "setsid" "見張りは親のプロセスグループの外に出る（グループへの kill で一緒に死なない）"
  # 見張りは自分自身を `mutate.sh restore` として呼び直す。復元の実装を 2 本持たせない
  # （持たせると、stale の判定を欠いた見張りが人の作業を黙って上書きする側に回る）。
  assert_contains "$body" 'restore' "見張りは restore の経路を使って戻す（別実装を持たない）"
  assert_not_contains "$body" 'cp -p --' "見張りは自前で cp しない（restore に任せる）"
  # 見張りは退避を作る cp より前に立てないと、立つ前に殺された分が戻らない。
  local cp_line watch_line
  # shellcheck disable=SC2016  # ソースの文字列を逐語で探す（展開させたら別物を探す）
  cp_line=$( { grep -n '^[^#]*cp -p -- "\$f" "\$f\$SV_EXT"' "$src" || true; } | head -1 | cut -d: -f1)
  watch_line=$( { grep -n '^[[:space:]]*start_watchdog\( \|$\)' "$src" || true; } | head -1 | cut -d: -f1)
  assert_ne "" "$watch_line" "見張りを立てる呼び出しが在る"
  if [[ -n $cp_line && -n $watch_line ]]; then
    [[ $watch_line -lt $cp_line ]] || fail "見張りの設置（$watch_line 行）が、退避を作る cp（$cp_line 行）より後にある"
  fi
  # そして run だけが立てる（apply は当てたまま残すのが仕様）。
  local run_body; run_body=$(sed -n '/^cmd_run() {/,/^}/p' "$src")
  assert_contains "$run_body" "ARM_RESTORE_TRAP=1" "run は見張りと trap を有効にする"
}

# 上の behavioral な検査は「速い機械では窓を通り過ぎて緑になる」ことが原理的に在りうる
# （赤にするには窓の中で殺せないといけない）。だから **並び自身** も直接読む。
# こちらは機械の速さに依存しないので、並びが戻ったら必ず赤になる。
t_the_restore_trap_is_armed_before_anything_is_written() {
  local src="$HERE/../mutate.sh"
  # 退避を作る cp は apply_pairs の中に1つだけある。その行より前に trap の設置が在ること。
  local cp_line trap_line
  # 見つからないときは空にする（pipefail のもとで grep の 1 が検査ごと落とすのを避ける）。
  # 同じ文字列はコメントにも出てくる（#577 の説明）ので、行頭が # の行は数えない。
  # ここを「コメントも拾う」形にすると、コメントの位置で結果が変わる弱い検査になる。
  # shellcheck disable=SC2016  # ソースの文字列を逐語で探すための単引用符（展開させたら別物を探す）
  cp_line=$( { grep -n '^[^#]*cp -p -- "\$f" "\$f\$SV_EXT"' "$src" || true; } | head -1 | cut -d: -f1)
  trap_line=$( { grep -n '^[[:space:]]*arm_restore_trap$' "$src" || true; } | head -1 | cut -d: -f1)
  assert_ne "" "$cp_line" "退避を作る cp の行が見つかる"
  assert_ne "" "$trap_line" "trap を仕掛ける呼び出し（arm_restore_trap）が見つかる"
  if [[ -n $cp_line && -n $trap_line ]]; then
    [[ $trap_line -lt $cp_line ]] || fail "trap の設置（$trap_line 行）が、退避を作る cp（$cp_line 行）より後にある。この順だと「退避が在るのに handler が無い瞬間」が残る"
  fi
  # そして run はその arm を必ず有効にしていること（apply は当てたままにするので有効にしない）。
  local run_body; run_body=$(sed -n '/^cmd_run() {/,/^}/p' "$src")
  assert_contains "$run_body" "ARM_RESTORE_TRAP=1" "run は restore の trap を有効にする"
  local apply_body; apply_body=$(sed -n '/^cmd_apply() {/,/^}/p' "$src")
  assert_not_contains "$apply_body" "ARM_RESTORE_TRAP=1" "apply は有効にしない（当てたまま残すのが仕様）"
}

# 何も当てていない状態でシグナルを受けたら、「戻すものが無い」と言わずに黙って死ぬこと。
# trap を cp より前に出したので、この状態でシグナルが来る道ができた。
# ここで cmd_restore を呼ぶと、上の 2 本が見ている「二重に restore していない」の合図
# （＝戻すものが無い）が偽で出る。
t_signal_before_anything_is_applied_says_nothing_about_restoring() {
  repo
  # 退避が1つも無い状態の restore は「戻すものが無い」と言って 0 を返す（既存の仕様。変えない）。
  run restore
  assert_eq 0 "$STATUS" "退避が無い restore は 0"
  assert_contains "$OUT" "戻すものが無い" "restore 単体ではこの文言が出る（既存の仕様）"
  # 「退避が現れる前」に殺されたときは、シグナル handler はこの文言を出してはいけない。
  # 出すと、上の 3 本が見ている合図（＝二重 restore の検出）が偽で鳴り、検査が意味を失う。
  # 端末からこの瞬間だけを狙って撃つことはできない（撃てたらそれは flaky な検査になる）ので、
  # handler 自身が「退避が在るか」を先に見ていることを読む。
  # この形は道具に検査専用の抜け道を足さずに済む（抜け道は本番の経路を1本増やす）。
  local sig_body; sig_body=$(sed -n '/^on_signal() {/,/^}/p' "$SCRIPT")
  assert_contains "$sig_body" "find_saves" "on_signal は退避が在るかを先に見る"
  # shellcheck disable=SC2016  # ソースの文字列を逐語で探す（$sig を展開したら探すものが変わる）
  assert_contains "$sig_body" 'kill -s "$sig"' "on_signal は最後に同じシグナルで自分を殺し直す"
}

# trap を「早く仕掛ける」方向には、行き過ぎると別の事故になる境界がある。
# **「他人の退避が残っている」拒否より前**で仕掛けると、run は着手を拒否したのに、
# その直後にシグナルを受けたら handler が **他人の退避を自分のものとして戻す**。
# 前の人が測っている最中のファイルを、別の人の Ctrl-C が書き戻すことになる。
# だから arm は「拒否を済ませた後、最初の cp の前」の 1 点でなければならない。
t_run_refuses_a_leftover_save_without_touching_it() {
  repo
  # 誰かが当てたまま残した退避を作る（apply は当てたまま残すのが仕様）。
  run apply src/app.ts 's/ORIGINAL/MUTANT/'
  assert_eq 0 "$STATUS" "先に apply が通る: $OUT"
  local save="$R/src/app.ts$SV_EXT"
  [[ -f $save ]] || { fail "前提の退避が作れていない"; return 0; }
  local save_md5 target_md5
  save_md5=$(md5 "$save"); target_md5=$(md5 "$R/src/app.ts")
  # そこへ別の run が来る。拒否されること、そして退避と対象の両方が1バイトも動かないこと。
  run run --file src/app.ts --expr 's/MUTANT/SECOND/' -- touch ran
  assert_ne 0 "$STATUS" "退避が残っているので run は拒否する"
  assert_contains "$OUT" "退避が残っている" "理由を言う"
  [[ ! -e "$R/ran" ]] || fail "コマンドを走らせない"
  assert_eq "$save_md5" "$(md5 "$save")" "他人の退避に触らない"
  assert_eq "$target_md5" "$(md5 "$R/src/app.ts")" "他人が当てた対象にも触らない"
  # 拒否の時点では handler を仕掛けていないこと（仕掛けていたら他人の退避を戻しうる）。
  local src_body; src_body=$(sed -n '/^apply_pairs() {/,/^}/p' "$SCRIPT")
  local refuse_off arm_off
  # 見つからないときは空にする。ここで grep の 1 を pipefail に拾わせると、
  # **この検査が落ちるのではなく、以降の検査ごと set -e で止まる**（残りが測られない）。
  refuse_off=$( { printf '%s\n' "$src_body" | grep -n '退避が残っている。先に restore' || true; } | head -1 | cut -d: -f1)
  arm_off=$( { printf '%s\n' "$src_body" | grep -n '^[[:space:]]*arm_restore_trap$' || true; } | head -1 | cut -d: -f1)
  assert_ne "" "$refuse_off" "拒否の行が apply_pairs の中にある"
  assert_ne "" "$arm_off" "arm の行が apply_pairs の中にある"
  if [[ -n $refuse_off && -n $arm_off ]]; then
    [[ $arm_off -gt $refuse_off ]] || fail "arm（$arm_off 行目）が「退避が残っている」拒否（$refuse_off 行目）より前にある。この順だと他人の退避を戻しうる"
  fi
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

# ---- #1114: 「当たったが、意図と違うものに当たった」を見せる／止める ------------------------
# md5 は「ファイルが変わったか」までしか見ない。`$` が shell に補間されて式が別物になっても、
# 変わりはするので md5 は通り、緑のまま偽の数字が出る。少なくとも 6 回・4 人以上が踏んだ（#1100 / #1115 の 2 回 / #1122 / #1124 の 2 回）。
#
# 注意: 補間は mutate.sh を呼ぶ **前** に終わっている。受け取った式に `$` は残っていないので、
# 「式に $ が在ったら警告」では 1 件も捕まらない（t_dollar_warning_would_not_have_caught_these が
# それを固定する）。捕まえられるのは「何が実際に変わったか」だけ。

# 変異が当たったら、何行が・どう変わったかを必ず標準エラーに出す。目に入るので飛ばせない。
t_apply_shows_what_actually_changed() {
  repo; run apply src/app.ts 's/ORIGINAL/MUTANT/'
  assert_eq 0 "$STATUS" "apply exits 0: $OUT"
  assert_contains "$OUT" "-export const keep = \"ORIGINAL\";" "消えた行をそのまま見せる"
  assert_contains "$OUT" "+export const keep = \"MUTANT\";" "できた行をそのまま見せる"
}
# 行数も出す。「1 行のつもりが 3 行変わった」が数字で目に入る形（事故の実際の形）。
t_apply_reports_the_number_of_changed_lines() {
  repo
  printf 'const THRESH = 2;\nif (residue > 2) { warn(); }\nconst pair = "k1-k2";\n' > "$R/src/app.ts"
  # 意図は「しきい値の比較だけ」。補間で s/2/999/ に化けると 3 行に当たる。
  run apply src/app.ts 's/2/999/'
  assert_eq 0 "$STATUS" "当たること自体は成功: $OUT"
  assert_contains "$OUT" "3 行" "何行変わったかを数字で出す"
}
# run 経由でも同じ（本番の形。ここで出ないと意味が無い）
t_run_shows_what_actually_changed() {
  repo; run run --file src/app.ts --expr 's/ORIGINAL/MUTANT/' -- true
  assert_eq 0 "$STATUS" "run exits 0: $OUT"
  assert_contains "$OUT" "-export const keep = \"ORIGINAL\";" "run でも差分を見せる"
  assert_contains "$OUT" "+export const keep = \"MUTANT\";" "run でも差分を見せる"
}
# 差分は標準エラーに出す。`-- pnpm test` の標準出力を集計するのを邪魔しない。
t_the_diff_goes_to_stderr_not_stdout() {
  repo
  local so; so=$( (cd "$R" && bash "$SCRIPT" run --file src/app.ts --expr 's/ORIGINAL/MUTANT/' -- true) 2>/dev/null )
  assert_not_contains "$so" "+export const keep" "差分が標準出力を汚さない"
  local se; se=$( (cd "$R" && bash "$SCRIPT" run --file src/app.ts --expr 's/ORIGINAL/MUTANT/' -- true) 2>&1 >/dev/null )
  assert_contains "$se" "+export const keep" "差分は標準エラーに出る"
}
# 巨大な変異で端末が流れてしまわないように上限を付ける。ただし「全体で何行か」は必ず出す。
t_the_diff_is_capped_but_says_how_many_were_hidden() {
  repo; local i
  : > "$R/src/big.ts"
  for i in $(seq 1 60); do printf 'const v%s = "ORIGINAL";\n' "$i" >> "$R/src/big.ts"; done
  run apply src/big.ts 's/ORIGINAL/MUTANT/'
  assert_eq 0 "$STATUS" "当たる: $OUT"
  assert_contains "$OUT" "60 行" "全体の行数は必ず出す"
  assert_contains "$OUT" "省略" "出し切らなかったことを言う"
  local shown; shown=$(printf '%s\n' "$OUT" | grep -c '^+const v' || true)
  [[ $shown -lt 60 ]] || fail "上限が効いていない（$shown 行出た）"
}

# --expect: 「置換後にこの文字列が含まれるはず」を宣言させ、突き合わせる。
# 開発者の約束の「この変異で落ちるはずを先に言う」を、道具の側で受け取る形。
t_expect_passes_when_the_mutation_is_what_was_declared() {
  repo; run apply src/app.ts 's/ORIGINAL/MUTANT/' --expect 'keep = "MUTANT"'
  assert_eq 0 "$STATUS" "宣言どおりなら通る: $OUT"
  assert_contains "$(cat "$R/src/app.ts")" MUTANT "当たっている"
}
# 宣言と違うものに当たったら、測る前に落ちる。これが事故を自動で止める道。
t_expect_fails_when_the_mutation_landed_on_something_else() {
  repo; local before; before=$(md5 "$R/src/app.ts")
  run apply src/app.ts 's/const n/const N/' --expect 'keep = "MUTANT"'
  assert_ne 0 "$STATUS" "宣言と違うなら落ちる"
  assert_contains "$OUT" "--expect" "何と突き合わせたか言う"
  assert_eq "$before" "$(md5 "$R/src/app.ts")" "巻き戻す（半端に当たったまま残さない）"
  assert_eq "" "$(find "$R" -name '*'"$SV_EXT" -print)" "退避も残さない"
}
# run でも同じで、しかもコマンドを走らせない（偽の数字を出させない）
t_run_expect_mismatch_does_not_run_the_command() {
  repo
  run run --file src/app.ts --expr 's/const n/const N/' --expect 'keep = "MUTANT"' -- touch ran
  assert_ne 0 "$STATUS" "落ちる"
  [[ ! -e "$R/ran" ]] || fail "コマンドを走らせない"
}
# --expect の不一致は「当たらなかった(3)」でも「測定中に外れた(4)」でもない別の事象。
# 既存の 5 つの意味を変えないので、新しい番号を使う。
t_expect_mismatch_has_its_own_exit_code() {
  repo; run apply src/app.ts 's/const n/const N/' --expect 'NOPE'
  assert_eq 5 "$STATUS" "--expect 不一致は exit 5"
  repo; run apply src/app.ts 's/NOT-THERE/X/'
  assert_eq 3 "$STATUS" "空振りは今まで通り exit 3"
}

# --from / --to: 逐語の置換。perl の式を書かないので、メタ文字も区切り文字も効かない。
# 3 人が python の逐語置換に逃げたのは、この形が欲しかったから。
t_from_to_substitutes_literally() {
  repo; run apply src/app.ts --from 'ORIGINAL' --to 'MUTANT'
  assert_eq 0 "$STATUS" "通る: $OUT"
  assert_contains "$(cat "$R/src/app.ts")" MUTANT "当たる"
  run restore; assert_eq 0 "$STATUS" "戻る: $OUT"
}
# 正規表現のメタ文字が「文字そのもの」として扱われる（--expr との決定的な違い）
# shellcheck disable=SC2016  # ここの '$' は「展開されないこと」を確かめる対象そのもの（#1114）
t_from_to_treats_regex_metacharacters_as_literal() {
  repo; printf 'if (a.b) { x } // a$b\n' > "$R/src/app.ts"
  run apply src/app.ts --from 'a.b' --to 'ZZ'
  assert_eq 0 "$STATUS" "通る: $OUT"
  assert_contains "$(cat "$R/src/app.ts")" '(ZZ)' "a.b に当たる"
  assert_contains "$(cat "$R/src/app.ts")" 'a$b' 'a$b は . のワイルドカードで巻き込まれない'
}
# --to に $ が入っていても、perl の後方参照として解釈されない（逐語）
# shellcheck disable=SC2016  # '${k2}' を literal として渡せることが検査の中身（#1114）
t_from_to_does_not_interpret_dollar_in_the_replacement() {
  repo; run apply src/app.ts --from 'ORIGINAL' --to '${k2}'
  assert_eq 0 "$STATUS" "通る: $OUT"
  assert_contains "$(cat "$R/src/app.ts")" '${k2}' '${k2} がそのまま入る（空に化けない）'
}
# 区切り文字 / を含む文字列も、エスケープ無しでそのまま渡せる
t_from_to_handles_slashes() {
  repo; printf 'import x from "./a/b/c";\n' > "$R/src/app.ts"
  run apply src/app.ts --from './a/b/c' --to './z'
  assert_eq 0 "$STATUS" "通る: $OUT"
  assert_contains "$(cat "$R/src/app.ts")" '"./z"' "スラッシュ入りでも当たる"
}
# --from が一致しなければ、--expr と同じく exit 3（空振りの扱いを変えない）
t_from_to_no_op_is_still_exit_3() {
  repo; run apply src/app.ts --from 'NOT-IN-THE-FILE' --to 'X'
  assert_eq 3 "$STATUS" "空振りは exit 3"
  assert_contains "$OUT" "変異が当たっていない" "同じ言い方をする"
}
# run でも --from / --to が使える
t_run_accepts_from_to() {
  repo; local before; before=$(md5 "$R/src/app.ts")
  run run --file src/app.ts --from 'ORIGINAL' --to 'MUTANT' -- grep -c MUTANT src/app.ts
  assert_eq 0 "$STATUS" "run でも通る: $OUT"
  assert_contains "$OUT" 1 "コマンドが変異を見た"
  assert_eq "$before" "$(md5 "$R/src/app.ts")" "戻る"
}
# --expr と --from を同じファイルに両方渡すのは、どちらが効くか曖昧なので拒否する
t_expr_and_from_together_is_refused() {
  repo; local before; before=$(md5 "$R/src/app.ts")
  run run --file src/app.ts --expr 's/ORIGINAL/MUTANT/' --from 'ORIGINAL' --to 'X' -- touch ran
  assert_ne 0 "$STATUS" "拒否する"
  [[ ! -e "$R/ran" ]] || fail "コマンドを走らせない"
  assert_eq "$before" "$(md5 "$R/src/app.ts")" "触らない"
}
# --from だけで --to が無い（逆も）は使い方の誤り
t_from_without_to_is_a_usage_error() {
  repo; run apply src/app.ts --from 'ORIGINAL'
  assert_eq 2 "$STATUS" "--to が無いのは使い方の誤り（exit 2）"
}

# ---- 3 件の事故そのものの再現（この道具が本当にそれを捕まえるか） ---------------------------
# 事故の形: 二重引用符の中の ${k2} / $((n+1)) が shell に食われ、式が別物になって、
# しかし「当たりはする」ので md5 は通り、緑のまま偽の数字が出る。
#
# ここで確かめるのは「補間を防げる」ことではない（補間は mutate.sh が呼ばれる前に終わっている）。
# 確かめるのは「意図と違うものに当たったことが、測る前に人の目に入る／自動で止まる」こと。
t_the_1100_accident_is_now_visible() {
  repo
  printf 'const THRESH = 2;\nif (residue > 2) { warn(); }\nconst pair = "k1-k2";\n' > "$R/src/app.ts"
  # 書いた人の意図は「しきい値の比較 1 箇所」。$((residue+1)) が 2 に展開されて s/2/999/ になった形。
  run apply src/app.ts 's/2/999/'
  assert_eq 0 "$STATUS" "当たりはする（md5 は通る）: $OUT"
  assert_contains "$OUT" "3 行" "1 行のつもりが 3 行だったことが数字で出る"
  assert_contains "$OUT" 'k1-k999' "意図していない行に当たったことが、そのまま目に入る"
}
# --expect を付けていれば、同じ事故が自動で止まる（目視に頼らない側）
t_the_1100_accident_is_stopped_by_expect() {
  repo
  printf 'const THRESH = 2;\nif (residue > 2) { warn(); }\nconst pair = "k1-k2";\n' > "$R/src/app.ts"
  local before; before=$(md5 "$R/src/app.ts")
  run run --file src/app.ts --expr 's/2/999/' --expect 'residue > 999' -- touch ran
  # 宣言した文字列自体は含まれてしまうので、ここは通ってよい。止めたいのは別の形なので下で。
  run restore >/dev/null 2>&1 || true
  printf 'const THRESH = 2;\nif (residue > 2) { warn(); }\nconst pair = "k1-k2";\n' > "$R/src/app.ts"
  before=$(md5 "$R/src/app.ts")
  # ${k2} が空に化けて、別の行に当たった形
  run run --file src/app.ts --expr 's/k1-/ZZ/' --expect 'k1-k2ZZ' -- touch ran2
  assert_eq 5 "$STATUS" "宣言と違うので exit 5 で止まる"
  [[ ! -e "$R/ran2" ]] || fail "コマンドを走らせない＝偽の数字が出ない"
  assert_eq "$before" "$(md5 "$R/src/app.ts")" "巻き戻す"
}
# 「式に $ が在ったら警告」では 1 件も捕まらないことを固定する。
# 補間は mutate.sh の外で終わっているので、事故った式に $ は残っていない。
# この検査が緑でなくなったら、その対策は的外れだという記録が消えたということ。
# shellcheck disable=SC2016  # 事故った式・安全な式を literal で持つ。展開させたら検査にならない
t_dollar_warning_would_not_have_caught_these() {
  # 事故った式（shell が展開したあと、mutate.sh が実際に受け取ったもの）
  local landed_1100='s/-/XX/' landed_1115='s/residue > 2/residue > 99/'
  assert_not_contains "$landed_1100" '$' "#1100 が受け取った式に $ は残っていない"
  assert_not_contains "$landed_1115" '$' "#1115 が受け取った式に $ は残っていない"
  # 一方、安全な書き方（単引用符）の式には $ が残る＝警告は誤検出しかしない
  local safe='s/(a)(b)/$2$1/'
  assert_contains "$safe" '$' "単引用符で正しく書いた式にこそ $ が残る"
}

# --expect は「逐語の部分文字列」で突き合わせる。正規表現一致に化けると、
# `.` `*` `$` `[` を含む宣言が**常に通る**——宣言したのに何も守っていない状態になる。
# レビュー（#1127）で、grep から -F を外す変異が 63 件緑のまま素通りすることが分かった。
# この PR が閉じたい穴と同種（道具が意図と違う挙動に化けても誰も気づかない）なので、
# 逐語であることを振る舞いで固定する。
t_expect_matches_literally_not_as_a_regex() {
  repo
  # `.` は正規表現なら任意 1 文字。逐語なら「点そのもの」。
  # 置換後のファイルに `a.c` は無く、`abc` だけが在る形を作る。
  printf 'const s = "abc";\n' > "$R/src/app.ts"
  local before; before=$(md5 "$R/src/app.ts")
  run apply src/app.ts 's/abc/abd/' --expect 'a.d'
  assert_eq 5 "$STATUS" "'a.d' は逐語では一致しないので exit 5（正規表現なら abd に当たって通ってしまう）"
  assert_eq "$before" "$(md5 "$R/src/app.ts")" "巻き戻す"
}
# `*` を含む宣言（正規表現なら直前文字の 0 回以上）。
# 置換後は `xw`。`xz*w` は**正規表現なら当たる**（z が 0 回）が、逐語では当たらない。
# fixture がこの差を作っていないと、-F の有無どちらでも落ちるだけの弱い検査になる。
t_expect_does_not_treat_star_as_a_quantifier() {
  repo; printf 'const s = "xyz";\n' > "$R/src/app.ts"
  run apply src/app.ts 's/xyz/xw/' --expect 'xz*w'
  assert_eq 5 "$STATUS" "'xz*w' は逐語では一致しない（正規表現なら z が 0 回で xw に当たってしまう）"
}
# `$` を含む宣言（正規表現なら行末）。
# 置換後の行は `const s = "xw";`。`xw";$` は**正規表現なら行末に当たる**が、逐語では
# ドル記号そのものが要るので当たらない。
t_expect_does_not_treat_dollar_as_end_of_line() {
  repo; printf 'const s = "xyz";\n' > "$R/src/app.ts"
  run apply src/app.ts 's/xyz/xw/' --expect 'xw";$'
  assert_eq 5 "$STATUS" 'xw";$ は逐語では一致しない（正規表現なら行末扱いで通ってしまう）'
}
# 逐語で本当に在る場合は通る（厳しすぎる側も固定する）
t_expect_passes_on_a_literal_dot_that_really_is_there() {
  repo; printf 'const s = "a.c";\n' > "$R/src/app.ts"
  run apply src/app.ts 's/a\.c/a.d/' --expect 'a.d'
  assert_eq 0 "$STATUS" "点そのものが在れば通る: $OUT"
}

# ---- 偽陽性: 既存の正しい使い方が、この仕組みで止まらないこと -------------------------------
# これが崩れると全員の作業が止まる。
t_no_new_failures_for_plain_expr_usage() {
  repo; run run --file src/app.ts --expr 's/ORIGINAL/MUTANT/' -- grep -c MUTANT src/app.ts
  assert_eq 0 "$STATUS" "--expect 無しの今まで通りの使い方は通る: $OUT"
}
# perl の後方参照（$1 / $2）を使う正当な式も通る。$ を一律に拒否していたら、ここで落ちる。
# shellcheck disable=SC2016  # '$2$1' は perl の後方参照。shell に展開させてはいけない
t_backreferences_in_expr_still_work() {
  repo; printf 'const ab = "foobar";\n' > "$R/src/app.ts"
  run apply src/app.ts 's/(foo)(bar)/$2$1/'
  assert_eq 0 "$STATUS" "後方参照つきの式は通る: $OUT"
  assert_contains "$(cat "$R/src/app.ts")" 'barfoo' "後方参照が効いている"
}
# 複数ファイルに --expect をそれぞれ付けられる（位置で対応する）
t_expect_is_per_file() {
  repo
  run apply src/app.ts 's/ORIGINAL/MUTANT/' --expect 'MUTANT' src/dirty.ts 's/EDIT/CHANGED/' --expect 'CHANGED'
  assert_eq 0 "$STATUS" "それぞれの宣言が効く: $OUT"
  run restore; assert_eq 0 "$STATUS" "戻る: $OUT"
  repo
  run apply src/app.ts 's/ORIGINAL/MUTANT/' --expect 'MUTANT' src/dirty.ts 's/EDIT/CHANGED/' --expect 'WRONG'
  assert_eq 5 "$STATUS" "2 つ目の宣言違反を捕まえる"
  assert_work_intact expect-per-file
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
