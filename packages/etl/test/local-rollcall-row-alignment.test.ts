import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseVotePdf as shigaParse } from "../src/sources/local/shiga/votes-pdf.ts";
import { parseVotePdf as aomoriParse } from "../src/sources/local/aomori/votes-pdf.ts";
import { parseVotePdf as akitaParse } from "../src/sources/local/akita/votes-pdf.ts";
import { parseVotePdf as sagaParse } from "../src/sources/local/saga/votes-pdf.ts";
import { legendKey } from "../src/sources/local/glyph-variants.ts";

/**
 * # y 方向（その行がどの議案か）の検算（Issue #819）
 *
 * ## なぜ要るか
 * **8 県の測定（合計 60 万対以上）はすべて x 方向（列）しか測っていない。**
 * 「k 番目の記号が k 番目の議員のもの」は確かめたが、
 * **「その記号帯が、同じ行の議案のものか」は 1 度も確かめていない。**
 *
 * **気づけない壊れ方はこれ:**
 * ```
 * 議案 A の行の賛否が、議案 B の行として記録される
 * （各議員の賛否は正しく並んでいるが、議案が 1 つずれる）
 * ```
 * **これは「別人の記録が出る」と同じ重さ**（#569）——
 * **「この議員はこの議案に賛成した」が偽になり、利用者からは検出できない。**
 *
 * ## 突き合わせるもの
 * **その行の左の欄に載っている公表数（`counts.yes` / `counts.no`）と、
 * その行の記号帯の `○` / `×` の数。**
 * 記号帯が 1 行ずれていれば、隣の議案の公表数と比べることになる。
 * **左の欄（議案の側）と記号帯（賛否の側）を結ぶ、唯一の公表された事実である。**
 *
 * ## **この検算は y 方向では弱い。ここに書いて残す。**
 * **実測（本番に出ている 12 本・307 行 / フィクスチャ 22 本・525 行）:**
 * **`cells` を 1 行ずらしても、本番 307 行のうち 193 行（63%）で落ちない。**
 * **理由は数えてある——307 行のうち 229 行（75%）が全会一致**（`×` が 1 つも無い）で、
 * **隣の議案と `○` の数まで同じなので、ずらしても数が合ってしまう。**
 * **だから「この検算が通る」ことは「y が正しい」ことの証明にならない。**
 * **1 行のずれを、この検算は 63% の行で見逃す。**
 *
 * ## **さらに悪い——この検算は「件名がずれる」壊れ方を、原理的に 1 件も捕まえられない。**
 *
 * **変異テストで分かった**（#819。`aomori/votes-pdf.ts` の錨の選び方を 12pt ずらした）:
 * ```
 * 青森 160 行中 152 行で `title` が 1 議案ぶんずれた。
 * `cells` は 160 行すべて変わらなかった。`counts` も 160 行すべて変わらなかった。
 * → このテストは 4 本とも通った。
 * ```
 * **実物**（`276_25.11_giketsukekka.pdf` の 5 行目）:
 * ```
 * 正しい: 第１号 平成25年度青森県一般会計補正予算（第４号）案   賛成 42
 * 変異後: 第18号 青森県病院事業会計の決算の認定を求めるの件     賛成 46
 * ```
 * **「第18号 に 46 人が賛成した」**という、**どの議案についても偽の記録ができる。**
 * **それでも `counts` と `○` の数は合う**——**`counts` は記号帯と同じ y から読んでいる**ので、
 * **件名だけがずれても、この検算は何も言わない。**
 *
 * **つまり `counts` の検算が結んでいるのは `counts` ↔ `cells` であって、
 * `title` ↔ `cells` ではない。** **議案を名指しするのは `title` の側である。**
 *
 * ## **公開されている出力だけでは、`title` ↔ `cells` を確かめる材料が無い**
 * 議決日・議案番号・件名・議決結果・`counts` は**すべて左の欄から読んでいる**ので、
 * **左の欄どうしの整合しか見ない。** **記号帯の側にあるのは記号だけである。**
 * **番号の並び（昇順）も使えない**——実測: 変異の前 491 対中 452 対が昇順、
 * **変異の後も 481 対中 444 対が昇順**（**全部を 1 つずらしても並びは保たれる**）。
 *
 * **確かめるには `VotePdfRow` に「その行の y」を持たせて、
 * 記号帯の y と左の欄の y が同じ行であることを見るしかない**（パーサ側の変更が要る）。
 * **#819 は測定の PBI なので、ここではやっていない。** **別の PBI が要る。**
 *
 * ## 変異テストの結果（#819。**`scripts/dev/mutate.sh` で当てた**）
 *
 * | # | 何を壊したか | 結果 | 分類 |
 * |---|---|---|---|
 * | 1 | 佐賀 `readLeftCells(..., band.y)` → `band.y - 14`（左の欄を 1 行下から読む） | **落ちた**（2 本） | 殺せた |
 * | 2 | 青森 `used.add(best)` を消す（錨の使い回しを許す） | 通った | **等価変異**——**フィクスチャ 5 本 160 行で出力が 1 行も変わらない**（どの行も固有の錨を持つので、この守りが発火しない）。**青森自身の 18 本のテストでも殺せない。** |
 * | 3 | 青森 錨の選び方を 12pt ずらす | 通った | **テストの穴**——**`title` が 152 / 160 行でずれたが `cells` も `counts` も 1 行も変わらない。**（上の「原理的に捕まえられない」の実測そのもの） |
 * | 4 | 滋賀 記号帯を 1 つ下の行から読む | **落ちた**（1 本） | 殺せた |
 * | 5 | 秋田 錨の選び方を 12pt ずらす | **落ちた**（2 本） | 殺せた——ただし**部分的**。**`label` は 211 / 213 行でずれたのに、`counts` がずれたのは 47 行だけ**で、**落ちたのはその 47 行のおかげ**。**残る 164 行は見逃している。** |
 *
 * **殺せた 3 件はすべて「`counts` と `cells` の対応が切れる」形**で、
 * **通った 1 件（#3）と、#5 で見逃した 164 行は、どちらも「`title` だけがずれる」形である。**
 */

