#!/usr/bin/env bash
# Tests for scripts/ci/etl-data-only-push.sh (Issue #943).
# 本物の git リポジトリを 2 つ（bare な「リモート」と作業ツリー）作って、
# **ETL の実行中に main が動いた**状況を再現する。
#   bash scripts/ci/test/etl-data-only-push.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../etl-data-only-push.sh"
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
# 戻り値として WORK にパスを置く。
setup() {
  rm -rf "$TMP/remote" "$TMP/work" "$TMP/seed"
  git init -q --bare -b main "$TMP/remote"
  git init -q -b main "$TMP/seed"
  (
    cd "$TMP/seed"
    mkdir -p data .github/workflows
    # ci.yml の中身は本番の「テストファイル数の下限」を模したもの（#943 で下がりかけた検査）。
    # shellcheck disable=SC2016  # 同上
    printf '[ "$etl" -ge 156 ] || exit 1\n' > .github/workflows/ci.yml
    printf '{"v":1}\n' > data/meta.json
    git add -A
    git_q commit -qm base
    git_q push -q origin main 2>/dev/null || git_q remote add origin "$TMP/remote"
    git_q push -q origin main
  )
  git clone -q "$TMP/remote" "$TMP/work"
  WORK=$TMP/work
}

# main が進む（ETL が走っている 2 時間の間に起きること）。
main_moves() {
  (
    cd "$TMP/seed"
    # shellcheck disable=SC2016  # 同上
    printf '[ "$etl" -ge 139 ] || exit 1\n' > .github/workflows/ci.yml   # 下限を 156 → 139 に下げる
    git add -A
    git_q commit -qm "ci: lower the floor"
    git_q push -q origin main
  )
}

# ETL が data/ を書いて枝を切る（本番の etl.yml と同じ手順）。
etl_writes_data() {
  (
    cd "$WORK"
    printf '{"v":2}\n' > data/meta.json
    git add data
    git switch -q -c data/refresh
    git_q commit -qm "data: refresh"
  )
}

run() { # run [args...]  — WORK の中で走らせる（REBASE は呼び出し側で上書きできる）
  set +e
  ( cd "$WORK" && GITHUB_STEP_SUMMARY="$TMP/summary" REBASE="${REBASE:-yes}" \
      GIT_AUTHOR_NAME=etl GIT_AUTHOR_EMAIL=etl@test \
      GIT_COMMITTER_NAME=etl GIT_COMMITTER_EMAIL=etl@test \
      bash "$SCRIPT" "$@" ) > "$TMP/out" 2>&1
  STATUS=$?
  set -e
  OUT=$(cat "$TMP/out")
}

# --- 1: これが #943 そのもの。土台が古く、main 側で .github/ が動いている ---
case_stale_base_is_rebased_and_pushed() {
  setup; etl_writes_data; main_moves
  run data/refresh
  assert_eq 0 "$STATUS" "rebase すれば push できる"
  assert_contains "$OUT" "の外 | 0" "data/ の外は 0 件"
  # push されたリモートの枝が、main の ci.yml（下限 139）をそのまま持っていること。
  # = 「下限を 156 に戻す」差分を持ち込んでいない。
  # 枝が push されていなければ git show は失敗する。assert が先に鳴っているので、
  # ここで set -e に殺されないようにする（変異を当てたとき、後続の assert まで見たい）。
  local pushed data_on_branch
  pushed=$(git -C "$TMP/remote" show data/refresh:.github/workflows/ci.yml 2>&1 || true)
  assert_contains "$pushed" "139" "push された枝の ci.yml は main と同じ"
  data_on_branch=$(git -C "$TMP/remote" show data/refresh:data/meta.json 2>&1 || true)
  assert_contains "$data_on_branch" '"v":2' "data/ の更新は載っている"
}

