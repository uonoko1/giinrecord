#!/usr/bin/env bash
# Tests for scripts/po/test/run.sh itself (Issue #1124).
#
# **測る道具自身が「走っていないのに緑」を出していた。**
#   $ bash scripts/po/test/run.sh merge-when-green
#     passed: 0  failed: 0     ← 1 件も当たらないのに exit 0
#   $ bash scripts/po/test/merge-when-green.test.sh
#     test_case: command not found（× 138 行）  ← 1 つの assertion も走らない
# どちらも #757 の軸（「0 件実行」と「0 件失敗」を区別する）そのもの。
#
# **なぜ scripts/po/test/ の中に置かないか**: run.sh は `$HERE/*.test.sh` を **source** する。
# その中に「run.sh を走らせるテスト」を置くと、子の run.sh がまた同じ glob を拾って再帰する。
# だから **run.sh を呼ぶ側**として、別ディレクトリの自己完結テストにする
# （CI の `for t in scripts/ci/test/*.test.sh ...` ループが拾う）。
#
# **fixture は使い捨ての run.sh のコピー**にする（本物の 8 本の *.test.sh には依存しない）。
# 依存すると、テストの本数が変わるたびにここが赤くなり、**測っているものが run.sh でなくなる。**
#   bash scripts/ci/test/po-test-runner.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
RUNNER="$ROOT/scripts/po/test/run.sh"
PO_TEST_DIR="$ROOT/scripts/po/test"
PASS=0; FAIL=0; FAILED=()
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

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

# ---- fixture -------------------------------------------------------------------------------
# 使い捨ての test ディレクトリを作り、**本物の run.sh をそのままコピーする**。
# 中の *.test.sh は合成（速い・本数が固定できる）。fake-bin も要らない
# （合成テストは run_script を呼ばないので）。
# **ファイル名の語幹を、どのテスト名にも含めない。**
# 最初の版は alpha.test.sh の中で "alpha: first thing" と名付けていたので、
# `run.sh alpha` は**ファイル名照合が無くても**名前照合で当たった。
# 実測: ファイル名照合を消す変異で、語幹のテストが**生き残った**（等価ではなく fixture の欠陥）。
# だから file = alpha/beta、name = "ONE: ..."/"TWO: ..." と綴りを分ける。
mkfixture() { # mkfixture → $TMP/po/test/{run.sh, alpha.test.sh, beta.test.sh}
  rm -rf "$TMP/po"
  mkdir -p "$TMP/po/test/fake-bin"
  cp "$RUNNER" "$TMP/po/test/run.sh"
  cat > "$TMP/po/test/alpha.test.sh" <<'EOF'
# shellcheck shell=bash
t_one() { :; }
t_two() { :; }
test_case "ONE: first thing" t_one
test_case "ONE: second thing" t_two
EOF
  cat > "$TMP/po/test/beta.test.sh" <<'EOF'
# shellcheck shell=bash
t_three() { :; }
test_case "TWO: only thing" t_three
EOF
}

run_fixture() { # run_fixture [args...] → OUT / STATUS
  set +e
  OUT=$(bash "$TMP/po/test/run.sh" "$@" 2>&1)
  STATUS=$?
  set -e
}

# ==== 1. フィルタが 1 件も当たらない =========================================================

t_no_match_filter_fails() {
  mkfixture
  run_fixture zzz-nothing-matches-this
  assert_ne 0 "$STATUS" "当たらないフィルタは exit 0 で終わらない"
  assert_eq 1 "$STATUS" "当たらないフィルタは exit 1"
  # **「passed: 0 failed: 0」だけを見て緑だと思わせない。** 理由が読めること。
  assert_contains "$OUT" "zzz-nothing-matches-this" "当たらなかったフィルタ文字列を出す"
  assert_contains "$OUT" "0" "実行件数 0 が読めること"
}

t_no_match_filter_lists_what_exists() {
  # **落ちるだけでは次の一手が分からない。** 何なら当たるかを出すこと。
  mkfixture
  run_fixture zzz-nothing-matches-this
  assert_contains "$OUT" "ONE: first thing" "存在するテスト名を案内に出す"
  assert_contains "$OUT" "TWO: only thing" "存在するテスト名を案内に出す"
}

# ==== 2. フィルタがファイル名でも効く =======================================================

