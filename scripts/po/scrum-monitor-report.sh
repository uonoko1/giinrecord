#!/usr/bin/env bash
# Issue #1110: `scrum-monitor.sh` の終了コードを GitHub Issue の開閉に変える（自動の入口の後半）。
#
# **なぜワークフローの `run:` にインラインで書かないか**——**#546 のレビューで実測されている**:
#   `branch-protection.yml` がこれをインラインに持っていた間、**それを検査するものが 1 つも無く、
#   レビューが「Issue のタイトルを入れ替える」「rc=2 の分岐を削除する」「`set +e` を削除する」の
#   3 つを入れても、テストは 19 passed のまま素通りした。**
#   **その 3 つは、この道具が書かれた理由そのものの間違いである。**
#   **だからファイルに置き、テストで固定する**（`deploy/monitor/branch-protection-report.sh`
#   と同じ理由・同じ形）。
#
# **立てる Issue は 2 種類で、混同してはいけない**（#540 で実際に混同した:
# 設定は無傷なのに「弱い」と書いた Issue が立った）:
#   「[monitor] scrum: 止まっている作業がある」    **測れて**、行動が要る事実が在る
#   「[monitor] scrum: 監視が測れていない」        **測れていない**。止まっているかは分からない
#
# 終了コードごとの対応（**何をどちらに倒すか**）:
#   rc=0  全部測れて、行動が要るものが無い
#         → **両方閉じる**（測れたので「測れていない」は反証され、事実も無い）
#   rc=3  測れて、行動が要る事実が在る
#         → 「止まっている」を開き、**「測れていない」は閉じる**（測れたので反証された）
#   rc=4  測れなかった節が在る（MONITOR-BROKEN）
#         → 「測れていない」を開き、**「止まっている」は触らない**——
#           **止まっているかどうかは決まっていないので、開くのも閉じるのも嘘になる。**
#           **特に「閉じる」をしてはいけない**: **測れていないことを根拠に
#           「もう止まっていない」と言うのが、#1110 が起きた形そのものである。**
#   それ以外（1 / 2 / 124 / 137 / …）
#         → **「測れていない」として扱う。** **これが #547 の再発防止の本体である**:
#           **`BRANCH_PROTECTION_TOKEN` が無い cron が 23 回連続 failure で死んでいて、
#           誰も気づかなかった。** **判定行に届かないまま死んだ場合も、Issue が立つこと。**
#           **「終了コードを知らない」は「異常なし」ではない。**
#
# **締めの行も見る**（#1110 の要件 5 / #1094）。`scrum-monitor.sh` は最後に必ず
# `scrum-monitor: 終了（節 N/M を測れました…）` を出す。**この行が無ければ、
# 監視は途中で死んでいる**（`set -e` で落ちた／killed／timeout）。
# **終了コードだけでは足りない**: **exit 0 で出力が空という形が在りうる**
# （実際 2026-09-29 に PO の監視が消え、ループだけが生きていた）。
# **だから「rc が 0 でも締めの行が無ければ、測れていない」と判定する。**
#
# 出力に書かないもの: IP・ホスト名・内部パス・鍵・アカウント名（OSS。Issue 本文に載る）。
# **`scrum-monitor.sh` はパスも枝名も出さない**ので、その出力をそのまま本文に入れてよい。
#
# Usage:
#   scripts/po/scrum-monitor-report.sh <run-url>
# Env:
#   MONITOR_CMD   監視の呼び出し方（既定 `bash <ここ>/scrum-monitor.sh`）。テストが差し替える
#   REPORT_CMD    Issue の開閉（既定 `bash deploy/monitor/report.sh`）。テストが差し替える
#
# Tests: scripts/po/test/scrum-monitor-report.test.sh
set -euo pipefail

RUN_URL=${1:-}

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
MONITOR=${MONITOR_CMD:-"bash $HERE/scrum-monitor.sh"}
# **Issue の開閉は `deploy/monitor/report.sh` に任せる**（#135 から在るもの。
# **タイトルが同一性なので、鳴り続けても Issue が溜まらない**——
# `monitor.yml` / `branch-protection.yml` と同じ仕組みを使う。**2 つ目を作らない**）。
REPORT=${REPORT_CMD:-"bash $ROOT/deploy/monitor/report.sh"}

STALLED_TITLE="[monitor] scrum: 止まっている作業がある"
BROKEN_TITLE="[monitor] scrum: 監視が測れていない"

BODY_FILE="${RUNNER_TEMP:-$(mktemp -d)}/scrum-monitor-body.md"
OUT_FILE="${RUNNER_TEMP:-$(dirname "$BODY_FILE")}/scrum-monitor-out.txt"

