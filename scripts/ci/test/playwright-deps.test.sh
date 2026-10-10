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
# **写しで測った結果は、本体の値の証拠にならない**（`two-numbers-in-two-files-drift`）。
# **だから本体の値そのものを見る検査を別に置く**（t_attempts_is_one_in_the_real_script）。
#
#   bash scripts/ci/test/playwright-deps.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
SCRIPT="$ROOT/scripts/ci/playwright-deps.sh"
PASS=0; FAIL=0
# #1244: 掃除の終了コードがテスト結果を上書きしないように、trap では結果を変えない。
# #1251 が逐語で照合する形に揃える（scripts/ci/test/trap-cleanup.test.sh の SHAPE_HEAD/SHAPE_TAIL）。
TMP=$(mktemp -d); cleanup() { local __rc=$?; rm -rf "$TMP" || echo "warn: cleanup left $TMP behind (not a test failure)" >&2; exit "$__rc"; }; trap cleanup EXIT

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
#
# **#1257 のレビューで合計予算（旧 PLAYWRIGHT_DEPS_TOTAL_BUDGET_SEC）が消えたので引数は 2 つ。**
with_budget() { # with_budget <1回の秒> <試行回数> → $TMP/pw.sh
  sed -e "s/^PLAYWRIGHT_DEPS_BUDGET_SEC=.*/PLAYWRIGHT_DEPS_BUDGET_SEC=$1/" \
      -e "s/^PLAYWRIGHT_DEPS_ATTEMPTS=.*/PLAYWRIGHT_DEPS_ATTEMPTS=$2/" \
      "$SCRIPT" > "$TMP/pw.sh"
  for want in "PLAYWRIGHT_DEPS_BUDGET_SEC=$1" "PLAYWRIGHT_DEPS_ATTEMPTS=$2"; do
    grep -qx "$want" "$TMP/pw.sh" || { echo "FATAL: 写しの置換が当たらなかった（$want）。このテストの結果は使えない"; exit 9; }
  done
  echo "$TMP/pw.sh"
}

# ci.yml から「この step を持つ job の、いちばん短い timeout-minutes（分）」を読む。
# **#1257 のレビュー指摘 3**: 20 という数をここに書くと ci.yml の 3 つ目の写しになる。
# **ci.yml 全体の最小値を取ってはいけない**——`stale-base` の 10 分はこの step を走らせない
# ので、関係の無い数で落ちる（packages/etl/test/playwright-deps-budget.test.ts の同じ注を見よ）。
# **読めなければテストを落とす**（0 や空で通すと、下の比較が空振りして常に緑になる）。
# **`| head -1` を使わない**（#527: `pipefail` のもとで早期終了する読み手をパイプの末尾に置くと、
# 書き手が SIGPIPE で死んで**確率的に**偽になる。`scripts/ci/shellcheck.sh` の検査が CI で落とした）。
# **最小値は awk の中で取る**——パイプが 1 本も無くなる。
shortest_job_timeout_minutes() {
  awk '
    /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { job=$1; sub(/:$/,"",job); t="" }
    /^    timeout-minutes:[[:space:]]*[0-9]+[[:space:]]*$/ { t=$2 }
    /^      - name: Install Chromium for Playwright[[:space:]]*$/ {
      if (t != "" && (min == "" || t + 0 < min + 0)) min = t
    }
    END { if (min != "") print min }
  ' "$ROOT/.github/workflows/ci.yml"
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
  local s; s=$(with_budget 1 1)
  run env PW_DEPS_CMD_OVERRIDE="sleep 30" bash "$s" --cache-hit true
  assert_eq 7 "$STATUS" "時間切れは 7（0 でも 1 でもない）"
  assert_contains "$OUT" "ミラーに届かなかった" "諦めたときに**ミラーに届かなかった**と言う（#1254 の受け入れ条件 2）"
  assert_contains "$OUT" "コードの赤ではない" "**コードの赤と呼び分ける**（受け入れ条件 4 の片側）"
  assert_contains "$OUT" "時間切れ" "何が起きたかを言う"
}

# **#1257 のレビュー指摘 1**: 2 回試す経路が #1254 の目的を自分で壊していた。
# `timeout` は**直接の子にしかシグナルを送らない**ので `apt-get`（孫）が生き残り、
# **dpkg のロックを握ったまま**になる。2 回目はミラーではなくロックで rc=100 で落ち、
# スクリプトは「時間切れではないので、ミラー障害ではない」と**嘘を言って exit 1** する。
# **＝本物のミラー障害が「コードの赤」として報告される。** だから 1 回で諦める。
t_one_attempt_only() {
  local s; s=$(with_budget 1 1)
  run env PW_DEPS_CMD_OVERRIDE="sleep 30" bash "$s" --cache-hit true
  assert_eq 7 "$STATUS" "1 回の時間切れで 7（2 回目を試して dpkg のロックで 1 にしない）"
  assert_contains "$OUT" "試行 1/1" "試行は 1 回だけ（分母も 1）"
  assert_not_contains "$OUT" "入れ直す" "入れ直さない（孫が dpkg のロックを握っている）"
  assert_not_contains "$OUT" "ミラー障害ではない" "**時間切れを「ミラー障害ではない」と言わない**（#1254 の逆）"
}

