import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseVotePdf, UNKNOWN_CELL, type VotePdf } from "../src/sources/local/mie/votes-pdf.ts";

/**
 * # 三重: x 方向（列）と y 方向（行）の対応を測る（Issue #835）
 *
 * ## 何を測ったか（151 本すべてを取得して測った実測値。PR #835 に全部書いてある）
 *
 * **index（`/KENGIKAI/07976009017.htm`）の `<a>` 518 本のうち `.pdf` は 151 本。
 * 151 本すべてが h3「議員別の賛否等の状況」の下にある**（別の種類の PDF は 0 本）。
 * **151 本を取得して `parseVotePdf` に通した結果、読めたのは 15 本だけである**（10%）。
 * **残り 136 本は例外で落ちる**（`moveText/nextLine` 80 本・`text matrix` 35 本・
 * 凡例の取りこぼし 20 本・議案等番号の形 1 本）。**詳しい内訳は PR #835。**
 *
 * **本番（`data/assemblies/pref-24`）に出ている 365 件は、この 15 本のうち 13 本から出ている**
 * （`--sessions 2` の既定で 令和8年・令和7年 の 2 会期だけを取っているため）。
 * **残る 138 本は取りに行っていない。** **ETL は読めない本を黙って飛ばさず例外で落ちる**ので、
 * **「読めない本が黙って欠けている」のではなく「取りに行っていない」が正しい。**
 *
 * ## 2 本の検算と、その効き（実測）
 *
 * | 壊し方 | 検算A（公表数 ↔ ○×の数） | 検算B（`議` の列 ↔ 歴代議長） |
 * |---|---|---|
 * | 無改造 | **0 / 378 行が不一致** | **0 / 421 行が不一致** |
 * | `cells` を 1 行回す（y がずれる） | **88 / 374 行で落ちる**（23.5%） | **0 / 417 行**（列は動かないので当然） |
 * | `cells` を 1 列回す（x がずれる） | **0 / 378 行**（置換なので数は変わらない） | **421 / 421 行で落ちる**（100%） |
 *
 * **2 本は互いの代わりにならない**（#774 と同じ問い。ここでは**完全に補い合う形で外れている**）:
 * **検算A は x を 1 件も捕まえない**——記号帯を回しても `○` と `×` の個数は変わらないからである。
 * **検算B は y を 1 件も捕まえない**——全行を同じだけ回せば `議` は同じ列に立ち続けるからである。
 * **片方を外すと、その方向の壊れ方は誰も見ていない状態になる。**
 *
 * ## 検算B が「回転で恒真にならない」のはなぜか
 * **「`議` が本の中で 1 つの列に揃う」だけなら恒真である**——実測でも
 * **x を 1 列回しても 2 列回しても「揃う」は 421 / 421 行で保たれた**（全行が同じだけ動くので）。
 * **だから列の中身を外の事実に結ぶ**: **`議` の列の議員名が、県が公表している歴代議長と一致するか。**
 * 一次資料: 三重県議会「歴代正副議長」 https://www.pref.mie.lg.jp/KENGIKAI/07681011814.htm
 * （更新日 令和8年5月19日。2026-09-13 取得）——
 * **114代 稲垣昭義（令和06.05〜）・115代 服部富男（令和07.05〜）・116代 藤田宜三（令和08.05〜）。**
 * **読めた 15 本の `議` の列は、421 行すべてでこの表と一致した。**
 * **同じページに「歴代副議長」の表が並んでおり、代の番号も氏名も違う**
 * （副議長 116代 は 藤田宜三 で 令和04.05）。**議長の表だけを使うこと。**
 *
 * ## 検算A の弱さ（数として残す）
 * **1 行回して落ちるのは 88 / 374 行（23.5%）でしかない。**
 * **理由は数えてある——421 行のうち 351 行（83%）が全会一致**（`×` が 1 つも無い）で、
 * **隣の議案と `○` の数まで同じことが多いので、ずらしても数が合ってしまう。**
 * **「検算A が通る」ことは「y が正しい」ことの証明にならない。**
 *
 * ## **測れていないこと**（#835 の担当者。**確かめていないので、そう書く**）
 * - **`title` が 1 議案ぶんずれる壊れ方を、この 2 本はどちらも捕まえない**（#829 と同じ形）。
 *   **ただし三重の `readRows` は、左の欄も記号帯も同じ `within(i.cy, y0, y1)` で、
 *   同じ罫線の間から読んでいる**（`votes-pdf.ts`。錨からの距離ではない）。
 *   **「左の欄だけが 1 行ずれる」経路がコードの上に無いことは読んで確かめたが、
 *   それを落とすテストは置けていない**（`VotePdfRow` に y が無いため。#829 と同じ制約）。
 * - **読めない 136 本の中身は測っていない。** **どの議案が欠けているかは分からない。**
 */

