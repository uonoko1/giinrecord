# shellcheck shell=bash
# Tests for scripts/po/board-audit.sh (sourced by run.sh)
#
# **書き込む道具なので、「書き込まない」側の検査を厚くする。**
# fake `gh` を使うので、**このテストは実際には Issue も ボードも触らない**
# （`gh issue close` が呼ばれたことは $LOG で確かめる）。
#
# **母数の検査**（#757）: 「食い違い 0 件」と「そもそも 1 件も読めていない」を区別する。

# ハンドラは別プロセスで source されるので、共通のシェル関数は見えない。
# 各ハンドラに board の GraphQL 応答をそのまま書く。

t_audit_finds_merged_pr_open_issue() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[{"number":763,"state":"OPEN"},{"number":700,"state":"CLOSED"}]' ;;
    "api graphql "*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},
      "nodes":[{"id":"I763","content":{"number":763},"fieldValueByName":{"name":"In Progress"}},
               {"id":"I700","content":{"number":700},"fieldValueByName":{"name":"Done"}}]}}}}' ;;
    "pr list "*) echo '[{"number":770,"body":"## fix\n\nCloses #763\n"}]' ;;
    "pr view 770 "*) echo '{"state":"MERGED"}' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" board-audit.sh
  assert_eq 1 "$STATUS" "食い違いがあるので 1: $ERR"
  assert_contains "$OUT" "closed-pr-open-issue" "**本丸の食い違いを検出する**"
  assert_contains "$OUT" "#763" "対象の Issue 番号を出す"
  assert_contains "$OUT" "PR #770" "根拠の PR 番号を出す"
  assert_not_contains "$LOG" "$(printf 'issue\tclose')" "**--fix が無ければ閉じない**"
}
test_case "audit: Closes #N の MERGED な PR があるのに OPEN な Issue を検出する" t_audit_finds_merged_pr_open_issue

t_audit_ignores_bare_mention() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[{"number":763,"state":"OPEN"}]' ;;
    "api graphql "*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},
      "nodes":[{"id":"I763","content":{"number":763},"fieldValueByName":{"name":"In Progress"}}]}}}}' ;;
    # **#763 の検索に実際に引っかかった形**: 本文に番号が出るだけで、閉じる語は無い
    "pr list "*) echo '[{"number":450,"body":"see #763 for background"},
                        {"number":698,"body":"related to #763 (not closing it)"},
                        {"number":461,"body":"#763 に書いた通り"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" board-audit.sh
  assert_not_contains "$OUT" "closed-pr-open-issue" "**本文に #N が出るだけの PR で閉じようとしない**"
  assert_not_contains "$LOG" "$(printf 'pr\tview\t450')" "閉じる語が無ければ PR の state すら問い合わせない"
  assert_contains "$OUT" "マージ済み PR 3 件" "**母数は 3 件のまま**（見なかったわけではない）"
}
test_case "audit: 本文に #N が出るだけの PR は拾わない" t_audit_ignores_bare_mention

t_audit_requires_merged() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[{"number":763,"state":"OPEN"}]' ;;
    "api graphql "*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},
      "nodes":[{"id":"I763","content":{"number":763},"fieldValueByName":{"name":"In Progress"}}]}}}}' ;;
    # 一覧は「マージ済み」として返すが、**個別に問うと OPEN**（一覧を信じてはいけない）
    "pr list "*) echo '[{"number":770,"body":"Closes #763"}]' ;;
    "pr view 770 "*) echo '{"state":"OPEN"}' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" board-audit.sh --fix
  assert_not_contains "$OUT" "closed-pr-open-issue" "**MERGED でない PR で Issue を閉じようとしない**"
  assert_not_contains "$LOG" "$(printf 'issue\tclose')" "**open な PR では gh issue close を呼ばない**"
  assert_contains "$LOG" "$(printf 'pr\tview\t770')" "PR の state を必ず個別に確かめる"
}
test_case "audit: PR が MERGED でなければ Issue を閉じない" t_audit_requires_merged

