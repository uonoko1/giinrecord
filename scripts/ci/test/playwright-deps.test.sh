#!/usr/bin/env bash
# Tests for scripts/ci/playwright-deps.sh (Issue #1254)。
#
# **何を測るか**: 「ミラーに届かなかった」ことを**言えるか**。
# #1254 の実害は赤でも遅さでもなく、**無言で cancelled になって原因が残らないこと**だった。
# だから検査の中心は「終了コード 7」と「ミラーに届かなかった、という語が出ること」である。
#
# **本物の apt は叩かない**（網も root も要らないし、ミラー障害は再現できない）。
# `PW_DEPS_CMD_OVERRIDE` で偽のコマンドを差し、
#   - 即座に成功する   → 0
#   - 固まる（sleep）  → `timeout` が切って 7
#   - 即座に落ちる     → 1（**ミラーのせいにしない**）
# の 3 通りを作る。**予算は環境変数で短くできない**（スクリプトが持つ定数である）ので、
# 時間切れの経路は**予算そのものを小さくした写し**を使って測る（下の with_budget）。
#
#   bash scripts/ci/test/playwright-deps.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
SCRIPT="$ROOT/scripts/ci/playwright-deps.sh"
PASS=0; FAIL=0
TMP=$(mktemp -d)
# #1244: 掃除の終了コードがテスト結果を上書きしないように、trap では結果を変えない。
trap 'rm -rf "$TMP" || true' EXIT

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

run() { # run <引数...> → OUT / STATUS（標準出力と標準エラーを混ぜる。両方が読まれる）
  set +e
  OUT=$("$@" 2>&1)
  STATUS=$?
  set -e
}

# 予算を小さくした写しを作る。**元のスクリプトは書き換えない**（他の担当者が同時に走っている）。
# 写しの作り方は逐語の置換 1 行だけで、**当たらなければテストを落とす**
# （空振りを「速く終わった」と読み替えないため。#514 と同じ型）。
with_budget() { # with_budget <1回の秒> <合計の秒> <試行回数> → $TMP/pw.sh
  sed -e "s/^PLAYWRIGHT_DEPS_BUDGET_SEC=.*/PLAYWRIGHT_DEPS_BUDGET_SEC=$1/" \
      -e "s/^PLAYWRIGHT_DEPS_TOTAL_BUDGET_SEC=.*/PLAYWRIGHT_DEPS_TOTAL_BUDGET_SEC=$2/" \
      -e "s/^PLAYWRIGHT_DEPS_ATTEMPTS=.*/PLAYWRIGHT_DEPS_ATTEMPTS=$3/" \
      "$SCRIPT" > "$TMP/pw.sh"
  for want in "PLAYWRIGHT_DEPS_BUDGET_SEC=$1" "PLAYWRIGHT_DEPS_TOTAL_BUDGET_SEC=$2" "PLAYWRIGHT_DEPS_ATTEMPTS=$3"; do
    grep -qx "$want" "$TMP/pw.sh" || { echo "FATAL: 写しの置換が当たらなかった（$want）。このテストの結果は使えない"; exit 9; }
  done
  echo "$TMP/pw.sh"
}

# ---- 入った場合 -------------------------------------------------------------------------------
t_success() {
  run env PW_DEPS_CMD_OVERRIDE="true" bash "$SCRIPT" --cache-hit true
  assert_eq 0 "$STATUS" "入ったら 0"
  assert_contains "$OUT" "入った" "入ったと言う"
  assert_not_contains "$OUT" "ミラーに届かなかった" "入ったのにミラーの話をしない"
}

# ---- 時間切れ: **これが #1254 の本体** --------------------------------------------------------
t_timeout_says_mirror() {
  local s; s=$(with_budget 1 3 2)
  run env PW_DEPS_CMD_OVERRIDE="sleep 30" bash "$s" --cache-hit true
  assert_eq 7 "$STATUS" "時間切れは 7（0 でも 1 でもない）"
  assert_contains "$OUT" "ミラーに届かなかった" "諦めたときに**ミラーに届かなかった**と言う（#1254 の受け入れ条件 2）"
  assert_contains "$OUT" "コードの赤ではない" "**コードの赤と呼び分ける**（受け入れ条件 4 の片側）"
  assert_contains "$OUT" "時間切れ" "何が起きたかを言う"
}

t_timeout_retries() {
  local s; s=$(with_budget 1 10 2)
  run env PW_DEPS_CMD_OVERRIDE="sleep 30" bash "$s" --cache-hit true
  assert_eq 7 "$STATUS" "2 回とも時間切れなら 7"
  assert_contains "$OUT" "試行 1/2" "1 回目を数える"
  assert_contains "$OUT" "試行 2/2" "**入れ直す**（ミラーは 18 分で表情を変えた。1 回で諦めない）"
}

