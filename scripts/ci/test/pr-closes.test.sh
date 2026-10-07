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
TMP=$(mktemp -d); cleanup() { local __rc=$?; rm -rf "$TMP" || echo "warn: cleanup left $TMP behind (not a test failure)" >&2; exit "$__rc"; }; trap cleanup EXIT

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

# ── 6b. GitHub が実際に送ってくる形（CRLF）────────────────────────────────────────────
# **GitHub の PR 本文は CRLF 改行で来る。** LF の fixture だけで測ると、本番でだけ
# 行末の `\r` が正規表現に噛んで落ちる、という形を見落とす。
t_crlf_body() {
  printf 'text\r\nCloses #793\r\n' > "$TMP/body.md"
  set +e; OUT=$(bash "$SCRIPT" "$TMP/body.md" 2>&1); STATUS=$?; set -e
  assert_eq 0 "$STATUS" "CRLF の本文でも Closes #N を拾う"
  printf 'text\r\nCloses \xe3\x81\xaa\xe3\x81\x97\xef\xbc\x88\xe4\xbd\x9c\xe6\xa5\xad\xe5\x90\x88\xe6\x84\x8f\xe3\x81\xae\xe6\x9b\xb4\xe6\x96\xb0\xef\xbc\x89\r\n' > "$TMP/body.md"
  set +e; OUT=$(bash "$SCRIPT" "$TMP/body.md" 2>&1); STATUS=$?; set -e
  assert_eq 0 "$STATUS" "CRLF の本文でも「Issue 無し」の宣言を拾う"
}
test_case "input: CRLF の本文（GitHub が送ってくる形）でも両方拾う" t_crlf_body

# ── 7. この PBI 自身の PR 本文（実物）が通ること ────────────────────────────────────────
# **自分が作った検査を自分が通らない、を防ぐ**（#793 の指示）。
t_this_pr_body_shape_passes() {
  run "## 何が問題だったか" "マージ済み PR の 44% が Closes #N を書いていない。" "Closes #793"
  assert_eq 0 "$STATUS" "この PBI の PR 本文の形は通る"
}
test_case "self: この PBI の PR 本文の形（Closes #793）は通る" t_this_pr_body_shape_passes

# ── 7b. コードスパン／コードブロックの中の閉じる語は数えない（#977）──────────────────────
# **GitHub は自動クローズの語をコードスパン（`` ` ``）とフェンス（```）の中では読まない。**
# **この検査は文字列として読むので、「#N は閉じない」と説明した文まで拾っていた。**
#
# 実測（2026-09-25、マージ済み PR **630 本**を `closingIssuesReferences` と突き合わせた）:
#   **取り出す番号が食い違うのは 11 本。うち 9 本はコードスパンが原因**
#   （#520 #839 #850 #857 #893 #954 #975 …）。**逆向き（検査が拾わず GitHub が閉じる）は 0 本。**
#   コードスパンを除いて測り直すと**食い違いは 2 本まで減る**（#130 = Issue が削除済み、
#   #964 = 既定でない base への PR。**どちらも本文の綴りでは説明がつかない**）。
t_code_span_is_not_a_closing_word() {
  # **PR #960 で実際に起きた形**: 「この番号は閉じない」と説明する文の中の閉じる語。
  run "## 何が問題だったか" \
      "当初 \`Closes #943\` と書いていたが、#943 は無関係な自動起票の Issue だった。" \
      "Closes #958"
  assert_eq 0 "$STATUS" "バッククォート外の Closes #958 があるので通る"
  assert_contains "$OUT" "#958" "GitHub が実際に閉じる番号は出す"
  assert_not_contains "$OUT" "#943" "コードスパンの中の番号は出さない（GitHub も閉じない）"
}
test_case "code-span: 説明のための \`Closes #N\` は拾わない（PR #960 の実測）" t_code_span_is_not_a_closing_word

t_only_code_span_fails() {
  # **閉じる語がコードスパンの中にしか無い PR は、GitHub から見れば何も閉じない。**
  # 実測: #839 #850 #857 #893 #954 は 1 行目が \`Closes #N\` だけで、
  # **GitHub は 1 件も閉じず、PO が手で閉じていた**（closer=null）。
  run "\`Closes #835\`" "" "## 何が問題だったか" "三重の賛否 PDF を測った。"
  assert_eq 1 "$STATUS" "閉じる語がコードスパンの中だけなら落ちる（GitHub も閉じない）"
  assert_contains "$OUT" "対応する Issue がどれかが書かれていません" "何が足りないかを言う"
}
test_case "code-span: 閉じる語がコードスパンの中だけの本文は落ちる（#839 の実測形）" t_only_code_span_fails

