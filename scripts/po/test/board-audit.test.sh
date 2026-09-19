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

# ---- 台帳（#919）-------------------------------------------------------------------------------
# **`--fix` が直したことを、後から数えられる形で残す。**
# **Sprint 28 の締めで「この回で何回食い違いを捕まえたか」が書けなかった**——
# **`--fix` が直すたびに食い違いが消えるので、後から数えられなかった。**
#
# **ここで固定するのは 3 つ**:
#   (a) **`--fix` が直したら台帳が増える**
#   (b) **`--fix` を付けずに読んだだけなら 1 バイトも書かない**（ファイルを作りもしない）
#   (c) **母数（何件見て・何件直して・何件残したか）が台帳に入る**（#757）

# 台帳の行を数える。**空を 1 行と数えない**（`printf '%s\n' ""` は空行 1 本を作るので、
# `grep -c ''` では「書いていない」と「1 行書いた」が両方 1 になる——そこが今回の主張の核心）。
# `grep -c` は 0 件で exit 1 を返し、run.sh の `set -e` が走行ごと落とすので `|| true` で受ける。
ledger_rows() { # ledger_rows [kind]  → 行数（kind を渡すとその種別の行だけ数える）
  [[ -n "$LEDGER" ]] || { echo 0; return 0; }
  local kind=${1:-}
  if [[ -z "$kind" ]]; then
    printf '%s\n' "$LEDGER" | grep -c '' || true
  else
    printf '%s\n' "$LEDGER" | cut -f2 | grep -cx "$kind" || true
  fi
}

# 直した 1 件・残した 1 件が同時に出るハンドラ（台帳の検査で使い回す）。
# #763: Closes #763 の MERGED な PR がある OPEN な Issue → 直す
# #710: OPEN なのに Done                                 → 残す（人が決める）
t_ledger_handler() {
  handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[{"number":763,"state":"OPEN"},{"number":710,"state":"OPEN"}]' ;;
    "api graphql "*"items(first:100"*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},
      "nodes":[{"id":"I763","content":{"number":763},"fieldValueByName":{"name":"In Review"}},
               {"id":"I710","content":{"number":710},"fieldValueByName":{"name":"Done"}}]}}}}' ;;
    "api graphql "*"projectItems(first:50"*) echo '{"data":{"repository":{"issue":{"id":"N763","projectItems":{"nodes":[{"id":"I763","project":{"id":"PVT_kwHOBy0CLs4BhHqj"}}]}}}}}' ;;
    "api graphql "*updateProjectV2ItemFieldValue*) echo '{"data":{"updateProjectV2ItemFieldValue":{"projectV2Item":{"id":"I763"}}}}' ;;
    "pr list "*) echo '[{"number":770,"body":"Closes #763"}]' ;;
    "pr view 770 "*) echo '{"state":"MERGED"}' ;;
    "issue close "*) ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
}

