import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bandIndex, cluster, readPages, type Item } from "../src/sources/local/pdf-table.ts";
import {
  bottomRun, isVoteSymbol, legendOf, memberColumns, parseHeading, parseLegend, parseVotePdf,
  readRowBands, readVoteCells, splitLeftItem, splitRowItem, UNKNOWN_CELL, UNKNOWN_LEGEND,
} from "../src/sources/local/saga/votes-pdf.ts";
// **食い違った行を全部並べる**（#826 でここに作り、#844 で 5 県が使う 1 か所に移した）。
import { countMismatchRows } from "./count-mismatch-rows.ts";

/**
 * 佐賀県議会「議案採決結果一覧表」PDF（Issue #768）。フィクスチャは本物の PDF 7 本:
 *
 * | ファイル | 会期 | 何のための本か |
 * |---|---|---|
 * | `3_119791_394982_up_cda325jj.pdf` | 令和8年6月定 | **1 セル 1 アイテム型**。`猪村理恵子`（理）が出る |
 * | `3_111805_349057_up_7elgmado.pdf` | 令和7年2月定 | **1 行 1 アイテム型・8 ページ・議決日 2 つ**。**#693 の CTM の本**。列幅が 15.00 / 14.76 で揺れる |
 * | `3_112934_353517_up_h8tpjpnt.pdf` | 令和7年4月臨 | **凡例に `除：除席`**。`桃崎裕介`（裕）が出る |
 * | `3_96145_279859_up_jsqwevkw.pdf` | 令和5年5月臨 | **凡例に `除：地方自治法第117条による除斥`**（**字が違う**） |
 * | `3_87962_253631_up_ita1q1dw.pdf` | 令和4年9月定 | **見出しの無い続きのページ**（2 ページ目）。`36 36` が 1 アイテム |
 * | `3_114143_360206_up_8onm36yv.pdf` | 令和7年6月定 | **否定的対照: 文字層が無い**（読めないのが正しい） |
 * | `3_48014_3948_up_zea78qos.pdf` | 平成28年6月定 | **否定的対照: `/Rotate 90`**（表の作りも違うので読まない） |
 */
const FIX = {
  r8_06: "3_119791_394982_up_cda325jj.pdf",
  r7_02: "3_111805_349057_up_7elgmado.pdf",
  r7_04: "3_112934_353517_up_h8tpjpnt.pdf",
  r5_05: "3_96145_279859_up_jsqwevkw.pdf",
  r4_09: "3_87962_253631_up_ita1q1dw.pdf",
  noText: "3_114143_360206_up_8onm36yv.pdf",
  rotated: "3_48014_3948_up_zea78qos.pdf",
} as const;
const bytes = (name: string): Buffer => readFileSync(new URL(`./fixtures/saga/${name}`, import.meta.url));

/* ---------- 読めた本の実測値（1 本ずつ固定する） ---------- */

test("#768 令和8年6月定例会（1 セル 1 アイテム型）: 3 ページ 5 表 21 行 × 37 人、不明 0", async () => {
  const pdf = await parseVotePdf(bytes(FIX.r8_06));
  assert.deepEqual(
    { heading: pdf.headingText, year: pdf.year, month: pdf.month, kind: pdf.kind, pages: pdf.pages, tables: pdf.tables, rows: pdf.rows.length, members: pdf.members.length, unknown: pdf.unknownCells },
    { heading: "令和８年６月定例会 議案採決結果一覧表", year: 2026, month: 6, kind: "定例会", pages: 3, tables: 5, rows: 21, members: 37, unknown: 0 },
  );
  assert.deepEqual(pdf.legend.votes, { "○": "賛成", "×": "反対", "△": "退席", "欠": "欠席", "議": "議長" });
  const first = pdf.rows[0];
  assert.deepEqual(
    { number: first.number, title: first.title, result: first.result, month: first.month, day: first.day, section: first.section, page: first.page },
    { number: "甲第36号議案", title: "令和８年度佐賀県一般会計補正予算（第１号）", result: "可決", month: 7, day: 1, section: "知事提出議案", page: 1 },
  );
  assert.deepEqual(first.counts, { present: "37", absent: "0", voting: "36", yes: "36", no: "0", withdrew: "0" });
  // **1 行目の 37 人ぶん**（`議` は 11 番目 ＝ 議長 宮原真一）
  assert.equal(first.cells.length, 37);
  assert.equal(first.cells.filter((c) => c === "議").length, 1);
  assert.equal(pdf.members[first.cells.indexOf("議")].nameText, "宮原真一");
});