const fx = (pref: string, name: string) => readFileSync(fileURLToPath(new URL(`fixtures/${pref}/${name}`, import.meta.url)));
const list = (pref: string) => readdirSync(fileURLToPath(new URL(`fixtures/${pref}/`, import.meta.url))).filter((f) => f.endsWith(".pdf")).sort();

interface Row { label: string; page: number; yes?: number; no?: number; cells: string[] }
interface Book { pref: string; name: string; legend: Record<string, string>; rows: Row[] }

/** 佐賀の counts は原文の文字列（`40`／空）。数として読めたときだけ使う（原文に無い数を作らない） */
const num = (s: unknown): number | undefined => {
  if (typeof s === "number") return Number.isInteger(s) ? s : undefined;
  if (typeof s !== "string") return undefined;
  const t = s.normalize("NFKC").replace(/[^\d]/g, "");
  return t === "" ? undefined : Number(t);
};

async function read(pref: string, name: string): Promise<Book | undefined> {
  try {
    if (pref === "shiga") {
      const p = await shigaParse(fx(pref, name));
      return { pref, name, legend: p.legend.votes, rows: p.rows.map((r) => ({ label: `${r.dateText} ${r.title}`, page: r.page, yes: r.counts?.yes, no: r.counts?.no, cells: r.cells })) };
    }
    if (pref === "aomori") {
      const p = await aomoriParse(fx(pref, name));
      return { pref, name, legend: p.legend.votes, rows: p.rows.map((r) => ({ label: `${r.number} ${r.title}`, page: r.page, yes: r.counts?.yes, no: r.counts?.no, cells: r.cells })) };
    }
    if (pref === "akita") {
      const p = await akitaParse(fx(pref, name));
      return { pref, name, legend: p.legend.votes, rows: p.rows.map((r) => ({ label: `${r.number} ${r.title}`, page: r.page, yes: r.counts?.yes, no: r.counts?.no, cells: r.cells })) };
    }
    const p = await sagaParse(fx(pref, name));
    return { pref, name, legend: p.legend.votes, rows: p.rows.map((r) => ({ label: `${r.number} ${r.title}`, page: r.page, yes: num(r.counts.yes), no: num(r.counts.no), cells: r.cells })) };
  } catch {
    // **読めないのが正しい結果の本がある**（文字層の無い画像 PDF・`/Rotate` の古い形）
    return undefined;
  }
}

