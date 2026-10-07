#!/usr/bin/env bash
# Issue #1254: `playwright install-deps` が Ubuntu のミラー障害で無言のまま
# `timeout-minutes` を使い切り、job が **cancelled** になる。
#
# ## 何が起きていたか（実測 2026-10-07。ci.yml の 2 か所が同じ形だった）
#
# **「ミラーに届かない」は 1 つの症状ではなく、2 つの別の区間で起きた。**
#
#   run 37663904608 check      18:10:49Z → 18:19:58Z = **554s（9 分 9 秒）で success**
#     `apt-get update`   12.6 MB を **1 秒**（8537 kB/s）で取れている＝届いている
#     `apt-get install`  32.5 MB を **9 分 2 秒**（**59.9 kB/s**）＝**帯域が落ちた**
#
#   run 37663904608 docker-web 18:28:11Z → 18:47:03Z = **1132s で cancelled**（同じ run の別 job）
#     `apt-get update`   `Ign:` を繰り返して**無言で張り付いた**＝ InRelease すら取れない
#     18 分 35 秒で `##[error]The operation was canceled.`
#
# **同じ run の 18 分差で、片方は「遅いが通る」、片方は「update が通らない」になった。**
# **だから「届かない」だけを塞ぐと、59.9 kB/s の側は 20 分を食い切るまで無言のままである。**
# **ここが切るのは「届いたか」ではなく「かかった時間」である。**
#
# ## なぜ再試行だけでは足りないか
#
# `apt-get` は既定で粘る（`Ign:` を繰り返す）。**粘っている間、終了コードは返ってこない。**
# `timeout-minutes` は job 全体を切るので、**使い切った時点で「何が遅かったか」は残らない**
# （cancelled な job のログは、どの step が食ったかを人間が読んで突き合わせるしかない）。
# **だから外から時間で切って、切ったことを自分で言う**（`waiting-loops-must-fail-closed`:
# 測れなかったことを「測れた」に倒さない）。
#
# ## 何分で諦めるか——その数はここに無い
#
# **`PLAYWRIGHT_DEPS_BUDGET_SEC` は `packages/etl/test/workflow-timeout.test.ts` の表が
# 1 か所で持つ**（#556 / #1056: 同じ数が 2 か所に在ると片方が腐る。実測で 225s と 658s に
# 2.8 倍食い違った）。**この変数の値もその表から写したものなので、変えるなら表から変える**
# （`packages/etl/test/playwright-deps-budget.test.ts` が逐語で突き合わせる）。
#
#   scripts/ci/playwright-deps.sh --cache-hit <true|false>   入れる（install-deps / install --with-deps）
#   scripts/ci/playwright-deps.sh --budget-sec               予算（秒）だけを出す。他は何も出さない
#
# 終了コード:
#   0  入った
#   1  入らなかった（コマンドが落ちた）。**ミラーのせいではない**ので、そう言う
#   7  **予算を使い切った**（= ミラーに届かなかった／遅すぎた）。**この 7 が「測れなかった」である**
#
# テスト: scripts/ci/test/playwright-deps.test.sh
set -euo pipefail

# **この数の出どころは packages/etl/test/workflow-timeout.test.ts の表である**（上の節）。
# 実測（2026-10-07、n=160 step、ci.yml の 2 job 合算）: 正常時は min 11 / med 14 / p90 26s。
# 障害時は 554s（通った）/ 1132s・1152s（cancelled）。
# **600 秒は「正常時の med の 43 倍」であり「障害時に通った 554s の 1.08 倍」である。**
# 554s を切らない値にしてあるのは、**通る見込みが在るものを落とさない**ため
# （偽陽性の赤を、別の偽陽性の赤に付け替えることになる）。
PLAYWRIGHT_DEPS_BUDGET_SEC=600

# 何回試すか。**ミラー障害は 18 分で表情を変えた**（上の実測）ので、1 回で諦めない。
# **予算は 1 回ごとに適用する**（合計ではない）。2 回とも使い切る最悪は
# 2 × 600s = 20 分で、`check` の 30 分 / `docker-web` の 20 分のどちらにも収まらない……
# のではなく **`docker-web` の 20 分はちょうど食い切る**。だから**合計にも上限を置く**（下の TOTAL）。
PLAYWRIGHT_DEPS_ATTEMPTS=2
# 合計の上限（秒）。**job の `timeout-minutes` より内側で終わること**が要点で、
# いちばん短い `docker-web` の 20 分 = 1200s に対して 900s（75%）。
# 残り 300s で step の後片付けと、この step の後ろの step（browser-check 等）が走る。
PLAYWRIGHT_DEPS_TOTAL_BUDGET_SEC=900