t_fenced_block_is_not_a_closing_word() {
  run "## 実行例" "\`\`\`" "\$ ./scripts/ci/pr-closes.sh body.md" "Closes #123" "\`\`\`" \
      "説明おわり。"
  assert_eq 1 "$STATUS" "フェンスの中の閉じる語は数えない"
}
test_case "code-span: フェンス（\`\`\`）の中の閉じる語は数えない" t_fenced_block_is_not_a_closing_word

# **偽陽性を作らないこと**: 同じ行にコードスパンがあっても、**その外**の閉じる語は生きている。
# **実測でここを踏み抜きかけた**: 「バッククォートを含む行を丸ごと捨てる」実装にすると、
# **PR #334 #461 #766 #772 の 4 本が誤って赤くなる**——4 本とも 1 行目が
# `Closes #N。…\`コード\`…` の形で、**GitHub は実際に閉じている**（それぞれ #333 #456 #759 #768）。
t_closing_word_outside_span_on_same_line() {
  run "Closes #759。**地方議会 10 議会目。** \`data/assemblies/pref-05/\` が出て通る。"
  assert_eq 0 "$STATUS" "同じ行にコードスパンがあっても、その外の Closes #N は生きている"
  assert_contains "$OUT" "#759" "拾うのはコードスパンの外の番号"
}
test_case "code-span: 同じ行のコードスパンの外にある Closes #N は通る（PR #766 の実測形）" t_closing_word_outside_span_on_same_line

# **スパンの閉じの「直後」に閉じる語が来る形**（レビューの指摘で足した）。
#
# **上の #766 の形は `Closes` がスパンより前に在る**ので、
# **「スパンの閉じの直後の 1 文字を食べる」変異では壊れない**——空白が食われるだけである。
# **実測（レビュアー）**: `found = m` を `found = m + 1` にすると **28/28 緑のまま**、
# **`` `strip_code_spans` ``Closes #900 が偽の赤になる**（`Closes` が `loses` に化ける）。
# **39,528 通りの合成入力で判定が反転する入力が 48 件。等価変異ではない。**
#
# **`pr-closes.sh` の docblock 自身が「一番たちの悪い壊れ方」と名指しした形である。**
# **`i = j + 1`（emit 側の同じ変異）は塞いだのに、`found` 側が空いていた。**
t_closing_word_immediately_after_span() {
  run "この検査は \`strip_code_spans\`Closes #900 で直った"
  assert_eq 0 "$STATUS" "スパンの閉じの直後の Closes を飲み込まない"
  assert_contains "$OUT" "#900" "スパンの直後の番号を拾う（1 文字ずれると loses になって拾えない）"
}
test_case "code-span: スパンの閉じの直後の Closes #N を飲み込まない（found = m + 1 を殺す）" t_closing_word_immediately_after_span

# **閉じの無い連続の「最後の 1 文字」を落とす形**（レビューの指摘で足した）。
#
# **実測（レビュアー）**: emit の上限 `x < j` を `x < j - 1` にすると **28/28 緑のまま**、
# **`Closes` と `#123` がくっついて `Closes#123` になり、偽の緑になる**:
#   本文: PO への説明: Closes`#123 の形は閉じる語ではない
#   いま      → rc=1（正しい。バッククォートが挟まるので GitHub は何も閉じない）
#   x < j - 1 → rc=0 ← 緑
# **22,912 通りで判定が反転する入力が 392 件。等価変異ではない。**
#
# **前のレビュアーは「等価変異かもしれない」と留保して指摘に数えなかった**——
# **留保したことは正しい態度だが、等価ではなかった。**
t_unclosed_run_keeps_last_char() {
  run "PO への説明: Closes\`#123 の形は閉じる語ではない"
  assert_eq 1 "$STATUS" "Closes と #N の間にバッククォートが挟まれば閉じる語ではない: $OUT"
  assert_not_contains "$OUT" "#123" "くっつけて Closes#123 にしてはいけない（最後の 1 文字を落とすと起きる）"
}
test_case "code-span: 閉じの無い連続の最後の 1 文字を落とさない（x < j - 1 を殺す）" t_unclosed_run_keeps_last_char