# --- 2: rebase を外しても検査が鳴る（2 が本体）。ETL が data/ の外に書いた場合 ---
case_outside_data_fails() {
  setup
  (
    cd "$WORK"
    printf '{"v":2}\n' > data/meta.json
    # shellcheck disable=SC2016  # ci.yml の中身を模した文字列。$etl は展開させない
    printf '[ "$etl" -ge 1 ] || exit 1\n' > .github/workflows/ci.yml   # data/ の外を書き換える
    git add -A
    git switch -q -c data/refresh
    git_q commit -qm "data: refresh (and something else)"
  )
  run data/refresh
  assert_eq 1 "$STATUS" "data/ の外に差分があれば失敗する"
  assert_contains "$OUT" ".github/workflows/ci.yml" "外のパスを名指しする"
  assert_contains "$OUT" "push しない" "push しないと言う"
  # リモートに枝が出来ていないこと（= 実際に push していない）
  local refs
  refs=$(git -C "$TMP/remote" for-each-ref --format='%(refname)' refs/heads)
  assert_not_contains "$refs" "data/refresh" "失敗したら枝は push されない"
}

# --- 3: 母数を出す（#757）。差分 0 件を「見ていない」と区別できること ---
case_denominator_is_reported() {
  setup
  (
    cd "$WORK"
    git switch -q -c data/refresh
    git_q commit -q --allow-empty -m "data: refresh (no change)"
  )
  run data/refresh
  assert_eq 0 "$STATUS" "差分が無ければ成功"
  assert_contains "$OUT" "母数） | 0" "母数 0 を明示する"
  assert_contains "$OUT" "差分は 1 件も無い" "0 件であることを言葉でも書く"
}

# --- 4: data/ の中は何件あっても通り、件数が母数と一致する ---
case_many_data_files_counted() {
  setup
  (
    cd "$WORK"
    mkdir -p data/rollcalls
    printf '{"v":2}\n' > data/meta.json
    printf '[]\n' > data/rollcalls/a.json
    printf '[]\n' > data/rollcalls/b.json
    git add data
    git switch -q -c data/refresh
    git_q commit -qm "data: refresh"
  )
  run data/refresh
  assert_eq 0 "$STATUS" "data/ だけなら成功"
  assert_contains "$OUT" "母数） | 3" "母数は 3"
  assert_contains "$OUT" "の中 | 3" "data/ の中が 3"
  assert_contains "$OUT" "の外 | 0" "data/ の外が 0"
}

# --- 5: data で始まる別ディレクトリ（dataset/）を data/ と混同しない ---
case_prefix_is_a_directory_not_a_string() {
  setup
  (
    cd "$WORK"
    mkdir -p dataset
    printf 'x\n' > dataset/x.json
    git add -A
    git switch -q -c data/refresh
    git_q commit -qm "data: refresh"
  )
  run data/refresh
  assert_eq 1 "$STATUS" "dataset/ は data/ ではない"
  assert_contains "$OUT" "dataset/x.json" "dataset/ を外として名指しする"
}

# --- 6: 引数が無ければ使い方を出して exit 2 ---
case_usage() {
  setup
  run
  assert_eq 2 "$STATUS" "引数無しは exit 2"
  assert_contains "$OUT" "usage:" "使い方を出す"
}

# --- 7: rebase が衝突したら push せずに失敗する（黙って main を壊さない） ---
case_rebase_conflict_fails() {
  setup
  (
    cd "$WORK"
    printf '{"v":2}\n' > data/meta.json
    git add data
    git switch -q -c data/refresh
    git_q commit -qm "data: refresh"
  )
  (
    cd "$TMP/seed"
    printf '{"v":99}\n' > data/meta.json   # main 側も同じファイルを別の内容に
    git add -A
    git_q commit -qm "main also touches data/meta.json"
    git_q push -q origin main
  )
  run data/refresh
  assert_eq 1 "$STATUS" "衝突したら失敗する"
  assert_contains "$OUT" "rebase" "rebase できなかったと言う"
  local refs
  refs=$(git -C "$TMP/remote" for-each-ref --format='%(refname)' refs/heads)
  assert_not_contains "$refs" "data/refresh" "衝突したら枝は push されない"
}

