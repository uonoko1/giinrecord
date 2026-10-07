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
# **直し方**: trap の先頭で `rc=$?` を保存し、`rm` の失敗は警告に落として、最後に `exit $rc` する。
# `rm -rf "$TMP" || true` でも exit code は守れるが、**消し残しに気づけなくなる**ので警告を残す。
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
trap '__rc=$?; chmod -R u+w "$TMP" 2>/dev/null || true; rm -rf "$TMP" || echo "warn: cleanup left $TMP behind (not a test failure)" >&2; exit $__rc' EXIT

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
# $1 = trap 行（丸ごと）  $2 = 落とすテストの件数（0 なら全件緑）
# 「消せないディレクトリ」を毎回作り直し、そこを $TMP に見立てる。
mkscript() { # mkscript <trap-line> <failcount> → スクリプトのパスを stdout に出す
  local trapline=$1 failcount=$2
  local d; d=$(mktemp -d "$TMP/case.XXXXXX")
  # 親 (victim) を 555 にして、子 (victim/inner) を消せなくする。`rm -rf` が実際に EACCES で転ぶ。
  mkdir -p "$d/victim/inner"; : > "$d/victim/inner/f"; chmod 555 "$d/victim"
  cat > "$d/t.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
TMP="$d/victim/inner"
$trapline
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

OLD_TRAP='trap '\''rm -rf "$TMP"'\'' EXIT'
# **実物と逐語で同じ綴りにする。** fixture が実物と違う形だと、通しているのは fixture だけになる
# （`fixtures-and-prose-drift-from-reality`）。下の t_fixture_matches_the_real_files が突き合わせる。
NEW_TRAP='trap '\''__rc=$?; rm -rf "$TMP" || echo "warn: cleanup left $TMP behind (not a test failure)" >&2; exit $__rc'\'' EXIT'

# ---- 1. いま踏んだ形が本当に再現すること（この検査が空振りでないことの基点）-----------------
# **これが赤になったら、fixture の `rm` が失敗していない**（= 以後の測定は無意味）。
t_old_shape_turns_green_into_red() {
  run_script "$(mkscript "$OLD_TRAP" 0)"; local out=$OUT
  assert_contains "$out" "failed 0"        "旧形: テストは全件緑だった"
  assert_contains "$out" "cannot remove"   "旧形: rm が実際に失敗した（存在しないパスでは再現しない）"
  assert_eq 1 "$RC" "旧形: 全件緑でも掃除の失敗で exit 1 になる（PR #1240 が踏んだ形）"
}

# ---- 2. 受け入れ条件 1: 全件緑 ＋ 掃除が失敗 → exit 0 ---------------------------------------
t_fixed_green_with_failing_cleanup_is_zero() {
  run_script "$(mkscript "$NEW_TRAP" 0)"; local out=$OUT
  assert_contains "$out" "failed 0"      "新形: テストは全件緑だった"
  assert_contains "$out" "cannot remove" "新形: rm は実際に失敗した（黙らせていない）"
  assert_contains "$out" "cleanup left"  "新形: 消し残しは警告として出る"
  assert_eq 0 "$RC" "新形: 全件緑なら掃除が転んでも exit 0"
}

# ---- 3. 受け入れ条件 2: 1 件でも落ちたら exit 1 のまま ----------------------------------------
# **掃除の穴を塞ぐついでに本物の失敗を飲んでいないか。** 掃除が失敗する側・成功する側の両方で見る。
t_fixed_failure_with_failing_cleanup_is_one() {
  run_script "$(mkscript "$NEW_TRAP" 1)"; local out=$OUT
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
$NEW_TRAP
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
$NEW_TRAP
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

t_every_ci_test_file_guards_its_cleanup() {
  local total=0 withcleanup=0 bad=0 badlist=""
  while IFS= read -r f; do
    [[ -n $f ]] || continue
    total=$((total+1))
    # EXIT で実際に走る掃除の行だけを拾う: trap 本体か cleanup 関数の定義で、かつ rm -rf "$TMP" を含む。
    local lines
    lines=$(grep -n 'rm -rf "\$TMP"' "$ROOT/$f" \
            | grep -E ':[[:space:]]*(TMP=|trap |cleanup\(\))' \
            | grep -v -E ':[[:space:]]*#' || true)
    [[ -n $lines ]] || continue
    withcleanup=$((withcleanup+1))
    while IFS= read -r ln; do
      [[ -n $ln ]] || continue
      [[ $ln == *'rm -rf "$TMP" || '* ]] && continue
      bad=$((bad+1)); badlist+="    $f:${ln%%:*}"$'\n'
    done <<< "$lines"
  done < <(ci_loop_files)
  # 母数（#757）: **「0 件違反」と「1 本も読めていない」を同じ緑にしない。**
  echo "    scanned $total file(s), $withcleanup with an EXIT-time rm -rf \"\$TMP\", $bad unguarded"
  [[ $total -ge 34 ]] || fail "glob が痩せている: $total 本しか数えられなかった（ci.yml:179 の下限は 34）"
  [[ $withcleanup -ge 34 ]] || fail "掃除を持つファイルが $withcleanup 本しかない。母数が崩れている（実測 38/38）"
  [[ $bad == 0 ]] || fail "掃除の失敗が exit code を決めてしまうファイルが $bad 件:
$badlist"
}

# ---- 6. fixture が実物から離れないこと -------------------------------------------------------
# **$NEW_TRAP で緑を測っても、実物が別の綴りなら測ったのは fixture だけ**
# （`fixtures-and-prose-drift-from-reality`）。実物の 1 本から trap 行を逐語で取り出して照合する。
t_fixture_matches_the_real_files() {
  local real
  real=$(grep -h "trap '__rc=" "$ROOT/scripts/ci/test/stale-base.test.sh" | sed 's/^TMP=\$(mktemp -d); //')
  assert_eq "$NEW_TRAP" "$real" "fixture の NEW_TRAP が実物（stale-base.test.sh）の trap 行と逐語で一致する"
}

test_case "旧形は全件緑でも掃除の失敗で exit 1 になる（再現。fixture の rm が本当に失敗している基点）" t_old_shape_turns_green_into_red
test_case "受け入れ条件1: 全件緑 ＋ 掃除が失敗 → exit 0" t_fixed_green_with_failing_cleanup_is_zero
test_case "受け入れ条件2: テストが 1 件落ちた ＋ 掃除も失敗 → exit 1" t_fixed_failure_with_failing_cleanup_is_one
test_case "受け入れ条件2(対): テストが 1 件落ちた ＋ 掃除は成功 → exit 1（かつ実際に消えている）" t_fixed_failure_with_clean_cleanup_is_one
test_case "0/1 以外の終了コードも丸めない" t_fixed_preserves_arbitrary_exit_code
test_case "CI が回す全ファイルで、掃除の失敗が exit code を決めない（本数は glob から数え直す）" t_every_ci_test_file_guards_its_cleanup
test_case "fixture の trap 行が実物と逐語で一致する（fixture だけ直して緑にしていない）" t_fixture_matches_the_real_files

echo "passed $PASS, failed $FAIL"
if [[ $FAIL -gt 0 ]]; then printf '  - %s\n' "${FAILED[@]}"; exit 1; fi