t_filter_matches_file_basename() {
  # #1124 の入口そのもの。`merge-when-green` はファイル名であってテスト名ではなかった。
  mkfixture
  run_fixture alpha.test.sh
  assert_eq 0 "$STATUS" "ファイル名（拡張子つき）で絞れる"
  assert_contains "$OUT" "ONE: first thing" "alpha.test.sh の 2 本が走る"
  assert_contains "$OUT" "ONE: second thing" "alpha.test.sh の 2 本が走る"
  assert_not_contains "$OUT" "TWO: only thing" "beta.test.sh は走らない"
  assert_contains "$OUT" "passed: 2" "2 本だけ走った"
}

t_filter_matches_file_stem() {
  # PO が実際に打った形（`merge-when-green` = 拡張子なしの語幹）。
  mkfixture
  run_fixture alpha
  assert_eq 0 "$STATUS" "ファイル名の語幹で絞れる"
  assert_contains "$OUT" "passed: 2" "alpha.test.sh の 2 本"
  assert_not_contains "$OUT" "TWO: only thing" "beta.test.sh は走らない"
}

t_defined_count_is_the_total_not_the_selected() {
  # **レビュー #1130 の指摘 1。** `(of K defined)` が**この PR の目玉**なのに、
  # **K を一度も検査していなかった。** `${#NAMES[@]}` を `$RAN` に変えると
  # `passed: 138  failed: 0  (of 138 defined)` と出て「全部走った」と嘘をつき、
  # **検査 14/14 が素通りした**（PO が再現、私も再現した）。
  # **K は「定義された総数」であって「走った数」ではない。** 絞ったときに差が出ることを見る。
  mkfixture
  run_fixture alpha           # 定義 3 本のうち 2 本だけ走る
  assert_eq 0 "$STATUS" "絞っても通る"
  assert_contains "$OUT" "passed: 2" "走ったのは 2 本"
  assert_contains "$OUT" "(of 3 defined)" "定義は 3 本（走った数 2 と違う値であること）"
  assert_not_contains "$OUT" "(of 2 defined)" "定義の欄に「走った数」を書かない"
}

t_defined_count_matches_the_unfiltered_total() {
  # 上の裏取り。**「3」は fixture のファイルから導いた数**ではなく、
  # **引数なしで走らせたときの実行数と一致すること**で固定する
  # （`(of 3 defined)` だけだと、定数 3 を書いても通ってしまう）。
  mkfixture
  run_fixture                 # 絞らない
  local all_ran; all_ran=$(sed -n 's/^passed: \([0-9]*\).*/\1/p' <<<"$OUT")
  local all_def; all_def=$(sed -n 's/.*(of \([0-9]*\) defined).*/\1/p' <<<"$OUT")
  assert_eq "$all_ran" "$all_def" "絞らなければ「走った数」と「定義」が一致する"
  # 絞ると定義は動かず、走った数だけ減る
  run_fixture alpha
  local few_def; few_def=$(sed -n 's/.*(of \([0-9]*\) defined).*/\1/p' <<<"$OUT")
  assert_eq "$all_def" "$few_def" "絞っても「定義」は動かない"
}

t_real_runner_defined_count_is_the_total() {
  # 本物の 8 本でも同じ。**絞ったときに「定義」が縮まないこと。**
  set +e
  local all few
  all=$(bash "$RUNNER" 2>&1)
  few=$(bash "$RUNNER" merge-when-green 2>&1)
  set -e
  local all_ran all_def few_ran few_def
  all_ran=$(sed -n 's/^passed: \([0-9]*\).*/\1/p' <<<"$all")
  all_def=$(sed -n 's/.*(of \([0-9]*\) defined).*/\1/p' <<<"$all")
  few_ran=$(sed -n 's/^passed: \([0-9]*\).*/\1/p' <<<"$few")
  few_def=$(sed -n 's/.*(of \([0-9]*\) defined).*/\1/p' <<<"$few")
  assert_eq "$all_ran" "$all_def" "引数なしでは「走った数」＝「定義」"
  assert_eq "$all_def" "$few_def" "絞っても「定義」は動かない（実測 221）"
  [[ ${few_ran:-0} -lt ${few_def:-0} ]] || fail "絞れば走った数 < 定義: ran=$few_ran def=$few_def"
}

