#!/usr/bin/env bash
# Tests for scripts/ci/pr-closes.sh (Issue #793): PR 本文に `Closes #N` か
# 「対応する Issue は無い」の明示があることを見る。
#
# **落ちる側だけでなく「通る側」もテストする**（#484）。逃げ道（`Closes なし（理由）`）が
# 壊れても、落ちる側のテストしか無ければ気づけない——そして逃げ道が壊れると
# **全部の PR が赤くなり、「赤いのが普通」になって誰も見なくなる**（#790 が扱っている状態）。
#
# 本文は fixture ファイルで渡す。**gh も網もいらない**（CI を遅くしない、#793 の指示）。
#   bash scripts/ci/test/pr-closes.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../pr-closes.sh"
ROOT=$(cd "$HERE/../../.." && pwd)
PASS=0; FAIL=0
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_eq() { [[ "$2" == "$1" ]] || fail "$3: expected [$1] got [$2]"; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in: $1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "$3: expected NOT to contain [$2] in: $1"; }
test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

# run <body...> → STATUS / OUT。各行を本文の 1 行として書き出す。
run() {
  printf '%s\n' "$@" > "$TMP/body.md"
  set +e
  OUT=$(bash "$SCRIPT" "$TMP/body.md" 2>&1)
  STATUS=$?
  set -e
}

# ── 1. 本丸: Closes も「Issue 無し」の宣言も無い PR は落ちる ─────────────────────────────
# **実測でここが 44%**（2026-09-13、直近 50 件で 22/50）。この 1 件がこの PBI の存在理由。
t_missing_fails() {
  run "## 何が問題だったか" "群馬の賛否 PDF を 106 本測った。" "## 測った数字" "106 本中 4 本が別形式。"
  assert_eq 1 "$STATUS" "本文に閉じる語も宣言も無ければ exit 1"
  assert_contains "$OUT" "対応する Issue がどれかが書かれていません" "何が足りないかを言う"
  assert_contains "$OUT" "Closes なし" "逃げ道の綴りを、落ちたその場で教える"
}
test_case "missing: Closes も宣言も無い本文は落ちる（本丸）" t_missing_fails

# **実在した形**: PR #770 は本文に `#763` が 6 回出るだけ、PR #776 はタイトルが `fix(771)`。
# **どちらも board-audit.sh が検出できなかった 2 件そのもの。**
t_bare_number_fails() {
  run "調査: 青森の個別ページを 46 本開いた（#763）" "#763 の調査。#763 では 46 本を開いた。" \
      "#763 の結論は次のとおり。#763 に書いた。#763 を参照。"
  assert_eq 1 "$STATUS" "本文に #N が出るだけでは通さない（board-audit.sh と同じ規則）"
}
test_case "bare-number: 本文に #N が出るだけの PR #770 の形は落ちる" t_bare_number_fails

t_fix_paren_title_fails() {
  # PR #776 の形。`fix(771):` は conventional commit の scope であって閉じる語ではない。
  run "fix(771): #632 の「独立した2つの値の検算」は空回りしていた" "本文本文。"
  assert_eq 1 "$STATUS" "fix(771) は閉じる語ではない（GitHub も自動クローズしない）"
}
test_case "bare-number: fix(771) という scope 表記は閉じる語として数えない（PR #776 の形）" t_fix_paren_title_fails

# ── 2. 閉じる語がある PR は通る（3 語 × 語形）─────────────────────────────────────────────
t_closes_passes() {
  run "## どう直したか" "直した。" "Closes #793"
  assert_eq 0 "$STATUS" "Closes #N は通る"
  assert_contains "$OUT" "#793" "どの Issue に当たったかを出す（取り違えが出力から読める）"
}
test_case "closing: Closes #N は通り、番号を出力する" t_closes_passes

t_keyword_variants_pass() {
  local kw
  for kw in Closes closes Close Closed Fixes fixes Fix Fixed Resolves resolves Resolve Resolved; do
    run "本文" "$kw #123"
    assert_eq 0 "$STATUS" "$kw #123 は通る（board-audit.sh と同じ語形）"
  done
  # コロン付き・空白なしも GitHub は受ける
  run "Fixes: #123"; assert_eq 0 "$STATUS" "Fixes: #123 は通る"
  run "closes#123";  assert_eq 0 "$STATUS" "closes#123 は通る"
}
test_case "closing: close/fix/resolve の語形（+ed/+es、コロン、空白なし）が通る" t_keyword_variants_pass

t_closing_anywhere_in_body() {
  run "## 何が問題だったか" "Closes #401" "## 測った数字" "8 件。"
  assert_eq 0 "$STATUS" "本文のどこにあっても通る（末尾に限らない）"
}
test_case "closing: 本文の途中にあっても通る" t_closing_anywhere_in_body

