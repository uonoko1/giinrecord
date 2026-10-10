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
# ## **なぜ 1 回しか試さないか**（#1257 のレビュー。**この PR の最初の版は 2 回試していた**）
#
# **`timeout` は直接の子にしかシグナルを送る。`apt-get` は孫なので、生き残る。**
# **実測（2026-10-07）**:
#
#   timeout 1 bash -c 'bash -c "trap \"\" TERM; sleep 20" & wait'
#     → timeout rc=124（1 秒で返る）／**孫の `sleep 20` は生存**（pgrep で PID を確認）
#
# **生き残った apt は dpkg のロックを握り続ける。** だから 2 回目はミラーではなくロックで落ちる:
#
#   試行 1 が 2s で時間切れ（rc=124）
#   試行 2/2 …
#   E: Could not get lock /var/lib/dpkg/lock-frontend
#   playwright-deps: install が rc=100 で落ちた。時間切れではないので、ミラー障害ではない。
#   → **SCRIPT rc=1**
#
# **これは #1254 の目的の逆である**——**本物のミラー障害が「ミラー障害ではない」と
# 報告されて `exit 1` になる。** 再試行の経路が、呼び分けを自分で壊していた。
#
# **2 回試す道を残すには孫まで殺す実装（プロセスグループごと KILL）が必要だが、
# それは #1254 の射程外なので入れない。** **1 回で測って、測れなかったと言う。**
# **副作用として、合計予算（旧 `PLAYWRIGHT_DEPS_TOTAL_BUDGET_SEC=900`）が不要になった**
# ——1 回しか試さないので「1 回の予算」が合計でもある。
# **同じ制約を 2 つの数が分担する形が 1 本減った**（`two-numbers-in-two-files-drift`）。
#
# ## 何分で諦めるか——その数はここに無い
#
# **`PLAYWRIGHT_DEPS_BUDGET_SEC` は `packages/etl/test/workflow-timeout.test.ts` の表が
# 1 か所で持つ**（#556 / #1056: 同じ数が 2 か所に在ると片方が腐る。実測で 225s と 658s に
# 2.8 倍食い違った）。**この変数の値もその表から写したものなので、変えるなら表から変える**
# （`packages/etl/test/playwright-deps-budget.test.ts` が逐語で突き合わせる）。
#
#   scripts/ci/playwright-deps.sh --cache-hit <true|false>   入れる（install-deps / install --with-deps）
#   scripts/ci/playwright-deps.sh --budget-sec               1 回の予算（秒）だけを出す。他は何も出さない
#   scripts/ci/playwright-deps.sh --attempts                 試行回数だけを出す。他は何も出さない
#
# 終了コード:
#   0  入った
#   1  入らなかった（コマンドが落ちた）。**ミラーのせいではない**ので、そう言う
#   7  **予算を使い切った**（= ミラーに届かなかった／遅すぎた）。**この 7 が「測れなかった」である**
#      **1 と 7 の呼び分けがこのスクリプトの要点である**（#1254 の実害は「無言」だった）
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

# 何回試すか。**1 回である**（理由は上の節: `timeout` は孫を殺さないので、
# 2 回目は dpkg のロックで rc=100 になり、ミラー障害が「ミラー障害ではない」に化ける）。
# **この 1 は「まだ測っていない」ではなく「2 を測って、害があると分かった」値である。**
# **`docker-web` の 20 分 = 1200s に対して 1 × 600s なので、job の timeout の内側で終わる**
# （残り 600s で、この step の後ろの step（browser-check 等）が走る）。
PLAYWRIGHT_DEPS_ATTEMPTS=1

if [[ ${1:-} == --budget-sec ]]; then echo "$PLAYWRIGHT_DEPS_BUDGET_SEC"; exit 0; fi
if [[ ${1:-} == --attempts ]]; then echo "$PLAYWRIGHT_DEPS_ATTEMPTS"; exit 0; fi

if [[ ${1:-} != --cache-hit || -z ${2:-} ]]; then
  echo "usage: $0 --cache-hit <true|false> | --budget-sec | --attempts" >&2
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
  this_budget=$PLAYWRIGHT_DEPS_BUDGET_SEC

  echo "playwright-deps: 試行 ${attempt}/${PLAYWRIGHT_DEPS_ATTEMPTS}（この試行の上限 ${this_budget}s、合計の経過 ${elapsed}s）"
  set +e
  # **`--kill-after` は「無言で張り付く」ことそのものを塞ぐ。** **実測（2026-10-07）**:
  #   timeout --signal=TERM --kill-after=2s 1s bash -c 'trap "" TERM; sleep 30'
  #     → rc=137、**3 秒**（= 予算 1s + kill-after 2s）で返る
  #   timeout --signal=TERM          1s bash -c 'trap "" TERM; sleep 8'
  #     → rc=124 だが **10 秒**かかる（**子が終わるまで timeout 自身が待つ**）
  # **`--kill-after` が無いと、TERM を無視する子に予算を踏み越えられる**
  # ——それは #1254 の「無言で `timeout-minutes` を食い切る」と同じ形である。
  # **この引数は `scripts/ci/test/playwright-deps.test.sh` の t_kill_after_bounds_the_overrun が固定する。**
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
    # **いまは ATTEMPTS=1 なので、ここには来ない**（上の `-ge` が必ず成立する）。
    # **経路は残す**——孫まで殺す実装が入れば ATTEMPTS を上げられる。その日まで到達不能である。
    echo "playwright-deps: 入れ直す" >&2
    continue
  fi

  # 時間切れ以外で落ちた＝ミラーのせいではない。**そう言う**（取り違えると #1254 の逆をやる）。
  echo "playwright-deps: install が rc=$rc で落ちた。時間切れではないので、ミラー障害ではない。" >&2
  exit 1
done
