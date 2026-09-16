import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseVotePdf, UNKNOWN_CELL, type VotePdf } from "../src/sources/local/miyagi/votes-pdf.ts";
import { toIsoDate } from "../src/sources/local/miyagi/rollcalls.ts";
import { localNameKey } from "../src/sources/local/name-match.ts";

/**
 * # 宮城: x 方向（列）と y 方向（行）の対応を測る（Issue #871）
 *
 * ## 何を測ったか（**index の 77 本すべてを取得して測った実測値**。数字は PR #871）
 *
 * **`kakohonkaigi.html` の `<a>` 413 本のうち「各議員の表決状況」は 77 本**
 * （58 本は会期ページ経由、19 本は index からの PDF 直リンク）。
 * **会期ページ 58 本はいずれも `#tmp_contents` の中に PDF が 1 本だけで、偽陽性は 0 本。**
 * **77 本すべてを取得して `parseVotePdf` に通した結果、読めたのは 8 本だけである**（10.4%）。
 *
 * **読めない 69 本の理由は 1 つではない**（**44 本は原因を 2 つ以上同時に持つ**）:
 *
 * | 原因 | 本数（重複あり） |
 * |---|---:|
 * | 凡例の見出しが `＜会派名＞` ではなく裸の `表決方法` / `賛否欄`（第327〜387回） | **61** |
 * | 見出しの数字が全角（`第３６８回宮城県議会（平成３０年…）`。JS の `\d` に合わない） | **42** |
 * | 和暦が「元年」（`令和元年11月定例会`。`\d+年` に合わない） | **3** |
 * | 文字層が無い（`/Rotate 90` の画像 PDF。第324〜326回） | **3** |
 * | 会派 `無所属` が凡例に無い（第394〜397回） | **4** |
 * | セルが ASCII の `-`（凡例は全角の `－`。第391回） | **1** |
 * | 見出しに年が無い（`第３３２回宮城県議会（８月臨時会）`） | **1** |
 *
 * **本番（`data/assemblies/pref-04`）に出ている 133 件は、この 8 本のうち 2 本（第399・400回）から出ている**
 * （`--sessions 2` の既定のため）。**読めない本が黙って飛ばされているのではなく、取りに行っていない。**
 *
 * ## 2 本の検算と、その効き（**フィクスチャ 8 本での実測。PR #871 は 77 本ぶんを載せている**）
 *
 * | 壊し方 | 検算A（公表数 ↔ ○×の数） | 検算B（`議` の列 ↔ 歴代議長） |
 * |---|---|---|
 * | 無改造 | **1 / 327 行が不一致**（下記。**一次資料そのものが合わない 1 行**） | **0 / 356 行が不一致** |
 * | `cells` を 1 行回す（y がずれる） | **81 / 327 行で落ちる**（24.8%） | **0 / 356 行**（列は動かないので当然） |
 * | `cells` を 1 列回す（x がずれる） | **1 / 327 行**（無改造と同じ 1 行。**x のずれは 1 件も増えない**） | **356 / 356 行で落ちる**（100%） |
 *
 * **2 本は互いの代わりにならない**（#774 と同じ問い）:
 * **検算A は x を 1 件も捕まえない**——記号帯を回しても `○` と `×` の個数は変わらないからである（置換）。
 * **検算B は y を 1 件も捕まえない**——全行を同じだけ回せば `議` は同じ列に立ち続けるからである。
 *
 * ## 検算A の弱さ（数として残す）
 * **1 行回して落ちるのは 81 / 327 行（24.8%）でしかない。**
 * **理由は数えてある——判定できる 327 行のうち 282 行（86.2%）が全会一致**（`×` が 1 つも無い）で、
 * **246 行（75.2%）は「次の行の ○ / × の数」が自分の公表数と一致する。**
 * **「検算A が通る」ことは「y が正しい」ことの証明にならない。**
 *
 * ## 検算B が「回転で恒真にならない」のはなぜか
 * **「`議` が本の中で 1 つの列に揃う」だけなら恒真である**（全行が同じだけ動くので）。
 * **だから列の中身を外の事実に結ぶ**: **`議` の列の議員名が、県が公表している歴代議長と一致するか。**
 * 一次資料: 宮城県議会「歴代議長・副議長一覧」 https://www.pref.miyagi.jp/site/kengikai/rekidai.html
 * （2026-09-16 取得、HTTP 200）。**同じ表の右半分が副議長で、代の番号も氏名も違う**——
 * **議長の列（表の左半分）だけを使う。** 下の `VICE_CHAIRS` は「副議長の表を使うと落ちる」ことを
 * 測るためだけに置いてあり、照合には使わない。
 *
 * ## **半セル未満は「列の割り当てが正しい」ことの証明にならない**（実測で確かめた）
 * **(記号, 議員) の対 20,461 対すべてが半セル未満**（最も外れた対でセル幅の **0.039**）だったが、
 * **記号の x をわざとセル幅 1 つぶんずらしても、なお 98.26%（20,105 / 20,461）が「半セル未満」になる**——
 * **隣の列の中心に落ちるからである。** **この測り方は「対応が付いている」ことしか言わない。**
 * **列の割り当てを測るのは回転（検算B）だけである。**
 *
 * ## **測れていないこと**（**確かめていないので、そう書く**）
 * - **読めない 69 本の中身は測っていない。** **どの議案・どの議員が欠けているかは分からない。**
 * - **`title` が 1 議案ぶんずれる壊れ方を、この 2 本はどちらも捕まえない**（#829 と同じ形）。
 * - **歴代議長の表そのものは検算していない**（県の公表を正しいものとして使っている）。
 */