test("#768 令和7年2月定例会（1 行 1 アイテム型・8 ページ）: 72 行 × 37 人、議決日は 3/7 と 3/17 の 2 つ", async () => {
  const pdf = await parseVotePdf(bytes(FIX.r7_02));
  assert.deepEqual(
    { pages: pdf.pages, tables: pdf.tables, rows: pdf.rows.length, unknown: pdf.unknownCells },
    { pages: 8, tables: 8, rows: 72, unknown: 0 },
  );
  // **1 本の PDF に議決日が 2 つある**（「PDF に 1 つの議決日」と決め打ちしない）
  assert.deepEqual([...new Set(pdf.rows.map((r) => `${r.month}/${r.day}`))], ["3/7", "3/17"]);
  // **すべての行が 37 人**（**列幅が 15.00 / 14.76 で揺れる本。±0.35pt で切ると 36 列になる**）
  assert.deepEqual([...new Set(pdf.rowMembers.map((m) => m.length))], [37]);
  assert.equal(pdf.rowMembers[0][0].nameText, "石井秀夫", "1 列目は 石井秀夫（この列を落とすと表が 1 列ずれる）");
  assert.deepEqual([...new Set(pdf.rows.map((r) => r.section))], ["知事提出議案", "議員提出議案"]);
});

test("#768 令和7年4月臨時会: 凡例の 除 は 除席（除斥 ではない）。桃崎裕介（裕 U+88D5）が出る", async () => {
  const pdf = await parseVotePdf(bytes(FIX.r7_04));
  assert.equal(pdf.legend.votes["除"], "除席", "原文のまま。除斥 に丸めない");
  assert.equal(pdf.rows.length, 1);
  assert.equal(pdf.rows[0].cells.filter((c) => c === "除").length, 1);
  const momozaki = pdf.members.find((m) => m.nameText.startsWith("桃崎"))!;
  assert.equal(momozaki.nameText, "桃崎裕介");
  assert.equal(momozaki.nameText.codePointAt(2), 0x88d5, "裕 は U+88D5（名簿の 祐 U+7950 とは別の漢字）");
});

test("#768 令和5年5月臨時会: 凡例の 除 は 地方自治法第117条による除斥（除席 ではない）", async () => {
  const pdf = await parseVotePdf(bytes(FIX.r5_05));
  assert.equal(pdf.legend.votes["除"], "地方自治法第117条による除斥");
  assert.equal(pdf.rows.length, 2);
  assert.equal(pdf.rows.reduce((s, r) => s + r.cells.filter((c) => c === "除").length, 0), 1);
});

/**
 * **見出しの無い続きのページ**（令和4年9月定の 2 ページ目）。
 * **`M月D日採決` の見出しが 1 つも無く、氏名帯だけがある。**
 * **見出しの無いページを飛ばすと 9 行（333 票）が消える。**
 */
test("#768 令和4年9月定例会: 見出しの無い 2 ページ目の 9 行も、直前の表の議決日を引き継いで読む", async () => {
  const pdf = await parseVotePdf(bytes(FIX.r4_09));
  assert.equal(pdf.rows.length, 26);
  const p2 = pdf.rows.filter((r) => r.page === 2);
  assert.equal(p2.length, 9, "2 ページ目に 9 行");
  assert.deepEqual([...new Set(p2.map((r) => `${r.month}/${r.day}`))], ["9/22"], "直前の表から引き継いだ議決日");
  // **2 ページ目に `M月D日採決` のアイテムが 1 つも無いこと**（この対照が空回りしていないこと）
  const pages = await readPages(bytes(FIX.r4_09));
  const heads = pages[1].items.filter((it) => /月.+日採決/.test(it.str.replace(/[\s　]/g, "")));
  assert.deepEqual(heads.map((h) => h.str), [], "2 ページ目に議決日の見出しは無い");
});

/* ---------- 否定的対照（読めないのが正しい結果） ---------- */

test("#768 文字層の無い PDF は読まない（黙って 0 行にしない）", async () => {
  const pages = await readPages(bytes(FIX.noText));
  assert.equal(pages.reduce((s, p) => s + p.items.length, 0), 0, "文字アイテムが 1 つも無い本であること");
  await assert.rejects(() => parseVotePdf(bytes(FIX.noText)), /文字層が無い/);
});