t_ledger_records_fixes() {
  local h; h=$(t_ledger_handler)
  run_script "$h" board-audit.sh --fix
  # (a) 直した 1 件が、**いつ・どの Issue を・どの状態からどの状態に**の形で残る
  # 規則 1 は **Issue を閉じる** と **ボードを Done にする** の 2 つを動かすので、両方を書く
  assert_contains "$LEDGER" "$(printf '\tfixed\t763\tOPEN/In Review\tCLOSED/Done\tclosed-pr-open-issue')" \
    "**直した 1 件が <どこから><どこへ><種別> 付きで台帳に残る**"
  # 残した 1 件も残る（**直していないものを「直した」と数えないため**）
  assert_contains "$LEDGER" "$(printf '\tleft\t710\tDone\t')" "**人に残した 1 件も台帳に残る**"
  assert_contains "$LEDGER" "open-issue-done" "残した理由（種別）も残る"
  # 時刻が UTC の ISO8601 で入っている（**いつ直したか**）
  local ts; ts=$(printf '%s\n' "$LEDGER" | head -1 | cut -f1)
  [[ "$ts" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
    || fail "台帳の 1 列目は UTC の ISO8601: got [$ts]"
  # **行数の検算**: fixed 1 + left 1 + run 1 = 3 行
  assert_eq 3 "$(ledger_rows)" "**台帳は fixed 1 + left 1 + run 1 の 3 行**"
}
test_case "ledger: --fix が直した/残した 1 件ずつを台帳に残す (#919)" t_ledger_records_fixes

t_ledger_records_denominator() {
  local h; h=$(t_ledger_handler)
  run_script "$h" board-audit.sh --fix
  # (c) **#757: 何件見て、何件直して、何件残したか。** 「直した 1 件」だけでは母数が分からない
  assert_contains "$LEDGER" "$(printf '\trun\t-\t-\t-\t')" "**1 回の --fix につき run 行が 1 本**"
  assert_contains "$LEDGER" "issues=2 board=2 prs=1 findings=2 fixed=1 left=1" \
    "**母数（見た件数）と内訳（直した/残した）が run 行に入る**"
  # **run 行の数字と、実際に書いた行数が一致すること**（台帳の中だけで検算できる）
  local fixed_rows left_rows
  fixed_rows=$(ledger_rows fixed)
  left_rows=$(ledger_rows left)
  assert_eq 1 "$fixed_rows" "fixed 行は 1 本"
  assert_eq 1 "$left_rows" "left 行は 1 本"
  assert_contains "$LEDGER" "fixed=$fixed_rows left=$left_rows" "**run 行の数字が実際の行数と一致する**"
}
test_case "ledger: 台帳に母数（見た/直した/残した）が入る (#919/#757)" t_ledger_records_denominator

t_ledger_readonly_writes_nothing() {
  # (b) **読んだだけで「直した」が増えてはいけない。** **ファイルを作りもしない。**
  #
  # **2 つの形を両方見る。** 片方だけでは `$FIX` の番人を外す変異を捕まえられない:
  #   - **食い違いがある形**: 読むだけの走行は `exit 1` で `ledger_flush` に着く前に終わる。
  #     **だからこの形は、番人が無くても台帳が増えない**——**この形だけでは何も主張できない**
  #     （実測: `[[ "$FIX" == 1 ]] || return 0` を 2 か所とも消しても、この形は緑のままだった）。
  #   - **食い違いが 0 件の形**: `ledger_flush` に着くので、**番人だけが書き込みを止めている。**
  local h; h=$(t_ledger_handler)
  run_script "$h" board-audit.sh   # **--fix を付けない**（食い違いあり）
  assert_eq 1 "$STATUS" "食い違いがあるので 1: $ERR"
  assert_contains "$OUT" "closed-pr-open-issue" "読むだけでも食い違いは出す（前提）"
  assert_eq "" "$LEDGER" "**読むだけの走行は台帳に 1 バイトも書かない（食い違いあり）**"
  [[ ! -e "$LEDGER_PATH" ]] || fail "**読むだけの走行は台帳のファイルを作りもしない（食い違いあり）**"

  local h0; h0=$(handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[{"number":700,"state":"CLOSED"}]' ;;
    "api graphql "*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},
      "nodes":[{"id":"I700","content":{"number":700},"fieldValueByName":{"name":"Done"}}]}}}}' ;;
    "pr list "*) echo '[{"number":702,"body":"no closing keyword"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h0" board-audit.sh   # **--fix を付けない**（食い違い 0 件）
  assert_eq 0 "$STATUS" "食い違いが無いので 0: $ERR"
  assert_contains "$OUT" "食い違い 0 件" "読むだけでも 0 件だと言う（前提）"
  assert_eq "" "$LEDGER" "**読むだけの走行は台帳に 1 バイトも書かない（0 件）**"
  [[ ! -e "$LEDGER_PATH" ]] || fail "**読むだけの走行は台帳のファイルを作りもしない（0 件）**"
}
test_case "ledger: --fix を付けずに読んだだけなら台帳に何も書かない (#919)" t_ledger_readonly_writes_nothing

t_ledger_clean_run_still_counted() {
  # **食い違い 0 件でも --fix なら run 行を書く。**
  # **走らせた回数が母数だから**——「直した 9 件」だけ残ると、
  # それが 1 回で出たのか 30 回走らせて出たのかが分からない。
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[{"number":700,"state":"CLOSED"}]' ;;
    "api graphql "*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},
      "nodes":[{"id":"I700","content":{"number":700},"fieldValueByName":{"name":"Done"}}]}}}}' ;;
    "pr list "*) echo '[{"number":702,"body":"no closing keyword"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  run_script "$h" board-audit.sh --fix
  assert_eq 0 "$STATUS" "食い違いが無いので 0: $ERR"
  assert_contains "$LEDGER" "findings=0 fixed=0 left=0" "**0 件の走行も run 行として数える**"
  assert_eq 1 "$(ledger_rows)" "**0 件なら run 行 1 本だけ**"
  # そして同じハンドラを --fix 無しで走らせたら、やはり何も書かない
  run_script "$h" board-audit.sh
  assert_eq "" "$LEDGER" "**0 件でも読むだけなら書かない**"
}
test_case "ledger: 食い違い 0 件の --fix も run 行として数える (#919/#757)" t_ledger_clean_run_still_counted

