#!/usr/bin/env bash
# Tests for scripts/ci/etl-rebuild-prepare.sh (Issue #284): rebuild を明示したときだけ国会側の出力を消す。
# 偽の data/ を作って、消えたもの・残ったもの・exit を見る。
#   bash scripts/ci/test/etl-rebuild-prepare.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../etl-rebuild-prepare.sh"
ALL_SESSIONS="200 201 202 203 204 205 206 207 208 209 210 211 212 213 214 215 216 217 218 219 220 221"
PASS=0; FAIL=0
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_eq() { [[ "$2" == "$1" ]] || fail "$3: expected [$1] got [$2]"; }
assert_exists() { [[ -e "$1" ]] || fail "$2: expected to exist: $1"; }
assert_gone() { [[ ! -e "$1" ]] || fail "$2: expected to be gone: $1"; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in: $1"; }
test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

# 偽の data/。本番と同じく、data/members に国会（m_* 参院 / h_* 衆院）と地方（p_*）が混在する（#157）。
make_data() {
  DATA=$TMP/data; rm -rf "$DATA"
  mkdir -p "$DATA/members/m_000001" "$DATA/rollcalls/217" "$DATA/bills/217" "$DATA/unmatched" "$DATA/assemblies/pref-04"
  echo '{}' > "$DATA/members/m_000001.json"
  echo '{}' > "$DATA/members/h_00abcd.json"
  echo '{}' > "$DATA/members/m_000001/speeches.json"   # 発言は別ファイル（#242）
  echo '{}' > "$DATA/members/p_04_amasita.json"        # 地方議員の detail（日次 ETL は書かない）
  printf '[{"id":"m_000001","assemblyId":"diet-sangiin"},{"id":"h_00abcd","assemblyId":"diet-shugiin"},{"id":"legacy_no_assembly"},{"id":"p_04_amasita","assemblyId":"pref-04"}]' > "$DATA/members/index.json"
  echo '[]' > "$DATA/rollcalls/index.json"
  echo '{}' > "$DATA/rollcalls/217/rc1.json"
  echo '[]' > "$DATA/bills/index.json"
  echo '{}' > "$DATA/bills/217/b1.json"
  echo '[]' > "$DATA/unmatched/217.json"
  echo '[]' > "$DATA/unmatched.json"
  echo '{}' > "$DATA/meta.json"
  echo '[]' > "$DATA/assemblies/index.json"
  echo '[]' > "$DATA/assemblies/pref-04/members.json"
}

run() { # run <rebuild> <sessions>
  set +e
  DATA_DIR="$TMP/data" GITHUB_STEP_SUMMARY="$TMP/summary" bash "$SCRIPT" "$1" "$2" > "$TMP/out" 2>&1
  STATUS=$?
  set -e
  OUT=$(cat "$TMP/out")
}

# data/ がそのまま残っていることを丸ごと確かめる（「何も消えない」を 1 か所で言い切る）
assert_data_intact() {
  local f
  for f in members/m_000001.json members/h_00abcd.json members/m_000001/speeches.json members/p_04_amasita.json \
           members/index.json rollcalls/index.json rollcalls/217/rc1.json bills/index.json bills/217/b1.json \
           unmatched/217.json unmatched.json meta.json assemblies/index.json assemblies/pref-04/members.json; do
    assert_exists "$DATA/$f" "$1: $f"
  done
  assert_contains "$(cat "$DATA/members/index.json")" "m_000001" "$1: index.json keeps Diet rows"
}

# 既定の実行（cron / 引数なしの手動実行）: 何も消えない
t_default_cron_deletes_nothing() {
  make_data; run "" ""
  assert_eq 0 "$STATUS" "exit"
  assert_data_intact "cron"
  assert_contains "$OUT" "left untouched" "message"
}

# sessions だけ指定した通常の手動実行: 何も消えない
t_sessions_only_deletes_nothing() {
  make_data; run "" "$ALL_SESSIONS"
  assert_eq 0 "$STATUS" "exit"
  assert_data_intact "sessions-only"
}

# "yes" 以外は発火しない（うっかり値で消えない）
t_other_values_do_not_fire() {
  local v
  for v in true TRUE Yes YES y 1 rebuild no false " yes"; do
    make_data; run "$v" "$ALL_SESSIONS"
    assert_eq 0 "$STATUS" "exit ($v)"
    assert_data_intact "value [$v]"
  done
}

# rebuild: 国会側だけ消える
t_rebuild_deletes_diet_output() {
  make_data; run yes "$ALL_SESSIONS"
  assert_eq 0 "$STATUS" "exit"
  assert_gone "$DATA/rollcalls" "rollcalls"
  assert_gone "$DATA/bills" "bills"
  assert_gone "$DATA/unmatched" "unmatched dir"
  assert_gone "$DATA/unmatched.json" "unmatched.json"
  assert_gone "$DATA/meta.json" "meta.json"
  assert_gone "$DATA/members/m_000001.json" "sangiin detail"
  assert_gone "$DATA/members/h_00abcd.json" "shugiin detail"
  assert_gone "$DATA/members/m_000001" "speeches dir"
}

# 地方議会は消えない。data/members はディレクトリごと消さない（国会と地方が共有する。#157）
t_rebuild_keeps_local_assemblies() {
  make_data; run yes "$ALL_SESSIONS"
  assert_exists "$DATA/assemblies/index.json" "assemblies/index.json"
  assert_exists "$DATA/assemblies/pref-04/members.json" "assemblies/pref-04"
  assert_exists "$DATA/members/p_04_amasita.json" "local member detail"
  assert_exists "$DATA/members/index.json" "members/index.json"
}

# members/index.json は国会の行だけ消える（assemblyId 無しの旧行も国会扱い。isDietMemberRow と同じ判定）
t_rebuild_rewrites_member_index() {
  make_data; run yes "$ALL_SESSIONS"
  local idx; idx=$(cat "$DATA/members/index.json")
  assert_contains "$idx" "p_04_amasita" "local row kept"
  [[ "$idx" != *m_000001* ]] || fail "sangiin row removed: $idx"
  [[ "$idx" != *h_00abcd* ]] || fail "shugiin row removed: $idx"
  [[ "$idx" != *legacy_no_assembly* ]] || fail "assemblyId-less row treated as Diet: $idx"
}

# 消した件数とパスがログと Summary に出る
t_rebuild_reports_counts() {
  make_data; run yes "$ALL_SESSIONS"
  assert_contains "$OUT" "$DATA/rollcalls" "path in log"
  assert_contains "$OUT" "計" "total row in log"
  assert_contains "$(cat "$TMP/summary")" "$DATA/bills" "path in summary"
  assert_contains "$(cat "$TMP/summary")" "ETL rebuild" "heading in summary"
  # 国会側 3 ファイル（m_ detail・h_ detail・speeches.json）を数えている
  assert_contains "$OUT" "国会議員の detail と発言） | 3 |" "member file count"
}

# 回次が空 → 失敗し、何も消えない
t_rebuild_without_sessions_fails() {
  make_data; run yes ""
  assert_eq 1 "$STATUS" "exit"
  assert_data_intact "empty sessions"
  assert_contains "$OUT" "sessions が不足" "message"
}

# 回次が足りない（既定の 5 回次だけ） → 失敗し、何も消えない
t_rebuild_with_partial_sessions_fails() {
  make_data; run yes "217 218 219 220 221"
  assert_eq 1 "$STATUS" "exit"
  assert_data_intact "partial sessions"
  assert_contains "$OUT" "200" "names a missing session"
}

# 部分文字列の一致で通してしまわない（"21" は "217" ではない）
t_rebuild_substring_is_not_a_match() {
  make_data; run yes "20 21 22"
  assert_eq 1 "$STATUS" "exit"
  assert_data_intact "substring"
}

# 22 回次を含んでいれば余分な回次（バックフィル）があっても通る
t_rebuild_with_extra_sessions_runs() {
  make_data; run yes "142 $ALL_SESSIONS"
  assert_eq 0 "$STATUS" "exit"
  assert_gone "$DATA/meta.json" "meta.json"
}

test_case "cron / no input deletes nothing"          t_default_cron_deletes_nothing
test_case "sessions-only run deletes nothing"        t_sessions_only_deletes_nothing
test_case "values other than yes do not fire"        t_other_values_do_not_fire
test_case "rebuild deletes the Diet output"          t_rebuild_deletes_diet_output
test_case "rebuild keeps the local assemblies"       t_rebuild_keeps_local_assemblies
test_case "rebuild rewrites members/index.json"      t_rebuild_rewrites_member_index
test_case "rebuild reports what it deleted"          t_rebuild_reports_counts
test_case "rebuild without sessions fails"           t_rebuild_without_sessions_fails
test_case "rebuild with partial sessions fails"      t_rebuild_with_partial_sessions_fails
test_case "substring is not a session match"         t_rebuild_substring_is_not_a_match
test_case "extra sessions are allowed"               t_rebuild_with_extra_sessions_runs

echo "--- $PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]
