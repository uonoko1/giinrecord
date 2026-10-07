#!/usr/bin/env bash
# Tests that the EXIT-trap cleanup in the bash test files can never decide the script's exit code
# (Issue #1244).
#
# **全件緑なのに job が赤になった**（PR #1240。そのファイルを 1 行も触っていない PR）:
#
#   ok   衝突ファイルの一覧は行全体で照合する（部分一致にしない）
#   ok   rebase すれば通る
#   ok   両方残す rebase なら --verify は通る          ← **全件 ok**
#   rm: cannot remove '/tmp/tmp.XXXX/work/.git/objects': Directory not empty
#   ##[error]Process completed with exit code 1.      ← **それでも赤**
#
# 機序: `trap 'rm -rf "$TMP"' EXIT` は **trap の最後のコマンドの終了コードが
# script の終了コードになる**。テスト結果を決めている末尾の `[[ $FAIL == 0 ]]` が 0 を出しても、
# そのあと走る `rm` が転べば 1 になる。`.git/objects` が「Directory not empty」になるのは、
# `rm -rf` が走っている最中に git がまだ object を書き足しているため（並行ビルドで出た）。
#
# **直し方**: `cleanup()` の先頭で `local __rc=$?` を保存し、`rm` の失敗は警告に落として、
# 最後に `exit "$__rc"` する。**trap 文字列の中に直接書かない**: shellcheck が文字列の中の代入を
# 見ないので `SC2154 __rc is referenced but not assigned` が 34 ファイルで出る（実測 35 件）。
# 関数の `local` にすると shellcheck が代入を見るうえ、**`rc` という名前の既存の変数とも衝突しない**
# （`pr-closes.test.sh` など **8 ファイル**が `rc` を使っている。base `7c135ac6` と PR head の両方で 8 本）。
# `rm -rf "$TMP" || true` でも exit code は守れるが、**消し残しに気づけなくなる**ので警告を残す。
#
# **`exit "$__rc"` は終了コードの保存には要らない**（実測。bash は EXIT trap が明示的に `exit`
# しなければ元の終了コードを保つ）。3 形すべて同じ数字が出る:
#
#                                           全件緑 / 1 件失敗 / exit 7
#   採用形                                      0  /    1    /    7
#   `exit "$__rc"` を消した形                   0  /    1    /    7
#   `cleanup() { rm -rf "$TMP" || true; }`      0  /    1    /    7
#   旧形（trap 文字列に直接書く形）              1  /    1    /    1   ← ここだけ壊れる
#
# **効いているのは `|| echo` の側**（trap の中の最後のコマンドを 0 にすること）。
# `exit "$__rc"` は意図を明示する注記であって、これを消しても今日の挙動は変わらない。
# それでも残すのは、**trap の中に後からコマンドを足した人が末尾を非 0 にしても壊れない**ため。
#
# **両側を見る**（#1244 の受け入れ条件 2、`a-check-is-judged-on-both-sides`）:
#   全件緑  ＋ 掃除が失敗  → **exit 0**   （掃除の穴を塞げているか）
#   1 件失敗 ＋ 掃除が失敗  → **exit 1**   （本物の失敗を飲んでいないか）
# **片側だけ確かめると、穴を塞ぐついでに本物の失敗を飲む。**
#
# **`rm` は実際に失敗させる。** 存在しないパスへの `rm -rf` は成功するので再現にならない
# （Issue で踏んだ）。ここでは親を `chmod 555` にして子を消せなくする。
#
#   bash scripts/ci/test/trap-cleanup.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
PASS=0; FAIL=0; FAILED=(); OUT=; RC=0
TMP=$(mktemp -d)
# このファイル自身も、直したい形で書く（**自分が直す欠陥を自分が持っていない**こと）。
# chmod 555 した fixture が残るので、戻してから消す。戻せなくても exit code は守る。
cleanup() { local __rc=$?; chmod -R u+w "$TMP" 2>/dev/null || true; rm -rf "$TMP" || echo "warn: cleanup left $TMP behind (not a test failure)" >&2; exit "$__rc"; }; trap cleanup EXIT

fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_eq()           { [[ "$2" == "$1" ]] || fail "$3: expected [$1] got [$2]"; }
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