# **フェンスの開き行そのものも落とす**（レビューの指摘で足した）。
#
# **フェンスの「情報文字列」に閉じる語を書いた形**。**GitHub は lang 属性として読むので何も閉じない:**
#
#   $ gh api markdown -X POST -f text='```Closes #500\ncode\n```'
#   <pre lang="Closes"><code>code</code></pre>        ← #500 は生きている
#
# **実測（レビュアー、PO が追試）**: フェンス行の `print ""` を `print line` にすると
# **30/30 緑のまま、`pr-closes: ok — 閉じる語があります: #500` と言う**（偽の緑）。
# **#977 が問題にした向き（閉じるつもりのない番号で緑）そのものである。**
t_fence_info_string_is_not_a_closing_word() {
  local f="$TMP/fence.md"
  printf '%s\n' '```Closes #500' 'code' '```' > "$f"
  set +e; OUT=$(bash "$SCRIPT" "$f" 2>&1); local rc=$?; set -e
  assert_eq 1 "$rc" "フェンスの情報文字列の閉じる語は拾わない（GitHub は lang 属性として読む）: $OUT"
  assert_not_contains "$OUT" "#500" "情報文字列の番号を拾ってはいけない"
}
test_case "fence: 情報文字列の Closes #N は閉じる語ではない（フェンス行を print line にすると落ちる）" t_fence_info_string_is_not_a_closing_word

# **フェンスの認識行は 3 つのことを同時に言っている**——**`^[ ]{0,3}` / `(```|~~~)` / `!infence`。**
# **R2 で 1 つ目を殺したが、残り 3 つは無検査だった**（レビューの実測。**各 31/0 緑で素通り**）。
#
#   R3 行頭空白を認めない（`^[ ]{0,3}` → `^`）      → 偽の緑
#   R4 チルダを外す（`(```|~~~)` → `(```)`）        → 偽の緑
#   N1 `infence = !infence` → `infence = 1`（閉じない） → **偽の赤**
#
# **N1 はこの PR 自身の本文の形である**（実行例のフェンスのあとに `Closes #977` を書く）——
# **`pr-closes.sh` の docblock が「一番たちの悪い壊れ方」と名指しした形で、
# この変異が入ると PR #1032 自身が赤くなるのに、テストは緑だった。**
#
# **どれも GitHub に `POST /markdown` で聞いて裏を取っている。**
t_fence_recognition_is_checked() {
  # R3: 行頭に空白 2 つ（CommonMark は 3 つまで許す）
  local a="$TMP/fence-indent.md"
  printf '%s\n' '  ```' '  Closes #501' '  ```' > "$a"
  set +e; OUT=$(bash "$SCRIPT" "$a" 2>&1); local rc=$?; set -e
  assert_eq 1 "$rc" "行頭に空白のあるフェンスも認識する（GitHub は <pre><code> にする）: $OUT"
  assert_not_contains "$OUT" "#501" "字下げフェンスの中の番号は拾わない"

  # R4: チルダのフェンス
  local b="$TMP/fence-tilde.md"
  printf '%s\n' '~~~' 'Closes #502' '~~~' > "$b"
  set +e; OUT=$(bash "$SCRIPT" "$b" 2>&1); rc=$?; set -e
  assert_eq 1 "$rc" "チルダのフェンスも認識する（CommonMark はこの 2 種だけを定める）: $OUT"
  assert_not_contains "$OUT" "#502" "チルダフェンスの中の番号は拾わない"

  # N1: フェンスを閉じたら普通の本文に戻る（**偽の赤を防ぐ**）
  local c="$TMP/fence-closed.md"
  printf '%s\n' '## 実行例' '```' 'bash foo.sh' '```' '' 'Closes #977' > "$c"
  set +e; OUT=$(bash "$SCRIPT" "$c" 2>&1); rc=$?; set -e
  assert_eq 0 "$rc" "フェンスを閉じたら普通の本文に戻る（この PR 自身の本文の形）: $OUT"
  assert_contains "$OUT" "#977" "フェンスの外の閉じる語は生きている"
}
test_case "fence: 認識行の 3 要素（行頭空白・チルダ・閉じたら戻る）を固定する" t_fence_recognition_is_checked