const dir = new URL("fixtures/miyagi/", import.meta.url);
/** **読めた 8 本すべて**（index の 77 本のうち。**「読める本だけを選んだ」のではなく「読めるのがこれだけ」**） */
const FILES = [
  "hyoketu080707.pdf",          // 第400回 令和8年6月定例会
  "syuusei_hyouketsu080318.pdf", // 第399回 令和8年2月定例会
  "hyouketsu071217.pdf",        // 第398回 令和7年11月定例会
  "hyouketsu061017.pdf",        // 第393回 令和6年9月定例会
  "hyouketsu060701.pdf",        // 第392回 令和6年6月定例会
  "hyouketsu051219.pdf",        // 第390回 令和5年11月定例会
  "hyouketsu051004.pdf",        // 第389回 令和5年9月定例会
  "hyouketsu050704.pdf",        // 第388回 令和5年6月定例会
];
const books: { name: string; pdf: VotePdf }[] = [];
for (const f of FILES) books.push({ name: f, pdf: await parseVotePdf(readFileSync(new URL(f, dir))) });

/**
 * **宮城県議会 歴代議長**（一次資料 https://www.pref.miyagi.jp/site/kengikai/rekidai.html 、2026-09-16 取得）。
 * **`議決月日` の日付で引く**（会期の年月ではない。宮城は 1 冊の中に議決日が複数ある——実測で 8 本に 19 の議決日）。
 * **表に無い日付の行は判定外**（推定しない。#569）。
 * **在任期間が重なる引き継ぎ日は、どちらかと一致すれば良しとする**（表の `退任` と次の `就任` が同日のことがある）。
 */
const CHAIRS: { term: string; name: string; from: string; to: string | null }[] = [
  { term: "47", name: "佐々木幸士", from: "2025-11-27", to: null },
  { term: "46", name: "髙橋伸二", from: "2023-11-28", to: "2025-11-27" },
  { term: "45", name: "菊地恵一", from: "2021-11-24", to: "2023-11-12" },
  { term: "44", name: "石川光次郎", from: "2019-11-25", to: "2021-11-24" },
  { term: "43", name: "相沢光哉", from: "2019-07-03", to: "2019-11-12" },
  { term: "42", name: "佐藤光樹", from: "2018-11-26", to: "2019-07-03" },
];

/**
 * **歴代副議長**（同じ表の右半分。**照合には使わない**）。
 * **「議長の表と副議長の表は別物である」ことをテストで落ちることとして固定するためだけに置く**
 * （三重 #835 の担当者が実際に取り違えた。宮城の表は 1 つの `<table>` に 2 人ぶんが横に並んでいるので、
 *  セルの位置を間違えると同じ罠に落ちる）。
 */
const VICE_CHAIRS: { term: string; name: string; from: string; to: string | null }[] = [
  { term: "42", name: "村上久仁", from: "2025-11-27", to: null },
  { term: "41", name: "本木忠一", from: "2023-11-28", to: "2025-11-27" },
  { term: "40", name: "池田憲彦", from: "2021-11-24", to: "2023-11-12" },
];

const chairsOn = (table: typeof CHAIRS, date: string) => table.filter((c) => c.from <= date && (c.to === null || date <= c.to));

/** `cells` を行方向に k 回す（左の欄は動かさない＝「記号帯が k 行ずれた」状態） */
const rotateRows = (rows: readonly (readonly string[])[], k: number): readonly string[][] =>
  rows.map((_, i) => rows[(((i + k) % rows.length) + rows.length) % rows.length] as string[]);

/** `cells` を列方向に k 回す（ずらしではなく回転——「空の列に落ちた」という安い理由を消す） */
const rotateCols = (cells: readonly string[], k: number): string[] =>
  cells.map((_, i) => cells[(((i + k) % cells.length) + cells.length) % cells.length]);

interface Tally { judgeable: number; skipped: number; bad: string[] }
const sum = (ts: Tally[]): Tally => ({
  judgeable: ts.reduce((n, t) => n + t.judgeable, 0),
  skipped: ts.reduce((n, t) => n + t.skipped, 0),
  bad: ts.flatMap((t) => t.bad),
});

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