t_ledger_appends() {
  # **追記であること。** **前回までの行を消したら、過去の回数がまた失われる**
  # ——**それがこの PBI の出発点である**（Sprint 28 の回数はもう復元できない）。
  #
  # 台帳に「前の回の 3 行」を先に置いてから走らせ、**その 3 行が残ったまま増える**ことを見る。
  local h; h=$(t_ledger_handler)
  run_script "$h" board-audit.sh --fix          # 1 回目（run_script が台帳を消してから走る）
  local first_rows; first_rows=$(ledger_rows)
  assert_eq 3 "$first_rows" "1 回目で 3 行（前提）"
  # 2 回目: **1 回目の中身を置いたまま**走らせる（run_script は消すので、直接呼ばずに自前で走らせる）
  local seeded="$LEDGER"
  printf '%s\n' "$seeded" > "$LEDGER_PATH"
  PATH="$HERE/fake-bin:$PATH" FAKE_GH_LOG="$TMP/gh.log" FAKE_GH_HANDLER="$h" \
    FAKE_COUNTER="$TMP/counter" FAKE_UNHANDLED="$TMP/unhandled" \
    POLL_INTERVAL=0 POLL_MAX=5 PO_REPO=uonoko1/giinrecord BOARD_AUDIT_LOG="$LEDGER_PATH" \
    bash "$PO_DIR/board-audit.sh" --fix > /dev/null 2>&1 || true
  local LEDGER; LEDGER=$(cat "$LEDGER_PATH" 2>/dev/null || true)
  assert_eq 6 "$(ledger_rows)" "**2 回走らせたら 6 行**（追記であって上書きではない）"
  assert_eq 2 "$(ledger_rows run)" "**run 行が 2 本 = --fix を 2 回走らせた**"
  assert_eq 2 "$(ledger_rows fixed)" "**直した延べ件数（2 件）が数えられる**"
  # **1 回目に置いた行がそのまま残っている**（消して書き直していない）
  assert_contains "$LEDGER" "$seeded" "**前の回の行を 1 行も消さない**"
}
test_case "ledger: 台帳は追記で、過去の回数が消えない (#919)" t_ledger_appends

t_ledger_writes_no_free_text() {
  # **OSS 公開前提。台帳に書くのは番号と Status と種別だけで、自由文は書かない。**
  # **Issue/PR のタイトルや本文は台帳の入力にしていない**——**何が入るか分からない**から
  # （調査中のホスト名や URL が入りうる）。
  #
  # **この検査が見るのは「実際に台帳まで流れうる文字列」である。**
  # 食い違いの行には `根拠` の列があり、そこには PR 番号や `since` の時刻が入る。
  # **台帳には種別しか書かない**ので、根拠の文字列は台帳に出ない。
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
  assert_contains "$LEDGER" "$(printf '\tleft\t781\t')" "残したことは台帳に残る（前提）"
  # **前提の確認**: 根拠の文字列は画面には出る。**ここが落ちたら下 2 行は何も主張していない**
  assert_contains "$OUT" "枝も PR も無い（since 2026-09-13T00:00:00Z）" "根拠は画面には出る（前提）"
  assert_not_contains "$LEDGER" "since" "**台帳に根拠の自由文を書かない**"
  assert_not_contains "$LEDGER" "2026-09-13T00:00:00Z" "**台帳に食い違いの根拠の時刻を書かない**"
  # 台帳の 6 列目（detail）は 5 種類の種別か run 行の母数のどちらかしかない
  local kinds; kinds=$(printf '%s\n' "$LEDGER" | awk -F'\t' '$2!="run"{print $6}' | sort -u)
  assert_eq "inprogress-no-trace" "$kinds" "**台帳の種別は board-audit.sh 自身の語彙だけ**"
}
test_case "ledger: 台帳に自由文を書かない（番号と Status と種別だけ）(#919)" t_ledger_writes_no_free_text

t_ledger_unwritable_is_not_success() {
  # **残らないなら「直した」と報告しない。** 台帳に書けない場所を指したら exit 5 で落ちる
  # （**直した件数が残らない走行を、静かに成功にしない**）。
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "issue list "*) echo '[{"number":700,"state":"CLOSED"}]' ;;
    "api graphql "*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":""},
      "nodes":[{"id":"I700","content":{"number":700},"fieldValueByName":{"name":"Done"}}]}}}}' ;;
    "pr list "*) echo '[{"number":702,"body":"none"}]' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