t_audit_closed_issue_not_done() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[{"number":700,"state":"CLOSED"}]' ;;
    "api graphql "*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},
      "nodes":[{"id":"I700","content":{"number":700},"fieldValueByName":{"name":"In Review"}}]}}}}' ;;
    "pr list "*) echo '[{"number":701,"body":"no refs here"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" board-audit.sh
  assert_eq 1 "$STATUS" "食い違いがあるので 1: $ERR"
  assert_contains "$OUT" "closed-issue-not-done" "**CLOSED なのに Done でない**を検出する"
  assert_contains "$OUT" "#700" "対象の Issue 番号を出す"
  assert_contains "$OUT" "現在=In Review" "現在の Status を出す"
  assert_contains "$OUT" "食い違い 1 件" "件数を出す"
}
test_case "audit: CLOSED な Issue がボードで Done でないことを検出する" t_audit_closed_issue_not_done

t_audit_open_issue_done() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[{"number":710,"state":"OPEN"}]' ;;
    "api graphql "*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},
      "nodes":[{"id":"I710","content":{"number":710},"fieldValueByName":{"name":"Done"}}]}}}}' ;;
    "pr list "*) echo '[{"number":711,"body":"no refs here"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" board-audit.sh
  assert_eq 1 "$STATUS" "食い違いがあるので 1: $ERR"
  assert_contains "$OUT" "open-issue-done" "**OPEN なのに Done**を検出する"
  assert_contains "$OUT" "#710" "対象の Issue 番号を出す"
}
test_case "audit: OPEN な Issue がボードで Done であることを検出する" t_audit_open_issue_done

t_audit_not_on_board() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[{"number":720,"state":"OPEN"},{"number":700,"state":"CLOSED"}]' ;;
    "api graphql "*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},
      "nodes":[{"id":"I700","content":{"number":700},"fieldValueByName":{"name":"Done"}}]}}}}' ;;
    "pr list "*) echo '[{"number":721,"body":"no refs here"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" board-audit.sh
  assert_eq 1 "$STATUS" "食い違いがあるので 1: $ERR"
  assert_contains "$OUT" "not-on-board" "**ボードに載っていない Issue**を検出する"
  assert_contains "$OUT" "#720" "対象の Issue 番号を出す"
  assert_not_contains "$OUT" "#700" "載っていて Done の CLOSED は食い違いではない"
}
test_case "audit: ボードに載っていない Issue を検出する" t_audit_not_on_board

t_audit_default_writes_nothing() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[{"number":763,"state":"OPEN"},{"number":700,"state":"CLOSED"},{"number":710,"state":"OPEN"},{"number":720,"state":"OPEN"}]' ;;
    "api graphql "*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},
      "nodes":[{"id":"I763","content":{"number":763},"fieldValueByName":{"name":"In Progress"}},
               {"id":"I700","content":{"number":700},"fieldValueByName":{"name":"In Review"}},
               {"id":"I710","content":{"number":710},"fieldValueByName":{"name":"Done"}}]}}}}' ;;
    "pr list "*) echo '[{"number":770,"body":"Closes #763"}]' ;;
    "pr view 770 "*) echo '{"state":"MERGED"}' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" board-audit.sh
  # **4 種類ぜんぶが 1 回の走行で出る**（どれか 1 つを検出から外すと、この検査が落ちる）
  assert_contains "$OUT" "closed-pr-open-issue" "1: MERGED な PR / OPEN な Issue"
  assert_contains "$OUT" "closed-issue-not-done" "2: CLOSED なのに Done でない"
  assert_contains "$OUT" "open-issue-done" "3: OPEN なのに Done"
  assert_contains "$OUT" "not-on-board" "4: ボードに載っていない"
  assert_contains "$OUT" "食い違い 4 件" "**件数（母数の検算）も出す**"
  # **既定は読むだけ**: 書き込む呼び出しは 1 つも出さない
  assert_not_contains "$LOG" "$(printf 'issue\tclose')" "**既定で gh issue close を呼ばない**"
  assert_not_contains "$LOG" "updateProjectV2ItemFieldValue" "**既定でボードの Status を書き換えない**"
  assert_not_contains "$LOG" "addProjectV2ItemById" "**既定でボードに項目を足さない**"
  assert_contains "$ERR" "--fix" "直す方法を案内する"
}
test_case "audit: 既定は 4 種類とも列挙するだけで何も書かない" t_audit_default_writes_nothing