/** 検算B: `議` が立つ列の議員が、その**議決日**の議長（県の公表）と同じか */
function checkChair(b: { name: string; pdf: VotePdf }, cellsOf: (i: number) => readonly string[], table = CHAIRS): Tally {
  const t: Tally = { judgeable: 0, skipped: 0, bad: [] };
  b.pdf.rows.forEach((r, i) => {
    const date = toIsoDate(r.dateText, b.pdf.sessionYear, b.pdf.sessionMonth);
    const on = chairsOn(table, date);
    // **表に無い日付は判定外**（推定しない）
    if (on.length === 0) { t.skipped++; return; }
    t.judgeable++;
    const cells = cellsOf(i);
    const at = cells.flatMap((c, k) => (c === "議" ? [k] : []));
    // **`議` がちょうど 1 つ立っていない行は、それ自体が壊れ**（議長は 1 人）
    if (at.length !== 1) { t.bad.push(`${b.name} ${r.kind}${r.number} 議 が ${at.length} 個`); return; }
    const got = localNameKey(b.pdf.members[at[0]].nameText);
    if (!on.some((c) => localNameKey(c.name) === got)) {
      t.bad.push(`${b.name} ${r.kind}${r.number} ${date} 議=${b.pdf.members[at[0]].nameText} ≠ ${on.map((c) => c.name).join("/")}`);
    }
  });
  return t;
}

test("#871 母数: 読めた 8 本の行・セル・不明セルが実測どおり", () => {
  assert.equal(books.length, 8, `読めた本 ${books.length}`);
  const rows = books.reduce((n, b) => n + b.pdf.rows.length, 0);
  const cells = books.reduce((n, b) => n + b.pdf.rows.length * b.pdf.members.length, 0);
  const unknown = books.reduce((n, b) => n + b.pdf.unknownCells, 0);
  // **母数を必ず出す**（#757）。「ずれ 0 件」と「1 行も比べていない」を同じ出力にしない
  assert.equal(rows, 356, `行 ${rows}`);
  assert.equal(cells, 20490, `セル ${cells}`);
  // **29 セルはすべて 第393回（令和6年9月）の 石川光次郎 の列**——
  // **PDF がその列を 29 行ぶん空欄にしている**（`欠` でも `－` でもなく、記号が 1 つも無い）。
  // **その 29 行の `出席者数` は 58、彼が `○` を置いている 2 行は 59 なので、公表数とも矛盾しない。**
  // **実装は推定せず `UNKNOWN_CELL` で残す**——**ただし現状の型では「PDF が空欄」と「読めなかった」が同じ値になる。**
  assert.equal(unknown, 29, `不明セル ${unknown}`);
});

test("#871 検算A: 公表された賛成者数・反対者数が、その行の記号帯の ○ / × の数と合う（合わない 1 行は一次資料側）", () => {
  const t = sum(books.map((b) => checkCounts(b, (i) => b.pdf.rows[i].cells)));
  assert.equal(t.judgeable, 327, `判定できた行 ${t.judgeable}（不明を含む ${t.skipped} 行は判定外）`);
  // **第388回 知事提出議案104（7/4、専決処分の承認）だけが合わない。**
  // **PDF の記号帯には `○` が 57 個と `議` が 1 個（計 58 = 議員数）あるのに、
  // 同じ PDF の欄は 出席57 / 表決56 / 賛成56 / 反対0 と書いてある。**
  // **原文の x 順のアイテム列をそのまま数えても `○` は 57 個である**（PR #871 に原文を載せた）。
  // **つまり我々の抽出ではなく、一次資料の中で数が食い違っている。**
  // **勝手にどちらかへ寄せない**（#569）。**1 行として固定し、増えたら気づけるようにする。**
  assert.deepEqual(t.bad, ["hyouketsu050704.pdf 知事提出議案104 ○57/56 ×0/0"], `合わない行 ${t.bad.length} / ${t.judgeable}`);
});

test("#871 検算B: `議` の列の議員が、県が公表している歴代議長と一致する", () => {
  const t = sum(books.map((b) => checkChair(b, (i) => b.pdf.rows[i].cells)));
  assert.equal(t.skipped, 0, `歴代議長の表に無い日付で判定外になった行 ${t.skipped}（0 が実測。増えたら表が足りていない）`);
  assert.equal(t.judgeable, 356, `判定できた行 ${t.judgeable}`);
  assert.deepEqual(t.bad, [], `合わない行 ${t.bad.length} / ${t.judgeable}`);
});

