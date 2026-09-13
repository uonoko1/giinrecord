import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  columnOf, countVoteSymbols, findMemberColumns, isLegendItem, isNameItem, isSingleGlyph, isVoteSymbol,
  legendOf, parseHeading, parseLegend, parseVotePdf, readMembers, readVoteCells, splitRowItem,
  unrotate, voteRowCore, voteRows, UNKNOWN_CELL, UNKNOWN_LEGEND,
} from "../src/sources/local/akita/votes-pdf.ts";
import { readPages, type Item, type PageGeometry } from "../src/sources/local/pdf-table.ts";

const pdf = (name: string) => readFileSync(fileURLToPath(new URL(`fixtures/akita/${name}.pdf`, import.meta.url)));

/**
 * **フィクスチャ 6 本で、秋田の作りの違いを全部覆う**（#753 が 154 本で数えた種類）。
 * **凡例 4 通りすべて・氏名 2 形すべて・`/Rotate 90` の有無・結合アイテムの有無**が入っている:
 *
 * | 本 | 凡例 | 氏名 | `/Rotate` | 結合アイテム | ほか |
 * |---|---|---|---|---:|---|
 * | `h291222giketu`   | **A**（`－`=議場に不在） | 1 文字 1 アイテム | **2 / 2 ページ** | **51** | 件名が 2 行に折り返す |
 * | `h231202giketu`   | **D**（**`－`=「棄権又は議場に不在」**） | 1 文字 1 アイテム | **1 / 1 ページ** | 1 | **回次が無い**（`平成２３年９月定例会`）・`知事提出` が縦書き |
 * | `060220hyoketsu`  | **B**（**`ー`(U+30FC)**=議場に不在） | **縦積み 1 アイテム** | 0 | 10 | 新しい形 |
 * | `R41102hyoketsu`  | **C**（**5 記号だけ**） | 縦積み 1 アイテム | 0 | 1 | 1 行だけの本 |
 * | `041222hyoketsu`  | **C** | 縦積み 1 アイテム | 0 | **85** | **`12月22日 簡易` が 1 アイテム**・番号と件名が 1 アイテム |
 * | `080319`          | **A** | 1 文字 1 アイテム | 0 | 1 | **3 ページ**・**件名が 2 行**・通し番号つき |
 */
const FIXTURES = ["h291222giketu", "h231202giketu", "060220hyoketsu", "R41102hyoketsu", "041222hyoketsu", "080319"] as const;

/** 凡例 A（130 / 154 本。#753） */
const LEGEND_A = { "○": "賛成", "×": "反対", "議": "議長", "欠": "欠席", "棄": "棄権", "除": "除斥", "－": "議場に不在" };
/** 凡例 B（10 本）。**`ー`(U+30FC) は `votes` に入らない**（`ignoredMarks` に行く。下のテスト） */
const LEGEND_B = { "○": "賛成", "×": "反対", "議": "議長", "欠": "欠席", "棄": "棄権", "除": "除斥" };
/** 凡例 C（9 本）。**`除` と「議場に不在」が無い** */
const LEGEND_C = { "○": "賛成", "×": "反対", "議": "議長", "欠": "欠席", "棄": "棄権" };
/** 凡例 D（5 本）。**`－` に 2 つの意味がある** */
const LEGEND_D = { "○": "賛成", "×": "反対", "議": "議長", "欠": "欠席", "－": "棄権又は議場に不在", "除": "除斥" };

test("#759 parseVotePdf: 6 本の形が違っても、議員の列・行・記号がそろう", async () => {
  const want = [
    { f: "h291222giketu", members: 41, rows: 50, pages: 2, rot: 2, year: 2017, round: 2, kind: "定例会", legend: LEGEND_A },
    { f: "h231202giketu", members: 45, rows: 1, pages: 1, rot: 1, year: 2011, round: undefined, kind: "９月定例会", legend: LEGEND_D },
    { f: "060220hyoketsu", members: 41, rows: 10, pages: 1, rot: 0, year: 2024, round: 1, kind: "定例会", legend: LEGEND_B },
    { f: "R41102hyoketsu", members: 43, rows: 1, pages: 1, rot: 0, year: 2022, round: 2, kind: "定例会", legend: LEGEND_C },
    { f: "041222hyoketsu", members: 43, rows: 60, pages: 2, rot: 0, year: 2022, round: 2, kind: "定例会", legend: LEGEND_C },
    { f: "080319", members: 41, rows: 91, pages: 3, rot: 0, year: 2026, round: 1, kind: "定例会", legend: LEGEND_A },
  ] as const;
  for (const w of want) {
    const p = await parseVotePdf(pdf(w.f));
    assert.equal(p.members.length, w.members, `${w.f}: 議員の列`);
    assert.equal(p.rows.length, w.rows, `${w.f}: 議案の行`);
    assert.equal(p.pages, w.pages, `${w.f}: ページ`);
    assert.equal(p.rotatedPages, w.rot, `${w.f}: /Rotate 90 のページ`);
    assert.equal(p.year, w.year, `${w.f}: 見出しの年`);
    assert.equal(p.round, w.round, `${w.f}: 見出しの回次（**無い本がある**）`);
    assert.equal(p.kind, w.kind, `${w.f}: 見出しの会期の種別`);
    // **不明セルが 0**（推定していない、ではなく「置けている」）
    assert.equal(p.unknownCells, 0, `${w.f}: 不明セル`);
    assert.deepEqual(p.legend.votes, w.legend, `${w.f}: 凡例`);
    // **氏名が空の列が無い**（#718 の「静かに消える議員」を作っていない）
    assert.deepEqual(p.members.filter((m) => m.nameText === ""), [], `${w.f}: 氏名の空の列`);
    // **議決月日が読めない行が無い**（154 本 3,985 行すべてが `M月D日`。#753）
    assert.deepEqual(p.rows.filter((r) => !/^[０-９0-9]{1,2}月[０-９0-9]{1,2}日$/.test(r.dateText)), [], `${w.f}: 議決月日`);
    // **件名が空の行が無い**（番号と件名が 1 アイテムに同居する本で空になった。実装中に踏んだ）
    assert.deepEqual(p.rows.filter((r) => r.title === "").map((r) => r.number), [], `${w.f}: 件名`);
  }
});