test("#768 /Rotate 90 の PDF は読まない（平成27〜29年は表の作りも違う）", async () => {
  const pages = await readPages(bytes(FIX.rotated));
  assert.ok(pages.every((p) => p.rotate === 90), "全ページが rotate=90 であること");
  assert.ok(pages.reduce((s, p) => s + p.items.length, 0) > 0, "文字層はある（「読めない」理由が回転であること）");
  await assert.rejects(() => parseVotePdf(bytes(FIX.rotated)), /Rotate/);
});

/* ---------- 幾何（列・行・記号） ---------- */

/**
 * **議員の列は「右端から、幅が中央値の ±8% 以内で続くところまで」。**
 *
 * **`±0.35pt` のような絶対値では令和7年2月版が落ちる**——
 * **議員の列の 1 本目だけ 15.00pt、残りが 14.76〜14.88pt で、末尾との差が 0.42pt ある。**
 * **切れると列が 36 本になり、記号 37 個と合わず 72 行すべてが `不明` に落ちる。**
 */
test("#768 列: 集計欄は議員の列より広い。±8% で切ると議員の列だけが残る", async () => {
  for (const [name, expect] of [[FIX.r8_06, 37], [FIX.r7_02, 37], [FIX.r7_04, 37], [FIX.r4_09, 37]] as const) {
    const pages = await readPages(bytes(name));
    for (const pg of pages) {
      const cols = memberColumns(pg.vlines);
      if (cols.length === 0) continue; // 表紙
      assert.equal(cols.length - 1, expect, `${name}: 議員の列は ${expect} 本`);
    }
  }
  // **集計欄が議員の列より広いこと**（この規則が効く前提。空回りしていないことの確認）
  const pages = await readPages(bytes(FIX.r7_02));
  const pg = pages[1];
  const vx = cluster(pg.vlines.map((v) => v.x));
  const cols = memberColumns(pg.vlines);
  const gaps = vx.slice(1).map((v, k) => v - vx[k]);
  const memberGaps = gaps.slice(gaps.length - (cols.length - 1));
  const countGaps = gaps.slice(2, gaps.length - (cols.length - 1));
  assert.ok(countGaps.length >= 7, `集計欄が ${countGaps.length} 欄`);
  assert.ok(Math.min(...countGaps) > Math.max(...memberGaps), `集計欄 ${Math.min(...countGaps).toFixed(2)}pt > 議員 ${Math.max(...memberGaps).toFixed(2)}pt`);
  assert.ok(Math.max(...memberGaps) - Math.min(...memberGaps) > 0.35, "議員の列の幅は ±0.35pt に収まらない（絶対値では切れない）");
});

/**
 * **列見出し `議員名` の `議` が議員の帯の x の中にある**（全 16 本）。
 * **「記号が 1 個でもあれば行」とすると、氏名帯の上に幻の行ができ、
 * 氏名帯が「行の下」に落ちてその表の議員が 1 人も読めなくなる。**
 */
test("#768 行: 列見出し「議員名」の 議 を行にしない（列の数の半分以上を要求する）", async () => {
  const pages = await readPages(bytes(FIX.r8_06));
  const pg = pages[0];
  const cols = memberColumns(pg.vlines);
  const lo = cols[0], hi = cols[cols.length - 1];
  // **`議員名` の 3 文字が同じ y に、議員の帯の x の中に並んでいること**（この対照が空回りしていないこと）。
  // **`議` はふつうの票の記号でもある**ので、`員` の y で選ぶ（`員` は票の記号ではない）
  const in1 = pg.items.filter((it) => it.str.length === 1 && it.cx > lo && it.cx < hi);
  const headerY = in1.find((it) => it.str === "員")!.cy;
  const header = in1.filter((it) => Math.abs(it.cy - headerY) < 1);
  assert.deepEqual(header.map((h) => h.str), ["議", "員", "名"], "議員名 の 3 文字が帯の中に並ぶ");
  const bands = readRowBands(pg, cols);
  assert.equal(bands.length, 11, "1 ページ目の行は 11");
  assert.ok(bands.every((b) => Math.abs(b.y - headerY) > 1), "見出しの y は行になっていない");
  // 氏名帯は行の上にあり、37 人ぶん取れている
  assert.equal(bands[0].members?.length, 37);
  assert.equal(bands[0].members?.[0].nameText, "石井秀夫");
});

