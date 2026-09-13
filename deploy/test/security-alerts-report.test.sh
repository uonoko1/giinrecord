#!/usr/bin/env bash
# Tests for deploy/monitor/security-alerts-report.sh (Issue #786): which Issue is opened or closed for each exit
# code of security-alerts.sh, and that the bodies match the outcome.
#
# Why this file exists as a file: the equivalent logic for branch protection lived in an inline `run:` block and
# NOTHING checked it — a review swapped the two Issue titles, dropped the rc=2 branch and deleted the `set +e`,
# and the suite stayed at 19 passed for every one (#546 review). The same three mistakes are pinned here.
#
# No network and no real gh: security-alerts.sh and report.sh are replaced through GUARD_CMD / REPORT_CMD, and
# every report.sh call is appended to $ACTIONS as one line "<status> <title>".
#   bash deploy/test/security-alerts-report.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../monitor/security-alerts-report.sh"
PASS=0; FAIL=0

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

ALERTS="[monitor] repo: security アラート"
UNREADABLE="[monitor] repo: security アラートを読めない"

cat > "$TMP/guard" <<'STUB'
#!/usr/bin/env bash
echo "${G_OUT:-guard says something}"
exit "${G_RC:-0}"
STUB
cat > "$TMP/report" <<'STUB'
#!/usr/bin/env bash
title=$1; status=$2
echo "$status $title" >> "$ACTIONS"
if [ -n "${R_FAIL_FOR:-}" ] && [ "$title" = "$R_FAIL_FOR" ]; then echo "stub: report.sh failing on purpose" >&2; exit 1; fi
STUB
chmod +x "$TMP/guard" "$TMP/report"

fail() { echo "    x $1"; CURRENT_FAILED=1; }

fresh() {
  P="$TMP/$1"; mkdir -p "$P"; ACTIONS="$P/actions"; : > "$ACTIONS"
  export ACTIONS RUNNER_TEMP="$P"
  unset G_RC G_OUT R_FAIL_FOR
}
# Runs the reporter the way the workflow does: the default shell there is `bash -e`, and the whole point of the
# `set +e` inside is to survive that. Running it without -e would hide the very bug this guards against.
run_report() {
  RC=0
  GUARD_CMD="bash $TMP/guard" REPORT_CMD="bash $TMP/report" \
    bash -e "$SCRIPT" uonoko1/giinrecord https://example/run > "$P/out" 2> "$P/err" || RC=$?
  OUT=$(cat "$P/out")
}
assert_actions() {
  local want got
  want=$(printf '%s\n' "$@" | sort)
  got=$(sort "$ACTIONS")
  [[ "$want" == "$got" ]] || fail "report.sh の呼ばれ方が違う
    期待: $(echo "$want" | tr '\n' '|')
    実際: $(echo "$got" | tr '\n' '|')"
}
body() { cat "$P/security-alerts-body.md"; }

test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

t_syntax() { bash -n "$SCRIPT" || fail "bash -n"; }

# rc=0: read successfully and empty. BOTH Issues close — "unreadable" is disproved by having read it.
t_rc0_closes_both() {
  fresh rc0
  G_RC=0 run_report
  [[ $RC == 0 ]] || fail "expected exit 0, got $RC"
  assert_actions "ok $ALERTS" "ok $UNREADABLE"
}

# rc=1: open alerts exist → the Issue opens. This is the whole point of #786: an alert that nobody reads.
t_rc1_opens_alerts_and_closes_unreadable() {
  fresh rc1
  G_RC=1 G_OUT="secret-scanning: open 1 件（Google API Key x1）" run_report
  [[ $RC == 1 ]] || fail "expected exit 1, got $RC"
  assert_actions "fail $ALERTS" "ok $UNREADABLE"
}

# rc=2: could not read. The unreadable Issue opens; the alerts one is NOT touched in either direction,
# because whether alerts exist was never determined this run.
t_rc2_opens_unreadable_and_leaves_alerts_alone() {
  fresh rc2
  G_RC=2 G_OUT="読めなかった" run_report
  [[ $RC == 1 ]] || fail "expected exit 1 (the run must go red), got $RC"
  assert_actions "fail $UNREADABLE"
}

# #757 の母数そのもの: 読めなかった run が「アラート」Issue を**閉じて**しまうと、
# 前の run が開けた本物のアラートが、読めなくなっただけで静かに消える。
t_unreadable_never_closes_the_alerts_issue() {
  fresh rc2_close
  G_RC=2 run_report
  if grep -q "^ok $ALERTS\$" "$ACTIONS"; then fail "読めなかった run がアラート Issue を閉じた（アラートは消えていないのに）"; fi
}

# 本文が結果と一致していること。#540 はこれを取り違えた Issue そのものだった。
t_bodies_match_the_outcome() {
  fresh bodies
  G_RC=1 G_OUT="secret-scanning: open 1 件" run_report
  [[ -f "$P/security-alerts-body.md" ]] || { fail "rc=1 で本文ファイルが作られていない"; return; }
  local b; b=$(body)
  [[ "$b" == *"open のままになっている"* ]] || fail "rc=1 の本文が「open のまま」と言っていない: $b"
  [[ "$b" != *"判定できていない"* ]] || fail "rc=1 の本文が「判定できていない」と言っている"

  fresh bodies2
  G_RC=2 G_OUT="読めなかった" run_report
  [[ -f "$P/security-alerts-body.md" ]] || { fail "rc=2 で本文ファイルが作られていない"; return; }
  local u; u=$(body)
  [[ "$u" == *"判定できていない"* ]] || fail "rc=2 の本文が「判定できていない」と言っていない: $u"
  [[ "$u" == *"これは「アラート 0 件」ではない"* ]] || fail "rc=2 の本文が 0 件と区別していない: $u"
  [[ "$u" != *"open のままになっている"* ]] || fail "rc=2 の本文が「open のまま」と言っている（#540 の再発）"
}

