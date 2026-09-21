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
 * **77 本すべてを取得して `parseVotePdf` に通した結果、読めたのは 8 本だけだった**（10.4%）——
 * **#901 で 5 本を通し、13 本（16.9%）になった**（下の `FILES`）。
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
 * **#871 の時点では、本番（`data/assemblies/pref-04`）に出ている 133 件はこの 8 本のうち 2 本
 * （第399・400回）から出ていた**（`--sessions 2` の既定のため）。
 * **#901 で既定を 11 にした**（第400 〜 第390回）——**本番 133 → 584 採決。**
 * **12 本目（第389回）で止めたのは「読めないから」ではなく、そこが 2023-10 の一般選挙の境だからである**
 * （**PDF に出る氏名の集合が IN 18 / OUT 19 で不連続になる。他の 11 回の移り変わりは 0〜2 人**）。
 * **読めない本が黙って飛ばされているのではなく、取りに行っていない。**
 *
 * ## 2 本の検算と、その効き（**フィクスチャ 13 本での実測。#901 で 8 本 → 13 本に増えた**）
 *
 * | 壊し方 | 検算A（公表数 ↔ ○×の数） | 検算B（`議` の列 ↔ 歴代議長） |
 * |---|---|---|
 * | 無改造 | **1 / 620 行が不一致**（下記。**一次資料そのものが合わない 1 行**） | **0 / 649 行が不一致** |
 * | `cells` を 1 行回す（y がずれる） | **153 / 620 行で落ちる**（24.7%） | **0 / 649 行**（列は動かないので当然） |
 * | `cells` を 1 列回す（x がずれる） | **1 / 620 行**（無改造と同じ 1 行。**x のずれは 1 件も増えない**） | **649 / 649 行で落ちる**（100%） |
 *
 * **8 本のときの数は 327 / 356 行で、比率はほぼ同じ**（検算A の効きは 24.8% → 24.7%）——
 * **「広げたら検算が効かなくなった」ということは起きていない。**
 *
 * **2 本は互いの代わりにならない**（#774 と同じ問い）:
 * **検算A は x を 1 件も捕まえない**——記号帯を回しても `○` と `×` の個数は変わらないからである（置換）。
 * **検算B は y を 1 件も捕まえない**——全行を同じだけ回せば `議` は同じ列に立ち続けるからである。
 *
 * ## 検算A の弱さ（数として残す）
 * **1 行回して落ちるのは 153 / 620 行（24.7%）でしかない。**
 * **理由は数えてある——判定できる 620 行のうち 530 行（85.5%）が全会一致**（`×` が 1 つも無い）で、
 * **467 行（75.3%）は「次の行の ○ / × の数」が自分の公表数と一致する。**
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
 * **(記号, 議員) の対 20,461 対すべてが半セル未満**（#871 の 8 本での測定）（最も外れた対でセル幅の **0.039**）だったが、
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
/**
 * **読めた 13 本すべて**（index の 77 本のうち。**「読める本だけを選んだ」のではなく「読めるのがこれだけ」**）。
 *
 * **#871 の時点では 8 本だった。** **#901 で 5 本を通した**（**どれも「広げて初めて見えた」欠陥**）:
 *   - **第397・396・395・394回**: **会派の見出し `無所属` が凡例に無い**（`votes-pdf.ts` の `readMembers`）
 *   - **第391回**: **セルが ASCII の `-`**（凡例は全角の `－`。`glyph-variants.ts`）
 * **もう 1 つ（第393回の `※` の議案等番号で採決 ID が衝突する）は `rollcalls.ts` の側で、
 * `parseVotePdf` は直す前から読めていた**——**だから 8 本には数えられていなかった。**
 * **詳しくは `miyagi-sessions-widen.test.ts`。**
 *
 * **並びは index の新しい順**。**本番に出るのは先頭 11 本まで**（`defaultSessionsFor("miyagi") === 11`）——
 * **12・13 本目（第389・388回）は 2023-10 の一般選挙の向こう側なので `data/` には出さないが、
 * ここでは読む**: **議長が 3 人ぶんに跨ることが検算B の効きに要る**（下の「議長 3 人ぶん」のテスト）。
 */