/** **`bottomRun`**: 列見出し `議員名` とページ番号を落とす（氏名の連なりだけを残す）。 */
test("#768 bottomRun: 氏名から離れて置かれた文字（議員名の見出し・ページ番号）を落とす", () => {
  const it = (str: string, cy: number): Item => ({ str, x: 100, y: cy - 5, w: 11, h: 11, cx: 105, cy });
  // 氏名 4 文字（12.2pt 間隔）＋ その 18.6pt 上に見出しの 1 文字
  const chars = [it("員", 704), it("石", 685), it("丸", 673), it("太", 661), it("郎", 649)];
  assert.deepEqual(bottomRun(chars).map((c) => c.str), ["郎", "太", "丸", "石"], "見出しの 員 は落ちる");
  // 離れた文字が無ければ全部残る
  assert.deepEqual(bottomRun(chars.slice(1)).map((c) => c.str), ["郎", "太", "丸", "石"]);
});

/** **`splitRowItem`**: 1 行 1 アイテム型の記号を、アイテムの幅を文字数で割って置く。 */
test("#768 splitRowItem: 複数記号のアイテムは幅を文字数で割って置く／1 文字なら cx をそのまま", () => {
  const row: Item = { str: "○ ○ 議", x: 100, y: 0, w: 30, h: 10, cx: 115, cy: 5 };
  assert.deepEqual(splitRowItem(row), [
    { ch: "○", x: 105 }, { ch: "○", x: 115 }, { ch: "議", x: 125 },
  ]);
  const one: Item = { str: "×", x: 200, y: 0, w: 10, h: 10, cx: 205, cy: 5 };
  assert.deepEqual(splitRowItem(one), [{ ch: "×", x: 205 }]);
});

/**
 * **`readVoteCells` は「k 番目の記号が k 番目の列に落ちる」ことを検算し、落ちなければ行ごと `不明`。**
 * **1 つでもずれていれば全部が別人の票になりうる**ので、部分的には出さない。
 */
test("#768 readVoteCells: k 番目が k 番目の列に落ちなければ行ごと 不明（部分的に出さない）", () => {
  const cols = [0, 10, 20, 30];
  const item = (ch: string, cx: number): Item => ({ str: ch, x: cx - 1, y: 0, w: 2, h: 10, cx, cy: 5 });
  assert.deepEqual(readVoteCells([item("○", 5), item("×", 15), item("議", 25)], cols, 3), ["○", "×", "議"]);
  // 記号の数が合わない → 行ごと 不明
  assert.deepEqual(readVoteCells([item("○", 5), item("×", 15)], cols, 3), [UNKNOWN_CELL, UNKNOWN_CELL, UNKNOWN_CELL]);
  // 2 個が同じ列に落ちる（1 列ずれている）→ 行ごと 不明
  assert.deepEqual(readVoteCells([item("○", 5), item("×", 15), item("議", 16)], cols, 3), [UNKNOWN_CELL, UNKNOWN_CELL, UNKNOWN_CELL]);
});

/** **`splitLeftItem`**: 2 つの欄にまたがるアイテムだけ空白で割る（件名の空白では割らない）。 */
test("#768 splitLeftItem: 欄をまたぐ 36 36 は割る／1 つの欄に収まるものは割らない", () => {
  const bounds = [0, 50, 100, 150];
  const spanning: Item = { str: "36 36", x: 60, y: 0, w: 80, h: 10, cx: 100, cy: 5 };
  const split = splitLeftItem(spanning, bounds);
  assert.deepEqual(split.map((s) => s.str), ["36", "36"]);
  assert.ok(split[0].cx < 100 && split[1].cx > 100, "2 つの欄に分かれて落ちる");
  const inside: Item = { str: "県有財産 の取得", x: 10, y: 0, w: 30, h: 10, cx: 25, cy: 5 };
  assert.deepEqual(splitLeftItem(inside, bounds).map((s) => s.str), ["県有財産 の取得"], "件名の空白では割らない");
});

