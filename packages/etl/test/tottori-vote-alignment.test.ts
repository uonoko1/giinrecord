import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "node-html-parser";
import { parseVotePdf, type VotePdf, type VotePdfRow } from "../src/sources/local/tottori/votes-pdf.ts";
import { cleanText } from "../src/sources/local/tottori/site.ts";

/**
 * 鳥取県議会の表決 PDF の **セルの対応づけ**（#873 の測定）。
 *
 * **既存の `tottori-votes-pdf.test.ts` は氏名と記号を逐語で固定している**（フィクスチャが変われば落ちる）。
 * **ここが足すのは「県が別に公表している一次資料に結ぶ」ことである**——
 * **県の表記が変われば落ち、逐語の固定では気づけない食い違いを見る。**
 *
 * **x 方向（どの列がどの議員か）の錨: `議` の列の議員 == 県公表「歴代正副議長」の、その議決日の議長。**
 *   一次資料: https://www.pref.tottori.lg.jp/76208.htm （2026-09-16 取得、HTTP 200、75,924 バイト）
 *   **同じページに議長（89 代）と副議長（83 代）の 2 つの表が並んでおり、代の番号も氏名も違う。**
 *   **`福田 俊史` は 議長 89 代（令和7.6.9）でもあり 副議長 80 代（令和元.5.10）でもある**——
 *   **取り違えると錨そのものが嘘になるので、議長の表だけを使う**（副議長の表を使うと落ちることも下で固定する）。
 *
 * **x を「半セル未満」で測らない**（#871 / PO が実測）。**1 列ずらしても 98% が「半セル未満」になる**ので、
 * あの指標は「記号が何かの列の中心の近くに在る」しか言っていない。**列の割り当てを測れるのは回転だけである。**
 *
 * **公表数（賛成者数・反対者数）も x の検算に使わない**——**記号帯を回しても `○` と `×` の個数は変わらない**
 * （三重 0/378・宮城 1/327・**鳥取は下で 0/306 と実測**）。**公表数は「数が合うか」だけの検算として別に置く。**
 *
 * **y 方向（どの行がどの議案か）の錨: PDF の (種別, 番号) → 件名・議決結果 が、
 * 県の HTML「議案等の議決結果」ページの同じ番号の行と一致すること。** **PDF とは別の一次資料である。**
 */

const fixture = (name: string) => new URL(`./fixtures/tottori/${name}`, import.meta.url);
const bytes = (name: string) => readFileSync(fixture(name));

const june = await parseVotePdf(bytes("R8.6giketsukekka0629.pdf"));
const juneSeigan = await parseVotePdf(bytes("R8.6.29_seiganchinjogiketsukekka.pdf"));
const juneGiin = await parseVotePdf(bytes("R8.6.29_giinteishutsugian_giketsukekka.pdf"));
const febSengi = await parseVotePdf(bytes("R0802sengikekka.pdf"));
const feb = await parseVotePdf(bytes("R8.2giketsukekka0325.pdf"));
const books: VotePdf[] = [june, juneSeigan, juneGiin, febSengi, feb];

/* ---------- 県公表「歴代正副議長」（x 方向の錨） ---------- */

export interface ChairTerm { dai: number; name: string; iso: string }

/**
 * 「令和7.6.9」「平成29.6.9」→ ISO。読めなければ undefined（推定しない）。
 * **副議長の表には元号を 1 文字に略した行がある**（`明18.12.16` / `大12.10.18` / `昭40.12.14`。**実測 7 行**）。
 * **略字は 1 文字目が一意に決まるものだけ受ける**——`明`→明治 / `大`→大正 / `昭`→昭和 / `平`→平成 / `令`→令和。
 * **`大` と `大正` が衝突しないのは、略さない表記を先に当てているからである。**
 */