/** 凡例で「賛成」「反対」と書かれている記号。**凡例に無ければ判定しない**（推定しない。#569） */
const symsFor = (legend: Record<string, string>, want: string): Set<string> =>
  new Set(Object.entries(legend).filter(([, v]) => v.startsWith(want)).map(([k]) => k));

const countIn = (cells: readonly string[], syms: Set<string>): number =>
  cells.reduce((n, c) => n + (syms.has(legendKey(c)) ? 1 : 0), 0);

interface Result { judgeable: number; skipped: number; bad: { book: string; label: string; gotYes: number; wantYes: number; gotNo: number; wantNo: number }[] }

function checkBook(b: Book, rows: readonly Row[]): Result {
  const yes = symsFor(b.legend, "賛成");
  const no = symsFor(b.legend, "反対");
  // **凡例に賛成・反対の記号が無い本は判定外**（滋賀 Kg220_240424 のような凡例の欠けた本）
  if (yes.size === 0 || no.size === 0) return { judgeable: 0, skipped: rows.length, bad: [] };
  const r: Result = { judgeable: 0, skipped: 0, bad: [] };
  for (const row of rows) {
    // **counts が無い行は判定外**（原文に数が無い。`0` と読み替えない）
    if (row.yes === undefined || row.no === undefined) { r.skipped++; continue; }
    // **記号が 1 つも置けていない行も判定外**（丸ごと `不明`）
    if (row.cells.every((c) => c === "不明")) { r.skipped++; continue; }
    r.judgeable++;
    const gy = countIn(row.cells, yes);
    const gn = countIn(row.cells, no);
    if (gy !== row.yes || gn !== row.no) r.bad.push({ book: `${b.pref}/${b.name}`, label: row.label, gotYes: gy, wantYes: row.yes, gotNo: gn, wantNo: row.no });
  }
  return r;
}

/** `cells` だけを行方向に k 回す（議案の側は動かさない＝「記号帯が k 行ずれた」状態を作る） */
function rotateCells(rows: readonly Row[], k: number): Row[] {
  const n = rows.length;
  return rows.map((r, i) => ({ ...r, cells: rows[(((i + k) % n) + n) % n].cells }));
}

const PREFS = ["shiga", "aomori", "akita", "saga"] as const;

/**
 * **公表数と記号の数が合わない行。**
 *
 * ## **#829 で 5 行とも直った。この表は空になった。**（2026-09-14）
 *
 * **#819（この測定）が固定していたのは、下の 5 行だった**——**すべて秋田の同じ 1 つの機序**
 * （**`readRows` の「いちばん近い錨に配る」に距離の上限が無く、ページ下端のページ番号が
 * `counts` の数字に混ざる**。機序は下の `#819 秋田: ページ番号` の docblock を読むこと）:
 *
 * ```
 * akita/041222hyoketsu.pdf 議案第209号 …連携協約を締結する協議について   公表 42/1  記号 ○42 ×0
 * akita/060220hyoketsu.pdf 議案第10号  …経費の一部負担の変更について     公表 40/1  記号 ○40 ×0
 * akita/h231202giketu.pdf  事提出認定第２号 …歳入歳出決算の認定について  公表 42/1  記号 ○42 ×2
 * akita/h291222giketu.pdf  議案第214号 公の施設の指定管理者の指定について 公表 40/40 記号 ○40 ×0
 * akita/h291222giketu.pdf  請願第40号  県立高校図書館の充実を求める請願   公表 40/40 記号 ○40 ×0
 * ```
 *
 * **#829 が `akita/votes-pdf.ts` に距離の上限（`ROW_ITEM_MAX_ROWS = 2.5`）を入れたので、
 * この 5 行の `counts` は捏造されなくなり、5 行とも合うようになった。**
 * **残った行は 0 行である。**
 *
 * ## **「0 件になった」だけを書かない**——**母数と、直した根拠を一緒に置く**
 *
 * **この配列を空にしただけでは「検算が空回りしている」のと見分けが付かない。**
 * **だから下のテストは、この表と一緒に次の 3 つを固定してある:**
 *   1. **読めた本の数と判定できた行の数**（母数。#757。**比べる行が消えたら落ちる**）
 *   2. **`#819 y 方向: 記号帯を 1 行ずらすと落ちる`**（**恒真でないこと**。既存のテスト）
 *   3. **`#829` 側に「ページ番号が混ざっていた 10 行」の実物**
 *      （`akita-votes-pdf.test.ts` の `PAGE_NUMBER_ROWS`。**直った値を実物で固定してある**）
 *
 * **この配列は消さずに残す**——**新しい機序で 1 行でも合わなくなったら、ここで落ちる。**
 * **「既知の壊れ」を足す場所であり、「0 件」を宣言する場所ではない。**
 */