/** **`36 36` が 1 アイテムに入る本で、賛成の欄が空にならないこと**（令和4年9月定。実測 20 行）。 */
test("#768 令和4年9月定例会: 議決者数と賛成が 1 アイテムの行でも、両方の欄が埋まる", async () => {
  const pdf = await parseVotePdf(bytes(FIX.r4_09));
  // **`36 36` の 1 アイテムが本文にあること**（対照が空回りしていないこと）
  const pages = await readPages(bytes(FIX.r4_09));
  const merged = pages.flatMap((p) => p.items).filter((it) => /^\d+ \d+$/.test(it.str.trim()));
  assert.ok(merged.length >= 20, `「36 36」の形のアイテムが ${merged.length} 個ある`);
  const empty = pdf.rows.filter((r) => r.counts.voting === "" || r.counts.yes === "");
  assert.deepEqual(empty.map((r) => r.number), [], "議決者数・賛成の欄が空の行は無い");
  // **記号の数と突き合わせる**（原文の数と抽出した記号が合う）。
  // **食い違った行を全部並べて比べる**（#826）——**`assert.equal` を行ごとに撃つと最初の 1 行で止まり、
  // 「1 行なのか 26 行なのか」が読めない**（実測: 3 行を食い違わせても、落ちたメッセージには 1 行しか出なかった）。
  assert.deepEqual(
    countMismatchRows(pdf.rows, { yes: "○", no: "×", cells: (r) => r.cells, label: (r) => r.number }),
    [], "○ の数 ＝ 賛成 / × の数 ＝ 反対",
  );
});

/* ---------- 表題・凡例 ---------- */

test("#768 表題が無ければ例外（どの会期の票か分からないものを出さない。#689 の罠 7）", async () => {
  const pages = await readPages(bytes(FIX.r8_06));
  assert.equal(parseHeading(pages).headingText, "令和８年６月定例会 議案採決結果一覧表");
  const stripped = pages.map((p) => ({ ...p, items: p.items.filter((it) => !/議案採決結果一覧表/.test(it.str)) }));
  assert.throws(() => parseHeading(stripped), /表題/);
});

test("#768 凡例: 同じ記号に 2 通りの意味があれば例外（黙って片方を採らない）", async () => {
  const pages = await readPages(bytes(FIX.r8_06));
  assert.deepEqual(parseLegend(pages).votes, { "○": "賛成", "×": "反対", "△": "退席", "欠": "欠席", "議": "議長" });
  const conflicting = pages.map((p, i) => (i === 0 ? { ...p, items: [...p.items, { ...p.items[0], str: "○：反対" }] } : p));
  assert.throws(() => parseLegend(conflicting), /凡例の ○ に 2 通りの意味がある/);
});

test("#768 凡例が 1 つも無ければ例外（抽出不能 にしない）", async () => {
  const pages = await readPages(bytes(FIX.r8_06));
  const stripped = pages.map((p) => ({ ...p, items: p.items.filter((it) => !/[：:]/.test(it.str)) }));
  assert.throws(() => parseLegend(stripped), /凡例/);
});

test("#768 legendOf: 凡例に無い記号は 抽出不能（推定しない）", () => {
  assert.equal(legendOf("○", { "○": "賛成" }), "賛成");
  assert.equal(legendOf("▲", { "○": "賛成" }), UNKNOWN_LEGEND);
  assert.equal(legendOf(UNKNOWN_CELL, { "○": "賛成" }), UNKNOWN_LEGEND);
});

/**
 * **`×` は U+00D7（乗算記号）**。`✕`(U+2715) でも `x` でもない（#765 が実測）。
 * **`VOTE_SYMBOLS` から外すと、反対票が記号として拾われず行の記号数が合わなくなる。**
 */
test("#768 記号: × は U+00D7。本文に出るのは 6 種だけ（フィクスチャ 5 本の実測）", async () => {
  assert.ok(isVoteSymbol("×"), "× U+00D7");
  const seen = new Map<string, number>();
  for (const name of [FIX.r8_06, FIX.r7_02, FIX.r7_04, FIX.r5_05, FIX.r4_09]) {
    const pdf = await parseVotePdf(bytes(name));
    for (const r of pdf.rows) for (const c of r.cells) seen.set(c, (seen.get(c) ?? 0) + 1);
  }
  assert.deepEqual(
    Object.fromEntries([...seen].sort((a, b) => b[1] - a[1])),
    { "○": 4208, "議": 122, "欠": 50, "×": 131, "△": 1, "除": 2 },
    "フィクスチャ 5 本の記号の内訳（実測 2026-09-13）",
  );
  assert.equal([...seen.keys()].find((c) => c === "✕"), undefined, "✕ U+2715 は出ない");
});