t_filter_does_not_match_the_directory_path() {
  # **レビュー #1130 の指摘 2。** `CURRENT_FILE=$(basename "$t")` を `CURRENT_FILE="$t"` に
  # すると、`$t` は**絶対パス**なので `run.sh scripts` / `run.sh tmp` が
  # **221 件全部に当たった**（PO が再現、私も再現: 0 件 → 221 件、検査 14/14 素通り）。
  # **#1124 の裏返しで、しかも「0 件」が二度と起きなくなるので、足したゲートごと無力化される。**
  #
  # **合成 fixture では測れない**——fixture は $TMP（/tmp 配下）に在るので、
  # そのパスに `scripts` は含まれない。**本物の runner に当てる必要がある**
  # （レビュアーの指摘どおり）。
  # **語はハードコードせず、本物のパスから derive する**——`scripts` を直に書くと、
  # この検査が「私が選んだ 1 語」の話になる。$PO_TEST_DIR の全ディレクトリ成分のうち、
  # **どのファイル名にも含まれない**ものを全部試す。
  # （`test` は `*.test.sh` に正しく当たるので除外される。実測: 8 ファイル名すべてにヒット。
  #  この作業ツリーは /tmp/... 配下なので `tmp` や `claude` も成分に入るが、どれも同じ扱い。）
  local word out st n=0
  local -a probes=()
  local IFS=/
  for word in $PO_TEST_DIR; do
    [[ -n $word ]] || continue
    # そのファイル名を持つテストファイルが 1 本でもあれば、**当たるのが正しい**ので除外
    local hits=0 f
    for f in "$PO_TEST_DIR"/*.test.sh; do [[ $(basename "$f") == *"$word"* ]] && hits=1; done
    [[ $hits == 0 ]] && probes+=("$word")
  done
  unset IFS
  [[ ${#probes[@]} -ge 1 ]] || { fail "母数: 試す語が 1 つも作れなかった（パス=$PO_TEST_DIR）"; return; }
  for word in "${probes[@]}"; do
    n=$((n+1))
    set +e
    out=$(bash "$RUNNER" "$word" 2>&1); st=$?
    set -e
    local ran def
    ran=$(sed -n 's/^passed: \([0-9]*\).*/\1/p' <<<"$out")
    def=$(sed -n 's/.*(of \([0-9]*\) defined).*/\1/p' <<<"$out")
    # ディレクトリ名に当たってしまうと全件（ran == def）になる。**そこを落とす。**
    [[ ${ran:-0} -lt ${def:-1} ]] || fail "[$word] がディレクトリ名に当たって全件走った: ran=$ran def=$def"
  done
  # `scripts` はどのテスト名にもファイル名にも無いので、**0 件 = exit 1** が正しい姿。
  # （実測: テスト名 0 件ヒット / ファイル名 0 件ヒット。`po` はテスト名に 7 件あるので使わない。）
  set +e
  out=$(bash "$RUNNER" scripts 2>&1); st=$?
  set -e
  assert_eq 1 "$st" "run.sh scripts は 0 件で exit 1（ディレクトリ名には当たらない）"
  [[ $n -ge 1 ]] || fail "試した語が 0 個"
}

t_current_file_holds_a_basename_not_a_path() {
  # 上の挙動テストが「たまたま当たらない語」に依存しないよう、**性質そのもの**も固定する。
  # CURRENT_FILE に `/` が入っていたら、それはパスであってファイル名ではない。
  mkfixture
  cat > "$TMP/po/test/probe.test.sh" <<'EOF'
# shellcheck shell=bash
echo "PROBE_CURRENT_FILE=[$CURRENT_FILE]"
t_probe() { :; }
test_case "PROBE: marker" t_probe
EOF
  run_fixture
  assert_contains "$OUT" "PROBE_CURRENT_FILE=[probe.test.sh]" "CURRENT_FILE はファイル名そのもの"
  assert_not_contains "$OUT" "PROBE_CURRENT_FILE=[/" "CURRENT_FILE に絶対パスが入っていない"
}

t_real_runner_accepts_the_filter_that_broke() {
  # **合成 fixture だけだと、私の思い込みを測っているだけになる。**
  # 本物の scripts/po/test/ に対して、#1124 で 0 件だった文字列を渡して 1 件以上走ることを見る。
  [[ -f "$PO_TEST_DIR/merge-when-green.test.sh" ]] || { fail "前提: merge-when-green.test.sh が無い"; return; }
  set +e
  local out st
  out=$(bash "$RUNNER" merge-when-green 2>&1); st=$?
  set -e
  assert_eq 0 "$st" "本物の run.sh に merge-when-green を渡して通る"
  assert_not_contains "$out" "passed: 0  failed: 0" "#1124 の症状（0 件で緑）が出ない"
  # 本数はテストが増減するので固定しない。**1 件以上走ったこと**だけ見る（#757 の母数）。
  local n; n=$(sed -n 's/^passed: \([0-9]*\).*/\1/p' <<<"$out")
  assert_ne "" "$n" "passed: の行が読める"
  [[ ${n:-0} -ge 1 ]] || fail "本物の run.sh で 1 件以上走る: passed=$n"
}

# ==== 3. 正常な使い方（偽陽性の確認。**これが無いと全員の作業が止まる**）====================