t_audit_fix_writes() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[{"number":763,"state":"OPEN"}]' ;;
    # board-audit.sh のボード読み出し（items(first:100…）と board-set.sh の照会／更新を区別する
    "api graphql "*"items(first:100"*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},
      "nodes":[{"id":"I763","content":{"number":763},"fieldValueByName":{"name":"In Progress"}}]}}}}' ;;
    "api graphql "*"projectItems(first:50"*) echo '{"data":{"repository":{"issue":{"id":"N763","projectItems":{"nodes":[{"id":"I763","project":{"id":"PVT_kwHOBy0CLs4BhHqj"}}]}}}}}' ;;
    "api graphql "*updateProjectV2ItemFieldValue*) echo '{"data":{"updateProjectV2ItemFieldValue":{"projectV2Item":{"id":"I763"}}}}' ;;
    "pr list "*) echo '[{"number":770,"body":"Closes #763"}]' ;;
    "pr view 770 "*) echo '{"state":"MERGED"}' ;;
    "issue close "*) ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" board-audit.sh --fix
  assert_contains "$LOG" "$(printf 'issue\tclose\t763')" "**--fix なら閉じる**"
  assert_contains "$LOG" "updateProjectV2ItemFieldValue" "ボードも Done にする"
}
test_case "audit: --fix なら閉じてボードも直す" t_audit_fix_writes

t_audit_fix_never_demotes_done() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[{"number":710,"state":"OPEN"}]' ;;
    "api graphql "*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},
      "nodes":[{"id":"I710","content":{"number":710},"fieldValueByName":{"name":"Done"}}]}}}}' ;;
    "pr list "*) echo '[{"number":711,"body":"no refs"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" board-audit.sh --fix
  assert_eq 1 "$STATUS" "直せないものが残るので 1: $ERR"
  assert_not_contains "$LOG" "updateProjectV2ItemFieldValue" "**OPEN なのに Done は自動で動かさない**（人が決める）"
  assert_contains "$ERR" "人が決めて" "残した理由を出す"
}
test_case "audit: --fix でも OPEN/Done は自動で戻さない" t_audit_fix_never_demotes_done

t_audit_empty_is_not_clean() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[]' ;;
    "api graphql "*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},"nodes":[]}}}}' ;;
    "pr list "*) echo '[]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" board-audit.sh
  # **#757: 「何も読めていない」を「全部きれい」と報告しない**
  assert_eq 4 "$STATUS" "母数 0 は異常終了: $ERR"
  assert_not_contains "$OUT" "食い違い 0 件" "**空を『全部きれい』と報告しない**"
  assert_contains "$ERR" "母数が 0" "母数が 0 だと言う"
}
test_case "audit: gh が空を返したら『全部きれい』と報告しない" t_audit_empty_is_not_clean