const dir = fileURLToPath(new URL("fixtures/mie/", import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".pdf")).sort();
const books: { name: string; pdf: VotePdf }[] = [];
for (const f of files) books.push({ name: f, pdf: await parseVotePdf(readFileSync(dir + f)) });

/**
 * **三重県議会 歴代議長**（一次資料 https://www.pref.mie.lg.jp/KENGIKAI/07681011814.htm 、2026-09-13 取得）。
 * **就任年月から次の就任年月の前月まで。** **PDF の表題の年月で引く**（議決月日ではない）。
 * **ここに無い年月の本は判定外**（推定しない。#569）。
 */
const SPEAKERS: { from: [number, number]; name: string }[] = [
  { from: [2024, 5], name: "稲垣昭義" },
  { from: [2025, 5], name: "服部富男" },
  { from: [2026, 5], name: "藤田宜三" },
];

const speakerAt = (year: number, month: number): string | undefined => {
  let found: string | undefined;
  for (const s of SPEAKERS) if (year > s.from[0] || (year === s.from[0] && month >= s.from[1])) found = s.name;
  return found;
};

const bare = (s: string) => s.replace(/[\s　]/g, "");

/** `cells` を行方向に k 回す（左の欄は動かさない＝「記号帯が k 行ずれた」状態） */
const rotateRows = (rows: readonly string[][], k: number): string[][] =>
  rows.map((_, i) => rows[(((i + k) % rows.length) + rows.length) % rows.length]);

/** `cells` を列方向に k 回す（行ごとに。ずらしではなく回転——空の列に落ちて落ちる、という安い理由を消す） */
const rotateCols = (cells: readonly string[], k: number): string[] =>
  cells.map((_, i) => cells[(((i + k) % cells.length) + cells.length) % cells.length]);

interface Tally { judgeable: number; skipped: number; bad: string[] }

/** 検算A: 公表された賛成者数・反対者数 ↔ その行の記号帯の ○ / × の数 */
function checkCounts(b: { name: string; pdf: VotePdf }, cellsOf: (i: number) => readonly string[]): Tally {
  const t: Tally = { judgeable: 0, skipped: 0, bad: [] };
  b.pdf.rows.forEach((r, i) => {
    const cells = cellsOf(i);
    // **置けていないセルがある行は判定外**（不明を ○ とも × とも数えない）
    if (cells.some((c) => c === UNKNOWN_CELL)) { t.skipped++; return; }
    t.judgeable++;
    const yes = cells.filter((c) => c === "○").length;
    const no = cells.filter((c) => c === "×").length;
    if (yes !== r.counts.yes || no !== r.counts.no) t.bad.push(`${b.name} ${r.kind}${r.number} ○${yes}/${r.counts.yes} ×${no}/${r.counts.no}`);
  });
  return t;
}

/** 検算B: `議` が立つ列の議員が、その月の議長（県の公表）と同じか */
function checkSpeaker(b: { name: string; pdf: VotePdf }, cellsOf: (i: number) => readonly string[]): Tally {
  const t: Tally = { judgeable: 0, skipped: 0, bad: [] };
  const want = speakerAt(b.pdf.year, b.pdf.month);
  // **歴代議長の表に無い年月は判定外**（推定しない）
  if (want === undefined) { t.skipped = b.pdf.rows.length; return t; }
  b.pdf.rows.forEach((r, i) => {
    const cells = cellsOf(i);
    const at = cells.flatMap((c, k) => (c === "議" ? [k] : []));
    t.judgeable++;
    // **`議` がちょうど 1 つ立っていない行は、それ自体が壊れ**（議長は 1 人）
    if (at.length !== 1) { t.bad.push(`${b.name} ${r.kind}${r.number} 議 が ${at.length} 個`); return; }
    const got = bare(b.pdf.members[at[0]].nameText);
    if (got !== want) t.bad.push(`${b.name} ${r.kind}${r.number} 議=${got} ≠ ${want}`);
  });
  return t;
}