# --- 8: 検査だけで鳴ること（rebase を外しても止まる）。#943 の「2 が本体」を直接測る。
#        ここは **tip 同士の比較でなければ素通りする**: 三点（merge base）だと
#        「data/ しか変わっていない」と答えてしまう（枝は実際 data/ しか触っていないので）。 ---
case_check_alone_catches_stale_base() {
  setup; etl_writes_data; main_moves
  REBASE=no run data/refresh
  assert_eq 1 "$STATUS" "rebase 無しなら、古い土台は検査で止まる"
  assert_contains "$OUT" ".github/workflows/ci.yml" "main 側で進んだ .github/ を名指しする"
  assert_contains "$OUT" "push しない" "push しない"
  local refs
  refs=$(git -C "$TMP/remote" for-each-ref --format='%(refname)' refs/heads)
  assert_not_contains "$refs" "data/refresh" "止まったら枝は push されない"
}

# --- 9: 3 つのデータ ETL ワークフローが全部この検査を通っている（母数付き） ---
case_all_data_workflows_use_the_guard() {
  local root; root=$(cd "$HERE/../../.." && pwd)
  local wfs=(etl.yml districts.yml local-assemblies.yml)
  local total=0 guarded=0 raw=0
  local f
  for f in "${wfs[@]}"; do
    total=$((total + 1))
    grep -q "etl-data-only-push.sh" "$root/.github/workflows/$f" && guarded=$((guarded + 1))
    # 素の `git push origin "$DATA_BRANCH"` が残っていないこと（検査を迂回する経路）
    # shellcheck disable=SC2016  # grep のパターン。$DATA_BRANCH は展開させない
    grep -qE '^\s*git push "?\$\{?REMOTE|^\s*git push origin "\$DATA_BRANCH"' "$root/.github/workflows/$f" && raw=$((raw + 1))
  done
  assert_eq 3 "$total" "データ ETL ワークフローの母数"
  assert_eq 3 "$guarded" "3 本すべてが etl-data-only-push.sh を通る"
  assert_eq 0 "$raw" "素の git push が残っていない"
}

# --- 10: **既存の stale-base.sh ではこの形を覆えない**（だからこの検査が別に要る）。
#         stale-base.sh の候補は「両側が触ったファイル」に限られる（それは意図的で正しい——
#         main に対して単に遅れているだけの枝で鳴らすと、main が動くたび全 PR が赤になる）。
#         #943 の形では枝は data/ しか触らず .github/ は main しか触らないので、**候補が 0 件**になり
#         stale-base は ok と言う。実測済み。ここが緑のままこの検査を消すと、守るものが無くなる。
case_stale_base_sh_does_not_cover_this_shape() {
  local root; root=$(cd "$HERE/../../.." && pwd)
  local sb="$root/scripts/ci/stale-base.sh"
  [[ -f $sb ]] || { fail "stale-base.sh が無い（この比較の前提が消えた）"; return; }
  rm -rf "$TMP/sb" "$TMP/sb-remote"; git init -q -b main "$TMP/sb"
  (
    cd "$TMP/sb"
    mkdir -p data .github/workflows
    # shellcheck disable=SC2016  # ci.yml の中身を模した文字列。$etl は展開させない
    printf '[ "$etl" -ge 156 ] || exit 1\n' > .github/workflows/ci.yml
    printf '{"v":1}\n' > data/meta.json
    git add -A; git_q commit -qm base
    git switch -q -c data/refresh
    printf '{"v":2}\n' > data/meta.json          # 枝は data/ しか触らない
    git add -A; git_q commit -qm "data: refresh"
    git switch -q main
    # shellcheck disable=SC2016  # 同上
    printf '[ "$etl" -ge 139 ] || exit 1\n' > .github/workflows/ci.yml   # main だけが .github/ を触る
    git add -A; git_q commit -qm "ci: lower the floor"
  )
  local head sb_out sb_status guard_out guard_status mb common
  head=$(git -C "$TMP/sb" rev-parse data/refresh)
  # 候補集合（両側が触ったファイル）が空であることを直接測る——これが ok の理由である
  mb=$(git -C "$TMP/sb" merge-base main data/refresh)
  common=$(comm -12 \
    <(git -C "$TMP/sb" diff --name-only "$mb" main | LC_ALL=C sort) \
    <(git -C "$TMP/sb" diff --name-only "$mb" data/refresh | LC_ALL=C sort) | wc -l)
  assert_eq 0 "$common" "stale-base の候補（両側が触ったファイル）は 0 件"
  set +e
  sb_out=$( cd "$TMP/sb" && bash "$sb" main "$head" 2>&1 ); sb_status=$?
  set -e
  assert_eq 0 "$sb_status" "stale-base.sh はこの形を ok と言う（候補が 0 件なので）"
  assert_contains "$sb_out" "ok" "stale-base.sh の出力は ok"
  # 同じ形を、こちらの検査は止める（tip 同士で比べるので .github/ が見える）
  # 本物の remote を 1 つ足して（REMOTE=. は `./main` という解決できない ref になる）、
  # 同じ形をこちらの検査に掛ける。
  git init -q --bare -b main "$TMP/sb-remote"
  ( cd "$TMP/sb" && git_q remote add origin "$TMP/sb-remote" && git_q push -q origin main )
  set +e
  guard_out=$( cd "$TMP/sb" && git switch -q data/refresh && \
    REBASE=no PUSH=no bash "$SCRIPT" data/refresh 2>&1 ); guard_status=$?
  set -e
  assert_eq 1 "$guard_status" "同じ形を etl-data-only-push.sh は止める"
  assert_contains "$guard_out" ".github/workflows/ci.yml" "止めた理由を名指しする"
}

