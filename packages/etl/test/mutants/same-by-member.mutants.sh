#!/usr/bin/env bash
# **`same-by-member.ts` に当てた変異の記録**（Issue #1129 / PR は本枝）。
#
# なぜスクリプトにするか:
#   **PR 本文の表だけが記録だと、次の人が同じ変異を当て直せない**
#   （#1062 のレビュー指摘 3。`comparator-shape.mutants.sh` と同じ形）。
#   `bash packages/etl/test/mutants/same-by-member.mutants.sh` で測り直せる。
#
# なぜ perl の式をファイルに置いて `--expr "$(cat …)"` で渡すか（**実際に踏んだ罠**）:
#   **シェルが `$` や `\|\|` を先に食う**——**当たり方が間違っていても md5 は変わるので
#   `mutate.sh` は「当たった」と判断する。** だから式はヒアドキュメントで書く。
#   さらにこの記録では、当てた直後に **`grep -nF` で置換後の行を目で見て
#   「狙った行が 1 行だけ変わった」ことを確かめる**（#1129 はまさにその話なので、
#   ここで横着すると自己矛盾になる）。
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
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

# run <名前> <対象への相対パス> <perl式> <テストファイル…>
run() {
  local name="$1" rel="$2" expr="$3"; shift 3
  local target="$ETL/$rel" out rc fail names
  printf '%s' "$expr" > "$WORK/e.pl"
  out=$(cd "$ETL" && bash "$ROOT/scripts/dev/mutate.sh" run --file "$target" --expr "$(cat "$WORK/e.pl")" \
        -- node --test --import tsx --test-reporter=spec "$@" 2>&1); rc=$?
  if [[ $rc -eq 3 ]]; then
    echo "!! $name : 変異が当たらなかった（式が古い。測定不能）"; return
  fi
  if printf '%s\n' "$out" | grep -qE 'ERR_MODULE_NOT_FOUND|TransformError|already been declared|perl が失敗'; then
    echo "!! $name : 環境/構文エラー（測定不能。この行の結果は使えない）"; return
  fi
  fail=$(printf '%s\n' "$out" | grep -E '^ℹ fail ' | tail -1 | grep -oE '[0-9]+$')
  names=$(printf '%s\n' "$out" | grep -E '^ *✖ #' | sed 's/ (.*//;s/^ *✖ //' | sort -u | tr '\n' '/')
  printf '%-58s fail=%-3s %s\n' "$name" "${fail:-?}" "${names:-（なし。等価変異かもしれない——理由を確かめること）}"
}

SBM=test/same-by-member.ts
T=test/same-by-member.test.ts

echo "==== #1129 が塞いだ穴（走査を片側に縮める）===="
# **`origin/main` では、この 2 つを当てても published-timeline-count.test.ts の 6 本は
#   pass 6 / fail 0 だった**（実測 2026-09-30。data/ は 61770bd5）。
run "M1  ...derived を落とす（timeline が丸ごと消えた形が見えない）" "$SBM" \
  's{for \(const id of new Set\(\[\.\.\.Object\.keys\(actual\), \.\.\.Object\.keys\(derived\)\]\)\) \{}{for (const id of new Set([...Object.keys(actual)])) \{}' "$T"
run "M2  ...actual を落とす（導き元だけ残った形が見えない）" "$SBM" \
  's{for \(const id of new Set\(\[\.\.\.Object\.keys\(actual\), \.\.\.Object\.keys\(derived\)\]\)\) \{}{for (const id of new Set([...Object.keys(derived)])) \{}' "$T"

echo "==== 助け手の他の要点（走査以外を壊す）===="
run "M3  食い違いを記録しない（diff が常に空）" "$SBM" \
  's{    if \(a !== d\) diff\[id\] = \{ timeline: a, derived: d \};}{}' "$T"
run "M4  食い違いの判定を反転（一致したものを出す）" "$SBM" \
  's{    if \(a !== d\) diff\[id\]}{    if (a === d) diff[id]}' "$T"
run "M5  assert を落とす（何も主張しない）" "$SBM" \
  's{  assert\.deepEqual\(diff, \{\}, `\$\{what\}}{  if (false) assert.deepEqual(diff, \{\}, `\x24\{what\}}' "$T"
run "M6  what をメッセージに入れない（どの種別か読めない）" "$SBM" \
  's{`\$\{what\}（食い違った議員だけを出す}{`（食い違った議員だけを出す}' "$T"
run "M7  欠けた側を 0 ではなく相手の値で埋める（差が消える）" "$SBM" \
  's{    const d = derived\[id\] \?\? 0;}{    const d = derived[id] ?? a;}' "$T"
run "M8  actual 側を相手の値で埋める（逆向き）" "$SBM" \
  's{    const a = actual\[id\] \?\? 0;}{    const a = actual[id] ?? (derived[id] ?? 0);}' "$T"
run "M9  diff に両側の数を入れない（名指しが読めない）" "$SBM" \
  's{diff\[id\] = \{ timeline: a, derived: d \};}{diff[id] = \{ timeline: 0, derived: 0 \};}' "$T"

echo "==== 呼び手が写しに戻ったら気づくか（母数の検査）===="
run "M10 呼び手が助け手を読まず自前に戻る（import を消す）" test/published-timeline-count.test.ts \
  's{^import \{ assertSameByMember \} from "\./same-by-member\.ts";$}{}' "$T"