# **フェンスの行頭空白の上限 3 の「両側」を固定する**（レビューの実測。**どちらも 32/0 素通りだった**）。
#
# **R3 のテストは空白 2 つを使っているので、上限 3 を一切固定していなかった:**
#
#   M06 上限を 2 に下げる: 空白 3 つがフェンスと見なされなくなる → **偽の緑**
#   M07 上限を 4 に上げる: 空白 4 つがフェンスと見なされる      → **偽の赤**
#
# **M07 のほうが重い**——**本物の閉じる語を飲み込む向き**で、
# **pr-closes.sh の docblock が「一番たちの悪い壊れ方」と名指しした形である。**
# **CommonMark は fence indent を 3 つまでとし、4 つは字下げコードブロックである。**
t_fence_indent_boundary() {
  local a="$TMP/fence-3sp.md"
  printf '%s\n' '   ```' '   Closes #601' '   ```' > "$a"
  set +e; OUT=$(bash "$SCRIPT" "$a" 2>&1); local rc=$?; set -e
  assert_eq 1 "$rc" "空白 3 つはフェンス（CommonMark の上限）: $OUT"

  local b="$TMP/fence-4sp.md"
  printf '%s\n' '    ```' 'Closes #602' '    ```' > "$b"
  set +e; OUT=$(bash "$SCRIPT" "$b" 2>&1); rc=$?; set -e
  assert_eq 0 "$rc" "空白 4 つはフェンスではない（本物の閉じる語を飲み込まない）: $OUT"
  assert_contains "$OUT" "#602" "字下げされた開き記号をフェンスと見ると #602 を失う"
}
test_case "fence: 行頭空白の上限 3 の両側を固定する（M06 / M07 を殺す）" t_fence_indent_boundary

# **閉じフェンスに文字が続く形**（レビューの実測。**next を外す変異が 32/0 素通りだった**）。
#
# **開きフェンスなら直下の if (infence) が吸収するので等価に見えるが、閉じフェンス側は違う**——
# **infence が 0 になるので素通りし、行の中身がスパン処理を通って印字される。**
# **GitHub はその行をコードブロックの中に入れるので、何も閉じない。**
t_closing_fence_with_trailing_text() {
  local f="$TMP/fence-trailing.md"
  printf '%s\n' '```' 'code' '```Closes #500' > "$f"
  set +e; OUT=$(bash "$SCRIPT" "$f" 2>&1); local rc=$?; set -e
  assert_eq 1 "$rc" "閉じフェンスに続く文字は閉じる語として拾わない: $OUT"
  assert_not_contains "$OUT" "#500" "コードブロックの中の番号を拾ってはいけない"
}
test_case "fence: 閉じフェンスに文字が続く形（next を外すと落ちる）" t_closing_fence_with_trailing_text

t_double_backtick_span_holds_single_backtick() {
  # **閉じは「開きと同じ長さ」でなければならない**（CommonMark と同じ数え方）。
  # `` で開いたスパンは、**中に単独の ` があっても閉じない**——
  # ここを「どのバッククォートでも閉じる」にすると、**スパンが途中で切れて
  # 中身の閉じる語が漏れ出す**（変異 M5 で実測: #111 が漏れた）。
  # shellcheck disable=SC2016  # **文字どおりのバッククォート**を本文に入れている。展開させてはいけない
  run '``コード \` の中 Closes #111 まだコード`` Closes #222'
  assert_eq 0 "$STATUS" "スパン外の Closes #222 で通る"
  assert_contains "$OUT" "#222" "スパンの外は拾う"
  assert_not_contains "$OUT" "#111" "二重スパンの中は、単独のバッククォートでは閉じない"
}
test_case "code-span: 二重バッククォートのスパンは単独では閉じない（長さを数える）" t_double_backtick_span_holds_single_backtick

t_escape_hatch_survives_code_span() {
  # **逃げ道がコードスパンの巻き添えで壊れないこと**（壊れると全 PR が赤くなる、#790）。
  run "\`pr-closes.sh\` の説明を直した。" "Closes なし（作業合意の更新）"
  assert_eq 0 "$STATUS" "同じ本文にコードスパンがあっても逃げ道は通る"
  assert_contains "$OUT" "対応する Issue が無いことが明示されています" "逃げ道で通ったことが分かる"
}
test_case "code-span: 本文にコードスパンがあっても逃げ道は通る" t_escape_hatch_survives_code_span

t_unclosed_backtick_does_not_swallow_rest() {
  # 閉じていないバッククォートは**コードスパンを作らない**（GitHub も同じ）。
  # ここを「開いたら以降全部コード」にすると、閉じ忘れ 1 つで本文全体が無効になる。
  run "残り 1 個の \` が閉じていない。Closes #401"
  assert_eq 0 "$STATUS" "閉じていないバッククォートの後ろの Closes #N は生きている"
}
test_case "code-span: 閉じていないバッククォートは以降を飲み込まない" t_unclosed_backtick_does_not_swallow_rest