# ── 3. 逃げ道が機能すること（**通ることのテスト**、#484）───────────────────────────────
# **PO 自身が 2026-09-13 に 3 本出している形**（#788 / #789 / #779）。
# **ここが壊れると全 PR が赤くなり、#790 の「毎日赤い」を自分で作ることになる。**
t_no_issue_declaration_passes() {
  run "## どう直したか" "作業合意を更新した。" "Closes なし（作業合意の更新。対応する Issue は無い）"
  assert_eq 0 "$STATUS" "Closes なし（理由）は通る（逃げ道）"
  assert_contains "$OUT" "対応する Issue が無いことが明示されています" "逃げ道で通ったことが出力で分かる"
}
test_case "escape: Closes なし（理由）は通る（PR #788 の実際の形）" t_no_issue_declaration_passes

t_no_issue_halfwidth_paren_passes() {
  run "Closes なし(スプリント文書の更新)"
  assert_eq 0 "$STATUS" "半角括弧でも通る（日本語入力の変換次第でどちらも出る）"
}
test_case "escape: 半角括弧 Closes なし(理由) も通る" t_no_issue_halfwidth_paren_passes

t_no_issue_spacing_passes() {
  run "Closes  なし （スプリント文書の更新）"
  assert_eq 0 "$STATUS" "語の間の空白は許す"
}
test_case "escape: Closes と なし の間に空白があっても通る" t_no_issue_spacing_passes

# ── 4. 逃げ道は「何も書かずに通せる」形にしない（#793 の指示）─────────────────────────
# **理由の無い宣言を通すと、`Closes なし` の 1 行を貼るだけの儀式になり、今と同じになる。**
t_no_issue_without_reason_fails() {
  run "## どう直したか" "直した。" "Closes なし"
  assert_eq 1 "$STATUS" "理由の無い Closes なし は通さない"
}
test_case "escape: 理由の無い Closes なし は落ちる" t_no_issue_without_reason_fails

t_no_issue_empty_reason_fails() {
  run "Closes なし（）"
  assert_eq 1 "$STATUS" "空の括弧は理由ではない"
  run "Closes なし（   ）"
  assert_eq 1 "$STATUS" "空白だけの括弧も理由ではない"
}
test_case "escape: 括弧が空／空白だけなら落ちる" t_no_issue_empty_reason_fails

# ── 5. 規則は board-audit.sh から取り出している（写しを 2 つ作らない）─────────────────
# **#793 の指示は「board-audit.sh と同じ規則にすること」。**
# **写しを持つと片方だけ直ったときに「CI は通るのに監査は拾わない」が起きる。**
t_regex_comes_from_board_audit() {
  # 取り出した値が、board-audit.sh に書いてある値と文字列として一致することを直接見る。
  local from_audit
  from_audit=$(sed -n "s/^CLOSING_RE='\(.*\)'[[:space:]]*\$/\1/p;T;q" "$ROOT/scripts/po/board-audit.sh")
  assert_contains "$from_audit" 'close' "board-audit.sh から規則を取り出せる（前提）"
  # pr-closes.sh 自身が正規表現の写しを持っていないこと。持っていたら、この設計は無意味。
  local copies
  copies=$(grep -c "close\[sd\]" "$SCRIPT" || true)
  assert_eq 0 "$copies" "pr-closes.sh は正規表現の写しを持たない（board-audit.sh から読む）"
}
test_case "same-rule: 規則は board-audit.sh から取り出し、写しを持たない" t_regex_comes_from_board_audit

t_unreadable_rule_source_is_not_ok() {
  # **規則の出どころが読めないときに「合格」と言ってはいけない**（#757 の形: 母数 0 を
  # 「きれい」と報告しない）。board-audit.sh の無い木で動かすと exit 3 で止まる。
  local fake="$TMP/fakeroot"
  mkdir -p "$fake/scripts/ci" "$fake/scripts/po"
  cp "$SCRIPT" "$fake/scripts/ci/pr-closes.sh"
  printf 'Closes #1\n' > "$fake/body.md"
  set +e
  OUT=$(bash "$fake/scripts/ci/pr-closes.sh" "$fake/body.md" 2>&1); STATUS=$?
  set -e
  assert_eq 3 "$STATUS" "board-audit.sh が無ければ exit 3（合格とは言わない）"
  assert_contains "$OUT" "board-audit.sh" "どこが読めなかったかを名指しする"

  # 行はあるが形が変わった場合も同じ（黙って自前の規則に退避しない）。
  printf 'CLOSING_RE_RENAMED="x"\n' > "$fake/scripts/po/board-audit.sh"
  set +e
  OUT=$(bash "$fake/scripts/ci/pr-closes.sh" "$fake/body.md" 2>&1); STATUS=$?
  set -e
  assert_eq 3 "$STATUS" "CLOSING_RE を取り出せなければ exit 3"
  assert_contains "$OUT" "退避しません" "自前の規則に退避しないことを言う"
}
test_case "same-rule: 規則を取り出せないときは合格と言わず exit 3（#757 の形）" t_unreadable_rule_source_is_not_ok