test("#871 検算B は「議長 3 人ぶん」を跨いで効いている（1 人だけなら列が固定でも通ってしまう）", () => {
  const seen = new Map<string, number>();
  for (const b of books) {
    for (const r of b.pdf.rows) {
      const at = r.cells.flatMap((c, k) => (c === "議" ? [k] : []));
      if (at.length !== 1) continue;
      const name = localNameKey(b.pdf.members[at[0]].nameText);
      seen.set(name, (seen.get(name) ?? 0) + 1);
    }
  }
  // **47代 佐々木幸士・46代 髙橋伸二・45代 菊地恵一 の 3 人**。
  // **本ごとに議長が替わるので、「たまたま同じ列」では通らない**（`議` の列番号も 22 / 24 / 28 と動く）。
  assert.deepEqual([...seen.entries()].sort(), [["佐々木幸士", 183], ["菊地恵一", 65], ["高橋伸二", 108]]);
});

test("#871 y 方向: 記号帯を 1 行回すと検算A が落ちる（検算A が恒真でないこと）", () => {
  let judgeable = 0, caught = 0;
  for (const b of books) {
    if (b.pdf.rows.length < 2) continue;
    const rot = rotateRows(b.pdf.rows.map((r) => r.cells), 1);
    const t = checkCounts(b, (i) => rot[i]);
    judgeable += t.judgeable; caught += t.bad.length;
  }
  assert.ok(caught > 0, `1 行回して落ちた行 ${caught} / ${judgeable}（0 なら恒真）`);
  // **実測 81 / 327（24.8%）。** **4 行に 1 行しか落ちない**（86.2% が全会一致で、隣の行と数が同じことが多い）。
  // **下限を置いて、効きが落ちたら気づけるようにする。**
  assert.ok(caught >= 75, `1 行回して落ちた行 ${caught} / ${judgeable}（実測 81。75 を下回ったら検算の効きが落ちている）`);
});

test("#871 x 方向: 記号帯を 1 列回すと検算B が全行で落ちる（ずらしではなく回転）", () => {
  for (const k of [1, 2, -1]) {
    const t = sum(books.map((b) => checkChair(b, (i) => rotateCols(b.pdf.rows[i].cells, k))));
    assert.ok(t.judgeable > 0, `k=${k}: 判定できた行が 0`);
    assert.equal(t.bad.length, t.judgeable, `k=${k}: 1 列回して落ちた行 ${t.bad.length} / ${t.judgeable}`);
  }
});

test("#871 2 本の検算は互いの代わりにならない（片方ずつ壊して 4 通り測る。#774）", () => {
  const multi = books.filter((b) => b.pdf.rows.length >= 2);
  const yRot = (b: { name: string; pdf: VotePdf }) => { const r = rotateRows(b.pdf.rows.map((x) => x.cells), 1); return (i: number) => r[i]; };
  const xRot = (b: { name: string; pdf: VotePdf }) => (i: number) => rotateCols(b.pdf.rows[i].cells, 1);
  const aY = sum(multi.map((b) => checkCounts(b, yRot(b))));
  const bY = sum(multi.map((b) => checkChair(b, yRot(b))));
  const aX = sum(books.map((b) => checkCounts(b, xRot(b))));
  const bX = sum(books.map((b) => checkChair(b, xRot(b))));
  // **検算A は y を捕まえ、x を 1 件も「増やさない」**——
  // **x 回転で残る 1 行は無改造でも落ちている一次資料側の 1 行なので、x のずれは 0 件である。**
  assert.ok(aY.bad.length > 0, `y 回転で検算A が落ちた ${aY.bad.length} / ${aY.judgeable}`);
  assert.equal(aX.bad.length, 1, `x 回転で検算A が落ちた ${aX.bad.length} / ${aX.judgeable}（無改造と同じ 1 行だけ。置換なので数は変わらない）`);
  // **検算B は x を全行で捕まえ、y を 1 件も捕まえない**
  assert.equal(bX.bad.length, bX.judgeable, `x 回転で検算B が落ちた ${bX.bad.length} / ${bX.judgeable}`);
  assert.equal(bY.bad.length, 0, `y 回転で検算B が落ちた ${bY.bad.length} / ${bY.judgeable}（0 が実測。全行が同じだけ動くので 議 は同じ列に立つ）`);
});

test("#871 副議長の表を使うと検算B は落ちる（議長の表と取り違えていないこと）", () => {
  const t = sum(books.map((b) => checkChair(b, (i) => b.pdf.rows[i].cells, VICE_CHAIRS)));
  // **副議長の表で引くと、判定できた行すべてで氏名が合わない**——
  // **「表を取り違えたら気づける」ことを数として置く**（#835 の担当者が実際に取り違えた）。
  assert.ok(t.judgeable > 0, `副議長の表で判定できた行 ${t.judgeable}`);
  assert.equal(t.bad.length, t.judgeable, `副議長の表で合わなかった行 ${t.bad.length} / ${t.judgeable}`);
});