/**
 * **`議` は各行で 1 人、同じ PDF では同じ 1 人の列に立つ**（#529 の錨）。
 * **#765 はこの錨が佐賀では恒真であること（記号を 1 列回しても 16/16 で成り立つこと）を測っている。**
 * **だからこれは「順序が正しい」証明ではない**——**順序は `readVoteCells` の
 * 「k 番目が k 番目の列」と、罫線から作った列そのものが受け持つ。**
 */
test("#768 議: 各行で高々 1 人、同じ PDF では同じ 1 人（恒真な錨だが、値そのものは固定する）", async () => {
  const expect: Record<string, { chair: string; rowsWithChair: number; rows: number }> = {
    [FIX.r8_06]: { chair: "宮原真一", rowsWithChair: 21, rows: 21 },
    [FIX.r7_02]: { chair: "大場芳博", rowsWithChair: 72, rows: 72 },
    [FIX.r7_04]: { chair: "宮原真一", rowsWithChair: 1, rows: 1 },
    [FIX.r5_05]: { chair: "大場芳博", rowsWithChair: 2, rows: 2 },
    [FIX.r4_09]: { chair: "藤木卓一郎", rowsWithChair: 26, rows: 26 },
  };
  for (const [name, e] of Object.entries(expect)) {
    const pdf = await parseVotePdf(bytes(name));
    const chairs = new Set<string>();
    let withChair = 0;
    for (const [i, r] of pdf.rows.entries()) {
      const idx = r.cells.map((c, k) => (c === "議" ? k : -1)).filter((k) => k >= 0);
      assert.ok(idx.length <= 1, `${name}: 議 が 2 人以上の行がある`);
      if (idx.length === 1) { withChair++; chairs.add(pdf.rowMembers[i][idx[0]].nameText); }
    }
    assert.deepEqual([...chairs], [e.chair], `${name}: 議長は 1 人`);
    assert.equal(withChair, e.rowsWithChair, `${name}: 議 が立つ行`);
    assert.equal(pdf.rows.length, e.rows);
  }
});

/**
 * **「k 番目の記号が k 番目の議員のもの」を、この実装の作り方（罫線の列＋アイテムの幅の按分）で測る。**
 *
 * **#765 は別の作り方（グリフの進み幅）で 18,606 対を測った。** **#764 の教訓——
 * 測定の結論をそのまま引かない。** **この対照はこの実装の写像を直接見る。**
 *
 * **順序不変ではないことを、記号を 1 列回して確かめる**（回転なので母数が減らない）。
 */
test("#768 対応: 記号を 1 列回すと、フィクスチャ 5 本の全対がずれる（順序不変ではない）", async () => {
  let pairs = 0, off = 0;
  let rotPairs = 0, rotOff = 0;
  for (const name of [FIX.r8_06, FIX.r7_02, FIX.r7_04, FIX.r5_05, FIX.r4_09]) {
    const pages = await readPages(bytes(name));
    for (const pg of pages) {
      const cols = memberColumns(pg.vlines);
      if (cols.length === 0) continue;
      const n = cols.length - 1;
      for (const band of readRowBands(pg, cols)) {
        const placed = [...band.items].sort((a, b) => a.cx - b.cx).flatMap(splitRowItem).sort((a, b) => a.x - b.x);
        if (placed.length !== n) continue;
        for (let k = 0; k < n; k++) {
          pairs++;
          if (bandIndex([...cols], placed[k].x) !== k) off++;
          // **1 列回す**（端は巻き戻すので対の数は減らない）
          rotPairs++;
          if (bandIndex([...cols], placed[(k + 1) % n].x) !== k) rotOff++;
        }
      }
    }
  }
  assert.equal(pairs, 4514, "フィクスチャ 5 本の (記号, 議員) 対（実測 2026-09-13）");
  assert.equal(off, 0, "回さなければ 1 対もずれない");
  assert.equal(rotPairs, pairs, "回しても対の数は変わらない（母数が減っていない）");
  assert.equal(rotOff, pairs, "1 列回すと全対がずれる（この検算は順序不変ではない）");
});