# ---- fixture: 本物の test ファイルと同じ骨格を持つ使い捨てスクリプト ------------------------
# $1 = 掃除の行（丸ごと。`cleanup() {...}; trap cleanup EXIT`）  $2 = 落とすテストの件数（0 なら全件緑）
# 「消せないディレクトリ」を毎回作り直し、そこを $TMP に見立てる。
mkscript() { # mkscript <掃除の行（丸ごと）> <failcount> → スクリプトのパスを stdout に出す
  local cleanupline=$1 failcount=$2
  local d; d=$(mktemp -d "$TMP/case.XXXXXX")
  # 親 (victim) を 555 にして、子 (victim/inner) を消せなくする。`rm -rf` が実際に EACCES で転ぶ。
  mkdir -p "$d/victim/inner"; : > "$d/victim/inner/f"; chmod 555 "$d/victim"
  cat > "$d/t.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
TMP="$d/victim/inner"
$cleanupline
PASS=3; FAIL=$failcount
echo "ok   first thing"
echo "ok   second thing"
echo "passed \$PASS, failed \$FAIL"; [[ \$FAIL == 0 ]]
EOF
  echo "$d/t.sh"
}

# run_script <path> → 出力を $OUT、終了コードを $RC に入れる。
# **コマンド置換で呼ばない。** `$(run_script ...)` は subshell なので $RC が親に戻らず、
# `set -u` で「unbound variable」になる（実測。最初の版がこれで転んだ）。
run_script() {
  local s=$1
  set +e; OUT=$(bash "$s" 2>&1); RC=$?; set -e
}

# shellcheck disable=SC2016  # fixture は**文字どおりの綴り**。展開させては、測っているものが変わる
OLD_SHAPE='trap '\''rm -rf "$TMP"'\'' EXIT'
# **実物と逐語で同じ綴りにする。** fixture が実物と違う形だと、通しているのは fixture だけになる
# （`fixtures-and-prose-drift-from-reality`）。下の t_fixture_matches_the_real_files が突き合わせる。
# shellcheck disable=SC2016  # 同上（実物の 37 本に入っている綴りを逐語で持つ）
NEW_SHAPE='cleanup() { local __rc=$?; rm -rf "$TMP" || echo "warn: cleanup left $TMP behind (not a test failure)" >&2; exit "$__rc"; }; trap cleanup EXIT'

# ---- 1. いま踏んだ形が本当に再現すること（この検査が空振りでないことの基点）-----------------
# **これが赤になったら、fixture の `rm` が失敗していない**（= 以後の測定は無意味）。
t_old_shape_turns_green_into_red() {
  run_script "$(mkscript "$OLD_SHAPE" 0)"; local out=$OUT
  assert_contains "$out" "failed 0"        "旧形: テストは全件緑だった"
  assert_contains "$out" "cannot remove"   "旧形: rm が実際に失敗した（存在しないパスでは再現しない）"
  assert_eq 1 "$RC" "旧形: 全件緑でも掃除の失敗で exit 1 になる（PR #1240 が踏んだ形）"
}

# ---- 2. 受け入れ条件 1: 全件緑 ＋ 掃除が失敗 → exit 0 ---------------------------------------
t_fixed_green_with_failing_cleanup_is_zero() {
  run_script "$(mkscript "$NEW_SHAPE" 0)"; local out=$OUT
  assert_contains "$out" "failed 0"      "新形: テストは全件緑だった"
  assert_contains "$out" "cannot remove" "新形: rm は実際に失敗した（黙らせていない）"
  assert_contains "$out" "cleanup left"  "新形: 消し残しは警告として出る"
  assert_eq 0 "$RC" "新形: 全件緑なら掃除が転んでも exit 0"
}

# ---- 3. 受け入れ条件 2: 1 件でも落ちたら exit 1 のまま ----------------------------------------
# **掃除の穴を塞ぐついでに本物の失敗を飲んでいないか。** 掃除が失敗する側・成功する側の両方で見る。
t_fixed_failure_with_failing_cleanup_is_one() {
  run_script "$(mkscript "$NEW_SHAPE" 1)"; local out=$OUT
  assert_contains "$out" "failed 1"      "新形: テストが 1 件落ちた"
  assert_contains "$out" "cannot remove" "新形: 掃除も失敗した"
  assert_eq 1 "$RC" "新形: テストが落ちていれば exit 1 のまま（掃除の失敗に紛れて飲まない）"
}

