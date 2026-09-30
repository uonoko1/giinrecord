# shellcheck shell=bash
# **Do not run this file directly** (#1124). It is sourced by scripts/po/test/run.sh.
[[ -n ${PO_TEST_RUN_SH:-} ]] || {
  echo "$(basename "${BASH_SOURCE[0]}"): このファイルは単体では走りません（run.sh が source します）。" >&2
  echo "  bash scripts/po/test/run.sh                       # 全部" >&2
  echo "  bash scripts/po/test/run.sh ${BASH_SOURCE[0]##*/} # このファイルだけ" >&2
  exit 2
}
# Tests for scripts/po/scrum-monitor-report.sh（どの終了コードでどの Issue を開閉するか）
#
# **なぜこのファイルが要るか**——**#546 のレビューが実測している**:
# `branch-protection.yml` が同じ論理をインラインの `run:` に持っていた間、**それを検査する
# ものが 1 つも無く、レビューが 5 通りに壊してもテストは 19 passed のまま素通りした**
# （タイトルの入れ替え・rc=2 の分岐の削除・`set +e` の削除・rc=0 で片方しか閉じない）。
# **その 5 つは、この道具が書かれた理由そのものの間違いである。**
#
# ネットワークも本物の `gh` も使わない: 監視と `report.sh` を `MONITOR_CMD` / `REPORT_CMD`
# で差し替え、**`report.sh` の呼び出しを 1 行 `<status> <title>` で記録する。**

MR_STALLED="[monitor] scrum: 止まっている作業がある"
MR_BROKEN="[monitor] scrum: 監視が測れていない"

# 監視の代役。`$M_RC` で終わり、`$M_OUT` を出す。
mr_setup() {
  MR_DIR="$TMP/mr.$RANDOM$RANDOM"; mkdir -p "$MR_DIR"
  MR_ACTIONS="$MR_DIR/actions"; : > "$MR_ACTIONS"
  cat > "$MR_DIR/monitor" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "${M_OUT-}"
exit "${M_RC:-0}"
STUB
  # `report.sh` の代役。**呼ばれた順に記録する**（タイトルと status の対応が要点）。
  cat > "$MR_DIR/report" <<'STUB'
#!/usr/bin/env bash
title=$1; status=$2; body=${3:-}
printf '%s %s\n' "$status" "$title" >> "$MR_ACTIONS"
# fail のときは本文ファイルが実在すること（本文を書かずに Issue を立てない）
if [ "$status" = fail ] && [ ! -f "$body" ]; then echo "stub: body file missing" >&2; exit 1; fi
[ -n "${R_FAIL_FOR:-}" ] && [ "$title" = "$R_FAIL_FOR" ] && { echo "stub: failing on purpose" >&2; exit 1; }
exit 0
STUB
  chmod +x "$MR_DIR/monitor" "$MR_DIR/report"
}

# **ワークフローと同じ `bash -e` で走らせる**（#546: 中の `set +e` はまさにこれを生き延びるため。
# `-e` を外して走らせると、守っている当のバグが隠れる）。
mr_run() {
  MR_STATUS=0
  MR_ACTIONS="$MR_ACTIONS" M_RC="${1:-0}" M_OUT="${2-}" R_FAIL_FOR="${R_FAIL_FOR:-}" \
    MONITOR_CMD="bash $MR_DIR/monitor" REPORT_CMD="bash $MR_DIR/report" RUNNER_TEMP="$MR_DIR" \
    bash -e "$(dirname "$HERE")/scrum-monitor-report.sh" https://example/run \
    > "$MR_DIR/out" 2> "$MR_DIR/err" || MR_STATUS=$?
  # shellcheck disable=SC2034  # MR_OUT は断定を足すときに使う（いまは stderr 側だけ見ている）
  MR_OUT=$(cat "$MR_DIR/out"); MR_ERR=$(cat "$MR_DIR/err")
  MR_LOG=$(cat "$MR_ACTIONS")
  MR_BODY=$(cat "$MR_DIR/scrum-monitor-body.md" 2>/dev/null || true)
}

CLOSE_LINE="[12:00:00Z] scrum-monitor: 終了（節 3/3 を測れました・行動が要る事実 0 件）"