export function eraIso(text: string): string | undefined {
  const t = text.normalize("NFKC").replace(/[\s　]/g, "");
  const m = t.match(/(令和|平成|昭和|大正|明治|令|平|昭|大|明)(\d+|元)\.(\d+)\.(\d+)/);
  if (!m) return undefined;
  const n = m[2] === "元" ? 1 : Number(m[2]);
  const base = { 令和: 2018, 平成: 1988, 昭和: 1925, 大正: 1911, 明治: 1867, 令: 2018, 平: 1988, 昭: 1925, 大: 1911, 明: 1867 }[m[1] as "令和"];
  return `${base + n}-${String(m[3]).padStart(2, "0")}-${String(m[4]).padStart(2, "0")}`;
}

/**
 * 歴代正副議長ページ → 議長の表・副議長の表。
 * **見出しの 1 列目が「代」・2 列目が「議長」/「副議長」である表を選ぶ**（位置で選ばない。並びが変われば落ちる）。
 */
export function readChairTables(html: string): { gicho: ChairTerm[]; fukugicho: ChairTerm[] } {
  const cp = parse(html).querySelector("#ContentPane");
  if (!cp) throw new Error("#ContentPane not found");
  const found: Record<string, ChairTerm[]> = {};
  for (const t of cp.querySelectorAll("table")) {
    const head = t.querySelectorAll("tr")[0]?.querySelectorAll("th,td").map((c) => cleanText(c.text)) ?? [];
    if (head[0] !== "代" || (head[1] !== "議長" && head[1] !== "副議長")) continue;
    const rows: ChairTerm[] = [];
    for (const tr of t.querySelectorAll("tr")) {
      const c = tr.querySelectorAll("th,td").map((x) => cleanText(x.text));
      if (c.length !== 3 || !/^\d+$/.test(c[0])) continue;
      const iso = eraIso(c[2]);
      if (!iso) throw new Error(`就任年月日が読めない: ${c.join(" ")}`);
      rows.push({ dai: Number(c[0]), name: c[1], iso });
    }
    if (rows.length === 0) throw new Error(`${head[1]} の表に行が無い`);
    if (head[1] in found) throw new Error(`${head[1]} の表が 2 つある`);
    found[head[1]] = rows.sort((a, b) => (a.iso < b.iso ? -1 : 1));
  }
  if (!found["議長"] || !found["副議長"]) throw new Error("議長 / 副議長 の表が見つからない");
  return { gicho: found["議長"], fukugicho: found["副議長"] };
}

/** その日に在任していた（＝就任日がその日以前の最後の）人。居なければ undefined。 */
export function chairOn(terms: readonly ChairTerm[], date: string): ChairTerm | undefined {
  let cur: ChairTerm | undefined;
  for (const t of terms) if (t.iso <= date) cur = t;
  return cur;
}

/**
 * 県公表の氏名「浜崎 晋一」が、PDF の列の見出し「浜崎議員」/「浜田一議員」に対応するか。
 * **PDF は姓だけ（同姓は名の 1 文字を添える）**なので、**公表の氏名から空白を除いた先頭 N 文字**と突き合わせる。
 * **推定で寄せない**——長さが足りなければ一致しない。
 */
export function chairMatchesColumn(chairName: string, nameText: string): boolean {
  const surname = nameText.replace(/議員$/, "");
  if (surname === "") return false;
  return chairName.replace(/[\s　]/g, "").startsWith(surname);
}

/**
 * **この検算が見ていないもの**（#873 の測定で実測。**弱いところを隠さない**）:
 * **PDF は姓しか印刷していない**ので、**県公表の「名」を書き換えても検算B は落ちない**
 * （`福田 俊史` → `福田 太郎` の変異で 検算B は緑のまま。**姓 `福田` → `山田` と就任日の変異では落ちる**）。
 * **つまりこの錨が固定しているのは「姓」と「就任日」であって、「名」ではない。**
 */

const { gicho, fukugicho } = readChairTables(readFileSync(fixture("76208-rekidai-seifukugicho.htm"), "utf8"));

