import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "node-html-parser";
import { parseVotePdf, type VotePdf } from "../src/sources/local/kochi/votes-pdf.ts";
import { parseChairs, chairOn } from "./kochi-chairman.ts";

/**
 * **高知の x（どの議員の列か）に 3 本目の錨を足す**（Issue #906 の後半）。
 *
 * ## 何が薄かったか
 *
 * **#876 が 2 本の錨を置いたが、本ごとに 1 本ずつしか効いていない**（#906）:
 *
 * | 本 | 錨A（`議` ⇔ 歴代議長） | 錨B（`除` ⇔ 件名の（○○議員）） |
 * |---|---|---|
 * | `080710.pdf`（令和8年6月） | **23/23、全回転で落ちる** | **`除` が 0 セル → 母数 0** |
 * | `0802.pdf`（令和8年2月） | **81 行すべてが議長交代の当日。`−1` が 0/81（穴）** | **`除` 1 セル。全回転で 1/1 落ちる** |
 *
 * **2 月の本は 81 行ぶんの x が `除` 1 セルに乗っている。**
 *
 * ## 足した錨C: **県の議員名簿（会派別）⇔ PDF の列の（氏名, 会派）**
 *
 * **一次資料**: 高知県議会「議員名簿」 https://gikai.pref.kochi.lg.jp/member/categories/
 * **（フィクスチャ `member-categories.html`。#220 で取得したものをそのまま使う）**
 * **表は会派ごとに「会派の見出し（自由民主党（20人））＋議員の行（議席番号・氏名・常任委員会・選挙区）」を繰り返す。**
 *
 * **ここが埋める穴**: **`rollcalls.ts` は `matchName(m.nameText, roster)` で氏名だけを名簿に寄せており、
 * 会派は PDF 側の値（`member.group`）をそのまま出力に入れている**（`kochi/rollcalls.ts:97`）。
 * **`name-match.ts` に `group` の文字列は 1 つも無い**——**会派は一度も突き合わされていない。**
 * **既存の `kochi-vote-alignment.test.ts` が見ているのは会派名の集合だけ**（`new Set(...)`。497 行目）
 * **で、「どの列がどの会派か」は見ていない。**
 *
 * ## **だがこの錨は「記号帯のずれ」を 1 件も捕まえない。そこは正直に書く**
 *
 * **測った結果（下のテストで固定する）**:
 *
 * | 壊し方 | 錨A（議長） | 錨B（除斥） | **錨C（名簿の会派）** |
 * |---|---|---|---|
 * | 無改造 | 0/81 | 0/1 | **0/36** |
 * | 記号帯だけ `+1` 列回転 | 81/81 | 1/1 | **0/36** ← **捕まえない** |
 * | 記号帯だけ `−1` 列回転 | **0/81（穴）** | 1/1 | **0/36** ← **捕まえない** |
 * | **氏名・会派・記号が一緒に `+1` 回転** | **0/81** | **0/1** | **0/36** ← **どれも捕まえない** |
 * | 氏名だけ `+1` 回転（会派はそのまま） | 0/81 | 1/1 | **6/36** |
 * | 会派帯だけ `+1` 回転 | 0/81 | 0/1 | **6/36** |
 *
 * **錨C は記号帯を見ていないので、記号帯の回転に対して恒真である。**
 * **つまり「錨A の `−1` の穴を錨C が塞ぐ」とは言えない**——**塞いでいるのは錨B のままである。**
 *
 * **錨C が塞ぐのは別の穴である**: **「列の氏名と会派の対応が壊れる」形。**
 * **これは今まで誰も見ていなかった**（`matchName` は会派を見ず、既存テストは集合しか見ない）。
 *
 * ## **#910 で自分が見つけたことを、この錨にも当てる**
 *
 * - **「回転で落ちる行数が多いほど錨が強い」とは読めない**——**錨C は `±1` で 6/36 しか落ちないが、
 *   それは「弱い」のではなく「自由民主党が 20 人続くので、回しても同じ会派に落ちる」からである。**
 *   **下で機序を数字ごと固定する。**
 * - **「全回転で全行落ちる」だけでは足りない**——**無改造で 0 であることと対で読む。**
 */

const T = new URL("./", import.meta.url);
const fx = (n: string): Buffer => readFileSync(new URL(`./fixtures/kochi/${n}`, T));
const txt = (n: string): string => fx(n).toString("utf-8");

