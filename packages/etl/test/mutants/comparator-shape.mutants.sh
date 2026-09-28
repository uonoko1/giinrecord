#!/usr/bin/env bash
# **`comparator-shape.ts` に当てた変異の記録**（Issue #1052 / PR #1062）。
#
# なぜスクリプトにするか:
#   **PR 本文の表だけが記録だと、次の人が同じ変異を当て直せない**
#   （**#1062 のレビュー指摘 3。`mutate.sh` は汎用ハーネスなので、
#     「どの変異を当てたか」はどこにも残らなかった**）。
#   ここに置けば、`bash packages/etl/test/mutants/comparator-shape.mutants.sh` で測り直せる。
#
# なぜ perl の式をヒアドキュメントのファイルに置くか（**実際に踏んだ罠**）:
#   **`--expr 's|…\|\|…|…|'` のようにシェル経由で渡すと `\|\|` が壊れ、
#     空の交替になって「全行に当たる」ことがある**（#1052 で 668 行に当たった）。
#   **md5 は変わるので `mutate.sh` は「当たった」と判断する**——
#   **当たり方が間違っていることは検出できない。**
#   だから式はファイルに書き、`--expr "$(cat …)"` で渡す。
#
# 前提（**これを守らないと測定が無意味になる**）:
#   - **テストは `packages/etl` の中から、リポジトリの本物の runner で回す**
#     （`node --test --import tsx`。ルートから叩くと `tsx` が見つからず
#      `ERR_MODULE_NOT_FOUND` を「赤」と読み違える。#1052 で踏んだ）
#   - **環境エラー・構文エラーは「落ちた」と数えない**（下の `run` が名指しして弾く）
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ETL=$(cd "$HERE/../.." && pwd)
ROOT=$(cd "$ETL/../.." && pwd)
TARGET=$ETL/test/comparator-shape.ts
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

run() {
  local name="$1" expr="$2" out rc fail names
  printf '%s' "$expr" > "$WORK/e.pl"
  out=$(cd "$ETL" && bash "$ROOT/scripts/dev/mutate.sh" run --file "$TARGET" --expr "$(cat "$WORK/e.pl")" \
        -- node --test --import tsx --test-reporter=spec test/pdf-row-order.test.ts 2>&1); rc=$?
  if printf '%s\n' "$out" | grep -qE 'ERR_MODULE_NOT_FOUND|TransformError|already been declared|perl が失敗'; then
    echo "!! $name : 環境/構文エラー（測定不能。この行の結果は使えない）"; return
  fi
  fail=$(printf '%s\n' "$out" | grep -E '^ℹ fail ' | tail -1 | grep -oE '[0-9]+$')
  names=$(printf '%s\n' "$out" | grep -E '^ *✖ #' | sed 's/ (.*//;s/^ *✖ //' | sort -u | tr '\n' '/')
  printf '%-52s fail=%-3s %s\n' "$name" "${fail:-?}" "${names:-（なし。等価変異かもしれない——理由を確かめること）}"
}

# ---- #1052 が塞いだ 8 通りに対応する変異（実測: M10 以外はすべて赤）----
run "M1  三項の条件を見ない（#1034 に戻す）" 's{  return isMirroredComparison\(n\.condition, sf, ps\);}{  return true;}'
run "M2  ROUNDING から parseInt/toFixed/toPrecision を外す" 's{^  "parseInt", "toFixed", "toPrecision",$}{}'
run "M3  ビット演算の切り捨てを見ない" 's{function isBitwiseTruncation\(n: ts\.Node\): boolean \{\n}{function isBitwiseTruncation(n: ts.Node): boolean \{ return false;\n}'
run "M4  resolveLocal を「最後が勝つ」に戻す" 's{  if \(sameNameDecls > 1\) return \{ kind: "ambiguous", count: sameNameDecls \};}{}'
run "M5  添字アクセスの sort を見ない" 's{if \(ts\.isElementAccessExpression\(e\) && e\.argumentExpression && ts\.isStringLiteralLike\(e\.argumentExpression\)}{if (false && ts.isElementAccessExpression(e) && e.argumentExpression && ts.isStringLiteralLike(e.argumentExpression)}'
run "M6  call/apply の sort を見ない" 's{if \(ts\.isPropertyAccessExpression\(e\) && \(e\.name\.text === "call" \|\| e\.name\.text === "apply"\)\) \{}{if (false) \{}'
run "M7  「両辺が引数を含む」を外す" 's{  if \(!usesParam\(c\.left\) \|\| !usesParam\(c\.right\)\) return false;}{}'
run "M8  鏡の照合を外す" 's{  return normalized\(c\.left, sf, ps, true\) === normalized\(c\.right, sf, ps, false\);}{  return true;}'
run "M9  apply の配列リテラルを開かない" 's{        if \(arg && call\.spread && ts\.isArrayLiteralExpression\(arg\)\) arg = arg\.elements\[0\];}{}'
# **M10 は等価変異である**（理由は `comparator-shape.ts` の当該行に書いてある）。
# **「fail=0 だから検査が弱い」ではない**——**`found` に関数宣言が入らないので、
#   この行が無くても危険な側の判定は生き残る**（実測。理由が変わるだけ）。
run "M10 function 宣言の同名を数えない（等価変異）" 's{    if \(ts\.isFunctionDeclaration\(n\) && n\.name && n\.name\.text === name\) sameNameDecls\+\+;}{}'
run "M11 分割代入の束縛名を集めない" 's{    if \(ts\.isBindingElement\(n\)\) \{ walk\(n\.name\); return; \}}{}'
run "M12 SORT_METHODS から toSorted を外す" 's{const SORT_METHODS = new Set\(\["sort", "toSorted"\]\);}{const SORT_METHODS = new Set(\["sort"\]);}'