/* ---------- 回転（ずらしではない） ---------- */

function rotate<T>(a: readonly T[], k: number): T[] {
  const n = a.length;
  const s = ((k % n) + n) % n;
  return [...a.slice(n - s), ...a.slice(0, n - s)];
}

/**
 * 検算B（x）: `議` がちょうど 1 つ立つ行で、その列の議員が県公表の議長か。
 * **母数（判定できた行）を必ず返す**（#757。母数を書かない「全部一致」は意味が無い）。
 */
function checkChairColumn(shift: number, terms: readonly ChairTerm[] = gicho): { judged: number; mismatched: number; skipped: number } {
  let judged = 0, mismatched = 0, skipped = 0;
  for (const pdf of books) {
    const chair = chairOn(terms, pdf.date);
    if (!chair) { skipped += pdf.rows.length; continue; }
    for (const row of pdf.rows) {
      const cells = shift === 0 ? row.cells : rotate(row.cells, shift);
      const at = cells.map((c, i) => (c === "議" ? i : -1)).filter((i) => i >= 0);
      if (at.length !== 1) { skipped++; continue; }
      judged++;
      if (!chairMatchesColumn(chair.name, pdf.members[at[0]].nameText)) mismatched++;
    }
  }
  return { judged, mismatched, skipped };
}

test("検算B（x）: 議 の列の議員は、県公表『歴代正副議長』のその議決日の議長である（母数 133 行、不一致 0）", () => {
  const r = checkChairColumn(0);
  assert.equal(r.judged, 133);
  assert.equal(r.mismatched, 0);
  assert.equal(r.skipped, 0);
});

test("検算B（x）: 記号帯を 1 列『回転』させると 133 行すべてが落ちる（ずらしではなく回転）", () => {
  for (const shift of [1, 2, -1, -2, 3]) {
    const r = checkChairColumn(shift);
    assert.equal(r.judged, 133, `${shift} 列回転で母数が変わった（検算が空回りしている）`);
    assert.equal(r.mismatched, 133, `${shift} 列回転で落ちたのは ${r.mismatched} 行だけ`);
  }
});

test("恒真の確認: 『議 がちょうど 1 つ立つ』だけでは回転を 1 件も捕まえない（列の中身を外の事実に結んで初めて測れる）", () => {
  // **回転しても「議 がちょうど 1 つ」は変わらない**——だから母数は同じままで、これ単体は x の根拠にならない。
  for (const shift of [0, 1, 7, 17]) assert.equal(checkChairColumn(shift).judged, 133);
});

test("錨の取り違え: 副議長の表を使うと 133 行すべてが落ちる（同じページに 2 つの表があり、福田 俊史 は議長 89 代でも副議長 80 代でもある）", () => {
  const r = checkChairColumn(0, fukugicho);
  assert.equal(r.judged, 133);
  assert.equal(r.mismatched, 133);
  // 錨そのものを固定する（県の公表が変われば落ちる）
  assert.deepEqual(chairOn(gicho, "2026-06-29"), { dai: 89, name: "福田 俊史", iso: "2025-06-09" });
  assert.deepEqual(chairOn(fukugicho, "2026-06-29"), { dai: 83, name: "浜田 一哉", iso: "2025-06-09" });
  assert.deepEqual(chairOn(gicho, "2024-03-22"), { dai: 88, name: "浜崎 晋一", iso: "2023-05-10" });
});