if [[ ${1:-} == --budget-sec ]]; then echo "$PLAYWRIGHT_DEPS_BUDGET_SEC"; exit 0; fi
if [[ ${1:-} == --attempts ]]; then echo "$PLAYWRIGHT_DEPS_ATTEMPTS"; exit 0; fi
if [[ ${1:-} == --total-budget-sec ]]; then echo "$PLAYWRIGHT_DEPS_TOTAL_BUDGET_SEC"; exit 0; fi

if [[ ${1:-} != --cache-hit || -z ${2:-} ]]; then
  echo "usage: $0 --cache-hit <true|false> | --budget-sec | --attempts | --total-budget-sec" >&2
  exit 2
fi
case "$2" in
  true|false) ;;
  *) echo "--cache-hit must be literally 'true' or 'false' (got '$2')" >&2; exit 2 ;;
esac

# `install-deps` は OS の依存だけ（ブラウザはキャッシュから来る）。
# cache-miss なら `install --with-deps` でブラウザも入れる。**どちらも apt を叩く。**
if [[ $2 == true ]]; then
  CMD=(pnpm --filter web exec playwright install-deps chromium)
else
  CMD=(pnpm --filter web exec playwright install --with-deps chromium)
fi

# `${PW_DEPS_CMD_OVERRIDE:-}` はテストが偽のコマンドを差すための口。
# **CI では設定しない**（設定されていたら実物の代わりにそれを走らせる）。
if [[ -n ${PW_DEPS_CMD_OVERRIDE:-} ]]; then
  read -r -a CMD <<< "$PW_DEPS_CMD_OVERRIDE"
fi

started=$(date +%s)
attempt=0
while :; do
  attempt=$((attempt + 1))
  elapsed=$(( $(date +%s) - started ))
  remaining=$(( PLAYWRIGHT_DEPS_TOTAL_BUDGET_SEC - elapsed ))
  # この試行に与える秒数は「1 回の予算」と「合計の残り」の小さいほう。
  this_budget=$PLAYWRIGHT_DEPS_BUDGET_SEC
  [[ $remaining -lt $this_budget ]] && this_budget=$remaining

  if [[ $this_budget -le 0 ]]; then
    echo "playwright-deps: 合計予算 ${PLAYWRIGHT_DEPS_TOTAL_BUDGET_SEC}s を使い切った（経過 ${elapsed}s）" >&2
    echo "playwright-deps: ミラーに届かなかった（apt の取得が終わらない）。Ubuntu のミラー障害が疑われる。コードの赤ではない。" >&2
    exit 7
  fi

  echo "playwright-deps: 試行 ${attempt}/${PLAYWRIGHT_DEPS_ATTEMPTS}（この試行の上限 ${this_budget}s、合計の経過 ${elapsed}s）"
  set +e
  timeout --signal=TERM --kill-after=30s "${this_budget}s" "${CMD[@]}"
  rc=$?
  set -e

  if [[ $rc -eq 0 ]]; then
    echo "playwright-deps: 入った（試行 ${attempt}、合計 $(( $(date +%s) - started ))s）"
    exit 0
  fi

  # `timeout` は TERM で切ったとき 124、KILL まで行ったとき 137 を返す。
  # **これが「ミラーに届かなかった」である**（コマンド自身の失敗と区別する）。
  if [[ $rc -eq 124 || $rc -eq 137 ]]; then
    echo "playwright-deps: 試行 ${attempt} が ${this_budget}s で時間切れ（rc=$rc）" >&2
    if [[ $attempt -ge $PLAYWRIGHT_DEPS_ATTEMPTS ]]; then
      echo "playwright-deps: ミラーに届かなかった（${PLAYWRIGHT_DEPS_ATTEMPTS} 回とも時間切れ）。Ubuntu のミラー障害が疑われる。コードの赤ではない。" >&2
      exit 7
    fi
    echo "playwright-deps: 入れ直す" >&2
    continue
  fi

  # 時間切れ以外で落ちた＝ミラーのせいではない。**そう言う**（取り違えると #1254 の逆をやる）。
  echo "playwright-deps: install が rc=$rc で落ちた。時間切れではないので、ミラー障害ではない。" >&2
  exit 1
done