# ---- PR #1062 のレビューで見つかった穴に対応する変異（実測: 全部赤）----
# **R1 の式は一度古くなった**（`hasRounding` → `hasRoundingDeep` に改名したので当たらなくなった）。
# **`mutate.sh` が exit 3（md5 が変わらない）で落としたので「素通り」と誤記録せずに済んだ**——
# **この道具が無ければ「fail 0 = 検査が弱い」と読み違えていた。**
run "R1  三項の条件で丸めを一切見ない" 's{  if \(hasRoundingDeep\(c\.left, sf\) \|\| hasRoundingDeep\(c\.right, sf\)\) return false;}{}'
run "R2  % を丸めと数えない" 's{if \(n\.operatorToken\.kind === ts\.SyntaxKind\.PercentToken\) return true;}{if (false) return true;}'
run "R3  (y/t)*t を丸めと数えない" 's{    return hasDivision\(n\.left\) \|\| hasDivision\(n\.right\);}{    return false;}'
run "R4  hasDivision を常に false" 's{function hasDivision\(n: ts\.Node\): boolean \{\n}{function hasDivision(n: ts.Node): boolean \{ return false;\n}'
run "R5  === / !== を鏡の演算子に足す" 's{    case ts\.SyntaxKind\.GreaterThanEqualsToken:}{    case ts.SyntaxKind.GreaterThanEqualsToken:\n    case ts.SyntaxKind.EqualsEqualsEqualsToken:\n    case ts.SyntaxKind.ExclamationEqualsEqualsToken:\n    case ts.SyntaxKind.EqualsEqualsToken:}'

# ---- PR #1062 のレビュー 3 巡目（ヘルパー関数の向こうの丸め）----
run "S1  ヘルパーの中の丸めを見ない（1 段辿るのをやめる）" 's{        if \(body && hasRoundingDeep\(body, sf, new Set\(\[\.\.\.seen, name\]\)\)\) \{ found = true; return; \}}{        if (false) \{ found = true; return; \}}'
run "S2  ヘルパーの本体を返さない" 's{  if \(decls !== 1\) return null;}{  return null;}'
run "S3  三項の条件で浅い hasRounding に戻す" 's{  if \(hasRoundingDeep\(c\.left, sf\) \|\| hasRoundingDeep\(c\.right, sf\)\) return false;}{  if (hasRounding(c.left) \|\| hasRounding(c.right)) return false;}'
run "S4  差の枝で浅い hasRounding に戻す" 's{      if \(hasRoundingDeep\(n, sf\)\) return "差の中に丸め}{      if (hasRounding(n)) return "差の中に丸め}'
run "S5  文字列で切る形を丸めと数えない" 's{function isStringTruncation\(n: ts\.Node\): boolean \{\n}{function isStringTruncation(n: ts.Node): boolean \{ return false;\n}'
run "S6  関数宣言のヘルパーの本体を集めない" 's{      if \(n\.body\) bodies\.push\(n\.body\);}{      if (false) bodies.push(n.body!);}'

# ---- PR #1062 のレビュー 4 巡目（B10: 名前の集合に載っていない 17 通り）----
# **B10 は「塞げないと分かって残した穴」なので、変異の向きが逆である**——
# **他の行は「守りを外したら赤くなるか」を測るが、ここは「穴を塞いだら赤くなるか」を測る。**
# **赤くなれば「B10 の記録が本物（何も主張していない検査ではない）」ことの証拠になる**
# （**変異の分類 4「テストが何も主張していない」を弾くため**）。
# **赤くなったときの assert のメッセージは「捕まえられるようになったら記録を消して
#   allowlist に寄せること」で、次の人がやることを名指ししている。**
run "T1  STRING_TRUNCATION に at/charAt を足す（B10-10/11 を塞ぐ）" 's{"padStart", "padEnd"\]}{"padStart", "padEnd", "at", "charAt"\]}'
run "T2  ROUNDING に toExponential を足す（B10-5 を塞ぐ）" 's{"parseInt", "toFixed", "toPrecision",}{"parseInt", "toFixed", "toPrecision", "toExponential",}'
run "T3  ROUNDING に format/toLocaleString を足す（B10-14/15 を塞ぐ）" 's{"parseInt", "toFixed", "toPrecision",}{"parseInt", "toFixed", "toPrecision", "format", "toLocaleString",}'
# **T4 は「文字列化を丸ごう落とす」案（レビュー 3 巡目の案 (1)）を当てたもの。**
# **B10 の 12 通りは塞がるが、`別名 rnd` / カンマ / `Reflect` / `Uint32Array` / `BigInt` は残る**
# ——**それを B10 の検査が `notStringy` として固定している。**
run "T4  文字列化を丸ごと落とす（案 (1)。5 通りは残る）" 's{  return ts\.isPropertyAccessExpression\(e\) && STRING_TRUNCATION\.has\(e\.name\.text\);}{  if (ts.isIdentifier(e) && (e.text === "String" \|\| e.text === "Number")) return true;\n  return ts.isPropertyAccessExpression(e);}'