test("錨の読み取り: 議長 89 代・副議長 83 代を、見出し（代 / 議長・副議長）で選ぶ。位置では選ばない", () => {
  assert.equal(gicho.length, 89);
  assert.equal(fukugicho.length, 83);
  assert.equal(gicho.at(-1)!.name, "福田 俊史");
  assert.equal(fukugicho.at(-1)!.name, "浜田 一哉");
  // 同じ人が議長にも副議長にも居る（取り違えが起きうることの固定）
  assert.ok(fukugicho.some((t) => t.name === "福田 俊史" && t.dai === 80));
  // **名（俊史）はこの錨の突き合わせには使っていない**（PDF は姓しか印刷していない）。**ここだけが逐語の固定である。**
  assert.equal(gicho.at(-1)!.name, "福田 俊史");
  assert.equal(eraIso("令和7.6.9"), "2025-06-09");
  assert.equal(eraIso("平成29.6.9"), "2017-06-09");
  assert.equal(eraIso("令和元.5.10"), "2019-05-10");
  // **副議長の表にある略字**（実測 7 行）。**略さない表記を先に当てているので `大` と `大正` は衝突しない。**
  assert.equal(eraIso("明18.12.16"), "1885-12-16");
  assert.equal(eraIso("大12.10.18"), "1923-10-18");
  assert.equal(eraIso("昭40.12.14"), "1965-12-14");
  assert.equal(eraIso("よめない"), undefined);
});

test("公表数（賛成者数・反対者数）は x 方向のずれを 1 件も捕まえない（記号帯を回しても ○ と × の個数は変わらない）", () => {
  const countCheck = (shift: number) => {
    let judged = 0, mismatched = 0;
    for (const pdf of books) for (const row of pdf.rows) {
      const cells = shift === 0 ? row.cells : rotate(row.cells, shift);
      judged++;
      if (cells.filter((c) => c === "○").length !== row.counts.yes || cells.filter((c) => c === "×").length !== row.counts.no) mismatched++;
    }
    return { judged, mismatched };
  };
  assert.deepEqual(countCheck(0), { judged: 133, mismatched: 0 });
  // **1 列・2 列・逆 1 列 回しても 0 件**。**この検算を x の根拠にしてはいけない**という事実を固定する。
  for (const shift of [1, 2, -1]) assert.deepEqual(countCheck(shift), { judged: 133, mismatched: 0 });
});

/* ---------- y 方向: 記号帯そのものを 1 行『回転』させる ---------- */

/**
 * **記号帯だけを行方向に回す**（行の順序は変えず、`cells` の中身だけを本の中で 1 行ずらす）。
 * **これが「賛成した議案と反対した議案が入れ替わる」壊れ方そのものである**（#819。9 回の測定で 0 回しか測られなかった）。
 */
function rotateSymbolBandByRow(shift: number): { checkChair: { judged: number; mismatched: number }; checkCounts: { judged: number; mismatched: number } } {
  let bJudged = 0, bFail = 0, cJudged = 0, cFail = 0;
  for (const pdf of books) {
    const bands = shift === 0 ? pdf.rows.map((r) => r.cells) : rotate(pdf.rows.map((r) => r.cells), shift);
    for (let i = 0; i < pdf.rows.length; i++) {
      const cells = bands[i];
      const at = cells.map((c, j) => (c === "議" ? j : -1)).filter((j) => j >= 0);
      if (at.length === 1) {
        bJudged++;
        const chair = chairOn(gicho, pdf.date)!;
        if (!chairMatchesColumn(chair.name, pdf.members[at[0]].nameText)) bFail++;
      }
      cJudged++;
      if (cells.filter((c) => c === "○").length !== pdf.rows[i].counts.yes || cells.filter((c) => c === "×").length !== pdf.rows[i].counts.no) cFail++;
    }
  }
  return { checkChair: { judged: bJudged, mismatched: bFail }, checkCounts: { judged: cJudged, mismatched: cFail } };
}

test("y 方向: 記号帯だけを 1 行『回転』させると、公表数との突き合わせが 133 行中 69 行で落ちる", () => {
  assert.deepEqual(rotateSymbolBandByRow(0).checkCounts, { judged: 133, mismatched: 0 });
  assert.equal(rotateSymbolBandByRow(1).checkCounts.mismatched, 69);
  assert.equal(rotateSymbolBandByRow(-1).checkCounts.mismatched, 69);
  assert.equal(rotateSymbolBandByRow(2).checkCounts.mismatched, 66);
});