/**
 * **凡例 4 通りが 6 本に全部入っている**（#753 が 154 本で A 130 / B 10 / C 9 / D 5 と数えた）。
 *
 * **これは「フィクスチャが偏っていない」ことの検算である**（#714 の「フィクスチャの偏り」）。
 * **1 通りしか入っていなければ、凡例を決め打ちしても緑になってしまう。**
 */
test("#759 凡例: 4 通りすべてがフィクスチャに入っている", async () => {
  const seen = new Set<string>();
  for (const f of FIXTURES) {
    const p = await parseVotePdf(pdf(f));
    seen.add(JSON.stringify(Object.entries(p.legend.votes).sort()));
  }
  assert.equal(seen.size, 4, `凡例の通り数（A / B / C / D の 4 通り。実際は ${seen.size} 通り）`);
});

/**
 * ## **`ー`(U+30FC) を表決の記号にしない**（#753 の問題 3。**秋田で新しく出た形**）
 *
 * **凡例 B の 10 本は「議場に不在」を `ー`(U+30FC ＝ 長音記号) と書く。**
 * **記号として拾うと議案名の長音が票に化ける**——`エネルギー` `センター` `アショア`（268 個 / 73 本）。
 * **実害は「記号が読めない」ではなく「記号でないものを記号と読む」側に出る**（#569）。
 *
 * **`ー` は 154 本のどの本文セルにも票として 1 個も出ていない**（凡例で `ー` を使う 10 本を含む）。
 * **だから捨てるのではなく `ignoredMarks` に残す**——
 * **「凡例にこう書いてあったが、この ETL は記号として読まなかった」という事実を残す。**
 */
test("#759 `ー`(U+30FC) は表決の記号ではない（議案名の長音が票に化けない）", async () => {
  assert.equal(isVoteSymbol("ー"), false, "`ー`(U+30FC) は記号ではない");
  assert.equal(isVoteSymbol("－"), true, "`－`(U+FF0D) は記号である（本文セルに 7 個 / 4 本）");
  // **凡例 B の本では `ー` が `ignoredMarks` に入り、`votes` には入らない**
  const b = await parseVotePdf(pdf("060220hyoketsu"));
  assert.deepEqual(b.legend.ignoredMarks, { "ー": "議場に不在" }, "凡例 B の `ー` は ignoredMarks に残る");
  assert.equal("ー" in b.legend.votes, false, "凡例 B の `ー` は votes に入らない");
  // **凡例の原文は捨てていない**
  assert.ok(b.legend.notes.includes("ー：議場に不在"), `凡例の原文（notes: ${JSON.stringify(b.legend.notes)}）`);
  // **議案名の中の `ー` が票になっていない**（この本には `ー` を含む議案名がある）
  for (const f of FIXTURES) {
    const p = await parseVotePdf(pdf(f));
    const bad = p.rows.flatMap((r) => r.cells).filter((c) => c === "ー");
    assert.deepEqual(bad, [], `${f}: 本文セルに ー が票として入っていない`);
  }
  // **もし `ー` を記号として拾ったら、この本の議案名の長音が票の候補になる**（否定的対照）。
  // **`countVoteSymbols` が数える記号に `ー` を足したときに何が起きるかを、
  // 実際の議案名のアイテムで示す**（**実装は変えない。ここで数えるだけ**）
  const pages = (await readPages(pdf("h291222giketu"))).map(unrotate);
  const chouon = pages.flatMap((pg) => pg.items).filter((i) => i.str.includes("ー"));
  assert.ok(chouon.length > 0, "この本に `ー` を含むアイテムがある（無ければ検算が空回り）");
  assert.ok(
    chouon.every((i) => countVoteSymbols(i.str) === 0),
    `議案名の \`ー\` は記号 0 個と数える: ${JSON.stringify(chouon.map((i) => i.str).slice(0, 3))}`,
  );
});

/**
 * ## **凡例 D の `－`＝「棄権又は議場に不在」は片方に決めない**（#569。**この PR の判断**）
 *
 * **`h231202giketu.pdf` の凡例には `「－」：棄権又は議場に不在` と書いてある**（原文）。
 * **1 つの記号に 2 つの意味がある。**
 * **`legend` には原文が入り、`mapped` は付かない**（`rollcalls.ts` の `MAPPED` に無いため）。
 * **`抽出不能` にもしない**（凡例が有り、原文がそう書いてあるので、原文を残すほうが情報が多い）。
 */
test("#759 凡例 D: `－` は「棄権」でも「議場に不在」でもない（原文のまま残る）", async () => {
  const d = await parseVotePdf(pdf("h231202giketu"));
  assert.equal(d.legend.votes["－"], "棄権又は議場に不在", "凡例 D の原文");
  assert.equal(legendOf("－", d.legend.votes), "棄権又は議場に不在", "`legendOf` は原文を返す");
  assert.notEqual(legendOf("－", d.legend.votes), "棄権", "「棄権」に決めていない");
  assert.notEqual(legendOf("－", d.legend.votes), "議場に不在", "「議場に不在」に決めていない");
  assert.notEqual(legendOf("－", d.legend.votes), UNKNOWN_LEGEND, "`抽出不能` にもしていない");
  // **凡例 A の `－` は「議場に不在」1 つ**（同じ記号で意味が違う本がある、という事実）
  const a = await parseVotePdf(pdf("h291222giketu"));
  assert.equal(a.legend.votes["－"], "議場に不在", "凡例 A の `－`");
});