const sum = (ts: Tally[]): Tally => ({
  judgeable: ts.reduce((n, t) => n + t.judgeable, 0),
  skipped: ts.reduce((n, t) => n + t.skipped, 0),
  bad: ts.flatMap((t) => t.bad),
});

test("#835 母数: フィクスチャ 8 本が読め、行と議員の数が実測どおり", () => {
  assert.equal(books.length, 8, `読めた本 ${books.length}`);
  const rows = books.reduce((n, b) => n + b.pdf.rows.length, 0);
  const cells = books.reduce((n, b) => n + b.pdf.rows.length * b.pdf.members.length, 0);
  const unknown = books.reduce((n, b) => n + b.pdf.unknownCells, 0);
  // **母数を必ず出す**（#757）。「ずれ 0 件」と「1 行も比べていない」を同じ出力にしない
  assert.equal(rows, 258, `行 ${rows}`);
  assert.equal(cells, 12065, `セル ${cells}`);
  // **43 セルはすべて 令和6年10月 の 下野幸助（※１、令和6年10月10日に議員辞職）の列**——
  // **PDF がその列を空欄にしており、「棄権」でも「欠席」でもない。実装は推定せず UNKNOWN_CELL で残す。**
  assert.equal(unknown, 43, `不明セル ${unknown}`);
});

test("#835 検算A: 公表された賛成者数・反対者数が、その行の記号帯の ○ / × の数と合う", () => {
  const t = sum(books.map((b) => checkCounts(b, (i) => b.pdf.rows[i].cells)));
  assert.equal(t.judgeable, 215, `判定できた行 ${t.judgeable}（不明を含む ${t.skipped} 行は判定外）`);
  assert.deepEqual(t.bad, [], `合わない行 ${t.bad.length} / ${t.judgeable}`);
});

test("#835 検算B: `議` の列の議員が、県が公表している歴代議長と一致する", () => {
  const t = sum(books.map((b) => checkSpeaker(b, (i) => b.pdf.rows[i].cells)));
  assert.equal(t.judgeable, 258, `判定できた行 ${t.judgeable}（歴代議長の表に無い年月 ${t.skipped} 行は判定外）`);
  assert.deepEqual(t.bad, [], `合わない行 ${t.bad.length} / ${t.judgeable}`);
});

test("#835 y 方向: 記号帯を 1 行回すと検算A が落ちる（検算A が恒真でないこと）", () => {
  let judgeable = 0, caught = 0;
  for (const b of books) {
    if (b.pdf.rows.length < 2) continue; // 1 行の本は回しても同じ
    const rot = rotateRows(b.pdf.rows.map((r) => r.cells), 1);
    const t = checkCounts(b, (i) => rot[i]);
    judgeable += t.judgeable; caught += t.bad.length;
  }
  // **落ちなければ検算A は y を測っていない**
  assert.ok(caught > 0, `1 行回して落ちた行 ${caught} / ${judgeable}（0 なら恒真）`);
  // **実測 47 / 212（フィクスチャ 8 本）= 22%。** 効きが落ちたら気づけるように下限を置く
  assert.ok(caught >= 40, `1 行回して落ちた行 ${caught} / ${judgeable}（実測 47。40 を下回ったら検算の効きが落ちている）`);
});

test("#835 x 方向: 記号帯を 1 列回すと検算B が落ちる（検算B が恒真でないこと）", () => {
  let judgeable = 0, caught = 0;
  for (const b of books) {
    const t = checkSpeaker(b, (i) => rotateCols(b.pdf.rows[i].cells, 1));
    judgeable += t.judgeable; caught += t.bad.length;
  }
  // **実測では 270 / 270 行すべてが落ちる**（列が 1 つ動けば議長の名前が変わる）
  assert.equal(caught, judgeable, `1 列回して落ちた行 ${caught} / ${judgeable}`);
  assert.ok(judgeable > 0, `判定できた行が 0`);
});