test("2 本の検算は互いの代わりにならない: 検算B は y を 1 件も捕まえず、公表数は x を 1 件も捕まえない", () => {
  // **記号帯を y に回しても、`議` は同じ列に残る**（行が入れ替わるだけ）ので検算B は気づかない。
  for (const shift of [1, -1, 2]) assert.equal(rotateSymbolBandByRow(shift).checkChair.mismatched, 0);
  // **記号帯を x に回しても、`○` と `×` の個数は変わらない**ので公表数は気づかない（上で 0/133 と実測）。
  // **どちらか 1 本を外すと、その壊れ方は誰も見ていない状態になる。**
  assert.equal(checkChairColumn(1).mismatched, 133);
});

/* ---------- 検算E（y）: 県の HTML「議案等の議決結果」に結ぶ ---------- */

export interface HtmlResultRow { key: string; title: string; result: string }

/**
 * PDF の (種別, 番号) と HTML の番号表記を同じ鍵にする。
 * **番号だけで引いてはいけない**——**知事提案 第2号 と 議員提案 第2号 が同じ会期に両方ある**（実測）。
 * HTML 側は「議員提出議案第N号」という 1 つの欄に種別が畳み込まれているので、そこで分ける。
 */
export function numberKey(kind: string, number: string): string {
  const raw = number.normalize("NFKC").replace(/[\s　]/g, "");
  const k = raw.startsWith("議員提出議案") ? "議員提案" : kind;
  const n = raw.replace(/^議員提出議案/, "").replace(/^議案/, "").replace(/^第/, "").replace(/号$/, "");
  return `${k}|${n}`;
}

/**
 * 議決結果ページ（HTML）→ (種別|番号) → 件名・議決結果。
 * **見出しが「番号 / 件名 / 議決結果」の表だけを読む**（委員長報告の表・番号をまとめた結合形式は読まない）。
 * **議決結果の欄は結合セルなので、空なら直前の値を引き継ぐ**（PDF ではなく HTML の作りに従う）。
 */