const KNOWN_BAD: string[] = [];

/**
 * **#829 が直した行の数**（**上の `KNOWN_BAD` が空になった理由の母数**）。
 * **「5 行あったものが 0 行になった」を数として残す**——
 * **`KNOWN_BAD` を空にしただけなら、この数が嘘になる。**
 */
const FIXED_BY_829 = 5;

const key = (b: Result["bad"][number]): string => `${b.book}\t${b.label}\t${b.gotYes}/${b.wantYes}\t${b.gotNo}/${b.wantNo}`;

async function allBooks(): Promise<Book[]> {
  const out: Book[] = [];
  for (const pref of PREFS) for (const f of list(pref)) { const b = await read(pref, f); if (b) out.push(b); }
  return out;
}

test("#819 y 方向: 公表された賛成者数・反対者数が、その行の記号帯の ○ / × の数と合う", async () => {
  const books = await allBooks();
  // **母数を必ず出す**（#757）。「ずれ 0 件」と「1 行も比べていない」を同じ出力にしない
  assert.ok(books.length >= 20, `読めた本 ${books.length}（20 本以上を測るはず）`);
  let judgeable = 0, skipped = 0;
  const bad: Result["bad"] = [];
  for (const b of books) { const r = checkBook(b, b.rows); judgeable += r.judgeable; skipped += r.skipped; bad.push(...r.bad); }
  assert.ok(judgeable >= 380, `判定できた行 ${judgeable}（380 行以上を比べるはず。全 ${judgeable + skipped} 行）`);
  // ## **母数は #829 の前後で変わらない**（**実測。414 のまま**）
  // **これは偶然である**——**ページ番号が混ざると、`counts` が「捏造される」行と
  // 「丸ごと落ちる」行の両方が出る。** **直すと前者は母数から抜け、後者は母数に入る。**
  // **フィクスチャでは捏造 5・喪失 5 でちょうど釣り合った**（**#829 が全件突き合わせて数えた**）。
  // **「母数が変わらなかったから何も起きていない」ではない**——**中身は 10 行入れ替わっている。**
  // **ここで母数を固定するのは、「合わない行 0」を「1 行も比べていない」ですり替えさせないため**（#757）。
  assert.equal(judgeable, 414, "**母数**——判定できた行（#829 の前後で変わらない。実測 414）");
  // **合わない行は 0 行**（**#829 が 5 行とも直した**）。**増えても落ちる。**
  // **`KNOWN_BAD` は空だが、消していない**——**新しい機序が出たら、ここに実物が並ぶ。**
  assert.deepEqual(bad.map(key).sort(), [...KNOWN_BAD].sort(), `公表数と記号の数が合わない行 ${bad.length} / 判定できた ${judgeable} 行`);
  assert.equal(KNOWN_BAD.length, 0, `**#829 が ${FIXED_BY_829} 行とも直したので、既知の壊れは 0 行**`);
});

test("#819 y 方向: 記号帯を 1 行ずらすと落ちる（この検算が恒真でないこと）", async () => {
  const books = await allBooks();
  let judgeable = 0, caught = 0;
  for (const b of books) {
    if (b.rows.length < 2) continue; // 1 行の本は回しても同じ（この検算では y を測れない）
    const r = checkBook(b, rotateCells(b.rows, 1));
    judgeable += r.judgeable;
    caught += r.bad.length;
  }
  // **回して落ちなければ、この検算は y 方向を測っていない**
  assert.ok(caught > 0, `1 行ずらして落ちた行 ${caught} / 判定できた ${judgeable} 行（0 なら恒真）`);
  assert.ok(caught >= 150, `1 行ずらして落ちた行 ${caught} / ${judgeable}（150 を下回ったら検算の効きが落ちている）`);
  // ## **#829 で 177 → 176 に 1 行減った**（**実測。減ったことを隠さず書く**）
  // **回転の母数 411 は変わっていない**（**1 行だけの本を除くのでここは 411。上のテストは 414**）。
  // **減った理由**: **#829 の前は捏造された `counts`（例 `no=40` なのに `×` が 0 個）があり、
  // 回すと隣とも合わずに落ちていた。** **直すとその行は `counts` 無しになり、判定の外に出る。**
  // **つまり「検算の効きが落ちた」のではなく「嘘の値で落ちていた 1 行が消えた」。**
  // **数を固定するのは、次に動いたときに理由を問えるようにするため**（#757）。
  assert.equal(judgeable, 411, "**母数**——回して判定できた行（1 行だけの本を除く）");
  assert.equal(caught, 176, "**1 行ずらして落ちた行**（#819 では 177。#829 で捏造 1 行が判定の外に出た）");
});