t_no_filter_runs_everything() {
  mkfixture
  run_fixture
  assert_eq 0 "$STATUS" "引数なしは通る"
  assert_contains "$OUT" "passed: 3  failed: 0" "3 本すべて走る"
}

t_matching_filter_still_narrows() {
  mkfixture
  run_fixture "second thing"
  assert_eq 0 "$STATUS" "当たるテスト名フィルタは通る"
  assert_contains "$OUT" "passed: 1  failed: 0" "1 本だけ"
  assert_contains "$OUT" "ONE: second thing" "当たったのはそれ"
}

t_failing_test_still_fails() {
  # **「当たらないと落ちる」を足したせいで「当たって落ちる」が壊れていないこと。**
  mkfixture
  cat > "$TMP/po/test/gamma.test.sh" <<'EOF'
# shellcheck shell=bash
t_red() { fail "deliberate"; }
test_case "THREE: deliberately red" t_red
EOF
  run_fixture
  assert_eq 1 "$STATUS" "赤があれば exit 1"
  assert_contains "$OUT" "failed: 1" "赤が 1 本"
  assert_contains "$OUT" "THREE: deliberately red" "どれが赤かを出す"
}

t_real_runner_no_filter_is_green() {
  # 本物の 8 本。**CI が叩いているのはこの形**なので、ここが赤くなると全員が止まる。
  set +e
  local out st
  out=$(bash "$RUNNER" 2>&1); st=$?
  set -e
  assert_eq 0 "$st" "本物の run.sh（引数なし）が通る"
  assert_contains "$out" "failed: 0" "赤は無い"
  local n; n=$(sed -n 's/^passed: \([0-9]*\).*/\1/p' <<<"$out")
  [[ ${n:-0} -ge 100 ]] || fail "本物の run.sh の本数（#1124 時点の実測 174 本、下限 100）: passed=$n"
}

# ==== 4. *.test.sh の直接実行 ================================================================

t_direct_execution_of_a_real_test_file_fails_loudly() {
  # **#1124 の 2 つめ。** origin/main で実測: `test_case: command not found` が **138 行**出て、
  # assertion は 1 つも走らない（8 本の合計は 221 行）。
  local f="$PO_TEST_DIR/merge-when-green.test.sh"
  [[ -f $f ]] || { fail "前提: merge-when-green.test.sh が無い"; return; }
  set +e
  local out st
  out=$(bash "$f" 2>&1); st=$?
  set -e
  assert_ne 0 "$st" "直接実行は exit 0 で終わらない"
  assert_eq 2 "$st" "直接実行は exit 2（使い方の誤り）"
  assert_contains "$out" "run.sh" "run.sh から呼ぶよう案内する"
  assert_not_contains "$out" "command not found" "command not found を 1 行も出さない"
  # 138 行のノイズではなく、短く読めること
  local lines; lines=$(wc -l <<<"$out")
  [[ $lines -le 10 ]] || fail "直接実行の出力は 10 行以内: $lines 行"
}