t_fixed_failure_with_clean_cleanup_is_one() {
  local d; d=$(mktemp -d "$TMP/ok.XXXXXX")
  cat > "$d/t.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
TMP="$d/doomed"
mkdir -p "\$TMP"
$NEW_SHAPE
PASS=2; FAIL=1
echo "passed \$PASS, failed \$FAIL"; [[ \$FAIL == 0 ]]
EOF
  run_script "$d/t.sh"; local out=$OUT
  assert_not_contains "$out" "cleanup left" "掃除が成功したときは警告を出さない"
  assert_eq 1 "$RC" "掃除が成功しても、テストが落ちていれば exit 1"
  # `[[ ... ]] && fail` と書くと、消えていた（= 望ましい）ときに [[ ]] が 1 を返し、
  # それが関数の最後のコマンドになって set -e で test_case ごと落ちる（実測）。if で書く。
  if [[ -d "$d/doomed" ]]; then fail "掃除が実際に消していない（|| true で黙らせただけでは駄目）"; fi
}

# ---- 4. 0 以外・1 以外の終了コードも通す ------------------------------------------------------
# po-test-runner.test.sh と mutate.test.sh は末尾が `exit 1`。将来 `exit 2` を使う形が出たときに
# trap が 0/1 に丸めないこと（`|| true` 形は丸めないが、`exit $FAIL` のような形に書き換えると丸まる）。
t_fixed_preserves_arbitrary_exit_code() {
  local d; d=$(mktemp -d "$TMP/rc.XXXXXX")
  mkdir -p "$d/victim/inner"; : > "$d/victim/inner/f"; chmod 555 "$d/victim"
  cat > "$d/t.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
TMP="$d/victim/inner"
$NEW_SHAPE
exit 7
EOF
  run_script "$d/t.sh"
  assert_eq 7 "$RC" "掃除が転んでも、script が返した 7 がそのまま出る"
}