t_audit_clean_reports_denominator() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[{"number":700,"state":"CLOSED"},{"number":701,"state":"OPEN"}]' ;;
    "api graphql "*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},
      "nodes":[{"id":"I700","content":{"number":700},"fieldValueByName":{"name":"Done"}},
               {"id":"I701","content":{"number":701},"fieldValueByName":{"name":"In Progress"}}]}}}}' ;;
    "pr list "*) echo '[{"number":702,"body":"no closing keyword"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" board-audit.sh
  assert_eq 0 "$STATUS" "食い違いが無いので 0: $ERR"
  assert_contains "$OUT" "食い違い 0 件" "きれいなら 0 件と言う"
  # **母数を必ず添える**（「0 件」だけでは「読めていない」と区別できない）
  assert_contains "$OUT" "Issue 2 件" "**Issue の母数を出す**"
  assert_contains "$OUT" "ボード項目 2 件" "**ボードの母数を出す**"
  assert_contains "$OUT" "マージ済み PR 1 件" "**PR の母数を出す**"
}
test_case "audit: 食い違い 0 件でも母数を出す" t_audit_clean_reports_denominator

t_audit_paginates_board() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[{"number":700,"state":"CLOSED"},{"number":701,"state":"CLOSED"}]' ;;
    "api graphql "*"cursor=C1"*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},
      "nodes":[{"id":"I701","content":{"number":701},"fieldValueByName":{"name":"Done"}}]}}}}' ;;
    "api graphql "*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":true,"endCursor":"C1"},
      "nodes":[{"id":"I700","content":{"number":700},"fieldValueByName":{"name":"Done"}}]}}}}' ;;
    "pr list "*) echo '[{"number":702,"body":"none"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" board-audit.sh
  # **2 ページ目を読まないと #701 が「載っていない」に見える**（打ち切りは誤検出になる）
  assert_eq 0 "$STATUS" "2 ページとも読めば食い違い 0: $OUT"
  assert_contains "$OUT" "ボード項目 2 件" "**ページングして母数が 2 件になる**"
  assert_not_contains "$OUT" "not-on-board" "打ち切りによる誤検出を出さない"
}
test_case "audit: ボードをページングして最後まで読む" t_audit_paginates_board

t_audit_usage() {
  local h; h=$(handler <<'EOF'
handle() { echo "should not be called" >&2; exit 99; }
EOF
)
  run_script "$h" board-audit.sh --yes
  assert_eq 2 "$STATUS" "知らない引数は usage"
  assert_eq "" "$LOG" "**gh を一度も呼ばない**"
}
test_case "audit: 知らない引数では何もしない" t_audit_usage

t_audit_reports_keyword_coverage() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[{"number":700,"state":"CLOSED"}]' ;;
    "api graphql "*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},
      "nodes":[{"id":"I700","content":{"number":700},"fieldValueByName":{"name":"Done"}}]}}}}' ;;
    # 3 本のうち閉じる語があるのは 1 本だけ（**実測 300 本中 150 本と同じ形**）
    "pr list "*) echo '[{"number":770,"body":"調査: かなは取れる。取らない（#763）"},
                        {"number":775,"body":"Closes #700"},
                        {"number":776,"body":"fix(771): #632 の検算は成り立っていなかった"}]' ;;
    "pr view 775 "*) echo '{"state":"MERGED"}' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" board-audit.sh
  assert_eq 0 "$STATUS" "食い違いは無い: $ERR"
  # **規則 1 が見えていない範囲を黙らない**（#757。#770/#776 は実際に閉じる語が無かった）
  assert_contains "$OUT" "閉じる語があるのは 1 件" "**閉じる語がある PR の本数を出す**"
  assert_contains "$OUT" "2 件は規則 1 の対象外" "**見えていない PR の本数も出す**"
}
test_case "audit: 規則1が見ていない PR の本数を出す（閉じる語が無い PR）" t_audit_reports_keyword_coverage

# ---- 5. inprogress-no-trace（#809）-------------------------------------------------------------
# **In Progress なのに作業の痕跡が無い。** #781 は起票して In Progress にしたまま
# **担当者を立て忘れ、PO が目で見つけるまで誰も作業していなかった。**
#
# **「痕跡が無い = 誰も居ない」ではない**（#809 で PO が実測。worktree=0 の 4 件は 4 件とも偽陽性）。
# だから **(a) 時間の閾値** と **(b) monitor ラベルの除外** で絞る。**列挙するだけで直さない。**
#
# **時刻はテストから固定できないといけない**ので、`PO_NOW` で now を差し込む
# （fake gh では `date` を差し替えられない）。

