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

if [[ ${1:-} != "--probe" ]]; then
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
fi

# ============================================================================
# **同型の母数**（#1129 の「他に何件在るか」。#757）
# ============================================================================
#
# **`new Set([...A, ...B])` で「独立した 2 つの側」を合わせている箇所は 6 件**
# （実測 2026-09-30、基点 61770bd5。`grep -rnE 'new Set\(\[[^]]*\.\.\.[^],]*,[^]]*\.\.\.'`
#   を `*.ts` / `*.tsx` に当て、`node_modules` と `dist` を除いた）。
# **`new Set([...oneIterable].map(…))` のように 1 つしか展開していない形は数に入れない**
#   （`shiga-published-data.test.ts:119` / `kochi-bloc-anchor.test.ts:117` /
#    `shimane/votes-pdf.ts:1159` の 3 件。**「片側を落とす」が定義できない**）。
#
# **6 件すべてに「片側を落とす」を両向きに当てた**（計 12 通り。母数は各テスト集合の全数）:
#
# | # | 箇所 | 片側を落とすと | 判定 |
# |---|---|---|---|
# | 1 | `test/same-by-member.ts:42`（本件） | **M1 fail 1 / M2 fail 2**（6 本中） | **この PR で塞いだ** |
# | 2 | `src/dataset.ts:61` `resolveSessions` | a **fail 2** / b **fail 2**（89 本中） | **両向き守られている** |
# | 3 | `src/sources/local/akita/votes-pdf.ts:858` | a **fail 0** / b **fail 0**（34 本中） | **等価変異**（下記） |
# | 4 | `src/sources/local/aomori/votes-pdf.ts:689` | a **fail 0** / b **fail 3**（49 本中） | **a は等価変異**（下記） |
# | 5 | `test/akita-votes-pdf.test.ts:639`（3 の写し） | a **fail 0** / b **fail 0**（24 本中） | **等価変異**（3 と同じ） |
# | 6 | `apps/web/scripts/font-subset.ts:116` | a **fail 0** / b **fail 0**（49 本中） | **どのテストも走らせていない**（下記） |
#
# ## 3 / 4 / 5 が「等価変異」である根拠（**推測ではなく測った**）
#
# **`rowAnchor` は `anchors` から作られる**（各行にいちばん近い錨を配り、
#   遠すぎるときだけ `b.cy` に落とす）。**両側が同じ集合なら、片側を落としても値は変わらない。**
# **両側の差を数える probe を挿して fixture を流した**（実測 2026-09-30）:
#
# | 箇所 | 呼び出し回数 | `rowAnchor` にしか無い錨 | `anchors` にしか無い錨 |
# |---|---:|---|---|
# | 秋田 | 79 | **全 79 回で 0** | **全 79 回で 0** |
# | 青森 | 127 | **全 127 回で 0** | 0 が 38 回 / **1 が 78 回 / 5 が 11 回** |
#
# **秋田は両側が完全に同じ集合なので、どんなテストを足しても片側落としは捕まらない**
#   （**捕まえるには fixture に「錨が余る PDF」か「錨が遠すぎて `b.cy` に落ちる行」が要る**）。
# **青森の `...rowAnchor` 側も同じ理由で等価変異**——**`b.cy` に落ちた行が fixture に 1 つも無い。**
# **青森の `...anchors` 側だけは差が在り、実際に 3 本落ちている**（守られている）。
#
# **つまり 3 / 4a / 5 は「テストが弱い」のではなく「その変異が振る舞いを変えていない」。**
# **#1129 の `...derived` とは性質が違う**——**あちらは振る舞いが変わるのに誰も見ていなかった。**
#
# ## 6 が「どのテストも走らせていない」根拠
#
# **`apps/web/scripts/font-subset.ts` は最上位に副作用を持つビルド script である**
#   （上流 TTF を fetch し `pyftsubset` を実行する）。
# **`import` しているテストは 1 件も無い**（実測 2026-09-30:
#   `grep -rn "from .*scripts/font-subset" apps/web --include='*.ts'` が 0 件。
#   `tsx-build-scripts.test.ts:299` は**ファイル名を文字列として数えているだけ**）。
# **web のテストが見ているのは `app/lib/` の純粋関数のほうで、116 行は実行されない。**
# **これは「片側走査の穴」ではなく「この行に検査が無い」ので、別の PBI にすべき**
#   （**ここで直すと、ビルド script を単体テストできる形に割る改造が要る**）。

# ---- 上の「等価変異」を測り直す probe（両側の差を数えるだけ。判定はしない）----
# **なぜ残すか**: **「fail 0 だから検査が弱い」と「fail 0 だから振る舞いが変わっていない」を
#   区別する根拠がここにしか無い。** 次の人が数え直せるようにしておく。
#   使い方: bash packages/etl/test/mutants/same-by-member.mutants.sh --probe
PROBE='s{  const allAnchors = \[\.\.\.new Set\(\[\.\.\.rowAnchor, \.\.\.anchors\]\)\];}{  const allAnchors = [...new Set([...rowAnchor, ...anchors])];\n  \{ const onlyRow = rowAnchor.filter((y) => !anchors.includes(y)); const onlyAnc = anchors.filter((y) => !rowAnchor.includes(y)); console.error(`PROBE onlyRow=\x24{onlyRow.length} onlyAnc=\x24{onlyAnc.length}`); \}}'
probe() {
  local name="$1" rel="$2"; shift 2
  printf '%s' "$PROBE" > "$WORK/p.pl"
  echo "---- probe: $name（両側の差。全回 0 なら等価変異）"
  ( cd "$ETL" && bash "$ROOT/scripts/dev/mutate.sh" run --file "$ETL/$rel" --expr "$(cat "$WORK/p.pl")" \
      -- node --test --import tsx "$@" 2>&1 ) | grep -E '^PROBE' | sort | uniq -c | sort -rn | head -8
}

if [[ ${1:-} == "--probe" ]]; then
  echo "==== 両側が実際に違うのかを数える（等価変異の切り分け）===="
  probe "秋田" src/sources/local/akita/votes-pdf.ts test/akita-votes-pdf.test.ts test/akita-rollcalls.test.ts
  probe "青森" src/sources/local/aomori/votes-pdf.ts test/aomori-votes-pdf.test.ts test/aomori-rollcalls.test.ts
fi