/**
 * **この検算がどれだけ見逃すかを、数として固定する。**
 * **「通った」ことを安心の根拠にしないため**に、**見逃す率のほうをテストに書く。**
 * この数が下がったら（＝効きが良くなったら）、それはそれで調べる価値がある。
 */
test("#819 y 方向: 1 行ずらしても落ちない行が過半数ある（この検算の弱さ）", async () => {
  const books = await allBooks();
  let judgeable = 0, missed = 0, unanimous = 0, rows = 0;
  for (const b of books) {
    rows += b.rows.length;
    for (const r of b.rows) if (!r.cells.some((c) => legendKey(c) === "×")) unanimous++;
    if (b.rows.length < 2) continue;
    const r = checkBook(b, rotateCells(b.rows, 1));
    judgeable += r.judgeable;
    missed += r.judgeable - r.bad.length;
  }
  // **全会一致の行が多いことが、見逃しの原因である**（隣の議案と ○ の数まで同じ）
  assert.ok(unanimous / rows > 0.5, `全会一致の行 ${unanimous} / ${rows}`);
  assert.ok(missed > judgeable * 0.3, `1 行ずらしても落ちない行 ${missed} / ${judgeable}（この検算は y のずれをここまで見逃す）`);
});

/**
 * # 秋田: **ページ番号が行の数字に混ざる**（#819 が y の検算で見つけた）
 *
 * **機序**——`akita/votes-pdf.ts` の `readRows` は、左の欄のアイテムを
 * **「いちばん近い錨（議決月日の y）」に配るが、距離の上限が無い。**
 * **ページ下端に 1 つだけ立つページ番号（`1` `2` `3`）は、どの行からも遠いのに、
 * いちばん近い錨の行に入る**（実測 Δy = -24.8 〜 -714.4）。
 *
 * **`readLeftCells` は「錨より右の数字を左から 3 つ」で `counts` を作る**ので:
 *   - その行の数字が **2 つ**（**反対 0 の行は反対者数の欄が空**）→ **3 つになり `counts` が捏造される**
 *   - その行の数字が **3 つ**（ふつう）→ **4 つになり `counts` が丸ごと落ちる**
 *
 * **捏造された値の実物**（フィクスチャ 6 本での実測。**#829 で直った。下記**。
 * **ここに 3 行しか挙がっていないのは #819 の数え落としで、実際は 5 行だった**）:
 * ```
 * h291222giketu p1 議案第214号 公の施設の指定管理者の指定について
 *     原文「原案可決 40 40」＋ ページ番号「1」 → counts {"voting":1,"yes":40,"no":40}
 * h291222giketu p2 請願第40号 県立高校図書館の充実を求める請願について
 *     原文「採択 40 40」    ＋ ページ番号「2」 → counts {"voting":2,"yes":40,"no":40}
 * h231202giketu p1 認定第２号 平成２２年度秋田県歳入歳出決算の認定について
 *     原文「認定 44 42」    ＋ ページ番号「1」 → counts {"voting":44,"yes":42,"no":1}
 * ```
 * **`no: 40` は「40 人が反対した」と読める値だが、記号帯の `×` は 0 個である。**
 * **反対 0 の全会一致の議案が「40 人反対」に化けている。**
 *
 * **落ちるほうの実測は 4 行**と書いてあったが、**#829 が数え直すと 5 行だった**
 * （`R41102` p1 / `041222` p2 請願第57号 / `080319` p1・p2・p3）。
 * **`080319` は本番に出ている PDF。**
 *
 * ## **#829 が直した**（2026-09-14）
 *
 * **`readRows` に距離の上限（`ROW_ITEM_MAX_ROWS = 2.5`）を入れた。**
 * **上限は実測から決めてある**——**フィクスチャ 6 本・213 行・左の欄のアイテム 1,667 個で、
 * 本物の最大が行の高さの 1.884 倍（縦書き `知事提出` の `出`）、
 * ページ番号の最小が 2.9999 倍で、そのあいだにアイテムが 1 つも無い。**
 * **`* 3` にしてはいけない**——**ページ番号の 1 つがちょうど 2.9999 なので通ってしまう**
 * （**変異で確かめた**）。
 *
 * **直したあと、フィクスチャ 6 本 213 行を全件突き合わせた実測**:
 *   - **10 行が直り、残り 203 行は 1 文字も変わらない**（全フィールド）
 *   - **内訳は捏造 5・喪失 5**（**上の docblock は「捏造 3・喪失 4」と書いているが、
 *     数え直すと 5・5 だった**。#829 が Issue に訂正を記録）
 *   - **`counts` ≠ 記号 の行: 5 行 → 0 行**
 *
 * **本番 5 本 157 行**（PDF を取り直して全件突き合わせ）:
 *   - **7 行が直り、残り 150 行は 1 文字も変わらない**
 *   - **上の「7 件のうち 3 件がこれ」は誤り**——**7 件とも同じ機序だった**
 *     （**上限を外した状態で読み直すと、`counts` が欠ける行がちょうどこの 7 件になる**）
 *
 * **直った値の実物は `akita-votes-pdf.test.ts` の `PAGE_NUMBER_ROWS` に 10 行ぶん置いてある**
 * （**議案名・`counts`・`○`/`×` の数まで固定してあり、直っても増えても減っても落ちる**）。
 */