# In Progress の項目 1 件を返すボード応答を組み立てる補助は使えない（ハンドラは別プロセス）。
# 各ハンドラに直接書く。

t_audit_stale_inprogress() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[{"number":781,"state":"OPEN"}]' ;;
    "api graphql "*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},
      "nodes":[{"id":"I781","content":{"number":781,"labels":{"nodes":[]}},
        "fieldValueByName":{"name":"In Progress","updatedAt":"2026-09-13T00:00:00Z"}}]}}}}' ;;
    "pr list --repo "*"--state merged"*) echo '[{"number":790,"body":"no refs","headRefName":"docs/790-x"}]' ;;
    "pr list --repo "*"--state all"*) echo '[{"number":790,"body":"no refs","headRefName":"docs/790-x"}]' ;;
    "api repos/"*"/branches"*) echo '[{"name":"main"},{"name":"docs/790-x"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  PO_NOW=2026-09-14T12:00:00Z run_script "$h" board-audit.sh
  assert_eq 1 "$STATUS" "食い違いがあるので 1: $ERR"
  assert_contains "$OUT" "inprogress-no-trace" "**痕跡の無い In Progress を検出する（本丸）**"
  assert_contains "$OUT" "#781" "対象の Issue 番号を出す"
}
test_case "audit: In Progress なのに痕跡が無い Issue を検出する (#809)" t_audit_stale_inprogress

t_audit_inprogress_with_branch_is_not_stale() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[{"number":781,"state":"OPEN"}]' ;;
    "api graphql "*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},
      "nodes":[{"id":"I781","content":{"number":781,"labels":{"nodes":[]}},
        "fieldValueByName":{"name":"In Progress","updatedAt":"2026-09-13T00:00:00Z"}}]}}}}' ;;
    # **母数 0 で exit 4 になる既存の検査を踏まないよう、無関係な PR を 1 本置く**
    "pr list --repo "*"--state merged"*) echo '[{"number":600,"body":"no refs","headRefName":"chore/600-x"}]' ;;
    "pr list --repo "*"--state all"*) echo '[{"number":600,"body":"no refs","headRefName":"chore/600-x"}]' ;;
    # **リモートに枝がある = 誰かが作業している**
    "api repos/"*"/branches"*) echo '[{"name":"main"},{"name":"docs/781-kumamoto-measure"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  PO_NOW=2026-09-14T12:00:00Z run_script "$h" board-audit.sh
  assert_not_contains "$OUT" "inprogress-no-trace" "**枝があれば鳴らさない（誤検出の検査）**"
  # **空回り防止**（この 2 行が無いと、規則 5 に到達しないだけで上の検査が通ってしまう。
  # 実際に最初の版はそうなっていて、`HAS_TRACE` を無視する変異で落ちなかった）
  assert_eq 0 "$STATUS" "規則 5 まで到達して食い違い 0 件で終わる: $ERR"
  assert_contains "$OUT" "痕跡あり 1 件" "**枝を痕跡として数えたことを出力で確かめる**"
}
test_case "audit: 番号の付いた枝があれば In Progress を誤検出しない (#809)" t_audit_inprogress_with_branch_is_not_stale