# --- 11: **土台を解決できないときに「差分 0 件」で通さない**（#757: 0 件を緑にしない）。
#         実測（このテストを書いている最中に踏んだ）: REMOTE=. だと BASE が `./main` になり、
#         git diff は fatal で終わるのに mapfile はプロセス置換の終了コードを捨てるので空配列になり、
#         検査は「差分は 1 件も無い」「push する」と言って先へ進んだ。
#         **比較できていないことと、比較した結果 0 件だったことは別である。**
case_unresolvable_base_is_not_green() {
  setup; etl_writes_data; main_moves
  set +e
  ( cd "$WORK" && REMOTE=. DEFAULT_BRANCH=main REBASE=no PUSH=no bash "$SCRIPT" data/refresh ) \
    > "$TMP/out" 2>&1
  STATUS=$?
  set -e
  OUT=$(cat "$TMP/out")
  assert_eq 1 "$STATUS" "土台を解決できなければ失敗する"
  assert_not_contains "$OUT" "push する" "「push する」とは言わない"
  assert_contains "$OUT" "解決できない" "解決できないと言う"
}

test_case "#943 土台が古くても rebase して push できる（.github/ を巻き戻さない）" case_stale_base_is_rebased_and_pushed
test_case "data/ の外に差分があれば push せず失敗する" case_outside_data_fails
test_case "母数を出す（0 件と「見ていない」を区別する）" case_denominator_is_reported
test_case "data/ の中の件数が母数と一致する" case_many_data_files_counted
test_case "dataset/ を data/ と混同しない" case_prefix_is_a_directory_not_a_string
test_case "引数無しは使い方を出して exit 2" case_usage
test_case "rebase 衝突は push せず失敗する" case_rebase_conflict_fails
test_case "rebase を外しても、古い土台は検査だけで止まる（tip 同士の比較）" case_check_alone_catches_stale_base
test_case "3 本のデータ ETL ワークフローが全部この検査を通る" case_all_data_workflows_use_the_guard
test_case "stale-base.sh はこの形を覆えない（候補 0 件）——だからこの検査が別に要る" case_stale_base_sh_does_not_cover_this_shape
test_case "土台を解決できないときに「差分 0 件」で通さない（#757）" case_unresolvable_base_is_not_green

echo
echo "passed: $PASS  failed: $FAIL"
[[ $FAIL == 0 ]]