const FILES = [
  "hyoketu080707.pdf",          // 第400回 令和8年6月定例会
  "syuusei_hyouketsu080318.pdf", // 第399回 令和8年2月定例会
  "hyouketsu071217.pdf",        // 第398回 令和7年11月定例会
  "hyouketsu1002syuusei.pdf",   // 第397回 令和7年9月定例会   ← #901 で通した（`無所属`）
  "hyouketsu070630.pdf",        // 第396回 令和7年6月定例会   ← #901 で通した（`無所属`）
  "hyouketsu070314.pdf",        // 第395回 令和7年2月定例会   ← #901 で通した（`無所属`）
  "hyouketsu061211.pdf",        // 第394回 令和6年11月定例会  ← #901 で通した（`無所属`）
  "hyouketsu061017.pdf",        // 第393回 令和6年9月定例会
  "hyouketsu060701.pdf",        // 第392回 令和6年6月定例会
  "hyouketsu060313.pdf",        // 第391回 令和6年2月定例会   ← #901 で通した（ASCII の `-`）
  "hyouketsu051219.pdf",        // 第390回 令和5年11月定例会  ← **本番に出る最後の 1 本**
  "hyouketsu051004.pdf",        // 第389回 令和5年9月定例会   ← 2023-10 の一般選挙の前（本番には出さない）
  "hyouketsu050704.pdf",        // 第388回 令和5年6月定例会   ← 同上
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

test("#871/#901 母数: 読めた 13 本の行・セル・不明セルが実測どおり", () => {
  assert.equal(books.length, 13, `読めた本 ${books.length}`);
  const rows = books.reduce((n, b) => n + b.pdf.rows.length, 0);
  const cells = books.reduce((n, b) => n + b.pdf.rows.length * b.pdf.members.length, 0);
  const unknown = books.reduce((n, b) => n + b.pdf.unknownCells, 0);
  // **母数を必ず出す**（#757）。「ずれ 0 件」と「1 行も比べていない」を同じ出力にしない
  // **#871 の 8 本では 356 行 / 20,490 セルだった**。**#901 で 5 本を通して 649 行 / 37,585 セル。**
  assert.equal(rows, 649, `行 ${rows}`);
  assert.equal(cells, 37_585, `セル ${cells}`);
  // **29 セルはすべて 第393回（令和6年9月）の 石川光次郎 の列**——
  // **PDF がその列を 29 行ぶん空欄にしている**（`欠` でも `－` でもなく、記号が 1 つも無い）。
  // **その 29 行の `出席者数` は 58、彼が `○` を置いている 2 行は 59 なので、公表数とも矛盾しない。**
  // **実装は推定せず `UNKNOWN_CELL` で残す**——**ただし現状の型では「PDF が空欄」と「読めなかった」が同じ値になる。**
  assert.equal(unknown, 29, `不明セル ${unknown}`);
});

test("#871 検算A: 公表された賛成者数・反対者数が、その行の記号帯の ○ / × の数と合う（合わない 1 行は一次資料側）", () => {
  const t = sum(books.map((b) => checkCounts(b, (i) => b.pdf.rows[i].cells)));
  assert.equal(t.judgeable, 620, `判定できた行 ${t.judgeable}（不明を含む ${t.skipped} 行は判定外）`);
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
  assert.equal(t.judgeable, 649, `判定できた行 ${t.judgeable}`);
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
  // **#901 で 5 本増えた分はすべて 46代 髙橋伸二 の在任中**（108 → 401 行）。**3 人であることは変わらない。**
  assert.deepEqual([...seen.entries()].sort(), [["佐々木幸士", 183], ["菊地恵一", 65], ["高橋伸二", 401]]);
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
  // **13 本での実測 153 / 620（24.7%）。** **4 行に 1 行しか落ちない**（85.5% が全会一致で、隣の行と数が同じことが多い）。
  // **下限を置いて、効きが落ちたら気づけるようにする。**
  assert.ok(caught >= 145, `1 行回して落ちた行 ${caught} / ${judgeable}（13 本での実測 153。145 を下回ったら検算の効きが落ちている）`);
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

/**
 * ## **議長の交代当日に議決した行は、13 本 649 行に 1 行も無い**（#910 / #901）
 *
 * **#871 は 8 本でこれを 0 行と測り、「フィクスチャの議決日がたまたま重ならなかっただけ」と読まれていた。**
 * **13 本に広げても 0 行のままである**——**そして理由が測れた:**
 *
 * **宮城の議長交代は 11 月下旬**（実測: 2025-11-27 / 2023-11-28 / 2023-11-12 / 2021-11-24 / 2019-11-25）**だが、
 * **13 本の議決日 28 通りに 11 月は 1 日も無い**（**10月 4 / 12月 6 / 6月 6 / 7月 3 / 9月 3 / 3月 4 / 2月 2**）。
 * **11月定例会は開会が 11 月で、議決は 12 月に入ってからである**——
 * **交代日に最も近い議決日でも 13 日離れている**（2025-11-27 ↔ 2025-12-10）。
 *
 * **これは「起こりえない」ではなく「28 通りの議決日では起きなかった」である。**
 * **1 本の中に議長が 2 人いる形は奈良（pref-29）で実在する**（`nara-published-data.test.ts`）——
 * **宮城でも臨時会の議決日が交代日に当たれば同じことが起きうる。**
 * **その日が出てきたらこのテストが落ちる**（**そのときは「新旧どちらでも通す」ではなく、
 * 奈良と同じように 1 行ずつ確かめて母数から外すこと**——**緩い規則は検算を弱くする**）。
 */
test("#901 議長の交代当日に議決した行は 13 本 649 行に 1 行も無い（母数つきで固定する）", () => {
  // **歴代議長の表の「就任」日**（`CHAIRS` の `from`。**退任日 `to` と次の `from` が同じ日なら交代日**）
  const handovers = CHAIRS.map((c) => c.from).sort();
  assert.deepEqual(handovers, ["2018-11-26", "2019-07-03", "2019-11-25", "2021-11-24", "2023-11-28", "2025-11-27"]);
  const dates = new Map<string, number>();
  for (const b of books) {
    for (const r of b.pdf.rows) {
      const d = toIsoDate(r.dateText, b.pdf.sessionYear, b.pdf.sessionMonth);
      dates.set(d, (dates.get(d) ?? 0) + 1);
    }
  }
  assert.equal([...dates.values()].reduce((a, b) => a + b, 0), 649, "母数（行）");
  assert.equal(dates.size, 28, "議決日の通り数");
  assert.deepEqual(handovers.filter((h) => dates.has(h)), [], "交代当日に議決した日");
  // **11 月の議決日が 1 日も無い**——**0 行の理由**（偶然ではなく、会期の組み方がそうなっている）
  const months = new Map<string, number>();
  for (const d of dates.keys()) months.set(d.slice(5, 7), (months.get(d.slice(5, 7)) ?? 0) + 1);
  assert.equal(months.get("11"), undefined, "11 月の議決日");
  assert.deepEqual(Object.fromEntries([...months].sort()), { "02": 2, "03": 4, "06": 6, "07": 3, "09": 3, "10": 4, "12": 6 });
  // **`議` が 1 つでない行も 0**（交代当日なら 2 つ立ちうる）
  const two = books.flatMap((b) => b.pdf.rows.filter((r) => r.cells.filter((c) => c === "議").length !== 1).map((r) => `${b.name} ${r.kind}${r.number}`));
  assert.deepEqual(two, [], "`議` がちょうど 1 つでない行");
});