t_audit_inprogress_with_pr_is_not_stale() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[{"number":781,"state":"OPEN"}]' ;;
    "api graphql "*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},
      "nodes":[{"id":"I781","content":{"number":781,"labels":{"nodes":[]}},
        "fieldValueByName":{"name":"In Progress","updatedAt":"2026-09-13T00:00:00Z"}}]}}}}' ;;
    "pr list --repo "*"--state merged"*) echo '[{"number":600,"body":"no refs","headRefName":"chore/600-x"}]' ;;
    # **枝は消えていても、Closes #781 の PR があれば作業はあった**
    "pr list --repo "*"--state all"*) echo '[{"number":799,"body":"Closes #781","headRefName":"gone"}]' ;;
    "api repos/"*"/branches"*) echo '[{"name":"main"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  PO_NOW=2026-09-14T12:00:00Z run_script "$h" board-audit.sh
  assert_not_contains "$OUT" "inprogress-no-trace" "**Closes #N の PR があれば鳴らさない（誤検出の検査）**"
  assert_eq 0 "$STATUS" "規則 5 まで到達して食い違い 0 件で終わる: $ERR"
  assert_contains "$OUT" "痕跡あり 1 件" "**PR を痕跡として数えたことを出力で確かめる**"
}
test_case "audit: Closes #N の PR があれば In Progress を誤検出しない (#809)" t_audit_inprogress_with_pr_is_not_stale

t_audit_inprogress_recent_is_not_stale() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[{"number":855,"state":"OPEN"}]' ;;
    # **1 分前に In Progress にしたばかり**（#855 の実物。worktree を作る前）
    "api graphql "*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},
      "nodes":[{"id":"I855","content":{"number":855,"labels":{"nodes":[]}},
        "fieldValueByName":{"name":"In Progress","updatedAt":"2026-09-14T11:59:00Z"}}]}}}}' ;;
    # **母数 0 で exit 4 になる既存の検査を踏まないよう、無関係な PR を 1 本置く**
    "pr list --repo "*"--state merged"*) echo '[{"number":600,"body":"no refs","headRefName":"chore/600-x"}]' ;;
    "pr list --repo "*"--state all"*) echo '[{"number":600,"body":"no refs","headRefName":"chore/600-x"}]' ;;
    "api repos/"*"/branches"*) echo '[{"name":"main"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  PO_NOW=2026-09-14T12:00:00Z run_script "$h" board-audit.sh
  assert_not_contains "$OUT" "inprogress-no-trace" "**始めた直後は鳴らさない（誤検出の検査）**"
  assert_contains "$OUT" "24 時間" "**閾値を出力に書く**（何を見なかったかが分かるように）"
  assert_eq 0 "$STATUS" "規則 5 まで到達して食い違い 0 件で終わる: $ERR"
  assert_contains "$OUT" "24 時間未満 1 件" "**閾値で見送ったことを出力で確かめる**（空回り防止）"
}
test_case "audit: In Progress にした直後は鳴らさない (#809)" t_audit_inprogress_recent_is_not_stale

t_audit_inprogress_monitor_label_excluded() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[{"number":821,"state":"OPEN"}]' ;;
    # **#821 の実物**: monitor が自動で開いた Issue。**担当者は要らない**
    "api graphql "*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},
      "nodes":[{"id":"I821","content":{"number":821,"labels":{"nodes":[{"name":"monitor"}]}},
        "fieldValueByName":{"name":"In Progress","updatedAt":"2026-09-01T00:00:00Z"}}]}}}}' ;;
    # **母数 0 で exit 4 になる既存の検査を踏まないよう、無関係な PR を 1 本置く**
    "pr list --repo "*"--state merged"*) echo '[{"number":600,"body":"no refs","headRefName":"chore/600-x"}]' ;;
    "pr list --repo "*"--state all"*) echo '[{"number":600,"body":"no refs","headRefName":"chore/600-x"}]' ;;
    "api repos/"*"/branches"*) echo '[{"name":"main"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  PO_NOW=2026-09-14T12:00:00Z run_script "$h" board-audit.sh
  assert_not_contains "$OUT" "inprogress-no-trace" "**monitor ラベルは対象外（担当者を立てない型）**"
  assert_contains "$OUT" "monitor" "**除外した理由と件数を出す**（沈黙で 100% に見せない。#757）"
  assert_eq 0 "$STATUS" "規則 5 まで到達して食い違い 0 件で終わる: $ERR"
  assert_contains "$OUT" "monitor 1 件" "**除外した件数を出力で確かめる**（空回り防止）"
}
test_case "audit: monitor ラベルの Issue は In Progress でも対象外 (#809)" t_audit_inprogress_monitor_label_excluded