export function parseHtmlResults(html: string): Map<string, HtmlResultRow> {
  const cp = parse(html).querySelector("#ContentPane");
  if (!cp) throw new Error("#ContentPane not found");
  const out = new Map<string, HtmlResultRow>();
  for (const t of cp.querySelectorAll("table")) {
    const head = t.querySelectorAll("tr")[0]?.querySelectorAll("th,td").map((c) => cleanText(c.text)) ?? [];
    if (head[0] !== "番号" || head[1] !== "件名" || head[2] !== "議決結果") continue;
    let carried = "";
    for (const tr of t.querySelectorAll("tr").slice(1)) {
      const c = tr.querySelectorAll("th,td").map((x) => cleanText(x.text));
      if (c.length < 2 || c[0] === "") continue;
      if (c.length >= 3 && c[2] !== "") carried = c[2];
      const m = carried.match(/^\d{1,2}月\d{1,2}日(.+?)(?:\s*\(pdf.*)?$/i);
      const key = numberKey("知事提案", c[0]);
      out.set(key, { key, title: c[1], result: m ? m[1].replace(/\s*\(pdf.*$/i, "").trim() : carried });
    }
  }
  if (out.size === 0) throw new Error("『番号 / 件名 / 議決結果』の表が 1 つも無い");
  return out;
}

const juneHtml = parseHtmlResults(readFileSync(fixture("328150.htm"), "utf8"));

/** y 方向: PDF の 件名 / 議決結果 の欄だけを回して、HTML の同じ番号の行と食い違うか。 */
function checkAgainstHtml(field: "title" | "result", shift: number): { judged: number; mismatched: number; skipped: number } {
  const rows: VotePdfRow[] = june.rows;
  const shifted = shift === 0 ? rows : rotate(rows, shift);
  let judged = 0, mismatched = 0, skipped = 0;
  for (let i = 0; i < rows.length; i++) {
    const want = juneHtml.get(numberKey(rows[i].kind, rows[i].number));
    if (!want) { skipped++; continue; }
    judged++;
    const got = field === "title" ? shifted[i].title : shifted[i].result;
    const expected = field === "title" ? want.title : want.result;
    if (got.replace(/[\s　]/g, "") !== expected.replace(/[\s　]/g, "")) mismatched++;
  }
  return { judged, mismatched, skipped };
}

test("検算E（y）: 議決結果の欄を 1 行『回転』させると落ちる。無改造では母数 18 行・不一致 1（県の 2 つの一次資料そのものが食い違っている）", () => {
  const base = checkAgainstHtml("result", 0);
  assert.deepEqual(base, { judged: 18, mismatched: 1, skipped: 12 });
  // **「全部一致」ではない。** **議案第2号（令和８年度鳥取県営病院事業会計補正予算（第１号））は
  // PDF が「決定」、HTML が「可決」と書いている。** **どちらが正しいかは決めない**（推定しない）。
  const row2 = june.rows.find((r) => numberKey(r.kind, r.number) === "知事提案|2")!;
  assert.equal(row2.result, "決定");
  assert.equal(juneHtml.get("知事提案|2")!.result, "可決");
  // **回転で落ちる件数を固定する**（「落ちた」だけでなく、どれだけ落ちるかを書く）。
  // **弱い**——同じ結果（`可決`）が続くので、回しても食い違わない行が多い。
  assert.equal(checkAgainstHtml("result", 1).mismatched, 4);
  assert.equal(checkAgainstHtml("result", -1).mismatched, 4);
  assert.equal(checkAgainstHtml("result", 2).mismatched, 5);
});

test("検算C（y）: 件名の欄を 1 行『回転』させると 18 行中 17 行が落ちる。無改造でも 1 行食い違う（県の HTML が『協働』、PDF が『共同』）", () => {
  const base = checkAgainstHtml("title", 0);
  assert.equal(base.judged, 18);
  // **「全部一致」ではない。県の 2 つの一次資料そのものが 1 行だけ食い違っている。**
  assert.equal(base.mismatched, 1);
  const row = june.rows.find((r) => numberKey(r.kind, r.number) === "知事提案|12")!;
  assert.match(row.title, /鳥取県行政不服審査会共同設置規約の変更に関する協議について/);
  assert.match(juneHtml.get("知事提案|12")!.title, /鳥取県行政不服審査会協働設置規約の変更に関する協議について/);
  for (const shift of [1, -1]) assert.equal(checkAgainstHtml("title", shift).mismatched, 17);
  assert.equal(checkAgainstHtml("title", 2).mismatched, 18);
});

test("母数外の 12 行の理由を書く（母数を書かない『全部一致』は意味が無い。#757）", () => {
  const out: string[] = [];
  for (const r of june.rows) if (!juneHtml.get(numberKey(r.kind, r.number))) out.push(`${r.kind} ${r.number}`);
  assert.equal(out.length, 12);
  // **11 行は 陳情**（HTML では「件名 / 委員長報告 / … / 議決結果」の別の表にあり、番号の欄が無い）。
  assert.equal(out.filter((s) => s.startsWith("陳情")).length, 11);
  // **残る 1 行は 知事提案 第6号**——**県の HTML の番号が「議案第６峰」と誤記されている**（`号` ではなく `峰`）。
  assert.deepEqual(out.filter((s) => !s.startsWith("陳情")), ["知事提案 第6号"]);
  assert.ok([...juneHtml.keys()].includes("知事提案|6峰"), "HTML 側に誤記の鍵がある");
  assert.equal(juneHtml.get("知事提案|6"), undefined);
});

/* ---------- 検算D（y）: 陳情の 11 行を、県の HTML の別の表（件名／委員長報告／議決結果）に結ぶ ---------- */

export interface HtmlChinjoRow { title: string; committeeReport: string; result: string }

/**
 * 議決結果ページの「件名 / 委員長報告 / 委員長報告に対する賛否 / 議決結果」の表。
 * **番号の欄が無い**ので **並び順でしか結べない**——**だから、これは y 方向の検算になる**
 * （PDF 側の行の並びが 1 行でも回れば食い違う）。
 * **「賛否」の欄が空の行がある**（HTML 実測: 11 行のうち 1 行だけ「賛成多数」が入り、他は列が 3 つ）ので欄数では選ばない。
 */
export function parseHtmlChinjo(html: string): HtmlChinjoRow[] {
  const cp = parse(html).querySelector("#ContentPane");
  if (!cp) throw new Error("#ContentPane not found");
  const out: HtmlChinjoRow[] = [];
  for (const t of cp.querySelectorAll("table")) {
    const head = t.querySelectorAll("tr")[0]?.querySelectorAll("th,td").map((c) => cleanText(c.text)) ?? [];
    if (head[0] !== "件名" || head[1] !== "委員長報告") continue;
    for (const tr of t.querySelectorAll("tr").slice(1)) {
      const c = tr.querySelectorAll("th,td").map((x) => cleanText(x.text));
      if (c.length < 3) continue;
      out.push({ title: c[0], committeeReport: c[1], result: c[c.length - 1].replace(/\s*\(pdf.*$/i, "").trim() });
    }
  }
  if (out.length === 0) throw new Error("『件名 / 委員長報告』の表が無い");
  return out;
}

const juneChinjoHtml = parseHtmlChinjo(readFileSync(fixture("328150.htm"), "utf8"));

/** 陳情だけの PDF（11 行）と HTML の 11 行を、**並び順で**突き合わせる。 */
function checkChinjo(field: "title" | "committeeReport", shift: number): { judged: number; mismatched: number } {
  const rows = juneSeigan.rows;
  const shifted = shift === 0 ? rows : rotate(rows, shift);
  let judged = 0, mismatched = 0;
  for (let i = 0; i < rows.length && i < juneChinjoHtml.length; i++) {
    judged++;
    const got = field === "title" ? shifted[i].title : (shifted[i].committeeReport ?? "");
    const want = field === "title" ? juneChinjoHtml[i].title : juneChinjoHtml[i].committeeReport;
    if (got.replace(/[\s　]/g, "") !== want.replace(/[\s　]/g, "")) mismatched++;
  }
  return { judged, mismatched };
}

test("検算D（y）: 陳情 11 行の件名は、県の HTML の別の表と並び順で一致する。1 行『回転』させると 11 行すべてが落ちる", () => {
  assert.equal(juneChinjoHtml.length, 11);
  assert.equal(juneSeigan.rows.length, 11);
  assert.deepEqual(checkChinjo("title", 0), { judged: 11, mismatched: 0 });
  for (const shift of [1, -1, 2]) assert.equal(checkChinjo("title", shift).mismatched, 11);
});

test("検算D（y）: 陳情の件名は『陳情の本文』を含まない——本文まで入ると HTML と食い違う（罫線の中の左端に揃った行だけを取っている）", () => {
  // **これが `TITLE_INDENT` の意味である。** 本文まで混ぜると 1 行目は 438 字になる（実測）。
  assert.equal(juneSeigan.rows[0].title, "旧姓の通称使用の法制化を求める陳情");
  assert.ok(juneSeigan.rows.every((r) => r.title.length <= 46), "陳情の件名は 46 字以下（実測の最大）");
});

test("検算D（y）: 委員長報告の欄も並び順で一致する。ただし 11 行中 1 行は県の 2 つの一次資料が食い違う（PDF『不採択』/ HTML『不採択（措置済み）』）", () => {
  const base = checkChinjo("committeeReport", 0);
  assert.equal(base.judged, 11);
  // **「全部一致」ではない。** 高等学校における平和教育…の行だけ、県の HTML が「（措置済み）」を足している。
  // **どちらが正しいかは決めない**（推定しない）。
  assert.equal(base.mismatched, 1);
  const i = juneChinjoHtml.findIndex((r) => /高等学校における平和教育/.test(r.title));
  assert.equal(juneSeigan.rows[i].committeeReport, "不採択");
  assert.equal(juneChinjoHtml[i].committeeReport, "不採択（措置済み）");
  for (const shift of [1, -1]) assert.ok(checkChinjo("committeeReport", shift).mismatched > base.mismatched);
});

/* ---------- y 方向のもうひとつの錨: 除斥 ---------- */

test("検算A（y）: 除（除斥）は、このフィクスチャ 5 本・133 行・4,655 セルに 1 つも無い——**母数 0 では y を測れない**", () => {
  const found: { title: string; member: string }[] = [];
  for (const pdf of books) for (const row of pdf.rows) for (let i = 0; i < row.cells.length; i++) {
    if (row.cells[i] === "除") found.push({ title: row.title, member: pdf.members[i].nameText });
  }
  // **0 件である。** **「一致した」ではなく「母数が 0 なので何も測れていない」と書く。**
  // **凡例には `除` があるが、実物は 1 セルも無い**——**凡例にあることは、出ることを意味しない。**
  assert.equal(found.length, 0);
  assert.equal(june.legend.votes["除"], "除斥");
  // **フィクスチャの外では出る**（#873 の測定: 読めた 15 本・307 行のうち 2025-06-30 議案第21号 鳥取県監査委員の選任について の 1 セル）。
  // **その本はフィクスチャに無いので、ここでは固定できない。**
  // **監査委員の選任の行そのものが、このフィクスチャに 0 行しか無い**ことも書いておく。
  assert.equal(books.flatMap((p) => p.rows).filter((r) => /監査委員の選任について/.test(r.title)).length, 0);
});

/* ---------- #204: 同じ PDF の中で ○ の意味が節ごとに変わる ---------- */

test("『委員長報告に対する賛否』の行では ○ の意味が変わる（陳情への賛成ではない）。5 本・133 行のうち 26 行", () => {
  const rows = books.flatMap((p) => p.rows);
  const iken = rows.filter((r) => r.voteSubject === "委員長報告に対する賛否");
  assert.equal(rows.length, 133);
  assert.equal(iken.length, 26);
  // **議決結果が「不採択」の行で ○ を投じた議員は、陳情に賛成したのではなく「不採択」という委員長報告に賛成した。**
  const fusaitaku = iken.filter((r) => r.result === "不採択");
  assert.equal(fusaitaku.length, 18);
  for (const r of fusaitaku) assert.equal(r.committeeReport, "不採択");
  // **凡例は「○ = 賛成」のままである**（PDF は節ごとに凡例を変えない）。**だから Web は voteSubject を必ず添える。**
  assert.equal(june.legend.votes["○"], "賛成");
});

/* ---------- 名寄せ: 同姓は名の 1 文字で分かれている ---------- */

test("同姓の議員は PDF の列見出しで名の 1 文字が添えられている（浜田一議員 / 浜田妙議員・内田博議員）。姓だけの列は 1 人に決まる", () => {
  const names = june.members.map((m) => m.nameText);
  assert.ok(names.includes("浜田一議員"));
  assert.ok(names.includes("浜田妙議員"));
  assert.ok(names.includes("内田博議員"));
  // **`浜田議員`（姓だけ）は 1 列も無い**——あると 2 人の区別がつかない
  assert.equal(names.filter((n) => n === "浜田議員").length, 0);
  assert.equal(new Set(names).size, names.length, "列見出しが重複していない");
  assert.equal(names.length, 35);
});