t_every_po_test_file_guards_direct_execution() {
  # **母数**（#757）: 1 本だけ直しても、残りが同じ穴を持っていたら意味が無い。
  # scripts/po/test/*.test.sh の**全部**を直接実行して、全部が exit 2 になること。
  local f n=0 bad=0
  for f in "$PO_TEST_DIR"/*.test.sh; do
    n=$((n+1))
    set +e
    local out st
    out=$(bash "$f" 2>&1); st=$?
    set -e
    if [[ $st != 2 ]]; then bad=$((bad+1)); fail "$(basename "$f"): exit=$st（2 を期待）"; fi
    if [[ $out == *"command not found"* ]]; then bad=$((bad+1)); fail "$(basename "$f"): command not found が出る"; fi
  done
  [[ $n -ge 8 ]] || fail "母数: scripts/po/test/*.test.sh が 8 本以上（実測 8 本）: $n"
  assert_eq 0 "$bad" "全 $n 本が直接実行を拒む"
}

t_sourced_from_run_sh_is_not_blocked() {
  # **守りが強すぎて run.sh からも走らなくなっていないこと**（これが壊れると全部が止まる）。
  # t_real_runner_no_filter_is_green と別の角度: source 経由で「守りの行」が何も出力しないこと。
  set +e
  local out st
  out=$(bash "$RUNNER" 2>&1); st=$?
  set -e
  assert_eq 0 "$st" "source 経由では守りが発火しない"
  assert_not_contains "$out" "run.sh から呼んでください" "案内文が誤発火していない"
}

# ==== 5. 他ディレクトリの runner（母数）======================================================

t_po_test_dir_is_the_only_filtering_runner() {
  # #1124 の「母数を出す」。**フィルタを持つ runner は scripts/po/test/run.sh の 1 本だけ**。
  # 他（scripts/ci/test, scripts/dev/test, deploy/test）は 1 ファイル = 1 実行で、
  # CI の glob ループが直接 bash する自己完結型。ここが変わったら数え直す。
  # 「フィルタを持つ」＝ **引数を受けて絞り込む変数を定義している**こと。
  # コメントに `FILTER` と書いただけのファイル（このファイル自身がそう）は数えない。
  # `--include` で *.sh / *.test.sh に絞る。**scripts/dev/mutate.sh の退避（*.mutate-sv）を数えない**
  # ため（変異テスト中にこの検査が誤って赤くなる。実測した）。
  local found; found=$(cd "$ROOT" && grep -rlE --include='*.sh' '^[A-Z_]*FILTER=' scripts/ci/test scripts/dev/test deploy/test scripts/po/test 2>/dev/null | LC_ALL=C sort | tr '\n' ' ')
  assert_eq "scripts/po/test/run.sh " "$found" "フィルタ付き runner は 1 本だけ（増えたら同じ穴を数え直す）"
}

t_other_test_dirs_are_self_contained() {
  # 他の 3 ディレクトリは **直接実行が正しい呼び方**なので、この PBI の守りを入れてはいけない。
  # 「自己完結している」＝ 自前の test_case を持つこと。ここが崩れたら #1124 と同じ穴が開く。
  local d f n=0 bad=0
  for d in scripts/ci/test scripts/dev/test; do
    for f in "$ROOT/$d"/*.test.sh; do
      n=$((n+1))
      grep -q '^test_case()' "$f" || { bad=$((bad+1)); fail "$d/$(basename "$f"): 自前の test_case が無い"; }
    done
  done
  [[ $n -ge 12 ]] || fail "母数: scripts/ci/test + scripts/dev/test が 12 本以上（実測 12 本）: $n"
  assert_eq 0 "$bad" "全 $n 本が自己完結"
}

# ---- run ------------------------------------------------------------------------------------
test_case "当たらないフィルタは exit 1（走っていないのに緑にしない）" t_no_match_filter_fails
test_case "当たらないフィルタは、存在するテスト名を案内する" t_no_match_filter_lists_what_exists
test_case "フィルタがファイル名（alpha.test.sh）でも効く" t_filter_matches_file_basename
test_case "フィルタがファイル名の語幹（alpha）でも効く" t_filter_matches_file_stem
test_case "(of K defined) は定義の総数で、走った数ではない (#1130 指摘 1)" t_defined_count_is_the_total_not_the_selected
test_case "絞っても「定義」は動かず、走った数だけ減る (#1130 指摘 1)" t_defined_count_matches_the_unfiltered_total
test_case "本物の run.sh でも「定義」は絞っても縮まない (#1130 指摘 1)" t_real_runner_defined_count_is_the_total
test_case "フィルタがディレクトリ名に当たらない (#1130 指摘 2)" t_filter_does_not_match_the_directory_path
test_case "CURRENT_FILE はパスではなくファイル名 (#1130 指摘 2)" t_current_file_holds_a_basename_not_a_path
test_case "本物の run.sh に merge-when-green を渡して 1 件以上走る" t_real_runner_accepts_the_filter_that_broke
test_case "引数なしは全部走る（偽陽性）" t_no_filter_runs_everything
test_case "当たるフィルタは従来どおり絞れる（偽陽性）" t_matching_filter_still_narrows
test_case "赤いテストは従来どおり exit 1（偽陽性）" t_failing_test_still_fails
test_case "本物の run.sh（引数なし）が緑で 100 本以上（偽陽性）" t_real_runner_no_filter_is_green
test_case "*.test.sh の直接実行が exit 2 で短く落ちる" t_direct_execution_of_a_real_test_file_fails_loudly
test_case "scripts/po/test/*.test.sh の全 8 本が直接実行を拒む（母数）" t_every_po_test_file_guards_direct_execution
test_case "source 経由では守りが発火しない（偽陽性）" t_sourced_from_run_sh_is_not_blocked
test_case "フィルタ付き runner は scripts/po/test/run.sh の 1 本だけ（母数）" t_po_test_dir_is_the_only_filtering_runner
test_case "他の test ディレクトリは自己完結（母数）" t_other_test_dirs_are_self_contained

echo
echo "passed: $PASS  failed: $FAIL"
if [[ $FAIL -gt 0 ]]; then printf '  - %s\n' "${FAILED[@]}"; exit 1; fi