# ---- 5. 関係式: CI が回す全ファイルが、この形を持っていること ---------------------------------
# **1 本だけ直すと残りで同じことが起きる**（`two-numbers-in-two-files-drift` と同じ型）。
# **本数をここに書かない。** `ci.yml:179` と同じ 3 つの glob から**毎回数え直す**ので、
# ファイルが増えても減ってもこの検査が自分で追いつく。
#
# **何を「掃除の行」と見るか**: `rm -rf "$TMP"` を含む行のうち、**実際に EXIT で走るもの**だけ。
#   拾う: `trap '...rm -rf "$TMP"...' EXIT` / `cleanup() { ... rm -rf "$TMP"; }`
#   拾わない: コメント行（`#` で始まる）と、**heredoc の中の文字列**
#             （このファイル自身が旧形を fixture として持っているので、ここを広く取ると
#              自分で自分を違反と呼ぶ。実測: 広い版は 41 件中 3 件がコメント／fixture だった）
#
# 守られている形: `rm -rf "$TMP" || ` が同じ行に在る（失敗を受け止めてから exit code を返す）。
ci_loop_files() {
  # ci.yml:179 の 3 つの glob と**同じ綴り**。ここを痩せさせると母数が減るので、下で 0 件を拒否する。
  ( cd "$ROOT" && printf '%s\n' scripts/ci/test/*.test.sh scripts/dev/test/*.test.sh deploy/test/*.test.sh )
}

# cleanup_lines <file> → EXIT で実際に走る掃除の行（`<行番号>:<行>`）を出す。
cleanup_lines() {
  # shellcheck disable=SC2016  # ファイルの中の**文字どおりの** rm -rf "$TMP" を探している
  grep -n 'rm -rf "$TMP"' "$1" \
    | grep -E ':[[:space:]]*(TMP=|trap |cleanup\(\))' \
    | grep -v -E ':[[:space:]]*#' || true
}

# is_guarded <行> → 守られていれば 0。**この判定自身を下で両側から試す。**
  # shellcheck disable=SC2016  # 同上（守られている形を文字どおり照合する）
is_guarded() { [[ $1 == *'rm -rf "$TMP" || '* ]]; }

# scan_unguarded <file...> → 守られていない行を `<file>:<行番号>` で出す（1 行 1 件）。
scan_unguarded() {
  local f ln
  for f in "$@"; do
    while IFS= read -r ln; do
      [[ -n $ln ]] || continue
      is_guarded "$ln" && continue
      echo "$f:${ln%%:*}"
    done <<< "$(cleanup_lines "$f")"
  done
}

# ---- 判定そのものを両側から試す（#1244 の変異 E で露出した穴）--------------------------------
# **`is_guarded` を「常に真」に変えても、きれいな木では 7 passed / 0 failed のまま緑だった**（実測）。
# 判定が全部を通してしまうのを、**全部が通る木**では見分けられない。だから**合成の悪い行**を
# 必ず 1 本食わせて、「落とせること」も毎回測る。これが無いと t_every_... は片側しか見ていない。
t_the_predicate_rejects_the_old_shape() {
  local d; d=$(mktemp -d "$TMP/pred.XXXXXX")
  # shellcheck disable=SC2016  # 合成の悪い行／良い行。**文字どおり**書き出す
  printf '%s\n' 'TMP=$(mktemp -d); trap '"'"'rm -rf "$TMP"'"'"' EXIT' > "$d/bad.sh"
  # shellcheck disable=SC2016  # 同上
  printf '%s\n' 'TMP=$(mktemp -d); cleanup() { local __rc=$?; rm -rf "$TMP" || echo x >&2; exit "$__rc"; }; trap cleanup EXIT' > "$d/good.sh"
  local bad good
  bad=$(scan_unguarded "$d/bad.sh");  good=$(scan_unguarded "$d/good.sh")
  assert_contains "$bad"  "bad.sh:1" "旧形の行を「守られていない」と判定できる（判定が常に真になっていない）"
  assert_eq ""    "$good"            "新形の行は「守られている」と判定する（判定が常に偽になっていない）"
}

# **新しく足した 2 つの判定も、両側から試す**（`a-check-is-judged-on-both-sides`）。
# 「全部が通る木」では、常に真の判定と、正しい判定が、同じ緑に見える。
t_the_new_predicates_are_judged_on_both_sides() {
  local d; d=$(mktemp -d "$TMP/pred2.XXXXXX")

  # (a) has_exit_trap: trap が EXIT でない／無いファイルを落とせるか。
  # shellcheck disable=SC2016  # **文字どおり**書き出す
  printf '%s\n' 'cleanup() { local __rc=$?; rm -rf "$TMP" || echo x >&2; exit "$__rc"; }' 'trap cleanup EXIT' > "$d/trap-ok.sh"
  # shellcheck disable=SC2016  # 同上（EXIT を INT にしただけ。掃除は一度も走らない）
  printf '%s\n' 'cleanup() { local __rc=$?; rm -rf "$TMP" || echo x >&2; exit "$__rc"; }' 'trap cleanup INT' > "$d/trap-int.sh"
  # shellcheck disable=SC2016  # 同上（1 行に繋がる形。実物 34 本がこれ）
  printf '%s\n' 'TMP=$(mktemp -d); cleanup() { local __rc=$?; rm -rf "$TMP" || echo x >&2; exit "$__rc"; }; trap cleanup EXIT' > "$d/trap-inline.sh"
  if ! has_exit_trap "$d/trap-ok.sh";     then fail "has_exit_trap: 行頭の trap cleanup EXIT を見落とした（判定が常に偽）"; fi
  if ! has_exit_trap "$d/trap-inline.sh"; then fail "has_exit_trap: 繋がった形の trap cleanup EXIT を見落とした（実物 34 本がこの形）"; fi
  if   has_exit_trap "$d/trap-int.sh";    then fail "has_exit_trap: trap cleanup INT を通した（判定が常に真）"; fi

  # (b) SHAPE_HEAD / SHAPE_TAIL: `local __rc=$?` を 2 文に割った形を落とせるか。
  # **これが一番効く変異**。`local` 自身が 0 を返すので、割った瞬間に本物の失敗が rc=0 になる。
  local ok split notail
  # shellcheck disable=SC2016  # **文字どおり**の綴り
  ok='cleanup() { local __rc=$?; rm -rf "$TMP" || echo "warn: cleanup left $TMP behind (not a test failure)" >&2; exit "$__rc"; }'
  # shellcheck disable=SC2016  # 同上（代入を 2 文に割った形）
  split='cleanup() { local __rc; __rc=$?; rm -rf "$TMP" || echo "warn: cleanup left $TMP behind (not a test failure)" >&2; exit "$__rc"; }'
  # shellcheck disable=SC2016  # 同上（失敗を受け止めず、戻しもしない形）
  notail='cleanup() { local __rc=$?; rm -rf "$TMP"; }'
  if [[ $ok     != "$SHAPE_HEAD"* ]]; then fail "SHAPE_HEAD: 採用形を落とした（判定が常に偽）"; fi
  if [[ $ok     != *"$SHAPE_TAIL" ]]; then fail "SHAPE_TAIL: 採用形を落とした（判定が常に偽）"; fi
  if [[ $split  == "$SHAPE_HEAD"* ]]; then fail "SHAPE_HEAD: local __rc; __rc=\$? に割った形を通した（本物の失敗が rc=0 になる形）"; fi
  if [[ $notail == *"$SHAPE_TAIL" ]]; then fail "SHAPE_TAIL: 失敗を受け止めない形を通した（判定が常に真）"; fi
}

# has_exit_trap <file> → `trap cleanup EXIT` が実在すれば 0。
# **`cleanup()` を定義しただけでは一度も走らない。** `cleanup_lines` が当たるのは**定義行**で、
# `is_guarded` はその行の中身しか見ないので、`trap cleanup EXIT` を `trap cleanup INT` に
# 変えても **8 passed / 0 failed のまま、掃除が一度も走らなかった**（レビュー実測。
# `LEAKED: /tmp/tmp.XXXX still exists after normal exit`）。
# `nginx-*` の 4 本は trap が**別の行**に在るので、定義行だけを見る検査では対応が取れない。
# 行頭に単独で在る形と、`; trap cleanup EXIT` と繋がる形の両方を受ける（実物 38/38 で確認）。
# **`\s` ではなく `[[:space:]]`。** `\s` は GNU/PCRE の拡張で、POSIX の ERE には無い。
has_exit_trap() { grep -qE '^[[:space:]]*trap cleanup EXIT|; trap cleanup EXIT' "$1"; }

t_every_ci_test_file_guards_its_cleanup() {
  local total=0 withcleanup=0 bad=0 notrap=0 badlist="" traplist="" f
  while IFS= read -r f; do
    [[ -n $f ]] || continue
    total=$((total+1))
    [[ -n $(cleanup_lines "$ROOT/$f") ]] || continue
    withcleanup=$((withcleanup+1))
    has_exit_trap "$ROOT/$f" || { notrap=$((notrap+1)); traplist+="    $f"$'\n'; }
    local hits; hits=$(scan_unguarded "$ROOT/$f")
    [[ -n $hits ]] || continue
    while IFS= read -r h; do
      [[ -n $h ]] || continue
      bad=$((bad+1)); badlist+="    ${h#"$ROOT/"}"$'\n'
    done <<< "$hits"
  done < <(ci_loop_files)
  # 母数（#757）: **「0 件違反」と「1 本も読めていない」を同じ緑にしない。**
  echo "    scanned $total file(s), $withcleanup with an EXIT-time rm -rf \"\$TMP\", $bad unguarded, $notrap without trap cleanup EXIT"
  [[ $total -ge 35 ]] || fail "glob が痩せている: $total 本しか数えられなかった（ci.yml:179 の下限は 35）"
  [[ $withcleanup -ge 35 ]] || fail "掃除を持つファイルが $withcleanup 本しかない。母数が崩れている（実測 38/38）"
  # **下限（-ge）だけでは 3 本まで静かに逃げられる**（レビュー実測。素通りした変異が 2 件）:
  #   新しいファイルが `WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT` と書く → scanned 39 / 38 で緑
  #   `rm -rf` を `cleanup() {` の**次の行**に書く                           → 同じく緑
  # どちらも `withcleanup` は 38 のまま `total` だけ増える。**差が出た瞬間に落とす。**
  # 今日の木では **38 == 38**（glob 内の全ファイルが mktemp を使い、例外は 0 本。実測）。
  # 掃除の要らないテストを足したくなったら、この等式を緩めるのではなく、
  # **なぜ要らないかを書いた除外の一覧**をここに持つこと（黙って -3 の余白に逃がさない）。
  [[ $total == "$withcleanup" ]] || fail "glob の $total 本のうち $withcleanup 本しか掃除を持っていない。\
差の $((total-withcleanup)) 本は、別の変数で掃除しているか、rm が別の行に在る（どちらもこの検査を素通りする）"
  [[ $notrap == 0 ]] || fail "cleanup() を定義しているのに trap cleanup EXIT が無いファイルが $notrap 件（掃除が一度も走らない）:
$traplist"
  [[ $bad == 0 ]] || fail "掃除の失敗が exit code を決めてしまうファイルが $bad 件:
$badlist"
}

# ---- 6. fixture が実物から離れないこと -------------------------------------------------------
# **$NEW_SHAPE で緑を測っても、実物が別の綴りなら測ったのは fixture だけ**
# （`fixtures-and-prose-drift-from-reality`）。
#
# **1 本だけ照合しても、残りは誰も綴りを見ていない**（レビュー指摘。実測で 1/38 本だった）。
# `is_guarded` は `rm -rf "$TMP" || ` という**部分文字列**しか見ないので、**先頭の `local __rc=$?`
# が消えても気づかない**。そして**その 1 行が、この PR で守っているもの全部**である:
#
#   cleanup() { local __rc=$?; … }   本物の失敗 → **rc=1**（正しい）
#   cleanup() { local __rc; __rc=$?; … }   本物の失敗 → **rc=0**（実測。失敗を飲む）
#
# `local` 自身が 0 を返すので、**代入を 2 文に分けた瞬間に `$?` が `local` の 0 に化ける。**
# だから**部分一致ではなく、38 本すべてを逐語で**押さえる。
#
# **1 つの式で 38 本を押さえるために 2 点で照合する**（前と後ろ）。
# 中間を自由にしているのは、`nginx-404` / `nginx-headers` の 2 本が
# `docker rm -f "$NAME" …;` を、このファイル自身が `chmod -R u+w "$TMP" …;` を
# 挟むため（実測。中身が違うのはこの 3 本だけ）。**前後が決まっていれば、
# `$?` の取り方も、失敗の受け止め方も、返し方も固定される。**
SHAPE_HEAD='cleanup() { local __rc=$?;'
# shellcheck disable=SC2016  # 実物の綴りを**文字どおり**持つ（展開させては照合にならない）
SHAPE_TAIL='|| echo "warn: cleanup left $TMP behind (not a test failure)" >&2; exit "$__rc"; }'

# real_cleanup_def <file> → そのファイルの**本物の** cleanup 定義行を 1 行出す
# （この検査ファイル自身が持つ fixture の文字列は除く）。
#
# **`cleanup() { local __rc=` では探さない。** そこまで含めて探すと、**まさに検査したい変異で
# 行が見つからなくなり、ファイルが母数から静かに落ちる**（実測。`local __rc; __rc=$?` を当てたら
# `verbatim-checked` が 38 → 37 になり、下限 `-ge 35` に吸収されて **9 passed / 0 failed** で素通りした）。
# 探すのは `cleanup() {` だけにして、**中身の綴りは照合の側で落とす。**
# 「見つからない」も「綴りが違う」も、どちらも失敗にする（下の n == total）。
real_cleanup_def() {
  grep -h '^[[:space:]]*cleanup() {\|; cleanup() {' "$1" \
    | grep -v -E "^(NEW_SHAPE=|[[:space:]]*printf )" \
    | head -1
}

# shape_of <行> → 先頭の `TMP=$(mktemp -d); ` と末尾の `; trap cleanup EXIT` を剥がした芯を出す。
shape_of() {
  local l=$1
  # shellcheck disable=SC2016  # 剥がすのは**文字どおりの**綴り
  l=${l#'TMP=$(mktemp -d); '}
  l=${l%'; trap cleanup EXIT'}
  printf '%s\n' "$l"
}

t_fixture_matches_the_real_files() {
  # **`|| true` が要る。** 実物が旧形に戻された変異では grep が 0 件になり、`set -e` と
  # `pipefail` でここが script ごと落ちる（実測: 変異 A で summary も出ず「passed」行が消えた）。
  # 落ちると **残りの test_case が走らず、集計も出ない**ので、失敗として報告されない。
  local real
  # shellcheck disable=SC2016  # sed の置換パターンは**文字どおり**。$(mktemp -d) を展開させない
  real=$(grep -h 'cleanup() { local __rc=' "$ROOT/scripts/ci/test/stale-base.test.sh" | sed 's/^TMP=\$(mktemp -d); //' || true)
  assert_eq "$NEW_SHAPE" "$real" "fixture の NEW_SHAPE が実物（stale-base.test.sh）の trap 行と逐語で一致する"

  # **そして残りの 37 本も見る。** 1 本だけだと、他が崩れても誰も気づかない。
  local total=0 n=0 headbad=0 tailbad=0 missing=0 badlist="" f line shape
  while IFS= read -r f; do
    [[ -n $f ]] || continue
    total=$((total+1))
    line=$(real_cleanup_def "$ROOT/$f" || true)
    if [[ -z $line ]]; then
      missing=$((missing+1)); badlist+="    $f: cleanup() の定義行が見つからない"$'\n'; continue
    fi
    n=$((n+1))
    shape=$(shape_of "$line")
    if [[ $shape != "$SHAPE_HEAD"* ]]; then
      headbad=$((headbad+1)); badlist+="    $f: 先頭が [$SHAPE_HEAD] で始まっていない: [$shape]"$'\n'
    fi
    if [[ $shape != *"$SHAPE_TAIL" ]]; then
      tailbad=$((tailbad+1)); badlist+="    $f: 末尾が [$SHAPE_TAIL] で終わっていない: [$shape]"$'\n'
    fi
  done < <(ci_loop_files)
  # 母数（#757）: **「0 件違反」と「1 本も読めていない」を同じ緑にしない。**
  echo "    verbatim-checked $n/$total cleanup definition(s): $headbad bad head, $tailbad bad tail, $missing missing"
  # **下限ではなく等式**。`-ge 35` だと 3 本までこぼれても緑で、
  # **こぼし方が「変異を当てた結果」そのもの**だった（上の real_cleanup_def のコメント）。
  [[ $n == "$total" ]] || fail "glob の $total 本のうち $n 本しか cleanup() の定義行を取れていない（差 $((total-n)) 本）"
  [[ $headbad == 0 && $tailbad == 0 && $missing == 0 ]] || fail "cleanup の綴りが実物とずれているファイルが $((headbad+tailbad+missing)) 件:
$badlist"
}

test_case "旧形は全件緑でも掃除の失敗で exit 1 になる（再現。fixture の rm が本当に失敗している基点）" t_old_shape_turns_green_into_red
test_case "受け入れ条件1: 全件緑 ＋ 掃除が失敗 → exit 0" t_fixed_green_with_failing_cleanup_is_zero
test_case "受け入れ条件2: テストが 1 件落ちた ＋ 掃除も失敗 → exit 1" t_fixed_failure_with_failing_cleanup_is_one
test_case "受け入れ条件2(対): テストが 1 件落ちた ＋ 掃除は成功 → exit 1（かつ実際に消えている）" t_fixed_failure_with_clean_cleanup_is_one
test_case "0/1 以外の終了コードも丸めない" t_fixed_preserves_arbitrary_exit_code
test_case "判定そのものが旧形を落とし新形を通す（判定が常に真/常に偽になっていない）" t_the_predicate_rejects_the_old_shape
test_case '新しい 2 つの判定も両側から試す（trap EXIT の実在／local __rc=$? を割った形）' t_the_new_predicates_are_judged_on_both_sides
test_case "CI が回す全ファイルで、掃除の失敗が exit code を決めない（本数は glob から数え直す）" t_every_ci_test_file_guards_its_cleanup
test_case "fixture の trap 行が実物と逐語で一致する（fixture だけ直して緑にしていない）" t_fixture_matches_the_real_files

echo "passed $PASS, failed $FAIL"
if [[ $FAIL -gt 0 ]]; then printf '  - %s\n' "${FAILED[@]}"; exit 1; fi