# 本文には GitHub 上の URL を入れる（中身は書かずに、人が辿れるようにする）。
t_alerts_body_links_to_the_security_tab() {
  fresh linkbody
  G_RC=1 G_OUT="secret-scanning: open 1 件" run_report
  [[ "$(body)" == *"https://github.com/uonoko1/giinrecord/security"* ]] || fail "Security タブへのリンクが無い"
  [[ "$(body)" == *"https://example/run"* ]] || fail "run へのリンクが無い"
}

# **ここが一番大事**: guard が（壊れて、あるいは将来の改変で）秘密の値を吐いたとしても、
# それは本文に逐語で入る。本文の出どころは guard の stdout だけであり、
# このレポータは**自分でアラートの中身を取りに行かない**ことを固定する。
t_report_does_not_fetch_alert_contents_itself() {
  fresh nofetch
  # gh をここで呼んだら即座に失敗する stub を PATH の先頭に置く。
  local bin="$P/bin"; mkdir -p "$bin"
  printf '#!/usr/bin/env bash\necho "report がアラートの中身を自分で取りに行っている" >&2\nexit 97\n' > "$bin/gh"
  chmod +x "$bin/gh"
  RC=0
  PATH="$bin:$PATH" GUARD_CMD="bash $TMP/guard" REPORT_CMD="bash $TMP/report" \
    bash -e "$SCRIPT" uonoko1/giinrecord https://example/run > "$P/out" 2> "$P/err" || RC=$?
  [[ $RC != 97 ]] || fail "レポータが gh を直接呼んでいる（中身を取りに行っている）"
  if grep -q "取りに行っている" "$P/err"; then fail "レポータが gh を直接呼んだ"; fi
}

# 本文は guard の stdout だけからできている。guard が出さなかった文字列は本文に現れない。
t_body_carries_only_what_the_guard_printed() {
  fresh onlyguard
  G_RC=1 G_OUT="secret-scanning: open 1 件（Google API Key x1）" run_report
  local b; b=$(body)
  [[ "$b" == *"Google API Key x1"* ]] || fail "guard の出力が本文に入っていない"
  [[ "$b" != *"AIzaSy"* ]] || fail "guard が出していない秘密の形の文字列が本文にある"
}

# 想定外の終了コードでも Issue を開く。何も報告しなければ、run が赤いだけで理由がどこにも無い。
t_unexpected_rc_reports_unreadable() {
  fresh rc5
  G_RC=5 G_OUT="想定外" run_report
  [[ $RC == 1 ]] || fail "expected exit 1, got $RC"
  assert_actions "fail $UNREADABLE"
  [[ "$OUT" == *"想定外の終了コード 5"* ]] || fail "想定外だったことを述べていない: $OUT"
}

# report.sh の失敗を飲まない。`set +e` を置きっぱなしにすると、1本目の失敗が2本目の 0 で上書きされ、
# 監視が Issue を閉じなくなっているのに毎回緑になる（#546 レビュー）。
t_first_report_failure_is_not_swallowed() {
  fresh reportfail
  G_RC=0 R_FAIL_FOR="$ALERTS" run_report
  [[ $RC != 0 ]] || fail "1本目の report.sh が失敗したのに step が 0 で終わった（失敗が飲まれている）"
}
t_second_report_failure_is_not_swallowed() {
  fresh reportfail2
  G_RC=0 R_FAIL_FOR="$UNREADABLE" run_report
  [[ $RC != 0 ]] || fail "2本目の report.sh が失敗したのに step が 0 で終わった"
}

# guard の終了コードは VALUE。`bash -e` のもとで非ゼロの置換はその場で step を終わらせる。
t_survives_errexit() {
  fresh errexit
  G_RC=2 run_report
  [[ -s "$ACTIONS" ]] || fail "bash -e のもとで report.sh が1回も呼ばれていない（set +e が効いていない）"
}

t_usage() {
  fresh usage
  RC=0; bash "$SCRIPT" > "$P/out" 2>&1 || RC=$?
  [[ $RC == 2 ]] || fail "引数なしは exit 2 のはず、got $RC"
}

echo "== deploy/monitor/security-alerts-report.sh =="
test_case "syntax"                                            t_syntax
test_case "引数なしは exit 2"                                  t_usage
test_case "rc=0: 両方の Issue を閉じる"                        t_rc0_closes_both
test_case "rc=1: アラートを開き、読めないを閉じる"              t_rc1_opens_alerts_and_closes_unreadable
test_case "rc=2: 読めないを開き、アラートには触らない"          t_rc2_opens_unreadable_and_leaves_alerts_alone
test_case "読めなかった run はアラート Issue を閉じない"        t_unreadable_never_closes_the_alerts_issue
test_case "本文が結果と一致している（取り違えない）"            t_bodies_match_the_outcome
test_case "本文が Security タブと run を指す"                  t_alerts_body_links_to_the_security_tab
test_case "レポータは自分でアラートの中身を取りに行かない"      t_report_does_not_fetch_alert_contents_itself
test_case "本文は guard が出したものだけからできている"         t_body_carries_only_what_the_guard_printed
test_case "想定外の終了コードでも Issue を開く"                t_unexpected_rc_reports_unreadable
test_case "1本目の report.sh の失敗を飲まない"                 t_first_report_failure_is_not_swallowed
test_case "2本目の report.sh の失敗を飲まない"                 t_second_report_failure_is_not_swallowed
test_case "bash -e のもとでも case に入る（set +e）"           t_survives_errexit

echo "-- $PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]