# ── 8. ワークフローがこの検査を呼んでいること ──────────────────────────────────────────
# **#504 の形: 1 つのファイルの中の検査は、そのファイル自身を守れない。**
# **スクリプトを消しても CI が緑になるなら、この検査は存在しないのと同じ。**
t_wired_into_ci() {
  # **#1039: この検査は ci.yml から pr-body.yml に移った。**
  # ファイル名を 1 つに決め打ちすると、移した瞬間にこの検査は「探しているファイルが無い」で
  # 落ちるか、あるいは（`cat` が空を返すなら）**何も見ずに落ちる**。
  # **どのワークフローに在るかではなく「どこか 1 つのワークフローに在ること」を見る。**
  # 2 つ以上に在るのも異常（同名の job が 2 つできてチェック名が衝突する）なので、
  # **ちょうど 1 つ**を要求する。
  local wfs=() f
  for f in "$ROOT"/.github/workflows/*.yml "$ROOT"/.github/workflows/*.yaml; do
    [[ -f "$f" ]] || continue
    grep -q 'bash scripts/ci/pr-closes.sh' "$f" && wfs+=("$f")
  done
  assert_eq "1" "${#wfs[@]}" "pr-closes.sh を実行するワークフローはちょうど 1 つ（実際: ${wfs[*]:-なし}）"
  local wf="${wfs[0]}"
  local body; body=$(cat "$wf")
  # **#1039 / N1・N2: job が走っただけでは本文を測ったことにならない。**
  # `step` の `if:` で本文判定だけを飛ばす／`run:` の先頭で `exit 0` する、という壊し方は
  # **job を success のまま緑にしたうえで、本文を 1 度も測らない。**
  # `pr-closes.sh` を実行する step に条件が付いていないことを見る。
  # （この step は job の唯一の実行 step なので、条件が付く正当な理由が無い。）
  # **job 全体を見る**（本文を測る step だけを見ると、その**前に**条件付き step を挿して
  # 抜ける形が素通りする——変異 N1 で実際に素通りした）。`pr-closes` job の中に
  # `if:` が 1 つも無いこと、`github.event.action` で分岐していないことを見る。
  # **コメント行は落としてから見る**（このファイルの解説コメントに `if:` の字が出てくる）。
  local job
  job=$(awk '/^  pr-closes:/{f=1;next} f&&/^  [A-Za-z_]/{f=0} f' "$wf" | sed 's/[[:space:]]*#.*$//')
  assert_not_contains "$job" "if:" "pr-closes job に if: が無い（付くと job は緑のまま本文を測らない。#1039 N1）"
  assert_not_contains "$job" "github.event.action" \
    "本文を測るかどうかをイベント種別で分岐していない（#1039 N1/N2: edited だけ測らない形を塞ぐ）"
  # `run:` の中で早期に抜けていないこと。`pr-closes.sh` に食わせる行より前に `exit` は無い
  # （`test -f ... || { ...; exit 1; }` は**在るべき** exit なので、`exit 0` だけを見る）。
  local before_exec
  before_exec=$(printf '%s\n' "$job" | sed -n '1,/pr-closes.sh -/p')
  assert_not_contains "$before_exec" "exit 0" "本文を測る前に exit 0 していない（緑のまま測らない形。#1039 N2）"
  # **「ファイル名がどこかに出てくる」では足りない**（実測: ci.yml から実行の行だけを消す変異を
  # 当てると、`test -f` の行に名前が残るので、その書き方のテストは 19/19 緑のまま通ってしまった）。
  # **実行している行そのもの**を見る。
  assert_contains "$body" 'bash scripts/ci/pr-closes.sh' "ワークフローがこの検査を実行している"
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
# **閉じの無いバッククォートの連続が O(N^2) にならないこと。**
#
# **実測（レビューの指摘、PO が追試）**: 先頭に 1 文字 + バッククォート 20,000 個の本文で
# **54 秒**（`main` の版は 0.3 秒）。`substr()` の呼び出し数は N^2/2 で N=20,000 なら 2 億回。
# **`pr-body.yml` の `timeout-minutes: 10` に賭ける形**になり、**本文は fork からでも誰でも書ける**
# （**#1050 でこの検査は `ci.yml` から `pr-body.yml` に移った**。実測: `pr-body.yml:66`）。
#
# **なぜ 1 秒で測るか**: 秒は機械の負荷で動く（レビュアーは同じ入力で 583 秒と 1,175 秒を得た。
# load average 33〜53 / 16 コア）。**1 秒は「O(N^2) なら絶対に超える」側に置いた閾値**で、
# **余裕は機械の負荷で変わる**（実測: 負荷が低いとき 25 ms / load 30 で 206〜274 ms /
# **load 43.2 / 16 コアで 5 回 269〜430 ms**（2026-09-28）/
# 別のレビュアーは load 155 で 40 回中 1 回 1,963 ms を観測）。
# **「遅い機械でも 1 秒は超えない」とは言えない**——初版はそう書き、レビューが測って否定した。
# **言えるのは「O(N^2) なら 1 秒では終わらない」**ことだけである
# （直す前は同じ入力で 54 秒（PO の実測）/ 90 秒（レビュアーの実測））。
case_unclosed_backtick_run_is_not_quadratic() {
  local f="$TMP/quad.md"
  python3 -c "open('$f','w').write('a'+chr(96)*20000+chr(10)+'Closes #7'+chr(10))"
  local start end ms
  start=$(date +%s%N)
  set +e; bash "$SCRIPT" "$f" > /dev/null 2>&1; local rc=$?; set -e
  end=$(date +%s%N)
  ms=$(( (end - start) / 1000000 ))
  assert_eq 0 "$rc" "閉じの無い連続でも判定は通る（${ms}ms）"
  [[ $ms -lt 1000 ]] || fail "20,000 個のバッククォートに ${ms}ms かかった（1000ms 未満であるべき。O(N^2) に戻っている）"

  # **時間だけを測る検査は、正しさを主張していない**（レビューの指摘）。
  # `i = j + 1` にすると 1 文字飲み込んで `Closes` が `loses` になり、**偽の赤**になる。
  # emit のループを消すと `x Close``s #55` が**偽の緑**になる（GitHub は何も閉じない本文）。
  # **速さと正しさの両方を、同じ検査で留める。**
  local g="$TMP/quad2.md"
  # 閉じの無い連続のあとに、飲み込まれてはいけない文字が続く形
  python3 -c "open('$g','w').write('a'+chr(96)*2000+'Closes #7'+chr(10))"
  set +e; OUT=$(bash "$SCRIPT" "$g" 2>&1); rc=$?; set -e
  assert_eq 0 "$rc" "連続の直後の Closes を飲み込まない: $OUT"
  assert_contains "$OUT" "#7" "拾った番号を読み上げる（1 文字ずれると loses になって拾えない）"

  # 偽の緑の側: スパンで割られた `Close``s` は閉じる語ではない
  local h="$TMP/quad3.md"
  python3 -c "open('$h','w').write('x Close'+chr(96)+chr(96)+'s #55'+chr(10))"
  set +e; OUT=$(bash "$SCRIPT" "$h" 2>&1); rc=$?; set -e
  assert_eq 1 "$rc" "スパンで割られた Close\`\`s は閉じる語として拾わない: $OUT"

  # **閉じの長さは「同じ」でなければならない**（CommonMark の数え方）。
  # **レビューの実測**: `if (r2 == run)` を `if (r2 >= run)` にすると 28/28 緑のまま、
  # **GitHub が閉じない番号を拾う**——つまり**この PR が塞ごうとしている向きの穴が開く**:
  #   本文: ``code ``` inside Closes #111 end`` Closes #222
  #   いま      → 閉じる語があります: #222
  #   r2 >= run → 閉じる語があります: #111 #222     ← #111 は GitHub が閉じない
  local m="$TMP/len.md"
  # shellcheck disable=SC2016  # バッククォートを literal で書くので単一引用符が正しい
  printf '%s\n' '``code ``` inside Closes #111 end`` Closes #222' > "$m"
  set +e; OUT=$(bash "$SCRIPT" "$m" 2>&1); rc=$?; set -e
  assert_eq 0 "$rc" "二重スパンの本文は通る: $OUT"
  assert_contains "$OUT" "#222" "スパンの外の番号は拾う"
  assert_not_contains "$OUT" "#111" "スパンの中の番号は拾わない（閉じの長さが同じでなければ閉じない）"
}
test_case "閉じの無いバッククォートの連続が O(N^2) にならない" case_unclosed_backtick_run_is_not_quadratic

test_case "wiring: ワークフローがこの検査を呼び、スクリプトの存在を要求している（#504 / #1039）" t_wired_into_ci

echo
echo "passed: $PASS  failed: $FAIL"
[[ $FAIL -eq 0 ]]