EOF
)
  # 書き込めないディレクトリの下を指す（root で走らせると通ってしまうので、そのときは飛ばす）
  local bad="$TMP/ro-dir"
  rm -rf "$bad"; mkdir -p "$bad"; chmod 500 "$bad"
  if ( : > "$bad/probe" ) 2>/dev/null; then
    rm -rf "$bad"; echo "    - skipped: この環境では読み取り専用ディレクトリに書けてしまう（root?）"; return 0
  fi
  local saved="$LEDGER_PATH"
  LEDGER_PATH="$bad/board-audit-log.tsv"
  run_script "$h" board-audit.sh --fix
  LEDGER_PATH="$saved"
  assert_eq 5 "$STATUS" "**台帳に書けなければ exit 5**: $ERR"
  assert_contains "$ERR" "台帳" "どこで失敗したかを言う"
  chmod 700 "$bad"; rm -rf "$bad"
}
test_case "ledger: 台帳に書けなければ成功と報告しない (#919)" t_ledger_unwritable_is_not_success

# ---- 台帳の検算（#919/#757）----------------------------------------------------------------
# **`ledger_flush` は「行数」と「直した/残した/食い違いの件数」が合わないと書かずに落ちる。**
#
# **この番人は、実際の走行では一度も鳴らない**（`ledger_add` と `fixed`/`left` の加算が
# 同じ `case` の同じ節に並んでいるので、ふだんは必ず一致する）。
# **一度も鳴らない番人を、テストの無いまま置いておかない**（#922「通るだけのテストは消す」の裏）:
# **鳴らす条件を直接作って、鳴ることを固定する。**
#
# **規則は board-audit.sh から取り出す。写しを持たない**（`scripts/ci/pr-closes.sh` が
# `CLOSING_RE` をそこから取り出しているのと同じ理由）。**取り出せなければ落ちる。**
t_ledger_checksum_refuses_mismatch() {
  local block="$TMP/ledger-block.sh"
  # LEDGER-BEGIN 〜 LEDGER-END の間だけを取り出す
  sed -n '/# ---- 台帳（#919）.*LEDGER-BEGIN/,/^# LEDGER-END$/p' "$PO_DIR/board-audit.sh" > "$block"
  # **印が片方でも壊れていたら、取り出しは黙って全部（または空）を返す。**
  # **両端が在ることと、中身が台帳の関数だけであることを確かめてから使う**
  # （**取り出せないまま緑にしない**。#757）。
  if ! grep -q '^# LEDGER-END$' "$block" || ! grep -q '^ledger_flush() {' "$block" \
     || grep -q '^REPO=' "$block"; then
    fail "board-audit.sh から台帳のブロックを取り出せません（LEDGER-BEGIN/LEDGER-END の印を確かめてください）"
    return 0
  fi
  # 取り出したブロックだけを走らせる小さな台本。lib.sh の log() と HERE が要る
  local drv="$TMP/ledger-drv.sh"
  cat > "$drv" <<DRV
set -euo pipefail
HERE="$PO_DIR"
source "$PO_DIR/lib.sh"
FIX=1
BOARD_AUDIT_LOG="\$1"; shift
source "$block"
# 行を \$1 本積んでから、fixed/left/findings を引数のとおりに渡す
n=\$1; shift
i=0; while [[ \$i -lt \$n ]]; do ledger_add fixed \$((900+i)) A B kind; i=\$((i+1)); done
ledger_flush 10 10 10 "\$1" "\$2" "\$3"
DRV
  local out rc log_path="$TMP/checksum.tsv"

  # (1) 合っている: 行 2 本 / 直した 2 / 残した 0 / 食い違い 2 → 書ける
  rm -f "$log_path"
  set +e; out=$(bash "$drv" "$log_path" 2 2 2 0 2>&1); rc=$?; set -e
  assert_eq 0 "$rc" "**数が合えば書ける（前提。ここが落ちたら下は何も主張していない）**: $out"
  assert_eq 3 "$(grep -c '' "$log_path")" "fixed 2 + run 1 = 3 行"

  # (2) 行より fixed が多い（`ledger_add` を呼び忘れた形）→ **書かずに 5 で落ちる**
  rm -f "$log_path"
  set +e; out=$(bash "$drv" "$log_path" 1 2 2 0 2>&1); rc=$?; set -e
  assert_eq 5 "$rc" "**行 1 本なのに直した 2 件なら落ちる**: $out"
  assert_contains "$out" "検算が合いません" "何が合わないかを言う"
  [[ ! -e "$log_path" ]] || fail "**合わないときは台帳を作りもしない**"

  # (3) findings が fixed+left と合わない（数え落とした形）→ **書かずに 5 で落ちる**
  rm -f "$log_path"
  set +e; out=$(bash "$drv" "$log_path" 2 3 2 0 2>&1); rc=$?; set -e
  assert_eq 5 "$rc" "**食い違い 3 件なのに直した 2 + 残した 0 なら落ちる**: $out"
  [[ ! -e "$log_path" ]] || fail "**合わないときは台帳を作りもしない（findings 側）**"
}
test_case "ledger: 行数と件数が合わない台帳は書かない (#919/#757)" t_ledger_checksum_refuses_mismatch