test("#835 2 本の検算は互いの代わりにならない（片方ずつ壊して 4 通り測る。#774）", () => {
  const yRot = (b: { name: string; pdf: VotePdf }) => { const r = rotateRows(b.pdf.rows.map((x) => x.cells), 1); return (i: number) => r[i]; };
  const xRot = (b: { name: string; pdf: VotePdf }) => (i: number) => rotateCols(b.pdf.rows[i].cells, 1);
  const multi = books.filter((b) => b.pdf.rows.length >= 2);
  const aY = sum(multi.map((b) => checkCounts(b, yRot(b))));
  const bY = sum(multi.map((b) => checkSpeaker(b, yRot(b))));
  const aX = sum(books.map((b) => checkCounts(b, xRot(b))));
  const bX = sum(books.map((b) => checkSpeaker(b, xRot(b))));
  // **検算A は y を捕まえ、x を 1 件も捕まえない**
  assert.ok(aY.bad.length > 0, `y 回転で検算A が落ちた ${aY.bad.length} / ${aY.judgeable}`);
  assert.equal(aX.bad.length, 0, `x 回転で検算A が落ちた ${aX.bad.length} / ${aX.judgeable}（置換なので数は変わらない。0 が実測）`);
  // **検算B は x を捕まえ、y を 1 件も捕まえない**
  assert.ok(bX.bad.length > 0, `x 回転で検算B が落ちた ${bX.bad.length} / ${bX.judgeable}`);
  assert.equal(bY.bad.length, 0, `y 回転で検算B が落ちた ${bY.bad.length} / ${bY.judgeable}（全行が同じだけ動くので 0 が実測）`);
});

test("#835 x 方向: 記号のアイテムの中心と、置いた列の中心が半セル未満（列番号を通さずに測る）", async () => {
  const { readGlyphPages } = await import("../src/sources/local/mie/glyphs.ts");
  const { cluster, within, bandIndex } = await import("../src/sources/local/pdf-table.ts");
  let pairs = 0, half = 0, worst = 0;
  for (const f of files) {
    const pages = await readGlyphPages(readFileSync(dir + f));
    for (const page of pages) {
      const legendBottom = Math.min(...page.items.filter((i) => /^(.)：(.+)$/.test(i.str)).map((i) => i.y));
      const vl = page.vlines.filter((l) => l.y0 < legendBottom);
      const hl = page.hlines.filter((l) => l.y < legendBottom);
      const colXs = cluster(vl.map((l) => l.x));
      const left = colXs[0], right = colXs[colXs.length - 1];
      const full = cluster(hl.filter((l) => l.x0 <= left + 2 && l.x1 >= right - 2).map((l) => l.y)).sort((a, b) => b - a);
      const voteCols = colXs.slice(8); // 左 8 列のぶんを飛ばす（LEFT_HEADERS.length）
      for (const it of page.items) {
        if (!within(it.cy, full[full.length - 1], full[1]) || it.cx <= voteCols[0]) continue;
        const c = bandIndex(voteCols, it.cx);
        if (c === undefined) continue;
        const w = voteCols[c + 1] - voteCols[c];
        const d = Math.abs(it.cx - (voteCols[c] + voteCols[c + 1]) / 2) / w;
        pairs++;
        if (d < 0.5) half++;
        if (d > worst) worst = d;
      }
    }
  }
  // **母数を書く**（#757）。「全部一致」だけでは 0 対を測ったのと区別が付かない
  assert.equal(pairs, 12022, `測った (記号, 列) の対 ${pairs}`);
  assert.equal(half, pairs, `半セル未満 ${half} / ${pairs}`);
  // 実測 max 0.0297（セル幅 14.64pt の 3%）
  assert.ok(worst < 0.05, `いちばん外れた対 ${worst.toFixed(4)} セル幅`);
});