t_mr_green_closes_both() {
  mr_setup
  mr_run 0 "$CLOSE_LINE"
  assert_eq 0 "$MR_STATUS" "exit status: $MR_ERR"
  # **rc=0 は両方閉じる**（測れたので「測れていない」は反証され、事実も無い）
  assert_contains "$MR_LOG" "ok $MR_STALLED" "止まっている の Issue を閉じる"
  assert_contains "$MR_LOG" "ok $MR_BROKEN" "**測れていない の Issue も閉じる（片方だけでは足りない。#546）**"
  assert_not_contains "$MR_LOG" "fail " "**緑のときに Issue を開かない**"
}
test_case "monitor-report: rc=0 は Issue を 2 本とも閉じる (#546 は片方だけ閉じる変異を素通りさせた)" t_mr_green_closes_both

t_mr_findings_opens_stalled() {
  mr_setup
  mr_run 3 "[12:00:00Z] 停滞 #31: In Progress のまま 120 分動いていません
$CLOSE_LINE"
  assert_eq 0 "$MR_STATUS" "**この道具は監視の結果で失敗しない（Issue を立てるのが仕事）**: $MR_ERR"
  assert_contains "$MR_LOG" "fail $MR_STALLED" "**止まっている の Issue を開く**"
  assert_contains "$MR_LOG" "ok $MR_BROKEN" "**測れたので「測れていない」は閉じる**"
  assert_contains "$MR_BODY" "停滞 #31" "**監視の出力をそのまま本文に入れる（要約しない）**"
  assert_contains "$MR_BODY" "終了コード: \`3\`" "終了コードを本文に書く"
  assert_contains "$MR_BODY" "https://example/run" "実行の URL を本文に書く"
}
test_case "monitor-report: rc=3 は「止まっている」を開き、「測れていない」を閉じる" t_mr_findings_opens_stalled

# **これが最も間違えやすい分岐である**（#540 で実際に混同した）。
t_mr_broken_leaves_stalled_alone() {
  mr_setup
  mr_run 4 "[12:00:00Z] MONITOR-BROKEN board: スクラムボードが読めませんでした
$CLOSE_LINE"
  assert_eq 0 "$MR_STATUS" "exit status: $MR_ERR"
  assert_contains "$MR_LOG" "fail $MR_BROKEN" "**測れていない の Issue を開く**"
  # **「止まっている」を閉じてはいけない**: 測れていないことを根拠に
  # 「もう止まっていない」と言うのが #1110 が起きた形そのものである。
  assert_not_contains "$MR_LOG" "ok $MR_STALLED" "**測れていないのに「止まっていない」と言わない**"
  assert_not_contains "$MR_LOG" "fail $MR_STALLED" "**測れていないのに「止まっている」とも言わない**"
  assert_contains "$MR_BODY" "「異常なし」として読まないでください" "**信じてはいけないと書く**"
}
test_case "monitor-report: rc=4 は「測れていない」だけを開き、「止まっている」に触らない (#540)" t_mr_broken_leaves_stalled_alone

# **#547 の再発防止の本体**: 判定行に届かないまま死んだ場合も Issue が立つこと。
# **`BRANCH_PROTECTION_TOKEN` が無い cron が 23 回連続 failure で死んでいて、誰も気づかなかった。**
t_mr_unknown_rc_is_broken() {
  mr_setup
  mr_run 2 "usage: scrum-monitor.sh"
  assert_eq 0 "$MR_STATUS" "exit status: $MR_ERR"
  assert_contains "$MR_LOG" "fail $MR_BROKEN" "**知らない終了コードでも Issue が立つ（#547）**"
  assert_not_contains "$MR_LOG" "ok $MR_STALLED" "**止まっているかは分からないので触らない**"
  assert_contains "$MR_BODY" "想定外の終了コード \`2\`" "**どの終了コードだったかを書く**"
  assert_contains "$MR_BODY" "#547" "**同じ型の過去の事故を引く**"
}
test_case "monitor-report: 想定外の終了コードは「測れていない」として Issue を立てる (#547)" t_mr_unknown_rc_is_broken

t_mr_killed_is_broken() {
  mr_setup
  # 137 = SIGKILL（OOM / timeout）。**判定に届いていない。**
  mr_run 137 ""
  assert_contains "$MR_LOG" "fail $MR_BROKEN" "**killed でも Issue が立つ**"
  assert_contains "$MR_BODY" "想定外の終了コード \`137\`" "終了コードを書く"
}
test_case "monitor-report: killed（137）も「測れていない」として Issue を立てる" t_mr_killed_is_broken

