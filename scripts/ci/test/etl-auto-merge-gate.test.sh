#!/usr/bin/env bash
# Tests for scripts/ci/etl-auto-merge-gate.sh (Issue #1227).
# 本物の git リポジトリを 2 つ（bare な「リモート」と作業ツリー）作って、
# **日次 ETL が data/ を書いて枝を切った**状況を再現する。
#   bash scripts/ci/test/etl-auto-merge-gate.test.sh
#
# **両側を見る**（作業合意）: 止めるべき形で止まることと、止めるべきでない形で止まらないこと。
# 片側だけだと「何も armed にしない門」も緑になる（それは退行である）。
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../etl-auto-merge-gate.sh"
PASS=0; FAIL=0
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_eq() { [[ "$2" == "$1" ]] || fail "$3: expected [$1] got [$2]"; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in:
$1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "$3: expected NOT to contain [$2] in:
$1"; }
test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

git_q() { git -c user.email=etl@test -c user.name=etl "$@"; }

# 本番と同じ形: bare なリモート（origin）＋ ETL が checkout した作業ツリー。
# data/unmatched/ を 3 回次ぶん置く（#1229 が消したのと同じ形のファイル）。
setup() {
  rm -rf "$TMP/remote" "$TMP/work" "$TMP/seed"
  git init -q --bare -b main "$TMP/remote"
  git init -q -b main "$TMP/seed"
  (
    cd "$TMP/seed"
    mkdir -p data/unmatched data/bills
    printf '{"v":1}\n' > data/meta.json
    printf '[{"id":"a"}]\n' > data/bills/index.json
    for s in 202 203 221; do printf '[{"row":%s}]\n' "$s" > "data/unmatched/$s.json"; done
    git add -A
    git_q commit -qm base
    git_q remote add origin "$TMP/remote"
    git_q push -q origin main
  )
  git clone -q "$TMP/remote" "$TMP/work"
  WORK=$TMP/work
}

# ETL が data/ を書いて枝を切る（本番の etl.yml と同じ手順）。
branch_with() {
  (
    cd "$WORK"
    git switch -q -c data/refresh 2>/dev/null || git switch -q data/refresh
    "$@"
    git add -A data
    git_q commit -qm "data: refresh test"
  )
}

run_gate() { (cd "$WORK" && "$SCRIPT" data/refresh 2>&1); }

# ---- 止めるべきでない形では止まらない（退行の検査） -------------------------

t_clean_refresh_arms() {
  setup
  branch_with bash -c 'printf "[{\"row\":221},{\"row\":222}]\n" > data/unmatched/221.json'
  local out rc=0
  out=$(run_gate) || rc=$?
  assert_eq 0 "$rc" "ふつうの refresh（行が増えただけ）は exit 0 で armed になる"
  assert_contains "$out" "auto-merge を付ける" "判定が出ている"
  assert_contains "$out" "消えたファイルも 0 件" "母数つきで 0 件と言っている"
}

t_new_file_arms() {
  setup
  branch_with bash -c 'printf "[{\"row\":205}]\n" > data/unmatched/205.json'
  local out rc=0
  out=$(run_gate) || rc=$?
  assert_eq 0 "$rc" "回次別ファイルが増えた refresh も armed になる（増えるのは喪失ではない）"
}

t_no_diff_arms_but_says_zero_is_measured() {
  setup
  (cd "$WORK" && git switch -q -c data/refresh)
  local out rc=0
  out=$(run_gate) || rc=$?
  assert_eq 0 "$rc" "差分が無ければ armed になる"
  # #757: 「0 件だった」と「数えていない」が出力で区別できること。
  assert_contains "$out" "母数 0" "母数 0 を明示している（数えていないのではない）"
}

# ---- 止めるべき形で止まる ---------------------------------------------------

t_deleted_file_withholds() {
  setup
  branch_with bash -c 'rm data/unmatched/202.json'
  local out rc=0
  out=$(run_gate) || rc=$?
  assert_eq 10 "$rc" "data/ からファイルが消えたら exit 10（armed にしない）"
  assert_contains "$out" "auto-merge を付けない" "判定が出ている"
  assert_contains "$out" "data/unmatched/202.json" "消えたファイルを名指ししている"
  assert_contains "$out" "うち消えた（D） | 1" "件数を母数と並べて出している"
}

t_many_deleted_files_withholds_and_lists_all() {
  # #1229 と同じ形（回次別ファイルが複数まとめて消える）。
  setup
  branch_with bash -c 'rm data/unmatched/202.json data/unmatched/203.json'
  local out rc=0
  out=$(run_gate) || rc=$?
  assert_eq 10 "$rc" "複数消えても exit 10"
  assert_contains "$out" "data/unmatched/202.json" "1 本目を名指ししている"
  assert_contains "$out" "data/unmatched/203.json" "2 本目も名指ししている（1 件だけ出して満足しない）"
}

t_hold_file_withholds_and_prints_reason() {
  setup
  branch_with bash -c 'printf "なぜ止めているか: #1229 の 493 行\n" > data/.refresh-hold'
  local out rc=0
  out=$(run_gate) || rc=$?
  assert_eq 10 "$rc" "停止ファイルが在れば exit 10（消えたファイルが 0 件でも）"
  assert_contains "$out" "停止ファイルが在る" "停止ファイルを名指ししている"
  assert_contains "$out" "#1229 の 493 行" "**書かれた理由を本文ごと出している**（人が読める。#1056）"
}

t_hold_file_on_main_withholds() {
  # 置いたのが main 側でも効く（枝は data/ を書き換えるだけなので引き継がれる）。
  setup
  (
    cd "$TMP/seed"
    printf "main 側に置いた理由\n" > data/.refresh-hold
    git add -A; git_q commit -qm hold; git_q push -q origin main
  )
  (cd "$WORK" && git_q pull -q --ff-only origin main)
  branch_with bash -c 'printf "[{\"row\":221},{\"row\":9}]\n" > data/unmatched/221.json'
  local out rc=0
  out=$(run_gate) || rc=$?
  assert_eq 10 "$rc" "main に置いた停止ファイルも効く"
  assert_contains "$out" "main 側に置いた理由" "理由が出ている"
}

t_removing_hold_file_arms_again() {
  # 受け入れ条件 3「停止を解除したら、いままでどおり auto-merge が付く」。
  setup
  (
    cd "$TMP/seed"
    printf "とりあえず止める\n" > data/.refresh-hold
    git add -A; git_q commit -qm hold; git_q push -q origin main
  )
  (cd "$WORK" && git_q pull -q --ff-only origin main)
  # **消したこと自体は「消えたファイル」に数えない**——
  # 停止ファイルは記録ではないので、解除が永久に自分を止めてはならない。
  branch_with bash -c 'rm data/.refresh-hold'
  local out rc=0
  out=$(run_gate) || rc=$?
  assert_eq 0 "$rc" "停止ファイルを消したら armed に戻る（解除が自分を止めない）"
  assert_contains "$out" "auto-merge を付ける" "判定が出ている"
}

# ---- 検査が成立しなかったときは armed にしない（#757 / #943） ---------------

t_unresolvable_base_fails_closed() {
  setup
  branch_with bash -c 'printf "[{\"row\":1}]\n" > data/unmatched/221.json'
  local out rc=0
  out=$(cd "$WORK" && DEFAULT_BRANCH=no-such-branch "$SCRIPT" data/refresh 2>&1) || rc=$?
  assert_eq 1 "$rc" "土台が解決できなければ exit 1（0 件を見て armed にしない）"
  assert_contains "$out" "解決できない" "理由を言っている"
  assert_not_contains "$out" "auto-merge を付ける" "**armed の判定を出していない**"
}

t_usage() {
  local rc=0
  out=$("$SCRIPT" 2>&1) || rc=$?
  assert_eq 2 "$rc" "引数が無ければ exit 2"
}

# ---- 出力は人が読める場所に出る（#1056） -----------------------------------

t_writes_step_summary() {
  setup
  branch_with bash -c 'rm data/unmatched/202.json'
  local sum="$TMP/summary.md" rc=0
  (cd "$WORK" && GITHUB_STEP_SUMMARY="$sum" "$SCRIPT" data/refresh >/dev/null 2>&1) || rc=$?
  assert_eq 10 "$rc" "止めた"
  local body; body=$(cat "$sum")
  assert_contains "$body" "auto-merge を付けない" "GITHUB_STEP_SUMMARY に判定が書かれている"
  assert_contains "$body" "data/unmatched/202.json" "GITHUB_STEP_SUMMARY に消えたファイルが書かれている"
}

test_case "ふつうの refresh は armed になる（退行していない）" t_clean_refresh_arms
test_case "ファイルが増えた refresh も armed になる" t_new_file_arms
test_case "差分 0 件は母数 0 と明示して armed になる" t_no_diff_arms_but_says_zero_is_measured
test_case "data/ からファイルが消えたら armed にしない" t_deleted_file_withholds
test_case "複数消えたら全件名指しして armed にしない" t_many_deleted_files_withholds_and_lists_all
test_case "停止ファイルが在れば理由ごと出して armed にしない" t_hold_file_withholds_and_prints_reason
test_case "main に置いた停止ファイルも効く" t_hold_file_on_main_withholds
test_case "停止ファイルを消したら armed に戻る" t_removing_hold_file_arms_again
test_case "土台が解決できなければ armed にせず失敗する" t_unresolvable_base_fails_closed
test_case "引数が無ければ使い方を出して exit 2" t_usage
test_case "判定と内訳を GITHUB_STEP_SUMMARY に書く" t_writes_step_summary

echo
echo "$PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]