const norm = (s: string): string => s.replace(/[\s　]/g, "").normalize("NFKC");
/** **回転**（ずらしではない）。端から出た要素は反対の端へ戻る。 */
const rot = <T,>(a: readonly T[], k: number): T[] => a.map((_, i) => a[(((i - k) % a.length) + a.length) % a.length]);

/* ============================================================ *
 * 一次資料: 県の議員名簿（会派別）
 * ============================================================ */

export interface RosterRow { group: string; seat: number; name: string }

/**
 * 議員名簿ページ → [会派, 議席番号, 氏名]。
 *
 * **会派の見出しは「自由民主党（20人）」の形で、人数は全角の数字のことがある**
 * （実測: `自由民主党（20人）` は半角、`一燈立志の会（２人）` は全角）——**NFKC で寄せてから読む。**
 * **氏名の欄は「氏名（ふりがな）」で、括弧は全角・半角の両方が来る**（実測: `浜口 卓也 （はまぐち たくや）` と
 * `戸田 宗崇 (とだ ひろたか)` が同じ表に混在する）。
 *
 * **`roster.ts`（実装）とは別に、この測定のために読み直している。**
 * **実装と同じ関数を使うと「実装が実装と一致する」しか言えない**ので、ここでは独立に読む。
 */
export function parseRosterRows(html: string): { rows: RosterRow[]; declared: { group: string; size: number }[] } {
  const table = parse(html).querySelectorAll("table")[0];
  if (!table) throw new Error("議員名簿の表が無い");
  const rows: RosterRow[] = [];
  const declared: { group: string; size: number }[] = [];
  let group = "";
  for (const tr of table.querySelectorAll("tr")) {
    const cells = tr.querySelectorAll("td,th").map((c) => c.text.replace(/[\s　]+/g, " ").trim());
    const first = (cells[0] ?? "").normalize("NFKC");
    // 会派の見出し行（人数つき）
    const g = first.match(/^(.+?)\((\d+)人\)$/);
    if (g) { group = g[1]; declared.push({ group, size: Number(g[2]) }); continue; }
    const seat = Number(first);
    if (!Number.isInteger(seat)) continue; // 列見出しの行など
    if (group === "") throw new Error(`議席 ${seat}: 会派の見出しより前に議員の行が出た`);
    // ふりがなの括弧を持つセルが氏名の欄（顔写真の空セルを飛ばす）
    const nameCell = cells.find((c, i) => i > 0 && /[（(]/.test(c) && /[ぁ-ん]/.test(c));
    if (!nameCell) throw new Error(`議席 ${seat}: 氏名の欄が読めない`);
    rows.push({ group, seat, name: nameCell.replace(/[（(].*$/, "").replace(/[\s　]+/g, "") });
  }
  if (rows.length === 0) throw new Error("議員名簿: 行が 1 つも読めなかった");
  return { rows, declared };
}

const { rows: roster, declared } = parseRosterRows(txt("member-categories.html"));
const gicho = parseChairs(txt("chairman.html"), "歴代議長");

/** 本番に出ている 2 本。**#876 のフィクスチャをそのまま使う**（新しく取得していない）。 */
const june = await parseVotePdf(fx("080710.pdf"));
const feb = await parseVotePdf(fx("0802.pdf"));
const BOOKS: { name: string; pdf: VotePdf }[] = [
  { name: "080710.pdf（令和8年6月）", pdf: june },
  { name: "0802.pdf（令和8年2月）", pdf: feb },
];

/* ============================================================ *
 * 錨C: 列の（氏名, 会派）⇔ 名簿
 * ============================================================ */

interface Cols { names: string[]; groups: string[] }
const colsOf = (pdf: VotePdf): Cols => ({ names: pdf.members.map((m) => m.nameText), groups: pdf.members.map((m) => m.group) });

/**
 * **錨C**: 列 i の氏名を名簿で引き、その会派が列 i の会派と一致するか。
 * **母数は「名簿に在った列の数」**（#757。**名簿に無い列は判定できないので数に入れない**）。
 */
function anchorC(c: Cols): { judged: number; mismatch: number; notInRoster: number } {
  let judged = 0, mismatch = 0, notInRoster = 0;
  for (let i = 0; i < c.names.length; i++) {
    const r = roster.find((x) => norm(x.name) === norm(c.names[i]));
    if (!r) { notInRoster++; continue; }
    judged++;
    if (norm(r.group) !== norm(c.groups[i])) mismatch++;
  }
  return { judged, mismatch, notInRoster };
}

test("#906 錨C の母数を先に固定する: 2 本とも 36 列すべてが名簿に在り、会派が一致する", () => {
  assert.equal(roster.length, 36, "名簿の議員");
  for (const b of BOOKS) {
    assert.equal(b.pdf.members.length, 36, `${b.name} の列`);
    const r = anchorC(colsOf(b.pdf));
    assert.equal(r.judged, 36, `${b.name}: **判定できた列**（母数が減れば以降は空回りする）`);
    assert.equal(r.notInRoster, 0, `${b.name}: 名簿に無い列`);
    assert.equal(r.mismatch, 0, `${b.name}: 会派が食い違った列`);
  }
});

test("#906 錨C の一次資料そのもの: 名簿は 6 会派 36 人で、公表の人数と実際の行数が一致する", () => {
  assert.deepEqual(declared, [
    { group: "自由民主党", size: 20 },
    { group: "一燈立志の会", size: 2 },
    { group: "公明党", size: 3 },
    { group: "自由の風", size: 1 },
    { group: "県民の会", size: 4 },
    { group: "日本共産党", size: 6 },
  ]);
  // **県が「（N人）」と書いた数と、実際に読めた行の数が会派ごとに一致する**
  // （**合計だけを見ると、ある会派で 1 人多く別の会派で 1 人少ない誤りが素通りする**）
  for (const d of declared) {
    assert.equal(roster.filter((r) => r.group === d.group).length, d.size, `${d.group} の行数`);
  }
  assert.equal(declared.reduce((a, d) => a + d.size, 0), 36, "合計");
});

test("#906 錨C は PDF 側の会派の帯とも一致する（会派ごとの人数が 6 会派とも合う）", () => {
  for (const b of BOOKS) {
    for (const d of declared) {
      const n = b.pdf.members.filter((m) => norm(m.group) === norm(d.group)).length;
      assert.equal(n, d.size, `${b.name} の ${d.group}`);
    }
  }
});

/* ============================================================ *
 * **この錨が捕まえないもの**（隠さない）
 * ============================================================ */

/** 錨A（`議` ⇔ 歴代議長）。**交代当日は前任も許す**（PDF が前後を書いていないため。#569） */
function anchorA(pdf: VotePdf, c: Cols, cells: string[][], date: string): { judged: number; mismatch: number } {
  const cur = chairOn(gicho, date);
  if (!cur) return { judged: 0, mismatch: 0 };
  const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1);
  const prev = chairOn(gicho, d.toISOString().slice(0, 10));
  let judged = 0, mismatch = 0;
  for (const row of cells) {
    const idx = row.flatMap((x, i) => (x === "議" ? [i] : []));
    if (idx.length !== 1) continue;
    judged++;
    const got = norm(c.names[idx[0]]);
    if (got !== norm(cur.name) && !(prev && got === norm(prev.name))) mismatch++;
  }
  return { judged, mismatch };
}

/** 錨B（`除` ⇔ 同じ行の件名の（○○議員）） */
function anchorB(pdf: VotePdf, c: Cols, cells: string[][]): { judged: number; mismatch: number } {
  let judged = 0, mismatch = 0;
  for (const [i, row] of cells.entries()) {
    const idx = row.flatMap((x, j) => (x === "除" ? [j] : []));
    if (idx.length !== 1) continue;
    const m = norm(pdf.rows[i].title).match(/[（(]([^（）()]+?)議員[）)]/);
    if (!m) continue;
    judged++;
    if (!norm(c.names[idx[0]]).startsWith(m[1])) mismatch++;
  }
  return { judged, mismatch };
}

/**
 * **本題**: **錨C は記号帯の回転を 1 件も捕まえない。**
 *
 * **錨C が見ているのは「列の氏名」と「列の会派」だけで、記号帯を見ていない。**
 * **だから記号帯を何列回しても結果が 1 つも変わらない**——**恒真である。**
 * **これは欠陥ではなく役割分担だが、「3 本目の錨ができたから安全になった」とは言えない。**
 */
test("#906 **錨C は記号帯の回転を 1 件も捕まえない**（恒真。錨A/錨B の代わりにならない）", () => {
  for (const b of BOOKS) {
    const c = colsOf(b.pdf);
    const base = anchorC(c);
    for (const k of [1, 2, -1, -2, 7, 17]) {
      // **記号帯だけを回す**（氏名も会派も動かさない）——**錨C は記号帯を引数に取らない**
      const rotated = b.pdf.rows.map((r) => rot(r.cells, k));
      assert.equal(rotated.length, b.pdf.rows.length, "回転で行数は変わらない");
      // **錨C の結果は記号帯に依存しない**ので、回す前と 1 つも変わらない
      assert.deepEqual(anchorC(c), base, `${b.name}: 記号帯を ${k} 列回しても錨C は変わらない`);
    }
    assert.equal(base.mismatch, 0);
  }
});

test("#906 錨A の `−1` の穴を塞いでいるのは、錨C ではなく錨B のままである", () => {
  const c = colsOf(feb);
  const cells = feb.rows.map((r) => r.cells.slice());
  // **無改造**
  assert.deepEqual(anchorA(feb, c, cells, "2026-03-24"), { judged: 81, mismatch: 0 });
  assert.deepEqual(anchorB(feb, c, cells), { judged: 1, mismatch: 0 });
  // **`−1` 列回転: 錨A は 0/81 で落ちない**（前任と後任が隣の列に居るため）
  const minus1 = cells.map((r) => rot(r, -1));
  assert.equal(anchorA(feb, c, minus1, "2026-03-24").mismatch, 0, "**錨A は −1 を捕まえない**");
  // **錨B は 1/1 落ちる**
  assert.equal(anchorB(feb, c, minus1).mismatch, 1, "錨B は −1 を捕まえる");
  // **錨C は 0/36 のまま**——**塞いでいない**
  assert.equal(anchorC(c).mismatch, 0, "**錨C は −1 を捕まえない**");
  // **`+1` では錨A も落ちる**
  assert.equal(anchorA(feb, c, cells.map((r) => rot(r, 1)), "2026-03-24").mismatch, 81);
});

/**
 * **では錨C は何を塞ぐのか**——**「列の氏名と会派の対応が壊れる」形。**
 *
 * **今まで誰も見ていなかった**: **`rollcalls.ts` は氏名だけを名簿に寄せ（`matchName`）、
 * 会派は PDF 側の値をそのまま出力に入れている。** **`name-match.ts` に `group` は 1 つも無い。**
 */
test("#906 錨C が塞ぐ穴: 氏名だけ / 会派帯だけがずれる形を捕まえる（6 / 36）", () => {
  for (const b of BOOKS) {
    const c = colsOf(b.pdf);
    for (const k of [1, -1]) {
      // **氏名の列だけを回す**（会派の帯はそのまま）
      assert.equal(anchorC({ names: rot(c.names, k), groups: c.groups }).mismatch, 6, `${b.name}: 氏名を ${k} 回転`);
      // **会派の帯だけを回す**（氏名はそのまま）
      assert.equal(anchorC({ names: c.names, groups: rot(c.groups, k) }).mismatch, 6, `${b.name}: 会派を ${k} 回転`);
    }
    // **2 列以上回せばもっと落ちる**
    assert.equal(anchorC({ names: c.names, groups: rot(c.groups, 2) }).mismatch, 11);
    assert.equal(anchorC({ names: c.names, groups: rot(c.groups, 7) }).mismatch, 23);
    assert.equal(anchorC({ names: c.names, groups: rot(c.groups, 17) }).mismatch, 32);
  }
});

/**
 * **`±1` で 6 / 36 しか落ちない理由を機序ごと固定する**（#910 で PO と合意した読み方）。
 *
 * **「落ちる行数が少ない = 弱い」ではない。**
 * **自由民主党が 20 人続くので、1 列回しても 18 列は同じ会派の中に落ちる**——
 * **会派の境目をまたいだ列だけが落ちる。** **境目は 6 会派なので 6 か所。**
 */
test("#906 錨C が `±1` で 6 / 36 なのは「会派の境目が 6 か所」だから（弱さではない）", () => {
  const c = colsOf(feb);
  // **会派の帯は 6 つの連続した区間**（並べ替えられていない）
  const runs: { group: string; from: number; to: number }[] = [];
  c.groups.forEach((g, i) => {
    const last = runs[runs.length - 1];
    if (last && norm(last.group) === norm(g)) last.to = i;
    else runs.push({ group: g, from: i, to: i });
  });
  assert.equal(runs.length, 6, "会派は 6 つの連続した区間（同じ会派が離れて 2 か所に出ない）");
  assert.deepEqual(runs.map((r) => `${r.group}:${r.to - r.from + 1}`), [
    "自由民主党:20", "一燈立志の会:2", "公明党:3", "自由の風:1", "県民の会:4", "日本共産党:6",
  ]);
  // **区間の数 == `±1` 回転で落ちる列の数**
  assert.equal(anchorC({ names: c.names, groups: rot(c.groups, 1) }).mismatch, runs.length);
  // **20 人の会派の内側 19 列は、1 列回しても同じ会派のまま**——**だから落ちない**
  assert.equal(runs[0].to - runs[0].from + 1, 20, "自由民主党");
  // **「落ちる行数が多いほど強い」とは読めない**（#910 の実測と同じ向き）
  assert.ok(anchorC({ names: c.names, groups: rot(c.groups, 17) }).mismatch > anchorC({ names: c.names, groups: rot(c.groups, 1) }).mismatch,
    "17 列回すほうが多く落ちるが、それは 17 のほうが「危ない」という意味ではない");
});

/**
 * **3 本そろっても捕まえられない形が 1 つ残る**——**隠さずに固定する。**
 *
 * **氏名・会派・記号が「一緒に」1 列ずれた場合、3 本とも緑になる。**
 * **錨A は `議` の列の氏名を見るが、氏名も一緒に動くので合ってしまう。**
 * **錨B も同じ。錨C は氏名と会派が一緒に動くので合ってしまう。**
 *
 * **ただしこの形は、実装では列の数が変わるので別の検査が落ちる**（下で機序を測る）。
 */
test("#906 **3 本とも捕まえられない形が残る**: 氏名・会派・記号が一緒に 1 列ずれる", () => {
  const c = colsOf(feb);
  const shifted: Cols = { names: rot(c.names, 1), groups: rot(c.groups, 1) };
  const cells = feb.rows.map((r) => rot(r.cells, 1));
  assert.equal(anchorA(feb, shifted, cells, "2026-03-24").mismatch, 0, "**錨A は捕まえない**");
  assert.equal(anchorB(feb, shifted, cells).mismatch, 0, "**錨B も捕まえない**");
  assert.equal(anchorC(shifted).mismatch, 0, "**錨C も捕まえない**");
  // **母数は 3 本とも減っていない**（「判定できなかった」ではなく「判定して緑だった」）
  assert.equal(anchorA(feb, shifted, cells, "2026-03-24").judged, 81);
  assert.equal(anchorB(feb, shifted, cells).judged, 1);
  assert.equal(anchorC(shifted).judged, 36);
});

test("#906 その形が実装で起きるには列の数が変わる（議員の列は 10.8pt の等間隔で 35 の隙間）", async () => {
  // **`voteCols = nameXs`**（`votes-pdf.ts:320`）——**列境界は氏名の段を区切る縦線そのものである。**
  // **その縦線を 1 本取りこぼすと列が 1 つ減るので、「36 列」の検査が落ちる。**
  // **列数を保ったまま全部が 1 列ずれるには、縦線の集合が丸ごと平行移動する必要がある。**
  const { readPages } = await import("../src/sources/local/pdf-table.ts");
  const pages = await readPages(fx("0802.pdf"));
  const xs = [...new Set(pages[0].vlines.map((l) => Number(l.x.toFixed(1))))].sort((a, b) => a - b);
  const gaps = xs.slice(1).map((x, i) => Number((x - xs[i]).toFixed(1)));
  const tally = new Map<number, number>();
  for (const g of gaps) tally.set(g, (tally.get(g) ?? 0) + 1);
  // **10.8pt の隙間が 35 個**——**議員の列 36 の間隔である**
  assert.equal(tally.get(10.8), 35, "議員の列の等間隔");
  assert.equal(xs.length, 45, "ページ 1 の相異なる縦線の x");
  // **だから「列数が同じまま全部ずれる」は、この PDF の罫線からは作れない。**
  // **列数そのものは 2 本とも 36 で固定してある**（上の母数のテスト）。
});

/* ============================================================ *
 * **この錨が「今まで見られていなかった」ことの証拠**
 * ============================================================ */

test("#906 会派は一度も突き合わされていなかった（`matchName` は氏名だけを見る）", () => {
  const nameMatch = readFileSync(new URL("../src/sources/local/name-match.ts", T), "utf8");
  // **`name-match.ts` に `group` の文字列が 1 つも無い**——**会派は照合に使われていない**
  assert.equal(nameMatch.includes("group"), false, "`name-match.ts` は会派を見ていない");
  // **`rollcalls.ts` は PDF 側の会派をそのまま出力に入れている**
  const rollcalls = readFileSync(new URL("../src/sources/local/kochi/rollcalls.ts", T), "utf8");
  assert.match(rollcalls, /group:\s*member\.group/, "PDF 側の会派をそのまま出す");
  // **既存の測定テストは会派名の「集合」しか見ていない**（どの列がどの会派かは見ない）
  const align = readFileSync(new URL("./kochi-vote-alignment.test.ts", T), "utf8");
  assert.match(align, /new Set\(june8\.members\.map\(\(m\) => m\.group\)\)/, "集合だけを見ている");
});

test("#906 錨C の要: 名簿の氏名を 1 つ書き換えると落ちる（名簿を見ていることの確認）", () => {
  const c = colsOf(feb);
  // **名簿の側で 下村勝幸 の会派を変えると、その列だけが落ちる**
  const tampered = roster.map((r) => (norm(r.name) === norm("下村勝幸") ? { ...r, group: "日本共産党" } : r));
  let mismatch = 0;
  for (let i = 0; i < c.names.length; i++) {
    const r = tampered.find((x) => norm(x.name) === norm(c.names[i]));
    if (!r) continue;
    if (norm(r.group) !== norm(c.groups[i])) mismatch++;
  }
  assert.equal(mismatch, 1, "名簿を 1 か所変えると 1 列落ちる");
});

/* ============================================================ *
 * **609 行の「2 人のどちらか」は減らせなかった**——**何を試したかを書く**
 * ============================================================ */

/**
 * **#906 の 2 つ目の課題**: **「議長交代日の前後を一次資料で特定できれば、その日の行も判定できる」。**
 *
 * **結論: できなかった。** **試した一次資料と、なぜ駄目だったかを残す**
 * （**「厚くできない県は『できない』と書くこと。それも結論である」**——#906）。
 *
 * | 試した一次資料 | 取得 | なぜ使えなかったか |
 * |---|---|---|
 * | **賛否 PDF 自身**（`0802.pdf`） | フィクスチャ | **81 行の議決年月日が全部 `R8.3.24`**（5 行が原文、76 行が `〃`）。**議事の順も、議長選挙の行も書いていない** |
 * | **会期詳細ページ**（`decision-2026-02.html`） | フィクスチャ | **「議長」「副議長」が 1 回ずつ出るだけ**（議決結果一覧の中の語）。**選挙の日時も議事順も無い** |
 * | **議長・副議長ページ**（`chairman.html`） | フィクスチャ | **就任日（`R08.03.24`）までしか書いていない。** **その日の何番目の議事だったかは無い** |
 * | **こうち県議会だより 第109号** | **2026-09-17 取得、HTTP 200、2,904,463 バイト、8 ページ** | **文字層が無い**（**8 ページで文字アイテムが合計 9 個**。スキャン画像）。**徳島（#875）はこれで境目を確定できたが、高知は読めない** |
 * | **会議録** | `/minutes/` は HTTP 200、12,144 バイト | **県のページには「欠席」の語が 0 回。** **本体は別ドメインの検索システム**（`kensakusystem.jp`）で、**このリポジトリが取得している県のサイトの外**である。**別ドメインは robots も取得規約も別なので、ここでは開かない** |
 *
 * **だから「交代当日は前任も後任も許す」を続ける。** **推定で決めない**（#569 / #796）。
 */
test("#906 609 行を減らせない根拠①: PDF の 81 行は議決日が全部同じで、議事の順を書いていない", () => {
  const dates = new Map<string, number>();
  for (const r of feb.rows) dates.set(r.dateText, (dates.get(r.dateText) ?? 0) + 1);
  // **5 行が `R8.3.24` の原文、76 行が `〃`**——**どれも同じ 1 日である**
  assert.deepEqual(Object.fromEntries(dates), { "R8.3.24": 5, "〃": 76 });
  assert.equal(feb.rows.length, 81);
  // **件名に「議長」「選挙」を含む行が 1 つも無い**——**議長選挙は賛否 PDF に載らない**
  assert.equal(feb.rows.filter((r) => /議[長⾧]|選挙/.test(r.title)).length, 0, "議長選挙の行");
});

test("#906 609 行を減らせない根拠②: 議長ページは就任日までで、その日の議事順を書いていない", () => {
  const cur = chairOn(gicho, "2026-03-24");
  const prev = chairOn(gicho, "2026-03-23");
  assert.equal(norm(cur!.name), "明神健夫", "当日就任した議長");
  assert.equal(norm(prev!.name), "三石文隆", "前日の議長");
  // **PDF の `議` は 81 行すべて 三石文隆**（前任）である
  const names = feb.members.map((m) => m.nameText);
  const cols = new Set(feb.rows.map((r) => r.cells.findIndex((c) => c === "議")));
  assert.equal(cols.size, 1, "`議` の列は 81 行とも同じ");
  assert.equal(norm(names[[...cols][0]]), "三石文隆");
  // **どちらが「正しい」かは、どちらの一次資料にも書かれていない。だから決めない**（#569）
  assert.notEqual(norm(cur!.name), norm(prev!.name), "2 人は別人である");
});

/* ============================================================ *
 * **同じ表を 2 か所に持っている件**（#910 で PO に報告した「自信が無い点」）
 * ============================================================ */

/**
 * **#910 で書いた懸念**: **奈良と宮城の歴代議長の表を、`local-x-anchor-rotation.test.ts` が
 * `*-vote-alignment.test.ts` から写している。** **同じ表が 2 か所にあると、片方だけ直したときに食い違う。**
 *
 * **PO の指示は「共有ヘルパに切り出す。ただし別 PR で」。**
 * **この PBI では切り出さない**（範囲が高知だからで、やらない理由は下に書く）。
 * **代わりに「2 か所が食い違ったら落ちる」検査をここに置く**——
 * **切り出すまでの間、食い違いを黙って通さないため。**
 *
 * **高知・鳥取・島根は一次資料から機械的に読んでいるので、この問題を持たない**
 * （`kochi-chairman.ts` の `parseChairs` / 鳥取の `readChairTables` / 島根の `parseSpeakers`）。
 * **手で写しているのは 奈良・宮城・三重 の 3 県である**（実測）。
 */
test("#906 手で写した歴代議長の表が 2 か所で食い違っていない（切り出すまでの見張り）", () => {
  const rot = readFileSync(new URL("./local-x-anchor-rotation.test.ts", T), "utf8");
  const nara = readFileSync(new URL("./nara-vote-alignment.test.ts", T), "utf8");
  const miyagi = readFileSync(new URL("./miyagi-vote-alignment.test.ts", T), "utf8");
  /** `{ from: "2024-07-03", name: "中野雅史" }` の形を全部拾って正規化する。 */
  const pick = (src: string, marker: string): string[] => {
    const at = src.indexOf(marker);
    assert.ok(at >= 0, `${marker} が見つからない`);
    // **配列リテラルの閉じ `];` までで切る**（次の配列＝副議長の表まで読まないため）
    const end = src.indexOf("];", at);
    assert.ok(end > at, `${marker} の配列の終わりが見つからない`);
    const body = src.slice(at, end);
    return [...body.matchAll(/\{\s*(?:term:\s*"[^"]*",\s*)?(?:from|name):\s*"([^"]+)",\s*(?:from|name):\s*"([^"]+)"/g)]
      .map((m) => `${m[1]}|${m[2]}`);
  };
  // **奈良**: 3 行が両方に在り、同じであること
  const naraA = pick(nara, "const SPEAKERS"), naraB = pick(rot, "const NARA_SPEAKERS");
  assert.equal(naraA.length, 3, "奈良の歴代議長の行");
  assert.deepEqual(naraB, naraA, "**奈良の表が 2 か所で食い違っている**");
  // **宮城**: 6 行が両方に在り、氏名と就任日が同じであること
  const miyagiA = pick(miyagi, "const CHAIRS"), miyagiB = pick(rot, "const MIYAGI_CHAIRS");
  assert.equal(miyagiA.length, 6, "宮城の歴代議長の行");
  assert.deepEqual(miyagiB, miyagiA, "**宮城の表が 2 か所で食い違っている**");
});