# **`set +e` は呼び出しの周りだけに掛ける。** 監視は**終了コードを値として使う**（0/3/4）ので、
# ワークフローの既定シェル（`bash -e {0}`）ではここで step が終わってしまう
# （#546 で実測: **Issue を 1 本も開かずに exit 2 した**）。
# **直後に `set -e` を戻す**——戻さないでいると、下の `report.sh` の失敗が
# **step が緑のまま飲み込まれる**（#546 のレビュー指摘）。
set +e
$MONITOR > "$OUT_FILE" 2>&1
RC=$?
set -e

# **締めの行が在るか**（#1094 / #1110 の要件 5）。**無ければ監視は途中で死んでいる。**
CLOSING=0
grep -qF "scrum-monitor: 終了（節 " "$OUT_FILE" && CLOSING=1

# **本文に監視の出力をそのまま入れる**（**要約しない**）。
# **要約すると「何が測れなかったか」が落ちる**ので、行数だけ添えて全文を入れる。
write_body() {
  local verdict=$1
  {
    echo "$verdict"
    echo
    echo "- 監視の終了コード: \`$RC\`"
    echo "- 締めの行（\`scrum-monitor: 終了（節 N/M を測れました…）\`）: $([[ $CLOSING == 1 ]] && echo "あり" || echo "**なし＝監視が途中で死んでいます**")"
    echo "- 出力の行数: $(grep -c '' "$OUT_FILE" || true) 行"
    [[ -n "$RUN_URL" ]] && echo "- 実行: $RUN_URL"
    echo
    echo "判定の対応は \`scripts/po/scrum-monitor-report.sh\` の冒頭にあります。"
    echo "手で確かめるには \`bash scripts/po/scrum-monitor.sh\`（読むだけです）。"
    echo
    echo '```'
    cat "$OUT_FILE"
    echo '```'
  } > "$BODY_FILE"
}

# **rc=0 でも締めの行が無ければ「測れていない」に倒す**（上の docblock）。
# **これは「黙って緑」を潰すための、この道具の要点である。**
if [[ "$RC" == 0 && "$CLOSING" == 0 ]]; then
  RC=broken_silent
fi

case "$RC" in
  0)
    # 測れて、事実が無い → **両方閉じる**
    $REPORT "$STALLED_TITLE" ok
    $REPORT "$BROKEN_TITLE" ok
    ;;
  3)
    # 測れて、行動が要る事実が在る → 開く。**「測れていない」は測れたので閉じる**
    write_body "**スクラムの監視が、行動が要る事実を見つけました。** 詳細は下の出力にあります。"
    $REPORT "$STALLED_TITLE" fail "$BODY_FILE"
    $REPORT "$BROKEN_TITLE" ok
    ;;
  4)
    # 測れなかった → 開く。**「止まっている」は触らない**（開くのも閉じるのも嘘になる）
    write_body "**スクラムの監視が、一部を測れませんでした。** **この出力を「異常なし」として読まないでください。** 止まっている作業が在るかどうかは、この実行では分かっていません。"
    $REPORT "$BROKEN_TITLE" fail "$BODY_FILE"
    ;;
  broken_silent)
    # **exit 0 なのに締めの行が無い**（#1094 で PO が踏んだ形）。**測れていない側に倒す。**
    RC=0
    write_body "**監視が終了コード 0 で終わったのに、締めの行を出していません。** **途中で死んでいます**（set -e で落ちた／killed／timeout のいずれか）。**「異常なし」として読まないでください。**"
    $REPORT "$BROKEN_TITLE" fail "$BODY_FILE"
    ;;
  *)
    # **知らない終了コードは「測れていない」として扱う**（#547 の再発防止）。
    # **判定行に届かないまま死んだ場合も、ここで Issue が立つ。**
    write_body "**監視が想定外の終了コード \`$RC\` で終わりました。** **判定に届いていない可能性が在ります**（#547: 入口が 23 回連続で死んでいたのに誰も気づかなかった形）。**「異常なし」として読まないでください。**"
    $REPORT "$BROKEN_TITLE" fail "$BODY_FILE"
    ;;
esac

# **この道具自身は、監視の結果で失敗しない。** **Issue を立てるのが仕事である。**
# **失敗するのは Issue を立てられなかったときだけ**（`report.sh` の非ゼロは `set -e` で上がる）。
# **step を赤くしてしまうと、「入口が死んだ」と「事実が在る」が区別できなくなる。**
exit 0