/**
 * **秋田で公表数が記号の数と合わない行。**
 *
 * ## **#829 で 5 行とも直った。この表は空になった。**
 *
 * **空にしただけではない**——**下のテストは母数（`counts` のある行の数）を一緒に固定してある**ので、
 * **`counts` を全部捨てる変異でも落ちる**（`akita-votes-pdf.test.ts` の変異 4a で確かめた）。
 * **この配列は消さずに残す**——**新しい機序で 1 行でも合わなくなったら、ここに実物が並ぶ。**
 */
const KNOWN_BAD_AKITA: string[] = [];

test("#819 秋田: 公表数が記号の数と合わない行（#829 で 5 行とも直り、0 行になった）", async () => {
  const bad: string[] = [];
  let rows = 0, withCounts = 0;
  for (const f of list("akita")) {
    const b = await read("akita", f);
    if (!b) continue;
    const yes = symsFor(b.legend, "賛成");
    const no = symsFor(b.legend, "反対");
    for (const r of b.rows) {
      rows++;
      if (r.yes === undefined || r.no === undefined) continue;
      if (r.cells.every((c) => c === "不明")) continue;
      withCounts++;
      const gy = countIn(r.cells, yes);
      const gn = countIn(r.cells, no);
      if (gy !== r.yes || gn !== r.no) bad.push(`${f} ${r.label.slice(0, 46)}: 公表 yes=${r.yes} no=${r.no} / 記号 ○=${gy} ×=${gn}`);
    }
  }
  // ## **母数を固定する**（#757）——**「合わない行 0」を「1 行も比べていない」とすり替えさせない**
  // **`counts` のある行は #829 の前後で 103 のまま**（**実測して確かめた**）。
  // **偶然である**——**捏造されていた 5 行が母数から抜け、落ちていた 5 行が母数に入って釣り合った。**
  // **中身は 10 行入れ替わっているので、「変わらない＝何も起きていない」ではない。**
  assert.equal(rows, 213, "**母数**——秋田のフィクスチャ 6 本の全行");
  assert.equal(withCounts, 103, "**母数**——`counts` があり判定できた行（#829 の前後で変わらない。実測 103）");
  // **合わない行は 0 行**（**#829 が 5 行とも直した**）。**1 行でも増えたら落ちる。**
  assert.deepEqual(bad.sort(), [...KNOWN_BAD_AKITA].sort(), `公表数が記号の数と合わない行 ${bad.length}`);
  assert.equal(KNOWN_BAD_AKITA.length, 0, `**#829 が ${FIXED_BY_829} 行とも直したので、既知の壊れは 0 行**`);
});