/**
 * ## **k 番目の記号が k 番目の議員のものか**（#753 が 154 本 167,653 対で測ったのと同じ検算）
 *
 * **記号の実 x と、その列の氏名の文字の中心 x（平均）の差**を見る。**列番号を経由しない**ので、
 * **記号だけを 1 列回せば差は 1 セルぶんになる。**
 *
 * **#753 は恒真な検算を 4 つ潰している**（記号の個数 ＝ 列の数／各行で `議` は高々 1 個／
 * 同じ本で `議` が同じ 1 人／記号がすべて罫線セルに入る）——**どれも回しても数が動かない。**
 * **だからこの検算を「回して落ちる」形にしてある**（下の否定的対照）。
 *
 * **この検算が見ていないもの**（#757: 母数は 1 つではない）:
 * **「氏名が名簿の本人か」は見ていない**——**比べているのは x だけ**なので、
 * **氏名が 1 文字欠けても 1 対も動かない**（#753 の変異 9 と同じ理由）。
 * **そちらは `akita-rollcalls.test.ts` の名寄せと、`akita-run.test.ts` の unmatched 0 が受け持つ。**
 */
async function pairs(name: string): Promise<{ n: number; overHalf: number; worstCells: number; noName: number }> {
  const pages = (await readPages(pdf(name))).map(unrotate);
  let n = 0, overHalf = 0, noName = 0, worst = 0;
  for (const pg of pages) {
    const mc = findMemberColumns(pg);
    if (!mc) continue;
    const members = readMembers(pg, mc);
    // 列ごとの氏名の文字の中心 x（平均）。**氏名が無い列は数えない**（別に数える）
    const nameCx: (number | undefined)[] = [];
    const nameItems = pg.items.filter((i) => isNameItem(i));
    for (let c = 0; c < mc.n; c++) {
      if (members[c].nameText === "") { nameCx.push(undefined); continue; }
      const xs = nameItems.filter((i) => i.cx >= mc.cols[c] && i.cx < mc.cols[c + 1]).map((i) => i.cx);
      nameCx.push(xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
    }
    for (const row of mc.rows) {
      const core = voteRowCore(row.marks);
      if (core.length !== mc.n) continue;
      for (let k = 0; k < mc.n; k++) {
        const cell = mc.cols[k + 1] - mc.cols[k];
        const nx = nameCx[k];
        if (nx === undefined) { noName++; continue; }
        n++;
        const d = Math.abs(core[k].cx - nx) / cell;
        if (d >= 0.5) overHalf++;
        if (d > worst) worst = d;
      }
    }
  }
  return { n, overHalf, worstCells: worst, noName };
}

test("#759 k 番目の記号は k 番目の議員のもの（6 本すべてで半セル未満）", async () => {
  // **実測 2026-09-13**（この worktree の 6 本）。**母数も判定に入れる**——
  // **「半セル以上が 0」だけを見ていたら、対が 0 に減っても通ってしまう**（#705 / #714）
  const want = [
    { f: "h291222giketu", n: 2050 },
    { f: "h231202giketu", n: 45 },
    { f: "060220hyoketsu", n: 410 },
    { f: "R41102hyoketsu", n: 43 },
    { f: "041222hyoketsu", n: 2580 },
    { f: "080319", n: 3731 },
  ] as const;
  let total = 0;
  for (const w of want) {
    const r = await pairs(w.f);
    assert.equal(r.n, w.n, `${w.f}: (記号, 議員) の対`);
    assert.equal(r.overHalf, 0, `${w.f}: 半セル以上ずれた対`);
    assert.equal(r.noName, 0, `${w.f}: 氏名の無い列に落ちた記号`);
    assert.ok(r.worstCells < 0.5, `${w.f}: 差の最大 ${r.worstCells.toFixed(4)} セル`);
    total += r.n;
  }
  assert.equal(total, 8859, "6 本ぶんの対の合計");
});

/**
 * **否定的対照: 記号だけを 1 列回すと、全部が半セル以上になる**（#748 / #753 と同じ形）。
 *
 * **これが無ければ、上の検算が恒真でないことを示せない**（#520: 「消しても緑」は恒真の証明にならない）。
 * **回転にする**（ずらしではない）——**端を空けると「空の列に落ちた」という安い理由で落ちる**（#705）。
 */
test("#759 否定的対照: 記号を 1 列回すと、対の数は変わらず全部が半セル以上になる", async () => {
  for (const f of FIXTURES) {
    const pages = (await readPages(pdf(f))).map(unrotate);
    for (const rot of [1, -1]) {
      let n = 0, overHalf = 0;
      for (const pg of pages) {
        const mc = findMemberColumns(pg);
        if (!mc) continue;
        const members = readMembers(pg, mc);
        const nameItems = pg.items.filter((i) => isNameItem(i));
        const nameCx: (number | undefined)[] = [];
        for (let c = 0; c < mc.n; c++) {
          if (members[c].nameText === "") { nameCx.push(undefined); continue; }
          const xs = nameItems.filter((i) => i.cx >= mc.cols[c] && i.cx < mc.cols[c + 1]).map((i) => i.cx);
          nameCx.push(xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
        }
        for (const row of mc.rows) {
          const core = voteRowCore(row.marks);
          if (core.length !== mc.n) continue;
          for (let k = 0; k < mc.n; k++) {
            // **回す**（mod で巻き戻すので母数が減らない）
            const j = (k + rot + mc.n) % mc.n;
            const cell = mc.cols[k + 1] - mc.cols[k];
            const nx = nameCx[k];
            if (nx === undefined) continue;
            n++;
            if (Math.abs(core[j].cx - nx) / cell >= 0.5) overHalf++;
          }
        }
      }
      assert.ok(n > 0, `${f} rot=${rot}: 対が 1 つも無い（検算が空回り）`);
      assert.equal(overHalf, n, `${f} rot=${rot}: 回したら全部が半セル以上になる（${overHalf} / ${n}）`);
    }
  }
});

/**
 * ## **左端の stray な `議` を拾わない**（#753 の問題 2。**5,298 個 / 154 本すべて**）
 *
 * **議員の帯の外（左の「議案等番号」「議決月日」「議決結果」の欄、議案名の中）に `議` が立つ。**
 * **除かずに測ると 半セル以上 35,097 / 170,686 対、落ちた行 3,863 / 3,930**（#753 の変異 11）。
 * **しかも「数は合う」ので、利用者からも素朴な検算からも見えない。**
 *
 * **このテストは「stray が実在すること」と「芯がそれを落とすこと」の両方を固定する**——
 * **stray が 0 個のフィクスチャしか無ければ、この守りは空回りになる**（#714）。
 */
test("#759 左端の stray な `議` は票にならない（芯が落とす）", async () => {
  // **フィクスチャに stray が実在する**（実測 2026-09-13）
  const wantStray = { h291222giketu: 4, h231202giketu: 2, "060220hyoketsu": 10, R41102hyoketsu: 1, "041222hyoketsu": 60, "080319": 97 };
  for (const [f, want] of Object.entries(wantStray)) {
    const pages = (await readPages(pdf(f))).map(unrotate);
    const gi = pages.flatMap((pg) => pg.items).filter((i) => i.str.trim() === "議").length;
    assert.equal(gi, want, `${f}: 1 文字 \`議\` のアイテム（帯の中も外も含む）`);
  }
  // **どの本でも、各行の `議` は高々 1 個**（stray を拾っていたら 2 個以上になる行が出る）
  for (const f of FIXTURES) {
    const p = await parseVotePdf(pdf(f));
    const bad = p.rows.filter((r) => r.cells.filter((c) => c === "議").length > 1);
    assert.deepEqual(bad.map((r) => r.number), [], `${f}: \`議\` が 2 個以上ある行`);
    // **`議` は 1 本の中で同じ 1 人の列にだけ立つ**（#753 が 154 / 154 本で確かめた）。
    // **議長が投票した行があるので 0 個の行はありうる**（#615 が実測）
    const cols = new Set<number>();
    for (const r of p.rows) r.cells.forEach((c, i) => { if (c === "議") cols.add(i); });
    assert.equal(cols.size, 1, `${f}: \`議\` が立つ列（${[...cols]}）`);
  }
});

/**
 * **否定的対照: 芯を取らない（stray を落とさない）と、ほとんどの行が丸ごと `不明` になる。**
 *
 * **「stray を拾ったら別人の票になる」ではなく「数が合わなくなって落ちる」**ようにしてある——
 * **落ちる側に倒してある**という設計をここで固定する（作業合意）。
 *
 * ## **最初に書いた否定的対照は空回りだった**（**測って気づいた。2026-09-13**）
 * **最初は「`mc.rows` のうち `marks.length === n` の行」を数えた**が、
 * **`mc.rows` は `findMemberColumns` が既に芯で絞った行である**——
 * **絞ったあとのものを「絞る前」として数えていた。** **6 本すべてで 91 対 91 のように同数になった。**
 * **緑にならなかったので気づけた**（**assert が `<` だったため**）。
 * **`>` や `>=` で書いていたら、空回りのまま緑になっていた**（#714 の「検算が空回り」）。
 *
 * **直した形**: **`voteRows`（芯を取る前）の各行について、
 * `marks.length`（芯なし）と `voteRowCore(marks).length`（芯あり）のどちらが `n` に一致するかを数える。**
 */
test("#759 否定的対照: 芯を取らないと、ほとんどの行が列の数と合わなくなる", async () => {
  // **実測 2026-09-13**。**`rawEqN` は「芯を取らずに数が合う行」**——**芯が効いているほど小さい**
  const want = [
    { f: "h291222giketu", rows: 50, coreEqN: 50, rawEqN: 4, dropped: 49 },
    { f: "h231202giketu", rows: 1, coreEqN: 1, rawEqN: 1, dropped: 0 },
    { f: "060220hyoketsu", rows: 10, coreEqN: 10, rawEqN: 0, dropped: 10 },
    { f: "R41102hyoketsu", rows: 1, coreEqN: 1, rawEqN: 1, dropped: 0 },
    { f: "041222hyoketsu", rows: 60, coreEqN: 60, rawEqN: 2, dropped: 88 },
    { f: "080319", rows: 91, coreEqN: 91, rawEqN: 6, dropped: 93 },
  ] as const;
  for (const w of want) {
    const pages = (await readPages(pdf(w.f))).map(unrotate);
    let rows = 0, coreEqN = 0, rawEqN = 0, dropped = 0;
    for (const pg of pages) {
      const mc = findMemberColumns(pg);
      if (!mc) continue;
      for (const r of voteRows(pg)) {
        rows++;
        const core = voteRowCore(r.marks);
        if (core.length === mc.n) coreEqN++;
        if (r.marks.length === mc.n) rawEqN++;
        dropped += r.marks.length - core.length;
      }
    }
    assert.equal(rows, w.rows, `${w.f}: 票の行`);
    assert.equal(coreEqN, w.coreEqN, `${w.f}: 芯を取れば列の数と合う行`);
    assert.equal(rawEqN, w.rawEqN, `${w.f}: 芯を取らずに合う行`);
    assert.equal(dropped, w.dropped, `${w.f}: 芯が落とした記号（帯の外の \`議\` など）`);
  }
  // **6 本の合計で見ても、芯を取らないと 14 / 213 行しか置けない**
  // （**残り 199 行 ＝ 8,400 セルあまりが丸ごと \`不明\` になる**）
  const totalRows = want.reduce((a, w) => a + w.rows, 0);
  const totalRaw = want.reduce((a, w) => a + w.rawEqN, 0);
  const totalCore = want.reduce((a, w) => a + w.coreEqN, 0);
  assert.equal(totalCore, totalRows, "芯を取れば全部の行が置ける（213 / 213）");
  assert.equal(totalRaw, 14, "芯を取らないと 14 行しか置けない");
});

/**
 * ## **結合アイテム（`"○ ○ … ○ 議 ○ … ○"`）を割る**（#753 の問題 6。**110 本 / 2,780 アイテム**）
 *
 * **モデルは「半角（ASCII）は全角の半分の送り幅」。アイテム自身の文字列と `w` だけから決まる**
 * （氏名の x を使っていないので循環しない）。
 */
test("#759 splitRowItem: 半角は全角の半分の送り幅（アイテムの中の x から決まる）", () => {
  // **実測**（`h291222giketu.pdf` の 1 行目。x=658.53 w=396.478、全角 36 ＋ 半角 35）
  const it: Item = { str: "○ ○ 議 ○", x: 100, y: 0, w: 100, h: 10, cx: 150, cy: 5 };
  const out = splitRowItem(it);
  assert.deepEqual(out.map((m) => m.ch), ["○", "○", "議", "○"], "記号だけを返す（空白は返さない）");
  // 全角 4 ＋ 半角 3 → 単位 4 + 1.5 = 5.5、1 単位 = 100 / 5.5
  const u = 100 / 5.5;
  assert.ok(Math.abs(out[0].cx - (100 + 0.5 * u)) < 1e-9, "1 個目の中心");
  assert.ok(Math.abs(out[1].cx - (100 + 2.0 * u)) < 1e-9, "2 個目の中心（全角 1 ＋ 半角 0.5 進む）");
  assert.ok(Math.abs(out[3].cx - (100 + 5.0 * u)) < 1e-9, "4 個目の中心");
  // **末尾の数字も半角として数える**（`"○ ○ 45"` の 45 は 2 文字ぶん 1.0 単位）
  const withNum = splitRowItem({ ...it, str: "○ ○ 45" });
  assert.deepEqual(withNum.map((m) => m.ch), ["○", "○"], "数字は記号ではない");
});

test("#759 結合アイテムがフィクスチャに実在する（この守りが空回りでない）", async () => {
  // **実測 2026-09-13**。**`041222hyoketsu` は 85 個、`h291222giketu` は 51 個**
  const want = { h291222giketu: 51, h231202giketu: 1, "060220hyoketsu": 10, R41102hyoketsu: 1, "041222hyoketsu": 85, "080319": 1 };
  for (const [f, n] of Object.entries(want)) {
    const pages = (await readPages(pdf(f))).map(unrotate);
    const combined = pages.flatMap((pg) => pg.items).filter((i) => countVoteSymbols(i.str) > 1).length;
    assert.equal(combined, n, `${f}: 記号を 2 個以上持つアイテム`);
  }
});

/** **凡例のアイテムは票の行にならない**（#753 の「測り方を 3 回直した」の 3 番目） */
test("#759 isLegendItem: 凡例は票にならない（議員の帯の x に入っていても）", () => {
  for (const s of ["「○」：賛成", "○ ： 賛成", "簡易：簡易表決（異議の有無を諮る）", "自民：自由民主党", "／"]) {
    assert.equal(isLegendItem(s), true, `${JSON.stringify(s)} は凡例`);
    assert.equal(countVoteSymbols(s), 0, `${JSON.stringify(s)} の記号は 0 個と数える`);
  }
  // **本文セルは記号と半角空白だけ**（154 本の実測。#753）
  assert.equal(isLegendItem("○ ○ ○ 議 ○"), false, "票の行は凡例ではない");
  assert.equal(countVoteSymbols("○ ○ ○ 議 ○"), 5, "票の行の記号の個数");
});

/**
 * **否定的対照: 凡例を除かないと、凡例の行が票の行になり、記号の個数が列の数と合わなくなる。**
 *
 * ## **最初に書いた否定的対照は空回りだった**（**測って気づいた。2026-09-13**）
 * **最初は「凡例を数えた行数」と「数えない行数」を比べた**が、
 * **どちらも 42 で同じだった**——**凡例の 1 行に入る記号は 3 個ほどで、
 * 「20 個以上の帯」という条件に届かないので、行としては数えられないからである。**
 * **つまり「行数」では凡例の害が見えない。**
 *
 * **害が出るのは「議員の帯の中に凡例がある行」**——**実測 `080703.pdf` の凡例は
 * `○ ： 賛成` が cx=940.7 にあり、議員の帯（825〜1531）の中にある。**
 * **除かないと、凡例の記号がその y 帯の票に足され、その行の記号が多くなる。**
 * **だから比べるのは「記号の個数」である。**
 */
test("#759 否定的対照: 凡例を除かないと、凡例の記号が票に混ざる", async () => {
  const SYM = new Set([..."○×議欠棄除－"]);
  let mixed = 0, legendItems = 0;
  for (const f of FIXTURES) {
    const pages = (await readPages(pdf(f))).map(unrotate);
    for (const pg of pages) {
      const mc = findMemberColumns(pg);
      if (!mc) continue;
      for (const it of pg.items) {
        if (!isLegendItem(it.str)) continue;
        const n = [...it.str].filter((c) => SYM.has(c)).length;
        if (n === 0) continue;
        legendItems++;
        // **議員の帯の x の中にある凡例のアイテム**（除かなければ票に混ざる）
        if (it.cx >= mc.left && it.cx < mc.right) mixed += n;
      }
    }
  }
  assert.ok(legendItems > 0, "凡例に記号を含むアイテムがある（無ければ検算が空回り）");
  // **実測 2026-09-13**: 6 本で **凡例の記号を含むアイテム 76 個**、
  // **そのうち議員の帯の x に入るものの記号 106 個**
  assert.equal(legendItems, 76, "凡例で記号を含むアイテム");
  assert.equal(mixed, 106, "議員の帯の x に入る凡例の記号（除かなければ票に混ざる）");
  // **除いているので、実際には 1 個も混ざっていない**（`countVoteSymbols` が 0 と数える）
  for (const f of FIXTURES) {
    const pages = (await readPages(pdf(f))).map(unrotate);
    const bad = pages.flatMap((pg) => pg.items).filter((i) => isLegendItem(i.str) && countVoteSymbols(i.str) > 0);
    assert.deepEqual(bad.map((i) => i.str), [], `${f}: 凡例のアイテムが記号を持っていない`);
  }
});

/** **`parseHeading` は断片を繋がない**（同じ見出しが 4 回、断片に割れて重なる本がある） */
test("#759 parseHeading: 断片に割れて重なった見出しを繋がない", () => {
  const item = (str: string, x: number, cy: number): Item => ({ str, x, y: cy - 4, w: str.length * 8, h: 8, cx: x + str.length * 4, cy });
  // **実測 `h251008giketu.pdf` の形**（`各議員|の|表決状況|平成|２５|年第|…` が上端に 44 アイテム）
  const page: PageGeometry = {
    items: [
      item("各議員", 10, 760), item("の", 40, 760), item("表決状況", 50, 760),
      item("平成", 100, 760), item("２５", 120, 760), item("年第", 140, 760),
      // **完結した形のアイテムも同じ帯にある**
      item("平成２５年第２回定例会（１０月８日）", 200, 760),
    ],
    vlines: [], hlines: [],
  };
  const h = parseHeading([page]);
  assert.equal(h.headingText, "平成２５年第２回定例会（１０月８日）", "完結した形のアイテムだけを見る");
  assert.equal(h.year, 2013, "和暦の年");
  assert.equal(h.round, 2, "回次");
  // **議案名の和暦は拾わない**（`平成２９年度…` は `年度` と続く）
  const bill: PageGeometry = { items: [item("平成２９年度秋田県一般会計補正予算（第１０号）", 10, 760)], vlines: [], hlines: [] };
  assert.equal(parseHeading([bill]).year, undefined, "議案名の和暦は見出しではない");
});

/** **`voteRowCore` は等間隔の連なりを採る**（左端の stray を落とす） */
test("#759 voteRowCore: 等間隔の連なりだけを採る", () => {
  const m = (cx: number, ch = "○") => ({ cx, ch });
  // 左に 1 個 stray（100pt 離れている）＋ 本体 5 個（10pt 間隔）
  assert.deepEqual(
    voteRowCore([m(0, "議"), m(100), m(110), m(120), m(130), m(140)]).map((q) => q.cx),
    [100, 110, 120, 130, 140],
    "左の stray 1 個を落とす",
  );
  // 左に 2 個 stray（33pt 間隔で別の連なりを作る）＋ 本体 6 個
  assert.deepEqual(
    voteRowCore([m(0, "議"), m(33, "表"), m(100), m(110), m(120), m(130), m(140), m(150)]).map((q) => q.cx),
    [100, 110, 120, 130, 140, 150],
    "左の別の連なり（長さ 2）が本体（長さ 6）に負ける",
  );
  // **右端が広がっていても切らない**（秋田の列は等間隔ではない。1.33 倍まで）
  assert.deepEqual(
    voteRowCore([m(100), m(110), m(120), m(130), m(143), m(157)]).map((q) => q.cx),
    [100, 110, 120, 130, 143, 157],
    "1.3〜1.4 倍の広がりは切らない",
  );
});

/** **数が合わない行は丸ごと `不明`**（推定しない。#689 が滋賀で踏んだ形） */
test("#759 readVoteCells: 数が合わない行は丸ごと `不明`", () => {
  const mc = { cols: [0, 10, 20, 30], n: 3, left: 0, right: 30, rows: [], oddRows: [] };
  const row = { cy: 0, h: 8, marks: [{ cx: 5, ch: "○" }, { cx: 15, ch: "×" }] };
  assert.deepEqual(readVoteCells(row, mc), [UNKNOWN_CELL, UNKNOWN_CELL, UNKNOWN_CELL], "2 個しか無い（3 列）");
  const ok = { cy: 0, h: 8, marks: [{ cx: 5, ch: "○" }, { cx: 15, ch: "×" }, { cx: 25, ch: "議" }] };
  assert.deepEqual(readVoteCells(ok, mc), ["○", "×", "議"], "3 個そろえば置く");
  // **k 番目が k 番目の列に無ければ、その行を丸ごと落とす**（ずれが積もっても気づける）
  const shifted = { cy: 0, h: 8, marks: [{ cx: 5, ch: "○" }, { cx: 15, ch: "×" }, { cx: 16, ch: "議" }] };
  assert.deepEqual(readVoteCells(shifted, mc), [UNKNOWN_CELL, UNKNOWN_CELL, UNKNOWN_CELL], "3 個目が 2 列目にある");
});

test("#759 columnOf / isSingleGlyph / legendOf", () => {
  assert.equal(columnOf([0, 10, 20], 5), 0);
  assert.equal(columnOf([0, 10, 20], 10), 1, "境界は右の列に入る（`bandIndex` と違い落とさない）");
  assert.equal(columnOf([0, 10, 20], 20), undefined, "右端は外");
  assert.equal(columnOf([0, 10, 20], -1), undefined, "左端より外");
  assert.equal(isSingleGlyph("櫛"), true);
  assert.equal(isSingleGlyph("櫛\u{E0101}"), true, "異体字セレクタを除いて 1 文字");
  assert.equal(isSingleGlyph("櫛引"), false);
  assert.equal(legendOf(UNKNOWN_CELL, LEGEND_A), UNKNOWN_LEGEND, "`不明` は `抽出不能`");
  assert.equal(legendOf("〇", LEGEND_A), "賛成", "字形の揺れ（U+3007 → U+25CB）は寄せる（#674）");
  assert.equal(legendOf("退", LEGEND_A), UNKNOWN_LEGEND, "凡例に無い記号は `抽出不能`（例外にしない。#569）");
});

/** **`isNameItem` は縦積み 1 アイテムを通し、横書きを弾く**（#753 の「測り方 #1」が踏んだ罠） */
test("#759 isNameItem: 縦積み 1 アイテム（B の形）も氏名として通す", () => {
  const it = (str: string, w: number, h: number): Item => ({ str, x: 0, y: 0, w, h, cx: w / 2, cy: h / 2 });
  assert.equal(isNameItem(it("宇", 8.76, 8.76)), true, "A の形（1 文字 1 アイテム）");
  assert.equal(isNameItem(it("武 内", 8.76, 22.32)), true, "B の形（縦積み 2 文字）");
  assert.equal(isNameItem(it("加 賀 屋 千 鶴 子", 8.76, 59.16)), true, "B の形（縦積み 6 文字）");
  assert.equal(isNameItem(it("みらい", 24.12, 8.76)), false, "横書き（会派の帯）は氏名ではない");
  assert.equal(isNameItem(it("自民：自由民主党", 65.76, 8.76)), false, "凡例は氏名ではない");
  assert.equal(isNameItem(it("○", 8.76, 8.76)), false, "記号は氏名ではない");
  assert.equal(isNameItem(it("40", 8.76, 8.76)), false, "数字は氏名ではない");
  assert.equal(isNameItem(it("／", 11.05, 11.05)), false, "区切りは氏名ではない（凡例に 11 個ある本がある）");
});

/** **画像 PDF・空の PDF は例外**（黙って「採決が無かった」にしない） */
test("#759 parseVotePdf: 文字層の無い PDF は例外", async () => {
  // 1 ページだけの最小の PDF（文字層なし）
  const empty = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n",
  );
  await assert.rejects(() => parseVotePdf(empty), /no pages|no text layer|Invalid PDF|XRef|structure/i, "文字層が無ければ例外");
});

/* ==================== #829 ページ番号が票の行に混ざる ==================== */

/**
 * **`readRows` が左の欄のアイテムを「いちばん近い錨」に配るときの距離の上限**（#829）。
 *
 * **上限が無かったころ、ページ下端に 1 つだけ立つページ番号（`1` `2` `3`）が
 * いちばん近い行に入り、`readLeftCells` の「右の数字を左から 3 つ」に混ざった**（#819 が見つけた）。
 *
 * **下の表は、上限を入れる前の実測**（フィクスチャ 6 本 213 行を全件突き合わせた。2026-09-13）。
 * **10 行が影響を受け、内訳は捏造 5・喪失 5 である。**
 * **上限を外すと、この表の `before` がそのまま戻る**（下の否定的対照）。
 */
const PAGE_NUMBER_ROWS = [
  // **捏造 5**（数が 2 つしか無い行にページ番号が足されて 3 つになり、counts ができてしまった）
  { book: "h291222giketu", page: 1, number: "議案第214号", before: { voting: 1, yes: 40, no: 40 }, after: undefined, yes: 40, no: 0 },
  { book: "h291222giketu", page: 2, number: "請願第40号", before: { voting: 2, yes: 40, no: 40 }, after: undefined, yes: 40, no: 0 },
  { book: "h231202giketu", page: 1, number: "事提出認定第２号", before: { voting: 44, yes: 42, no: 1 }, after: undefined, yes: 42, no: 2 },
  { book: "060220hyoketsu", page: 1, number: "議案第10号", before: { voting: 40, yes: 40, no: 1 }, after: undefined, yes: 40, no: 0 },
  { book: "041222hyoketsu", page: 1, number: "議案第209号", before: { voting: 42, yes: 42, no: 1 }, after: undefined, yes: 42, no: 0 },
  // **喪失 5**（数が 3 つある行にページ番号が足されて 4 つになり、counts が丸ごと落ちた）
  { book: "R41102hyoketsu", page: 1, number: "知事提出認定第3号", before: undefined, after: { voting: 42, yes: 41, no: 1 }, yes: 41, no: 1 },
  { book: "041222hyoketsu", page: 2, number: "請願第57号", before: undefined, after: { voting: 42, yes: 6, no: 36 }, yes: 6, no: 36 },
  { book: "080319", page: 1, number: "議案第86号", before: undefined, after: { voting: 40, yes: 39, no: 1 }, yes: 39, no: 1 },
  { book: "080319", page: 2, number: "議員提出決議案第1号", before: undefined, after: { voting: 40, yes: 40, no: 0 }, yes: 40, no: 0 },
  { book: "080319", page: 3, number: "請願第27号", before: undefined, after: { voting: 40, yes: 40, no: 0 }, yes: 40, no: 0 },
] as const;

const parsed = new Map<string, Awaited<ReturnType<typeof parseVotePdf>>>();
const parseOnce = async (book: string): Promise<Awaited<ReturnType<typeof parseVotePdf>>> => {
  const hit = parsed.get(book);
  if (hit) return hit;
  const v = await parseVotePdf(pdf(book));
  parsed.set(book, v);
  return v;
};

test("#829 ページ番号が混ざっていた 10 行が、実物の値で直っている", async () => {
  assert.equal(PAGE_NUMBER_ROWS.length, 10, "**母数**——この表が縮んだら落ちる（#757）");
  assert.equal(PAGE_NUMBER_ROWS.filter((r) => r.before !== undefined).length, 5, "捏造されていた行");
  assert.equal(PAGE_NUMBER_ROWS.filter((r) => r.before === undefined).length, 5, "counts が落ちていた行");
  for (const want of PAGE_NUMBER_ROWS) {
    const v = await parseOnce(want.book);
    const row = v.rows.find((r) => r.page === want.page && r.number === want.number);
    assert.ok(row, `${want.book} p${want.page} ${want.number} が見つからない`);
    assert.deepEqual(row.counts, want.after, `${want.book} p${want.page} ${want.number} の counts`);
    // **counts があるなら、その行の記号の数と一致する**（捏造された値はここで落ちる）
    const yes = row.cells.filter((c) => c === "○").length;
    const no = row.cells.filter((c) => c === "×").length;
    assert.equal(yes, want.yes, `${want.number} の ○`);
    assert.equal(no, want.no, `${want.number} の ×`);
    if (row.counts) {
      assert.equal(row.counts.yes, yes, `${want.number}: counts.yes と ○ が合う`);
      assert.equal(row.counts.no, no, `${want.number}: counts.no と × が合う`);
    }
  }
});

/**
 * **フィクスチャ 6 本 213 行で、`counts` のある行は 1 行残らず記号の数と一致する。**
 *
 * **上限を入れる前は 5 行が合わなかった**（#819 が「無改造で合わない行 5 行」と書いたのがこれ）。
 * **「0 件」と書いているが、母数（`counts` のある行の数）も一緒に固定してある**ので、
 * **`counts` を全部捨てる変異でも落ちる。**
 */
test("#829 counts と記号の数が合う（6 本 213 行・合わない行 0）", async () => {
  let rows = 0;
  let withCounts = 0;
  const bad: string[] = [];
  for (const f of FIXTURES) {
    const v = await parseOnce(f);
    for (const r of v.rows) {
      rows++;
      if (!r.counts) continue;
      withCounts++;
      const yes = r.cells.filter((c) => c === "○").length;
      const no = r.cells.filter((c) => c === "×").length;
      if (r.counts.yes !== yes || r.counts.no !== no) bad.push(`${f} p${r.page} ${r.number} counts=${JSON.stringify(r.counts)} ○=${yes} ×=${no}`);
    }
  }
  assert.equal(rows, 213, "**母数**——行が減ったら落ちる");
  assert.equal(withCounts, 103, "**母数**——`counts` を読めた行（全部捨てる変異で落ちる）");
  assert.deepEqual(bad, [], "counts と記号の数が合わない行");
});

/**
 * ## **否定的対照: 上限を外すと、捏造が戻ることを「実物で」示す**
 *
 * **`readRows` は export されていない**ので、**ここでは `parseVotePdf` の外から上限を外せない。**
 * **代わりに「上限が無い配り方」をこのテストの中で組み直して、
 * ページ番号が実在し、それが `counts` の欄に届くことを確かめる。**
 *
 * **これは実装の写しではない**——**確かめているのは「ページ番号のアイテムが、
 * 上限が無ければどの行に入り、その行の数字が何個になるか」という PDF 側の事実である。**
 * **フィクスチャからページ番号が消えれば、この対照は落ちる**（守りが空回りでないことの母数）。
 */
test("#829 否定的対照: 上限が無ければページ番号が行に届く（実物が 10 個ある）", async () => {
  const DATE_IN = /([０-９0-9]{1,2})月([０-９0-9]{1,2})日/;
  const found: { book: string; page: number; str: string; ratio: number }[] = [];
  const legit: number[] = [];
  for (const f of FIXTURES) {
    const raw = await readPages(pdf(f));
    const pages = raw.map(unrotate);
    for (let p = 0; p < pages.length; p++) {
      const page = pages[p];
      const mc = findMemberColumns(page);
      if (!mc) continue;
      const rows = [...mc.rows, ...mc.oddRows].sort((a, b) => b.cy - a.cy);
      if (rows.length === 0) continue;
      const bandBottom = rows[0].cy + Math.max(rows[0].h, 1);
      const anchors = [...new Set(page.items.filter((i) => i.x + i.w <= mc.left + 1 && i.cy < bandBottom && DATE_IN.test(i.str)).map((i) => i.cy))].sort((a, b) => b - a);
      const used = new Set<number>();
      const rowAnchor = rows.map((b) => {
        let best: number | undefined;
        for (const y of anchors) {
          if (used.has(y)) continue;
          if (best === undefined || Math.abs(y - b.cy) < Math.abs(best - b.cy)) best = y;
        }
        if (best === undefined || Math.abs(best - b.cy) > Math.max(b.h, 1) * 3) return b.cy;
        used.add(best);
        return best;
      });
      const allAnchors = [...new Set([...rowAnchor, ...anchors])];
      for (const it of page.items) {
        if (it.x + it.w > mc.left + 1) continue;
        if (it.cy >= bandBottom) continue;
        const nearest = allAnchors.reduce((bestY, y) => (Math.abs(y - it.cy) < Math.abs(bestY - it.cy) ? y : bestY), allAnchors[0] ?? Infinity);
        const r = rowAnchor.indexOf(nearest);
        if (r < 0) continue;
        const ratio = Math.abs(it.cy - nearest) / Math.max(rows[r].h, 1);
        if (ratio > 2.5) found.push({ book: f, page: p + 1, str: it.str.trim(), ratio });
        else legit.push(ratio);
      }
    }
  }
  assert.equal(found.length, 10, "**上限より遠いアイテムが 10 個ある**（消えたらこの守りは空回り）");
  assert.deepEqual([...new Set(found.map((x) => x.str))].sort(), ["1", "2", "3"], "**遠いのは全部ページ番号の 1 桁**");
  // **上限の置き場所が「実測の隙間の中」にあることを、数字で残す**
  const maxLegit = Math.max(...legit);
  const minStray = Math.min(...found.map((x) => x.ratio));
  assert.ok(maxLegit < 2.0, `本物の最大は行の高さの 2 倍未満（実測 1.884。今 ${maxLegit.toFixed(3)}）`);
  // **`3.000` は丸めた表示で、実数は 2.9999… である**（実測。行の高さ 8.28 に対して Δy = -24.8）。
  // **`>= 3.0` と書くと落ちる**ので、**上限 2.5 との隙間を見る形にする**（ここが見たいことでもある）。
  assert.ok(minStray > 2.9, `ページ番号の最小は行の高さの 2.9 倍より遠い（実測 2.9999。今 ${minStray.toFixed(4)}）`);
  assert.ok(minStray - maxLegit > 1.0, `**本物とページ番号のあいだが 1 行ぶん以上空いている**（実測 2.9999 − 1.884 = 1.116。今 ${(minStray - maxLegit).toFixed(3)}）`);
  assert.equal(legit.length, 1657, "**母数**——上限の内側に残るアイテム（1,667 − 10）");
});