# **exit 0 なのに出力が空**——**2026-09-29 に PO が実際に踏んだ形**（監視が消え、ループだけ生きていた）。
# **終了コードだけを見ていると、これは「異常なし」に見える。**
t_mr_silent_zero_is_broken() {
  mr_setup
  mr_run 0 ""
  assert_eq 0 "$MR_STATUS" "exit status: $MR_ERR"
  assert_contains "$MR_LOG" "fail $MR_BROKEN" "**exit 0 でも締めの行が無ければ「測れていない」**"
  assert_not_contains "$MR_LOG" "ok $MR_BROKEN" "**閉じてはいけない**"
  # **【#1150 の 2 人目のレビュー 要修正 2】「止まっている」に触ってはいけない。**
  # **rc=4 側には同じ断定が在るのに、この分岐には無かった**ので、
  # **「監視が死んだから止まっている作業は無い」と閉じる変異が素通りした**（実測 0 件落ち）。
  # **測れていないことを根拠に「もう止まっていない」と言うのが #1110 が起きた形そのものである。**
  assert_not_contains "$MR_LOG" "ok $MR_STALLED" "**測れていないのに「止まっていない」と言わない（#1110 の再来）**"
  assert_not_contains "$MR_LOG" "fail $MR_STALLED" "**測れていないのに「止まっている」とも言わない**"
  assert_contains "$MR_BODY" "締めの行を出していません" "**何がおかしいかを書く**"
  assert_contains "$MR_BODY" "**なし＝監視が途中で死んでいます**" "締めの行の有無を本文に書く"
  # **バックティックを本文に書いてはいけない**（`worktree-audit.sh` が同じ罠を逐語で書いている:
  # 「log は二重引用符で受けるのでコマンド置換されて**助言そのものが消える**」）。
  # **実測**: 助言に **バックティックで囲んだ `set -e`** と書いていたとき、
  # **`set -e` が実行されて空に置き換わり**、本文は
  # 「途中で死んでいます（ で落ちた／killed／timeout）」になった。
  # **消えた助言は、書かなかったのと同じである。** shellcheck SC2006 も同じ行を指摘した。
  assert_contains "$MR_BODY" "set -e で落ちた" "**助言がコマンド置換で消えていない**"
}
test_case "monitor-report: exit 0 でも締めの行が無ければ「測れていない」(#1094 で PO が踏んだ形)" t_mr_silent_zero_is_broken

# **rc=3 でも締めの行が無ければ**——**事実は出ているので「止まっている」は開く**が、
# **締めの行の有無は本文に書かれる**（人が「途中で死んだ」と読める）。
t_mr_closing_line_is_reported_in_body() {
  mr_setup
  mr_run 3 "[12:00:00Z] 停滞 #31: 120 分"
  assert_contains "$MR_LOG" "fail $MR_STALLED" "事実は出ているので開く"
  assert_contains "$MR_BODY" "**なし＝監視が途中で死んでいます**" "**締めの行が無いことを本文に書く**"
}
test_case "monitor-report: 締めの行の有無は必ず本文に書く（rc=3 でも）" t_mr_closing_line_is_reported_in_body

# **`report.sh` が失敗したら step を赤くする**（#546: `set -e` を戻していないと飲み込まれた）。
t_mr_report_failure_surfaces() {
  mr_setup
  R_FAIL_FOR="$MR_BROKEN" mr_run 4 "MONITOR-BROKEN x
$CLOSE_LINE"
  assert_eq 1 "$MR_STATUS" "**Issue を立てられなかったら失敗する（飲み込まない。#546）**"
}
test_case "monitor-report: report.sh の失敗を飲み込まない (#546 の set -e 変異)" t_mr_report_failure_surfaces

# **rc=3 で 1 本目の `report.sh` が失敗したときも飲み込まない。**
t_mr_first_report_failure_surfaces() {
  mr_setup
  R_FAIL_FOR="$MR_STALLED" mr_run 3 "[12:00:00Z] 停滞 #31: 120 分
$CLOSE_LINE"
  assert_eq 1 "$MR_STATUS" "**1 本目の失敗も飲み込まない（#546 のレビュー指摘そのもの）**"
}
test_case "monitor-report: 1 本目の report.sh の失敗も飲み込まない (#546)" t_mr_first_report_failure_surfaces

t_mr_body_has_no_paths() {
  mr_setup
  mr_run 4 "[12:00:00Z] MONITOR-BROKEN board: 読めません
$CLOSE_LINE"
  # **OSS なので本文に絶対パスを書かない**（`scrum-monitor.sh` はパスを出さないので、
  # そのまま入れても漏れない。**この道具が余分に足していないこと**を固定する）
  assert_not_contains "$MR_BODY" "/home/" "**本文に絶対パスを書かない（OSS）**"
  assert_not_contains "$MR_BODY" "$MR_DIR" "**一時ディレクトリのパスも書かない**"
}
test_case "monitor-report: Issue 本文に絶対パスを書かない（OSS）" t_mr_body_has_no_paths
