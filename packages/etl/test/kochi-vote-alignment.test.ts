import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseVotePdf, type VotePdf, type VotePdfRow } from "../src/sources/local/kochi/votes-pdf.ts";
import { parseChairs, chairOn, parseSince, type Chair } from "./kochi-chairman.ts";
import { parseHtmlResults } from "./kochi-html-results.ts";

/**
 * 高知県議会の賛否 PDF の **列（x）と 行（y）の対応**を、**PDF の外の一次資料**に結ぶ（Issue #876）。
 *
 * ## なぜこれが要るか
 *
 * **`kochi-votes-pdf.test.ts` は「PDF をこう読んだ」を固定しているが、
 * 「読んだ結果が正しい列・正しい行に載っているか」は見ていない。**
 * **列がずれれば別人の賛否になり、行がずれれば別の議案の賛否になる**——
 * **どちらも利用者からは検出できない虚偽である**（`docs/WORKING_AGREEMENT.md`）。
 *
 * ## **「半セル未満」は根拠にしない**（#891 で PO が訂正した）
 *
 * **「(記号, 議員) の対が半セル未満に収まっているか」は、列の割り当てを何も言っていない。**
 * **高知の一次資料で実測した**（`.measure/halfcell.ts`、2026-09-16）:
 *
 * | 本 | 記号 | 半セル未満 | **1 列ずらしても「半セル未満」相当** |
 * |---|---|---|---|
 * | 2026-06 | 934 | 98.07% | **99.25%** |
 * | 2026-02 | 3,084 | 99.06% | **99.64%** |
 * | 2024-02 | 3,629 | 99.26% | **99.67%** |
 * | 2020-02 | 3,170 | 99.12% | **99.72%** |
 *
 * **正しかろうが 1 列ずれていようが 98〜99% になる。だからこの指標は使わない。**
 * **列の割り当てを測れるのは回転だけである**（ずらしではない。ずらしは「空の列に落ちた」という
 * 安い理由で落ちるので、測ったことにならない）。
 *
 * ## 錨は 3 本。**互いの穴が違う**
 *
 * | 錨 | 見ているもの | 出どころ | x を捕まえるか | y を捕まえるか |
 * |---|---|---|---|---|
 * | **A 議長** | `議` の列の議員 == その議決日の議長 | **県の「議長・副議長」ページ**（PDF の外） | **○**（1 列回転で 91.7%） | **×（0 件）** |
 * | **B 除斥** | `除` の列の議員 == 件名の（○○議員） | **同じ行の件名**（PDF の中で完結） | **○（どの列回転でも 9/9）** | **母数が 0 になる**（下記） |
 * | **C 公表数** | `○`/`×` の数 == 賛成者数/反対者数 | 同じ行の欄 | **×（0 件）** | **○（1 行回転で 171 件）** |
 * | **D 件名・番号** | PDF の r 行目 == HTML の r 行目 | **県の会期詳細ページ**（PDF の外） | × | **○（番号は 100%）** |
 *
 * **きれいに外れている**——**A は y を 1 件も捕まえず、C と D は x を 1 件も捕まえない。**
 *
 * **錨B は y のとき「捕まえる」のではなく「母数が 0 になる」**（実測 `.measure/b-y.ts`）——
 * **記号帯を 1 行回すと `除` が別の行へ移り、その行の件名には（○○議員）が無いので判定できる行が 0 になる。**
 * **母数を検算に入れていなければ、ここは静かに緑のままだった**（#757）。
 * **だからテストは `judged` を必ず assert している。**
 * **どれか 1 本を外すと、その壊れ方は誰も見ていない状態になる**（下の「互いの代わりにならない」）。
 *
 * ## フィクスチャ
 *
 * - `080710.pdf` — 令和8年6月定例会の賛否 PDF（**2026-09-16 取得**。`/_files/00157346/080710.pdf`）。
 *   **`0806.pdf`（既存）とは別の本である**——**県が同じ会期の PDF を差し替え、新しい番号で置き直した。**
 *   **1 行だけ件名が違う**（`令和８年度高知県一般会計予算` → `令和８年度高知県一般会計補正予算`）。
 *   **本番の `data/` は新しいほう（補正予算）で出ている。**
 * - `chairman.html` — 県議会「議長・副議長」（`/chairman/`、35,104 バイト）。**歴代議長 105 代・歴代副議長 110 代。**
 * - `decision-2026-06.html` / `decision-2026-02.html` — 会期詳細ページの「議決結果一覧」（HTML の表）。
 */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/kochi/${name}`, import.meta.url));
const text = (name: string) => fixture(name).toString("utf-8");

const june8 = await parseVotePdf(fixture("080710.pdf"));
/** **令和7年12月定例会**（`0712.pdf`、2026-09-20 取得）。**#901 で読めるようになった本**（請願の枝番） */
const kochiDec7 = await parseVotePdf(fixture("0712.pdf"));
const chairmanHtml = text("chairman.html");
const gicho = parseChairs(chairmanHtml, "歴代議長");
const fukugicho = parseChairs(chairmanHtml, "歴代副議長");

const strip = (s: string) => s.replace(/[\s　]/g, "").normalize("NFKC");
const dayBefore = (d: string): string => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); };

/**
 * **測定用**の議決年月日の読み。**実装の `parseDateText` は `R<数字>.M.D` しか読まない**ので、
 * `H30.3.20`（平成）と `R元.10.10`（元年）を読めない——**それが 421 行 / 1,282 行（32.8%）に効く**
 * （下の「実装の欠陥」のテスト）。ここは**一次資料に何が書いてあるか**を測るために広げる。
 */
function measureDate(s: string): string | undefined {
  const m = s.normalize("NFKC").replace(/[\s　]/g, "").match(/^([HR])(元|\d+)\.(\d+)\.(\d+)$/);
  if (!m) return undefined;
  const y = (m[1] === "R" ? 2018 : 1988) + (m[2] === "元" ? 1 : Number(m[2]));
  return `${y}-${String(Number(m[3])).padStart(2, "0")}-${String(Number(m[4])).padStart(2, "0")}`;
}

/** 記号帯だけを `rot` 列ぶん**回す**（端から落ちた記号は反対の端に戻る。**ずらしではない**）。 */
const rotateCols = (cells: readonly string[], rot: number): string[] =>
  rot === 0 ? [...cells] : cells.map((_, i) => cells[(i - rot + cells.length * 1000) % cells.length]);

/* ============================ 錨 A: 議長（PDF の外の一次資料） ============================ */

/**
 * `議` の列の議員が、**県が公表しているその議決日の議長**か。
 *
 * **交代の当日は前任も許す**——**PDF は議決が交代の前か後かを書いていない。**
 * **これは錨を弱くする**（下で「弱さ」を数字で固定している）。
 */
function chairCheck(pdf: VotePdf, chairs: readonly Chair[], rot = 0): { judged: number; mismatch: number; handover: number } {
  const names = pdf.members.map((m) => m.nameText);
  let date: string | undefined;
  let judged = 0, mismatch = 0, handover = 0;
  for (const r of pdf.rows) {
    const d = measureDate(r.dateText);
    if (d) date = d;
    if (!date) continue;
    const idx = rotateCols(r.cells, rot).flatMap((c, i) => (c === "議" ? [i] : []));
    if (idx.length !== 1) continue;
    const cur = chairOn(chairs, date);
    if (!cur) continue;
    judged++;
    const prev = chairOn(chairs, dayBefore(date));
    const isHandover = parseSince(cur.since) === date && prev !== undefined && strip(prev.name) !== strip(cur.name);
    if (isHandover) handover++;
    const got = strip(names[idx[0]]);
    if (got !== strip(cur.name) && !(isHandover && got === strip(prev!.name))) mismatch++;
  }
  return { judged, mismatch, handover };
}

test("#876 錨A: `議` の列の議員が、県が公表しているその議決日の議長と一致する（23 / 23 行）", () => {
  // **母数を先に書く**（#757。母数を書かない「全部一致」は意味が無い）
  assert.equal(june8.rows.length, 23, "この本の行");
  const base = chairCheck(june8, gicho);
  assert.equal(base.judged, 23, "**判定できた行**（`議` がちょうど 1 つ立つ行）");
  assert.equal(base.mismatch, 0, "県公表の議長と食い違った行");
  // **この本は交代日ではない**（2026-07-10 の議決、明神健夫は 2026-03-24 就任）
  assert.equal(base.handover, 0, "交代当日の行");
  const chair = chairOn(gicho, "2026-07-10");
  assert.equal(strip(chair!.name), "明神健夫");
  assert.equal(chair!.dai, 105);
  assert.equal(parseSince(chair!.since), "2026-03-24");
  // **この本だけでは `chairOn` が日付を見ていることを示せない**——
  // **2026-07-10 の議長は「最新の議長」でもあるので、`chairOn` を「常に最新の議長」に壊しても
  //   このテストは緑のままになる**（実測: 変異 13 でこのテストは落ちなかった）。
  // **日付を見ていることを示すのは、下の 2026-02 の本と、過去の日付である。**
  assert.equal(strip(chairOn(gicho, "2019-06-01")!.name), "桑名龍吾", "**過去の日付では別人になる**");
  assert.equal(strip(chairOn(gicho, "2014-03-19")!.name), "浜田英宏");
});

test("#876 錨A: 記号帯を 1 列 回すと 23 / 23 行が落ちる（ずらしではなく回転）", () => {
  for (const rot of [1, 2, -1, -2, 7, 17]) {
    const r = chairCheck(june8, gicho, rot);
    assert.equal(r.judged, 23, `${rot} 列回転: 母数が減っていないこと（減ったら検算が空回りしている）`);
    assert.equal(r.mismatch, 23, `${rot} 列回転で落ちた行`);
  }
});

test("#876 錨A: 錨を「歴代副議長」に取り違えると 23 / 23 行が落ちる（同じページに 2 つの表がある）", () => {
  // **同じページの左右に 議長 と 副議長 の表が並んでおり、代の番号も氏名も違う。**
  // **取り違えると錨そのものが嘘になるので、見出しで表を選んでいる**（位置で決め打ちにしない）。
  assert.equal(gicho.length, 105, "歴代議長");
  assert.equal(fukugicho.length, 110, "歴代副議長");
  assert.notEqual(strip(gicho[gicho.length - 1].name), strip(fukugicho[fukugicho.length - 1].name));
  const wrong = chairCheck(june8, fukugicho);
  assert.equal(wrong.judged, 23, "母数");
  assert.equal(wrong.mismatch, 23, "副議長の表を錨にすると全行落ちる");
});

test("#876 錨A の弱さ: 交代の当日は前任も許すので、錨がその日は緩む（**確かめていないことを書く**）", () => {
  // **2026-03-24 は 明神健夫（105 代）の就任日であり、その日の 81 件の議決で PDF は 三石文隆 を `議` にしている。**
  // **どちらが正しいかは PDF にも県の公表にも書かれていない**（議決が交代の前か後か）。**推定しない。**
  const cur = chairOn(gicho, "2026-03-24")!;
  const prev = chairOn(gicho, dayBefore("2026-03-24"))!;
  assert.equal(strip(cur.name), "明神健夫");
  assert.equal(strip(prev.name), "三石文隆");
  assert.equal(parseSince(cur.since), "2026-03-24", "就任日が議決日と同じ");
  // **全数測定（読めた 31 本・1,282 行）では 609 行（47.5%）が交代当日だった**（`.measure/x-anchor2.ts`）。
  // **その 609 行では錨が「2 人のどちらか」しか言えない。**
  // **さらに 2018-03-20 では前任 浜田英宏(列19) と後任 土森正典(列20) が隣の列で、
  //   1 列回転しても片方からもう片方に移るだけなので落ちない**（107 行）。
  // **だから 1 列回転で落ちるのは 1,175 / 1,282（91.7%）であって 100% ではない。**
  // **この穴は 錨B（除斥）が塞ぐ**（下）——**錨B はどの回転でも 9 / 9 落ちる。**
  assert.ok(true, "ここは数字を記録するためのテストで、主張はしていない");
});

/* ============================ 錨 B: 除斥（PDF の中で完結する） ============================ */

/**
 * `除`（除斥）の列の議員が、**同じ行の件名に書かれた（○○議員）**と一致する。
 * **監査委員に選任される議員は、その議案の議決から除斥される。**
 * **外の表を要らない**ので、錨A の「交代当日」の穴を持たない。
 */
const NAMED_IN_TITLE = /[（(]([^（）()]+?)議員[）)]/;
function josekiCheck(pdf: VotePdf, rot = 0): { judged: number; mismatch: number } {
  const names = pdf.members.map((m) => m.nameText);
  let judged = 0, mismatch = 0;
  for (const r of pdf.rows) {
    const idx = rotateCols(r.cells, rot).flatMap((c, i) => (c === "除" ? [i] : []));
    if (idx.length !== 1) continue;
    const m = strip(r.title).match(NAMED_IN_TITLE);
    if (!m) continue;
    judged++;
    if (!strip(names[idx[0]]).startsWith(m[1])) mismatch++;
  }
  return { judged, mismatch };
}

test("#876 錨B: この本には `除` が 0 セルなので、**母数 0 では x を測れない**（全数では 9 / 9）", () => {
  // **母数が 0 なのに「一致した」と書かないために、0 であることを固定する**（#757）。
  assert.equal(june8.rows.flatMap((r) => r.cells).filter((c) => c === "除").length, 0, "この本の `除`");
  const base = josekiCheck(june8);
  assert.equal(base.judged, 0, "**判定できた行が 0**——この本では錨B は何も言っていない");
  assert.equal(base.mismatch, 0);
  // **全数測定では 9 本に 1 セルずつ、計 9 行**（`.measure/x-jo.ts`、2026-09-16）。
  // **9 行とも、件名の（○○議員）の姓と除斥の列の議員の姓が一致した。**
  // **1/2/-1/-2/7/17 列のどの回転でも 9 / 9 が落ちる**（錨A と違って交代日の穴が無い）。
});

/* ============================ 錨 C: 公表数（y を捕まえる。x は捕まえない） ============================ */

/** `○`/`×` の数 == 賛成者数/反対者数。**x の回転は置換なので数が変わらない**（下で実測）。 */
function countsCheck(rows: readonly VotePdfRow[], rotX = 0, rotY = 0): { judged: number; mismatch: number; noCounts: number } {
  let judged = 0, mismatch = 0, noCounts = 0;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!row.counts) { noCounts++; continue; }
    const src = rows[(r - rotY + rows.length * 1000) % rows.length];
    const cells = rotateCols(src.cells, rotX);
    judged++;
    if (cells.filter((c) => c === "○").length !== row.counts.yes || cells.filter((c) => c === "×").length !== row.counts.no) mismatch++;
  }
  return { judged, mismatch, noCounts };
}

test("#876 錨C: 公表数（賛成者数・反対者数）が記号の数と 23 / 23 行で一致する", () => {
  const base = countsCheck(june8.rows);
  assert.equal(base.judged, 23, "**母数**（`counts` のある行）");
  assert.equal(base.noCounts, 0, "`counts` の無い行");
  assert.equal(base.mismatch, 0);
});

test("#876 錨C は **x を 1 件も捕まえない**（記号帯を回しても `○` と `×` の個数は変わらない）", () => {
  for (const rot of [1, 2, -1, 7, 17]) {
    const r = countsCheck(june8.rows, rot, 0);
    assert.equal(r.judged, 23, "母数");
    assert.equal(r.mismatch, 0, `${rot} 列回転（x）で落ちた行 —— **0 件が正しい**。x は錨A/B の仕事`);
  }
});

test("#876 錨C は **y を捕まえる**（記号帯だけを 1 行回すと落ちる）", () => {
  for (const rot of [1, -1, 2]) {
    const r = countsCheck(june8.rows, 0, rot);
    assert.equal(r.judged, 23, "母数");
    assert.ok(r.mismatch > 0, `${rot} 行回転（y）で落ちた行: ${r.mismatch}`);
  }
  // **この本では 1 行回転で 6 / 23 しか落ちない**——**全会一致の行が続くと、回しても数が変わらない。**
  // **だから錨C だけでは y は足りない**（錨D が 23 / 23 落とす）。
  assert.equal(countsCheck(june8.rows, 0, 1).mismatch, 6, "1 行回転で落ちた行（**弱い**）");
});

/* ============================ 錨 D: 会期詳細ページの HTML（y を捕まえる） ============================ */

/**
 * **PDF の r 行目 == HTML の r 行目**（**並び順で突き合わせる**。番号を鍵にして引き当てない）。
 * **番号を鍵にすると「行の並び」ではなく「番号の対応」を見ることになり、行の入れ替わりを捕まえられない。**
 */
const htmlJune8 = parseHtmlResults(text("decision-2026-06.html"));
/** HTML 側だけに付く「[PDF：78.3KB]」を落とす（**PDF 本文には無い**。突き合わせのためだけ）。 */
const stripTitle = (s: string) => strip(s).replace(/\[PDF[:：][^\]]*\]/g, "");

function htmlCheck(pdf: VotePdf, html: ReturnType<typeof parseHtmlResults>, rot = 0): { judged: number; titleBad: number; numberBad: number } {
  let judged = 0, titleBad = 0, numberBad = 0;
  const n = pdf.rows.length;
  for (let i = 0; i < n; i++) {
    const p = pdf.rows[(i - rot + n * 1000) % n];
    const q = html[i];
    judged++;
    if (stripTitle(p.title) !== stripTitle(q.title)) titleBad++;
    if (strip(p.number) !== strip(q.number)) numberBad++;
  }
  return { judged, titleBad, numberBad };
}

test("#876 錨D: PDF の 23 行が、県の HTML「議決結果一覧」の 23 行と並び順で対応する", () => {
  assert.equal(htmlJune8.length, 23, "HTML の行");
  assert.equal(june8.rows.length, 23, "PDF の行");
  const base = htmlCheck(june8, htmlJune8);
  assert.equal(base.judged, 23, "母数");
  assert.equal(base.numberBad, 0, "番号が食い違った行");
  // **件名は 1 行だけ食い違う**——**県の 2 つの一次資料が違うことを書いている**（実装の誤りではない）。
  // **PDF「令和８年度高知県一般会計補正予算」／ HTML は同じ件名に
  //   「（議発第２号「…に対する修正案」を否決）」を足している。** **どちらが正しいかは決めない。**
  assert.equal(base.titleBad, 1, "件名が食い違った行");
  assert.ok(stripTitle(htmlJune8[0].title).includes("修正案"), "HTML 側にだけ修正案の注記がある");
  assert.ok(!stripTitle(june8.rows[0].title).includes("修正案"), "PDF 側には無い");
});

test("#876 錨D: PDF の行を 1 行 回すと番号が 23 / 23 落ちる（**y の検算としていちばん強い**）", () => {
  for (const rot of [1, -1, 2]) {
    const r = htmlCheck(june8, htmlJune8, rot);
    assert.equal(r.judged, 23, "母数");
    assert.equal(r.numberBad, 23, `${rot} 行回転で番号が落ちた行`);
    assert.ok(r.titleBad >= 22, `${rot} 行回転で件名が落ちた行: ${r.titleBad}`);
  }
});

test("#876 錨D は **x を 1 件も捕まえない**（件名も番号も記号帯を見ていない）", () => {
  // **列を回しても件名・番号は動かない**——**錨D は y だけの仕事である。**
  const rotated: VotePdf = { ...june8, rows: june8.rows.map((r) => ({ ...r, cells: rotateCols(r.cells, 1) })) };
  const r = htmlCheck(rotated, htmlJune8);
  assert.deepEqual(r, htmlCheck(june8, htmlJune8), "記号帯を回しても錨D の結果は 1 つも変わらない");
});

/* ============================ 互いの代わりにならない（#773 / #774） ============================ */

test("#876 4 本の錨は互いの代わりにならない —— x を捕まえるのは A/B、y を捕まえるのは C/D", () => {
  // **x（1 列回転）**
  const xChair = chairCheck(june8, gicho, 1);
  const xCounts = countsCheck(june8.rows, 1, 0);
  const xHtml = htmlCheck({ ...june8, rows: june8.rows.map((r) => ({ ...r, cells: rotateCols(r.cells, 1) })) }, htmlJune8);
  assert.equal(xChair.mismatch, 23, "錨A は x を捕まえる");
  assert.equal(xCounts.mismatch, 0, "**錨C は x を 1 件も捕まえない**");
  assert.equal(xHtml.numberBad + xHtml.titleBad, 1, "**錨D は x を捕まえない**（無改造と同じ 1 件のまま）");
  // **y（1 行回転）**
  const yRows = june8.rows.map((r, i) => ({ ...r, cells: june8.rows[(i - 1 + june8.rows.length) % june8.rows.length].cells }));
  const yChair = chairCheck({ ...june8, rows: yRows }, gicho);
  const yCounts = countsCheck(june8.rows, 0, 1);
  const yHtml = htmlCheck(june8, htmlJune8, 1);
  assert.equal(yChair.mismatch, 0, "**錨A は y を 1 件も捕まえない**（議長は毎行同じ人なので回しても動かない）");
  assert.equal(yCounts.mismatch, 6, "錨C は y を捕まえる");
  assert.equal(yHtml.numberBad, 23, "錨D は y を捕まえる");
});

/* ============================ 凡例にあるが出ない記号 ============================ */

test("#876 凡例は 7 種類あるが、この本に出るのは 3 種類だけ（**凡例にあることは、出ることを意味しない**）", () => {
  assert.deepEqual(Object.keys(june8.legend.votes), ["○", "×", "議", "副", "欠", "除", "－"]);
  const tally = new Map<string, number>();
  for (const r of june8.rows) for (const c of r.cells) tally.set(c, (tally.get(c) ?? 0) + 1);
  assert.equal([...tally.values()].reduce((a, b) => a + b, 0), 23 * 36, "**母数 828 セル**");
  assert.deepEqual(Object.fromEntries([...tally].sort()), { "×": 122, "○": 683, "議": 23 });
  // **全数測定（読めた 31 本・46,860 セル）でも `副` は 1 度も出ない**（`.measure/`、2026-09-16）:
  //   ○ 43,762 ／ × 1,634 ／ 議 1,282 ／ 欠 172 ／ 除 9 ／ － 1 ／ **副 0**
  for (const absent of ["副", "欠", "除", "－"]) assert.equal(tally.get(absent), undefined, `${absent} はこの本に出ない`);
});

/* ============================ 令和8年2月定例会（`除` と 交代当日 がある本） ============================ */

/**
 * **`0802.pdf`**（令和8年2月定例会。`/_files/00150866/0802.pdf`、2026-09-16 取得）。
 * **この本には 錨B（除斥）が 1 セルあり、議決日が議長交代の当日である**——
 * **フィクスチャ `080710.pdf` に無い形を両方とも持っている。**
 */
const feb = await parseVotePdf(fixture("0802.pdf"));
const htmlFeb = parseHtmlResults(text("decision-2026-02.html"));

test("#876 錨B（除斥）: `除` の列の議員が、同じ行の件名の（下村議員）と一致する（1 / 1 行）", () => {
  const joseki = feb.rows.flatMap((r, i) => r.cells.flatMap((c, j) => (c === "除" ? [{ i, j, row: r }] : [])));
  assert.equal(joseki.length, 1, "**母数**（この本の `除` のセル）");
  assert.equal(feb.members[joseki[0].j].nameText, "下村勝幸");
  assert.equal(joseki[0].row.number, "第75号");
  assert.ok(strip(joseki[0].row.title).includes("（下村議員）".replace(/[（）]/g, (c) => c)) || /下村議員/.test(strip(joseki[0].row.title)), `件名: ${joseki[0].row.title}`);
  const base = josekiCheck(feb);
  assert.equal(base.judged, 1, "判定できた行");
  assert.equal(base.mismatch, 0);
});

test("#876 錨B: **どの列回転でも 1 / 1 落ちる** —— 錨A の「交代当日」の穴を塞ぐ", () => {
  // **錨A はこの本では 81 行すべてが交代当日で、前任も後任も許してしまう**（下）。
  // **錨B は件名と同じ行の中で完結するので、交代とは無関係に落ちる。**
  for (const rot of [1, 2, -1, -2, 7, 17]) {
    const r = josekiCheck(feb, rot);
    assert.equal(r.judged, 1, `${rot} 列回転: 母数`);
    assert.equal(r.mismatch, 1, `${rot} 列回転で落ちた行`);
  }
});

test("#876 錨A の穴を数字で固定する: この本の 81 行は **全部が議長交代の当日**（2026-03-24）", () => {
  const base = chairCheck(feb, gicho);
  assert.equal(feb.rows.length, 81, "この本の行");
  assert.equal(base.judged, 81, "判定できた行");
  assert.equal(base.mismatch, 0, "食い違った行");
  assert.equal(base.handover, 81, "**交代当日の行 —— 81 行すべて**");
  // **前任も許さないと 81 / 81 が落ちる**——**PDF は 三石文隆、県の公表は 明神健夫（当日就任）。**
  // **どちらが正しいかは PDF にも県の公表にも書かれていない。推定しない。**
  const names = feb.members.map((m) => m.nameText);
  const gi = feb.rows[0].cells.flatMap((c, i) => (c === "議" ? [i] : []));
  assert.equal(gi.length, 1);
  assert.equal(strip(names[gi[0]]), "三石文隆", "PDF の `議`");
  assert.equal(strip(chairOn(gicho, "2026-03-24")!.name), "明神健夫", "県の公表（当日就任）");
  assert.equal(strip(chairOn(gicho, dayBefore("2026-03-24"))!.name), "三石文隆", "前日の議長");
  // **ここが錨A のいちばん重い穴である**——
  // **前任 三石文隆 は列 19、後任 明神健夫 は列 18 で、隣り合っている。**
  // **だから `-1` 列 回転すると `議` が 三石文隆 から 明神健夫 に移るだけで、
  //   「交代当日はどちらも許す」ので錨A は 81 行すべて緑のままになる。**
  // **1 列ずれた表を、錨A は「正しい」と言う。**
  assert.equal(strip(names[18]), "明神健夫", "列 18");
  assert.equal(strip(names[19]), "三石文隆", "列 19（隣）");
  assert.equal(chairCheck(feb, gicho, -1).mismatch, 0, "**-1 列回転で 0 / 81 —— 錨A はこのずれを捕まえない**");
  // **ほかの回転では落ちる**（隣が「許される 2 人」でなくなるから）
  for (const rot of [1, 2, -2, 7]) assert.equal(chairCheck(feb, gicho, rot).mismatch, 81, `${rot} 列回転`);
  // **この穴を塞いでいるのが錨B（除斥）である**——**上のテストで -1 列回転でも 1 / 1 落ちている。**
  assert.equal(josekiCheck(feb, -1).mismatch, 1, "**錨B は -1 列回転を捕まえる**");
});

test("#876 錨D（HTML）: 81 行が並び順で対応し、**県の 2 つの一次資料が 3 か所で食い違う**", () => {
  assert.equal(htmlFeb.length, 81, "HTML の行");
  assert.equal(feb.rows.length, 81, "PDF の行");
  const base = htmlCheck(feb, htmlFeb);
  assert.equal(base.judged, 81, "母数");
  assert.equal(base.numberBad, 0, "番号が食い違った行");
  // **件名の食い違いは 3 行**（下の 3 つ）。**どちらが正しいかは決めない**（推定しない）。
  assert.equal(base.titleBad, 3, "件名が食い違った行");
  // 1. **県の HTML に `算` が 1 文字多い**（`…特別会計予算算`）
  assert.ok(stripTitle(htmlFeb[18].title).endsWith("予算算"), `HTML: ${htmlFeb[18].title}`);
  assert.ok(stripTitle(feb.rows[18].title).endsWith("予算"), `PDF: ${feb.rows[18].title}`);
  // 2/3. **PDF は監査委員の氏名を（○○議員）で添えるが、HTML は添えない**
  //    **同じ会期に同じ件名が 2 行あり、PDF 側だけが区別している**（#72 と #74）
  // **PDF は 2 行とも氏名を添えるが、片方は `（奥村氏）`（議員ではない外部の委員）、
  //   もう片方は `（下村議員）`（議員）である**——**だから錨B（除斥）の母数は 2 ではなく 1。**
  assert.match(feb.rows[72].title, /（奥村氏）/, `PDF 72: ${feb.rows[72].title}`);
  assert.match(feb.rows[74].title, /（下村議員）/, `PDF 74: ${feb.rows[74].title}`);
  for (const i of [72, 74]) assert.ok(!/[（(][^（）()]*[氏員][）)]/.test(htmlFeb[i].title), `HTML ${i}: ${htmlFeb[i].title}`);
  // **`除` が立つのは議員の行だけ**（外部の委員は議員ではないので除斥されない）
  assert.equal(feb.rows[72].cells.filter((c) => c === "除").length, 0, "奥村氏の行に `除` は無い");
  assert.equal(feb.rows[74].cells.filter((c) => c === "除").length, 1, "下村議員の行に `除` が 1 つ");
  assert.equal(stripTitle(htmlFeb[72].title), stripTitle(htmlFeb[74].title), "**HTML では 2 行が同じ件名**");
  assert.notEqual(stripTitle(feb.rows[72].title), stripTitle(feb.rows[74].title), "**PDF では区別されている**");
  // **番号が違うので採決 id は衝突しない**（実測: 読めた 31 本・1,282 行で id の重複 0）
  assert.notEqual(feb.rows[72].number, feb.rows[74].number);
});

test("#876 錨D: 81 行を 1 行 回すと番号が 81 / 81 落ちる", () => {
  for (const rot of [1, -1, 2]) {
    const r = htmlCheck(feb, htmlFeb, rot);
    assert.equal(r.judged, 81, "母数");
    assert.equal(r.numberBad, 81, `${rot} 行回転`);
  }
});

/* ============================ 実装の欠陥（**直すのはこの PBI の範囲外**） ============================ */

/**
 * **以下は高知の `votes-pdf.ts` / `rollcalls.ts` の欠陥である。**
 * **ここでは「そうなっている」を固定するだけで、直さない**（測定であって実装ではない。Issue #876）。
 * **`data/` も 1 行も変えていない。**
 */

test("#876 欠陥①: `parseDateText` が `H30.3.20`（平成）と `R元.10.10`（元年）を読めない", async () => {
  const { parseDateText } = await import("../src/sources/local/kochi/rollcalls.ts");
  assert.equal(parseDateText("R8.7.10"), "2026-07-10", "令和の数字は読める");
  assert.equal(parseDateText("H30.3.20"), undefined, "**平成が読めない**");
  assert.equal(parseDateText("R元.10.10"), undefined, "**元年が読めない**");
  // **`toLocalRollCalls` は読めない日付を例外にする**ので、**その本は 1 行も出力されない。**
  // **全数測定（読めた 31 本・1,282 行）で、この 2 つの形が最初の行に来る本は 12 本・421 行（32.8%）**
  //   （`H` が 40 行・`R元` が 9 行。残りは `〃` が継ぐ先を失う）。
  // **本番（`--sessions 2`）は 2026 年の 2 会期しか読まないので、いま出ているデータには影響していない。**
  assert.equal(measureDate("H30.3.20"), "2018-03-20", "測定用の読みでは読める");
  assert.equal(measureDate("R元.10.10"), "2019-10-10");
});

test("#876 欠陥②（**#901 で直した**）: 番号の正規表現が `請第1-1号`（請願の枝番）を弾いていた", () => {
  // **#876 が測ったときの形**（**この行は歴史の記録であって、いまの実装ではない**）
  const BEFORE = /^(.*?第[0-9]+号)(.*)$/;
  assert.equal(BEFORE.test("請第1-1号"), false, "**直す前は枝番があると通らなかった**");
  // **全数測定: 65 本のうち 9 本がこれで落ちていた**（2015-12 / 2016-12 / 2017-12 / 2019-12 /
  //   2021-12 / 2022-12 / 2023-12 / 2024-12 / 2025-12）。
  // **12月定例会は請願を議決するので、15 ある 12月定例会は 15 本とも読めなかった**
  //   （9 本がこの欠陥、3 本が `setDash`、3 本が text matrix）。
  //
  // **#901 で `第[0-9]+(?:-[0-9]+)?号` に枝を足した**——**実装そのものを呼んで確かめる**
  // （**上の `BEFORE` のような写しを assert すると「写しが写しと一致する」しか言えない**）。
  const dec7 = kochiDec7;
  assert.deepEqual(dec7.rows.filter((r) => r.kind === "請願").map((r) => r.number), ["請第1-1号", "請第1-2号", "請第2-1号", "請第2-2号"]);
  assert.equal(dec7.rows.length, 75, "**この本が丸ごと読めるようになった**");
  // **残る 6 本の 12月定例会は別の理由で落ちる**（`setDash` 2 / text matrix 4。**#901 でも直っていない**）
});

test("#876 欠陥③: `setDash [[],0]`（＝実線に戻すだけ）で本が丸ごと落ちる", () => {
  // **`glyphs.ts` の HARMLESS_OPS は allowlist で、知らない演算子はすべて例外にする**（#717 の設計）。
  // **`setDash` は線の体裁で、文字の座標にも可読性にも効かない**——`setFillRGBColor` などと同じ種類である。
  // **実測: 3 本（2018-12 / 2019-02 / 2020-12）で、それぞれ 1 ページに 2 回だけ、引数は `[[], 0]`。**
  // **`[[], 0]` は「破線を解除して実線に戻す」という no-op である。**
  // **allowlist の設計自体は正しい**（#717 の理由は今も生きている）——**足りていないのは表の中身。**
  assert.ok(true, "数字を記録するためのテスト（実装は変えない）");
});

test("#876 欠陥④: `-` U+002D が凡例の `－` U+FF0D に寄らない —— 2 本が落ちる", async () => {
  const { legendKey } = await import("../src/sources/local/glyph-variants.ts");
  assert.equal(legendKey("〇"), "○", "既にある寄せ");
  assert.equal(legendKey("✕"), "×");
  assert.equal(legendKey("-"), "-", "**`-` U+002D は寄らない**");
  assert.equal("－".codePointAt(0), 0xff0d, "凡例の `－`");
  assert.equal("-".codePointAt(0), 0x2d);
  assert.ok(!("-" in june8.legend.votes), "凡例に `-` U+002D は無い");
  assert.ok("－" in june8.legend.votes, "凡例にあるのは `－` U+FF0D");
  // **実測: 2016-02 と 2015-06 の 2 本が `cell value "-" is not in the legend` で落ちる。**
  // **これは「記録が出ない」側の失敗であって「別人の記録が出る」ではない**——
  // **`glyph-variants.ts` の設計どおり、寄せた先が凡例に無ければ例外になる**（#674 / #569）。
  // **寄せてよいかは「同じ字形の別コードポイントか」で決まる。ここでは決めない**（実装は別 PBI）。
});

test("#876 欠陥⑤: 会派名が 2 列に折り返すと順序が入れ替わる（**県の HTML と食い違う**）", () => {
  // **`joinVerticalColumns` は「いちばん字数の多い列を主列として先に読む」**。
  // **会派見出しが 2 列に折り返すと、主列が右の列になり、左の列が後ろに付く。**
  // **実測（`.measure/probe-group.ts`）:**
  //   2016-06: x=650 に「くろしおの会」(6 字)・x=645 に「新風・」(3 字) → **`くろしおの会新風・`**
  //   2015-09: x=651 に「無所属の会」(5 字)・x=647 に「くろしお」(4 字) → **`無所属の会くろしお`**
  // **県の会期詳細ページ（別の一次資料）はこの会派を `新風・くろしおの会` / `くろしお無所属の会` と書いている。**
  // **つまり PDF の読みは 2 つとも順序が逆で、県の表記と一致しない。**
  // **本番（2026 年の 2 会期）には出ない会派なので、いまのデータには影響していない**
  //   （本番の 6 会派: 自由民主党・一燈立志の会・公明党・自由の風・県民の会・日本共産党）。
  const groups = new Set(june8.members.map((m) => m.group));
  assert.deepEqual([...groups].sort(), ["一燈立志の会", "公明党", "日本共産党", "県民の会", "自由の風", "自由民主党"]);
  assert.ok(![...groups].some((g) => /くろしお/.test(g)), "この本には折り返す会派が無い");
});

test("#876 欠陥⑥: 議案種別の結合セルが、ページをまたぐと印刷されている字だけになる", () => {
  // **PDF が実際に `議員提出`（4 字）や `知事`（2 字）としか印刷していないページがある**
  //   （実測: 2025-09 の 2 ページ目は種別の列が `議員提出`、2024-06 の 2 ページ目は `知事`）。
  // **これは読み違いではなく、一次資料がそう印刷している**（`.measure/probe-kind2.ts` で座標から確認した）。
  // **`kind` は採決 id に入る**ので、`pref-39-2025-09-…-議員提出-議発第4号` のようになる。
  // **id の重複は起きていない**（読めた 31 本・1,282 行でユニーク 1,282）。
  const kinds = new Set(june8.rows.map((r) => r.kind));
  assert.deepEqual([...kinds].sort(), ["知事提出議案", "議員提出議案"], "この本は 2 ページとも完全な形");
});
