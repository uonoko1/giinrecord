# shellcheck shell=bash
# Tests for scripts/po/measure-pbi.sh (sourced by run.sh)
#
# **この道具の最悪の壊れ方は「静かに不完全な本文を出す」ことである**——
# **y 方向が抜けたまま 9 回走ったのと同じ形**（#823）。だから母数（#757）を厚く見る。
# `--create` は fake `gh` なので、**実際には Issue を起こさない**（$LOG で呼ばれたことだけ確かめる）。

t_measure_prints_body_from_template() {
  local h; h=$(handler <<'HEOF'
handle() { echo ""; }
HEOF
)
  run_script "$h" measure-pbi.sh --pref 熊本 --prior '#618 が 3 本'
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_contains "$OUT" "y 方向（行）の対応を回転で測る" "**0/10 だった y 方向が本文に載る**"
  assert_contains "$OUT" "判定できる母数を先に数える" "**0/10 だった項目が本文に載る**"
  assert_contains "$OUT" "片方を壊して他方が落ちるか測る" "**0/10 だった項目が本文に載る**"
  assert_contains "$OUT" "熊本" "県名が入る"
  assert_contains "$OUT" "#618 が 3 本" "これまで何本開いたかが入る"
  assert_contains "$OUT" "Closes #N" "PR に Closes を書けと言う（pr-closes.sh）"
  assert_contains "$ERR" "測る項目 13 項目" "**何項目を写したかを出す（母数。#757）**"
  assert_not_contains "$LOG" "issue" "**--create 無しでは gh を一度も呼ばない**"
}
test_case "measure-pbi: 雛形から本文を出す（0/10 だった 3 項目が載る）" t_measure_prints_body_from_template

t_measure_requires_args() {
  local h; h=$(handler <<'HEOF'
handle() { echo ""; }
HEOF
)
  run_script "$h" measure-pbi.sh --pref 熊本
  assert_eq 2 "$STATUS" "--prior が無ければ使い方で落ちる"
  run_script "$h" measure-pbi.sh
  assert_eq 2 "$STATUS" "引数が無ければ使い方で落ちる"
}
test_case "measure-pbi: 県名とこれまでの本数は必須" t_measure_requires_args

t_measure_fails_loudly_on_empty_template() {
  local h; h=$(handler <<'HEOF'
handle() { echo ""; }
HEOF
)
  local tpl="$TMP/empty-template.md"
  printf '# 空\n\n## 測る項目（必須）\n\n## 必ず守ること（必須）\n' > "$tpl"
  MEASURE_TEMPLATE="$tpl" run_script "$h" measure-pbi.sh --pref 熊本 --prior '3 本'
  assert_eq 4 "$STATUS" "**項目 0 件なら異常終了する（静かに空を出さない）**"
  assert_contains "$ERR" "測る項目 0 行" "何が 0 件だったかを言う"
}
test_case "measure-pbi: 項目 0 件の雛形では静かに本文を出さない（#757）" t_measure_fails_loudly_on_empty_template

t_measure_fails_when_template_missing() {
  local h; h=$(handler <<'HEOF'
handle() { echo ""; }
HEOF
)
  MEASURE_TEMPLATE="$TMP/does-not-exist.md" run_script "$h" measure-pbi.sh --pref 熊本 --prior '3 本'
  assert_eq 1 "$STATUS" "雛形が無ければ落ちる"
  assert_contains "$ERR" "雛形が無い" "在処を言う"
}
test_case "measure-pbi: 雛形が無ければ落ちる" t_measure_fails_when_template_missing

t_measure_create_calls_gh() {
  local h; h=$(handler <<'HEOF'
handle() { echo "https://github.com/uonoko1/giinrecord/issues/999"; }
HEOF
)
  run_script "$h" measure-pbi.sh --pref 熊本 --prior '3 本' --sprint 29 --create
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_contains "$LOG" "issue" "--create なら gh issue create を呼ぶ"
  assert_contains "$LOG" "y 方向（行）の対応を回転で測る" "**gh に渡す本文にも 0/10 だった項目が入っている**"
  assert_contains "$LOG" "[S29]" "--sprint がタイトルに入る"
}
test_case "measure-pbi: --create で gh issue create を呼ぶ（本文ごと渡る）" t_measure_create_calls_gh