# **ATTEMPTS を 2 に戻すと落ちる**ことを、スクリプト本体の値そのもので見る。
# （上の t_one_attempt_only は写しを使うので、本体が 2 に戻っても緑のままになりうる。
#  **`two-numbers-in-two-files-drift`: 写しで測った結果は本体の値の証拠にならない。**）
t_attempts_is_one_in_the_real_script() {
  local a; a=$(bash "$SCRIPT" --attempts)
  assert_eq 1 "$a" "本体の PLAYWRIGHT_DEPS_ATTEMPTS が 1 でない（2 以上にすると #1254 の逆をやる）"
}

# **#1257 のレビュー指摘 2 の後半**: `--kill-after` が何を守っているか。
# **実測（2026-10-07、この worktree で）**:
#   timeout --signal=TERM --kill-after=2s 1s bash -c 'trap "" TERM; sleep 30' → rc=137 / **3s**
#   timeout --signal=TERM              1s bash -c 'trap "" TERM; sleep 8'  → rc=124 / **10s**
# **`--kill-after` が無いと、TERM を無視する子が終わるまで `timeout` 自身が待つ**
# ——予算を踏み越えて無言で張り付く。**それは #1254 の症状そのものである。**
t_kill_after_bounds_the_overrun() {
  assert_contains "$(cat "$SCRIPT")" "--kill-after" "--kill-after が無い（TERM を無視する子に予算を踏み越えられる）"
  # 予算 1s・TERM を無視する子（sleep 30）。`--kill-after` が効いていれば **KILL されて 137**。
  # 無ければ rc=124 になり、しかも子が終わる 30 秒まで返ってこない。
  local s; s=$(with_budget 1 1)
  sed -i "s/--kill-after=30s/--kill-after=2s/" "$s"
  grep -q -- "--kill-after=2s" "$s" || { echo "FATAL: kill-after の置換が当たらなかった。この測定は使えない"; exit 9; }
  printf '#!/usr/bin/env bash\ntrap "" TERM\nsleep 30\n' > "$TMP/ignores-term.sh"
  chmod +x "$TMP/ignores-term.sh"
  local t0 t1; t0=$(date +%s)
  run env PW_DEPS_CMD_OVERRIDE="$TMP/ignores-term.sh" bash "$s" --cache-hit true
  t1=$(date +%s)
  assert_eq 7 "$STATUS" "TERM を無視する子でも 7（無言で張り付かない）"
  assert_contains "$OUT" "rc=137" "**KILL まで行ったこと**を言う（TERM で死んでいないので 124 ではない）"
  [[ $((t1-t0)) -lt 25 ]] || fail "予算 1s + kill-after 2s なのに $((t1-t0))s かかった（--kill-after が効いていない）"
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
}

t_worst_case_fits_inside_the_shortest_job_timeout() {
  # **この関係が崩れると「内側で終わる」が嘘になる。**
  # **最悪の所要は 1 回の予算 × 試行回数**（合計予算は #1257 のレビューで消えた）。
  # **20 分という数はここに書かない**（#1257 のレビュー指摘 3: ci.yml の 3 つ目の写しになる）。
  local mins; mins=$(shortest_job_timeout_minutes)
  [[ "$mins" =~ ^[0-9]+$ ]] || { fail "ci.yml から timeout-minutes を読めなかった（got [$mins]）"; return; }
  local shortest=$((mins * 60))
  local per attempts; per=$(bash "$SCRIPT" --budget-sec); attempts=$(bash "$SCRIPT" --attempts)
  local worst=$((per * attempts))
  [[ $worst -lt $shortest ]] || fail "最悪 ${worst}s（${per}s × ${attempts} 回）が、いちばん短い job の ${shortest}s（${mins} 分）に収まっていない"
}

# **ci.yml を読む経路そのものが生きているか**（上の検査が空振りしていないこと）。
t_shortest_is_read_from_ci_yml() {
  local mins; mins=$(shortest_job_timeout_minutes)
  [[ "$mins" =~ ^[0-9]+$ ]] || { fail "ci.yml から読めなかった（got [$mins]）"; return; }
  # **この step を走らせない job の値を拾っていないこと**——`stale-base` は 10 分だが
  # Install Chromium を持たない。拾っていたら 10 が出る。
  [[ $mins -gt 10 ]] || fail "いちばん短い timeout-minutes が ${mins} 分。Install Chromium を持たない job（stale-base の 10 分）を拾っている疑いがある"
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
test_case "#1257 1 回しか試さない（2 回目は dpkg のロックで「ミラー障害ではない」に化ける）" t_one_attempt_only
test_case "#1257 本体の ATTEMPTS が 1（写しではなく実物の値を見る）" t_attempts_is_one_in_the_real_script
test_case "#1257 --kill-after が予算の踏み越えを止める（TERM を無視する子でも 137 で返る）" t_kill_after_bounds_the_overrun
test_case "#1254 時間切れでない失敗はミラーのせいにしない（受け入れ条件 4 の片側）" t_real_failure_is_not_a_mirror_problem
test_case "cache-hit / cache-miss で引くコマンドが違う" t_cache_hit_picks_install_deps
test_case "予算の出口は数だけを出す（ci.yml と表が読む）" t_budget_flags_print_one_number
test_case "最悪（予算 × 試行）はいちばん短い job の timeout-minutes に収まる" t_worst_case_fits_inside_the_shortest_job_timeout
test_case "#1257 いちばん短い timeout-minutes は ci.yml から読む（20 を書き写さない）" t_shortest_is_read_from_ci_yml
test_case "引数の検証（true/false 以外を黙って受けない）" t_bad_args

echo "pass $PASS / fail $FAIL"
[[ $FAIL == 0 ]]