t_total_budget_caps_retries() {
  # 1 回の予算 2s・合計 3s・試行 5 回 → 合計で切れるので 5 回は回らない。
  local s; s=$(with_budget 2 3 5)
  run env PW_DEPS_CMD_OVERRIDE="sleep 30" bash "$s" --cache-hit true
  assert_eq 7 "$STATUS" "合計で切れても 7"
  assert_contains "$OUT" "ミラーに届かなかった" "合計で切れたときもミラーの話をする"
  assert_not_contains "$OUT" "試行 5/5" "合計の上限が試行回数より先に効く（job の timeout より内側で終わる）"
}

# ---- 時間切れ**ではない**失敗: ミラーのせいにしない -------------------------------------------
t_real_failure_is_not_a_mirror_problem() {
  run env PW_DEPS_CMD_OVERRIDE="false" bash "$SCRIPT" --cache-hit true
  assert_eq 1 "$STATUS" "コマンドが落ちたら 1（7 ではない）"
  assert_contains "$OUT" "ミラー障害ではない" "**ミラーのせいにしない**（取り違えると #1254 の逆をやる）"
  assert_not_contains "$OUT" "ミラーに届かなかった" "届かなかったとは言わない"
}

# ---- どちらのコマンドを選ぶか -----------------------------------------------------------------
t_cache_hit_picks_install_deps() {
  # 偽のコマンドを差さず、`timeout` が引く実体を見る。`pnpm` は在るが `--filter web exec`
  # が走ってしまうので、PATH を差し替えて引数だけ記録する。
  mkdir -p "$TMP/bin"
  printf '#!/usr/bin/env bash\necho "ARGS: $*"\n' > "$TMP/bin/pnpm"
  chmod +x "$TMP/bin/pnpm"
  run env PATH="$TMP/bin:$PATH" bash "$SCRIPT" --cache-hit true
  assert_eq 0 "$STATUS" "cache-hit: 0"
  assert_contains "$OUT" "install-deps chromium" "cache-hit なら install-deps（ブラウザはキャッシュから）"
  assert_not_contains "$OUT" "--with-deps" "cache-hit で --with-deps は使わない"
  run env PATH="$TMP/bin:$PATH" bash "$SCRIPT" --cache-hit false
  assert_eq 0 "$STATUS" "cache-miss: 0"
  assert_contains "$OUT" "install --with-deps chromium" "cache-miss なら install --with-deps"
}

# ---- 数の出口（ci.yml と workflow-timeout.test.ts の表が読む） --------------------------------
t_budget_flags_print_one_number() {
  run bash "$SCRIPT" --budget-sec
  assert_eq 0 "$STATUS" "--budget-sec は 0 で返る"
  [[ "$OUT" =~ ^[0-9]+$ ]] || fail "--budget-sec は数だけを出す（got [$OUT]）"
  run bash "$SCRIPT" --attempts
  [[ "$OUT" =~ ^[0-9]+$ ]] || fail "--attempts は数だけを出す（got [$OUT]）"
  run bash "$SCRIPT" --total-budget-sec
  [[ "$OUT" =~ ^[0-9]+$ ]] || fail "--total-budget-sec は数だけを出す（got [$OUT]）"
}

t_total_budget_fits_inside_the_shortest_job_timeout() {
  # **この関係が崩れると「内側で終わる」が嘘になる。**
  # いちばん短い job は ci.yml:docker-web の 20 分（workflow-timeout.test.ts の表）。
  local total; total=$(bash "$SCRIPT" --total-budget-sec)
  local shortest=$((20 * 60))
  [[ $total -lt $shortest ]] || fail "合計予算 ${total}s が docker-web の ${shortest}s に収まっていない"
  local per; per=$(bash "$SCRIPT" --budget-sec)
  [[ $per -le $total ]] || fail "1 回の予算 ${per}s が合計 ${total}s を超えている"
}

t_bad_args() {
  run bash "$SCRIPT"
  assert_eq 2 "$STATUS" "引数なしは 2"
  run bash "$SCRIPT" --cache-hit yes
  assert_eq 2 "$STATUS" "true/false 以外は 2（'yes' を true と読むと cache-miss を取り違える）"
  assert_contains "$OUT" "true" "何が正しいかを言う"
}

test_case "入ったら 0 を返し、ミラーの話をしない" t_success
test_case "#1254 時間切れは 7 で「ミラーに届かなかった」と言う（受け入れ条件 2）" t_timeout_says_mirror
test_case "#1254 1 回で諦めず入れ直す" t_timeout_retries
test_case "#1254 合計の上限が試行回数より先に効く（job の timeout より内側）" t_total_budget_caps_retries
test_case "#1254 時間切れでない失敗はミラーのせいにしない（受け入れ条件 4 の片側）" t_real_failure_is_not_a_mirror_problem
test_case "cache-hit / cache-miss で引くコマンドが違う" t_cache_hit_picks_install_deps
test_case "予算の出口は数だけを出す（ci.yml と表が読む）" t_budget_flags_print_one_number
test_case "合計予算はいちばん短い job の timeout-minutes に収まる" t_total_budget_fits_inside_the_shortest_job_timeout
test_case "引数の検証（true/false 以外を黙って受けない）" t_bad_args

echo "pass $PASS / fail $FAIL"
[[ $FAIL == 0 ]]