# ── 6. 母数 / 入力そのもの ─────────────────────────────────────────────────────────────
t_empty_body_fails() {
  : > "$TMP/body.md"
  set +e
  OUT=$(bash "$SCRIPT" "$TMP/body.md" 2>&1); STATUS=$?
  set -e
  assert_eq 1 "$STATUS" "空の本文は通さない（本文を書かない PR は今と同じ）"
}
test_case "input: 空の本文は落ちる" t_empty_body_fails

t_unreadable_body_is_usage_error() {
  set +e
  OUT=$(bash "$SCRIPT" "$TMP/no-such-file.md" 2>&1); STATUS=$?
  set -e
  assert_eq 2 "$STATUS" "読めない本文は exit 2（**合格でも不合格でもない**）"
  assert_not_contains "$OUT" "ok —" "読めていないのに ok と言わない"
}
test_case "input: 読めないファイルは exit 2（ok とは言わない）" t_unreadable_body_is_usage_error

t_usage() {
  set +e
  OUT=$(bash "$SCRIPT" 2>&1); STATUS=$?
  set -e
  assert_eq 2 "$STATUS" "引数無しは exit 2"
  set +e
  OUT=$(bash "$SCRIPT" a b 2>&1); STATUS=$?
  set -e
  assert_eq 2 "$STATUS" "引数が多いのも exit 2"
}
test_case "input: 使い方の誤りは exit 2" t_usage

t_stdin() {
  set +e
  OUT=$(printf 'Closes #793\n' | bash "$SCRIPT" - 2>&1); STATUS=$?
  set -e
  assert_eq 0 "$STATUS" "- で標準入力から読める（ワークフローが本文を渡す経路）"
}
test_case "input: - で標準入力から読める" t_stdin

# ── 7. この PBI 自身の PR 本文（実物）が通ること ────────────────────────────────────────
# **自分が作った検査を自分が通らない、を防ぐ**（#793 の指示）。
t_this_pr_body_shape_passes() {
  run "## 何が問題だったか" "マージ済み PR の 44% が Closes #N を書いていない。" "Closes #793"
  assert_eq 0 "$STATUS" "この PBI の PR 本文の形は通る"
}
test_case "self: この PBI の PR 本文の形（Closes #793）は通る" t_this_pr_body_shape_passes

# ── 8. ワークフローがこの検査を呼んでいること ──────────────────────────────────────────
# **#504 の形: 1 つのファイルの中の検査は、そのファイル自身を守れない。**
# **スクリプトを消しても CI が緑になるなら、この検査は存在しないのと同じ。**
t_wired_into_ci() {
  local wf="$ROOT/.github/workflows/ci.yml"
  local body; body=$(cat "$wf")
  # **「ファイル名がどこかに出てくる」では足りない**（実測: ci.yml から実行の行だけを消す変異を
  # 当てると、`test -f` の行に名前が残るので、その書き方のテストは 19/19 緑のまま通ってしまった）。
  # **実行している行そのもの**を見る。
  assert_contains "$body" 'bash scripts/ci/pr-closes.sh' "ci.yml がこの検査を実行している"
  # shellcheck disable=SC2016  # ci.yml の中の**文字どおりの**文字列を探している。展開させてはいけない
  assert_contains "$body" '"$PR_BODY" | bash scripts/ci/pr-closes.sh' "PR 本文を渡して実行している"
  # ワークフロー側に「スクリプトが存在すること」の要求があること（stale-base と同じ形、#504）
  assert_contains "$body" 'test -f scripts/ci/pr-closes.sh' "スクリプトの存在自体をワークフローが要求する"
  # 本文は env 経由で渡すこと。`run:` に直接展開するとシェル差し込みになる（本文は誰でも書ける）。
  # shellcheck disable=SC2016  # 同上（`${{ }}` は GitHub Actions の式で、シェルの展開ではない）
  assert_contains "$body" 'PR_BODY: ${{ github.event.pull_request.body }}' "本文は env 経由（run: に直接展開しない）"
  # shellcheck disable=SC2016
  assert_not_contains "$body" 'pr-closes.sh "${{' "本文を run: に直接展開していない"
  # **API を叩かない**（#793: 既存の CI を遅くしない）。イベントのペイロードから取る。
  assert_not_contains "$body" 'gh pr view' "PR 本文の取得に API を使っていない"
}
test_case "wiring: ci.yml がこの検査を呼び、スクリプトの存在を要求している（#504）" t_wired_into_ci

echo
echo "passed: $PASS  failed: $FAIL"
[[ $FAIL -eq 0 ]]