t_audit_inprogress_denominator() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[{"number":781,"state":"OPEN"},{"number":812,"state":"OPEN"},{"number":821,"state":"OPEN"},{"number":700,"state":"CLOSED"}]' ;;
    "api graphql "*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},
      "nodes":[{"id":"I781","content":{"number":781,"labels":{"nodes":[]}},
                "fieldValueByName":{"name":"In Progress","updatedAt":"2026-09-13T00:00:00Z"}},
               {"id":"I812","content":{"number":812,"labels":{"nodes":[]}},
                "fieldValueByName":{"name":"In Progress","updatedAt":"2026-09-13T00:00:00Z"}},
               {"id":"I821","content":{"number":821,"labels":{"nodes":[{"name":"monitor"}]}},
                "fieldValueByName":{"name":"In Progress","updatedAt":"2026-09-01T00:00:00Z"}},
               {"id":"I700","content":{"number":700,"labels":{"nodes":[]}},
                "fieldValueByName":{"name":"Done","updatedAt":"2026-09-01T00:00:00Z"}}]}}}}' ;;
    "pr list --repo "*"--state merged"*) echo '[{"number":790,"body":"no refs","headRefName":"x"}]' ;;
    "pr list --repo "*"--state all"*) echo '[{"number":790,"body":"no refs","headRefName":"x"}]' ;;
    "api repos/"*"/branches"*) echo '[{"name":"main"},{"name":"docs/812-ci-throughput"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  PO_NOW=2026-09-14T12:00:00Z run_script "$h" board-audit.sh
  # **母数を出す**（#757。「0 件」と「1 件も見ていない」を区別する）
  assert_contains "$OUT" "In Progress 3 件" "**In Progress の母数を出す**"
  assert_contains "$OUT" "痕跡あり 1 件" "**痕跡があった件数を出す**"
  assert_contains "$OUT" "monitor 1 件" "**除外した件数を出す**"
  assert_contains "$OUT" "#781" "痕跡が無いのは #781 だけ"
  assert_not_contains "$OUT" "inprogress-no-trace	#812" "枝がある #812 は鳴らさない"
  assert_not_contains "$OUT" "inprogress-no-trace	#821" "monitor の #821 は鳴らさない"
}
test_case "audit: In Progress の母数と内訳を出す (#809/#757)" t_audit_inprogress_denominator

t_audit_inprogress_not_fixed() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[{"number":781,"state":"OPEN"}]' ;;
    "api graphql "*"items(first:100"*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},
      "nodes":[{"id":"I781","content":{"number":781,"labels":{"nodes":[]}},
        "fieldValueByName":{"name":"In Progress","updatedAt":"2026-09-13T00:00:00Z"}}]}}}}' ;;
    "pr list --repo "*"--state merged"*) echo '[{"number":790,"body":"no refs","headRefName":"x"}]' ;;
    "pr list --repo "*"--state all"*) echo '[{"number":790,"body":"no refs","headRefName":"x"}]' ;;
    "api repos/"*"/branches"*) echo '[{"name":"main"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  PO_NOW=2026-09-14T12:00:00Z run_script "$h" board-audit.sh --fix
  assert_eq 1 "$STATUS" "直せないものが残るので 1: $ERR"
  # **担当者を立てるのは PO の判断。--fix で動かさない**（OPEN/Done を戻さないのと同じ理由）
  assert_not_contains "$LOG" "updateProjectV2ItemFieldValue" "**--fix でもボードを動かさない**"
  assert_not_contains "$LOG" "$(printf 'issue\tclose')" "**--fix でも Issue を閉じない**"
  assert_contains "$ERR" "人が決めて" "残した理由を出す"
}
test_case "audit: --fix でも In Progress の痕跡無しは直さない (#809)" t_audit_inprogress_not_fixed
