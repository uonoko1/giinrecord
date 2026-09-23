import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseResultsPdf, parseVotePdf, type VotePdf, type VoteRow } from "../src/sources/local/shimane/votes-pdf.ts";
import { readPages } from "../src/sources/local/pdf-table.ts";

/**
 * 島根県議会の表決 PDF の **行と列の対応** を、**県が別に公表している一次資料**に結んで見張る（Issue #874）。
 *
 * **既存の `shimane-votes-pdf.test.ts` は氏名・件名・記号を逐語で固定している。**
 * **それは「今日の PDF をこう読んだ」の記録であって、「列の割り当てが正しい」の根拠ではない**
 * ——**名簿の並びと記号帯の並びが揃って狂えば、逐語の固定は 1 件も落ちない。**
 *
 * **この測定で外の事実に結んだのは 2 つ:**
 *   1. **`議⾧`/`議長` のセルが立つ列の議員 == 県が公表している歴代議長**（x 方向）
 *      一次資料: 島根県議会「歴代議長・副議長一覧」 https://www.pref.shimane.lg.jp/gikai/gityou/gityou-2.html
 *      からリンクされた PDF（`rekidai-gicho.pdf`。2026-09-16 取得、HTTP 200、251,485 バイト）。
 *   2. **各議案の `result` == 同じ会期ページの「議決結果一覧」PDF のその議案の議決結果**（y 方向）
 *      表決 PDF とは**別のファイル**なので、表決 PDF の中だけで閉じない。
 *
 * **加えて PDF の中で閉じた検算を 2 つ置く**（外に結べない行を埋めるため）:
 *   3. **公表の賛成者数・反対者数 == その行の `○`・`●` の数**（y 方向。**x は 1 件も捕まえない**——下のテストで固定する）
 *   4. **「(副)議長辞職」の行 ⇒ 除斥 が立つのは県公表の直前の (副)議長**（y と x の両方）
 *
 * **「半セル未満か」は根拠にしない**（PO が #871 で実測: **1 列ずらしても 98% が「半セル未満」**。ほぼ恒真）。
 * **測るのは回転だけである**（ずらしは「空の列に落ちた」という安い理由で落ちるので根拠にならない）。
 */
const fixture = (name: string): Buffer => readFileSync(new URL(`./fixtures/shimane/${name}`, import.meta.url));

/**
 * **x の錨を当てる本。**
 *
 * **#901 で既定を 2 → 5 会期に広げたので、増えた 3 会期（2025-11 / 2025-09 / 2025-06）をここに足した**——
 * **「件数が増えた」は「正しく増えた」ではない**ので、**増えたぶんにも錨を当てる**（#819 / #901）。
 * **2024-06 は既定の外だが、作りが違う本として残す**（Producer が DocuWorks・議員 36 人）。
 *
 * **`decidedOn` は議決結果一覧 PDF から読んだ最大の議決日**（逐語で写さず、下の検算で突き合わせる）。
 * **`resignedOn` は歴代議長一覧 PDF にある就任日**——**その日に議長が代わっている会期だけ入る。**
 */
const BOOKS: { sessionId: string; vote: string; results: string; /** 会期の議決日（歴代議長を引くための日） */ decidedOn: string; /** 議長辞職があった日（無ければ空） */ resignedOn: string }[] = [
  { sessionId: "2026-06", vote: "r0806_giinbetu_kekka.pdf", results: "r0806_giketu_kekka.pdf", decidedOn: "2026-07-02", resignedOn: "2026-06-09" },
  { sessionId: "2026-02", vote: "r0802_giinbetu_kekka.pdf", results: "r0802_giketu_kekka.pdf", decidedOn: "2026-03-25", resignedOn: "" },
  // **#901 で増えた 3 会期**
  { sessionId: "2025-11", vote: "r0711_giinbetu_kekka.pdf", results: "r0711_giketu_kekka.pdf", decidedOn: "2025-12-19", resignedOn: "" },
  { sessionId: "2025-09", vote: "r0709_giinbetu_kekka.pdf", results: "r0709_giketu_kekka.pdf", decidedOn: "2025-10-09", resignedOn: "" },
  { sessionId: "2025-06", vote: "r0706_giinbetu_kekka.pdf", results: "r0706_giketu_kekka.pdf", decidedOn: "2025-07-02", resignedOn: "2025-06-09" },
  { sessionId: "2024-06", vote: "r0606_giinbetu_kekka.pdf", results: "r0606_giketu_kekka.pdf", decidedOn: "2024-06-28", resignedOn: "2024-06-10" },
];

const books = new Map<string, { pdf: VotePdf; results: Map<string, { date: string; result: string }> }>();
for (const b of BOOKS) books.set(b.sessionId, { pdf: await parseVotePdf(fixture(b.vote)), results: await parseResultsPdf(fixture(b.results)) });

/* ---------- 歴代議長・副議長（県公表 PDF を機械的に読む。逐語で写さない） ---------- */

/**
 * 「歴代議長・副議長一覧」PDF → [就任日(ISO), 氏名] の列。
 * **左に議長・右に副議長の 2 つの表が横に並んでおり、代の番号も氏名も違う**
 * （例: 令和8年6月9日に **議長 83代 山根成二** と **副議長 93代 吉田雅紀** が同時に就任している）。
 * **取り違えると錨そのものが嘘になるので、x で左右を分ける。**
 * 行の形は `{代} {氏名} {和暦の日付}` が左右に 1 組ずつ（副議長だけの行・議長だけの行もある）。
 */
export function parseSpeakers(bytes: Buffer, pages: Awaited<ReturnType<typeof readPages>>): { speakers: [string, string][]; vices: [string, string][] } {
  const speakers: [string, string][] = [];
  const vices: [string, string][] = [];
  for (const page of pages) {
    // 行にまとめる
    const byY = new Map<number, typeof page.items>();
    for (const it of page.items) {
      const k = [...byY.keys()].find((v) => Math.abs(v - it.y) < 3) ?? it.y;
      if (!byY.has(k)) byY.set(k, []);
      byY.get(k)!.push(it);
    }
    // 「議長」「副議長」の見出しの x で左右を分ける
    const headSpk = page.items.find((i) => i.str.trim() === "議長");
    const headVic = page.items.find((i) => i.str.trim() === "副議長");
    if (!headSpk || !headVic) continue;
    const split = (headSpk.x + headSpk.w + headVic.x) / 2;
    for (const [, items] of byY) {
      for (const [side, list] of [["L", speakers], ["R", vices]] as const) {
        const inSide = items.filter((i) => (side === "L" ? i.x < split : i.x >= split)).sort((a, b) => a.x - b.x);
        const line = inSide.map((i) => i.str).join(" ").replace(/[\s　]+/g, " ").trim().normalize("NFKC");
        // **氏名に空白が入る行がある**（`82 池田 一 令和7年6月9日`）ので `\S+?` では取りこぼす。
        // 代の番号と和暦の日付に挟まれた部分を氏名とし、**中の空白は落とす**（表決 PDF の氏名も空白なしで繋ぐ）。
        const m = line.match(/^(\d+)\s+(.+?)\s+(昭和|平成|令和)(\d+|元)年(\d{1,2})月(\d{1,2})日$/);
        if (!m) continue;
        const y = m[3] === "令和" ? 2018 + (m[4] === "元" ? 1 : Number(m[4])) : m[3] === "平成" ? 1988 + (m[4] === "元" ? 1 : Number(m[4])) : 1925 + (m[4] === "元" ? 1 : Number(m[4]));
        const iso = `${y}-${String(Number(m[5])).padStart(2, "0")}-${String(Number(m[6])).padStart(2, "0")}`;
        const name = m[2].replace(/[\s　]+/g, "");
        if (name === "〃") continue; // 同じ人の再任（前の行と同じ氏名。錨に使わない）
        list.push([iso, name]);
      }
    }
  }
  speakers.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  vices.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { speakers, vices };
}

const rekidaiBytes = fixture("rekidai-gicho.pdf");
const { speakers, vices } = parseSpeakers(rekidaiBytes, await readPages(rekidaiBytes));
/** その日に在職している人（就任日 <= iso の最後の行）。 */
const on = (tbl: [string, string][], iso: string): string => { let s = ""; for (const [d, n] of tbl) if (d <= iso) s = n; return s; };
/** その日の**直前**に在職していた人（就任日 < iso の最後の行）。辞職の行の除斥に使う。 */
const before = (tbl: [string, string][], iso: string): string => { let s = ""; for (const [d, n] of tbl) if (d < iso) s = n; return s; };

/** 配列を k だけ回す（**ずらしではなく回転**。端の要素は反対側へ回る）。 */
const rot = <T>(a: readonly T[], k: number): T[] => a.map((_, i) => a[(i - (k % a.length) + a.length * 2) % a.length]);

/** 検算のために「どう壊すか」を差し込める見え方。無改造なら素通し。 */
interface View { cells: string[][]; titles: string[]; results: string[]; members: string[] }
const view = (pdf: VotePdf, m: { cellRow?: number; cellCol?: number; title?: number; result?: number; member?: number } = {}): View => {
  let cells = pdf.rows.map((r) => r.cells.slice());
  if (m.cellCol) cells = cells.map((c) => rot(c, m.cellCol!));
  if (m.cellRow) cells = rot(cells, m.cellRow);
  return {
    cells,
    titles: m.title ? rot(pdf.rows.map((r) => r.title), m.title) : pdf.rows.map((r) => r.title),
    results: m.result ? rot(pdf.rows.map((r) => r.result), m.result) : pdf.rows.map((r) => r.result),
    members: m.member ? rot(pdf.members, m.member) : pdf.members,
  };
};

const isGicho = (c: string): boolean => /^議[長⾧]$/.test(c);
const isResignRow = (t: string): boolean => /議[長⾧]辞職/.test(t);

/* ---------- 検算B（x）: 「議」の列の議員 == 県公表の歴代議長 ---------- */

/**
 * @returns 判定できた行数（母数）と一致しなかった行数。**母数を返す**（#757。母数を書かずに「全部一致」と書かない）
 *
 * ## **議長辞職の当日は、議長席が 2 人になる**（#901 で 2025-06 でも観測）
 *
 * **辞職の議案そのもの以外にも、その日は副議長が議長席に座る行がある**——
 * **2025-07-02 の `特別委員会の設置` / `特別委員の選任` が 高橋雅彦（副議長）である**（実測）。
 * **2026-06 でも同じ形が出ている。**
 *
 * **だから辞職があった会期では「新しい議長」か「その日の直前の副議長」のどちらかを許す。**
 * **緩めているように見えるが、許すのは 2 人だけで、35 人のうち残り 33 人は落ちる**——
 * **列が 1 つでも回れば、この 2 人以外が議長席に来るので落ちる**（下の回転のテストで確かめている）。
 */
function checkB(sessionId: string, v: View, table: [string, string][] = speakers, allowAlt = true): { n: number; bad: number } {
  const { pdf } = books.get(sessionId)!;
  const b = BOOKS.find((x) => x.sessionId === sessionId)!;
  const want = on(table, b.decidedOn);
  // **辞職のあった会期だけ、その日に在職している副議長も許す**（議長席に座るのはこの 2 人のどちらか）
  const alt = allowAlt && b.resignedOn ? on(table === speakers ? vices : speakers, b.decidedOn) : "";
  let n = 0, bad = 0;
  for (const [i, row] of pdf.rows.entries()) {
    // 議長辞職の議案そのものは 除斥 が絡むので母数から外す（下の検算A で別に見る）
    if (isResignRow(row.title)) continue;
    n++;
    const who = v.cells[i].map((c, ci) => (isGicho(c) ? v.members[ci] : null)).filter((x): x is string => x !== null);
    if (who.length !== 1 || (who[0] !== want && !(alt !== "" && who[0] === alt))) bad++;
  }
  return { n, bad };
}

/* ---------- 検算C（y）: 公表の賛成者数・反対者数 == その行の ○・● の数 ---------- */

function checkC(sessionId: string, v: View): { n: number; bad: number } {
  const { pdf } = books.get(sessionId)!;
  let n = 0, bad = 0;
  for (const [i, row] of pdf.rows.entries()) {
    n++;
    if (v.cells[i].filter((c) => c === "○").length !== row.counts.yes || v.cells[i].filter((c) => c === "●").length !== row.counts.no) bad++;
  }
  return { n, bad };
}

/* ---------- 検算E（y）: result == 議決結果一覧 PDF（別の一次資料） ---------- */

function checkE(sessionId: string, v: View): { n: number; bad: number } {
  const { pdf, results } = books.get(sessionId)!;
  let n = 0, bad = 0;
  for (const [i, row] of pdf.rows.entries()) {
    const want = results.get(row.number.normalize("NFKC"));
    if (!want) continue; // 請願・その他表決は議決結果一覧に載らない
    n++;
    if (v.results[i] !== want.result) bad++;
  }
  return { n, bad };
}

/* ---------- 検算A（y と x）: 辞職の行の 除斥 == 県公表の直前の (副)議長 ---------- */

function checkA(sessionId: string, v: View): { n: number; bad: number } {
  const { pdf } = books.get(sessionId)!;
  const d = BOOKS.find((b) => b.sessionId === sessionId)!.resignedOn;
  if (!d) return { n: 0, bad: 0 };
  const oldSpk = before(speakers, d), oldVic = before(vices, d);
  let n = 0, bad = 0;
  for (let i = 0; i < pdf.rows.length; i++) {
    const t = v.titles[i];
    const isVice = /副議[長⾧]辞職/.test(t);
    const isSpk = !isVice && isResignRow(t);
    if (!isVice && !isSpk) continue;
    n++;
    const who = v.cells[i].map((c, ci) => (/除斥/.test(c) ? v.members[ci] : null)).filter((x): x is string => x !== null);
    if (who.length !== 1 || who[0] !== (isVice ? oldVic : oldSpk)) bad++;
  }
  return { n, bad };
}

const sum = (f: (sid: string, v: View) => { n: number; bad: number }, m: Parameters<typeof view>[1] = {}): { n: number; bad: number } => {
  let n = 0, bad = 0;
  for (const b of BOOKS) { const r = f(b.sessionId, view(books.get(b.sessionId)!.pdf, m)); n += r.n; bad += r.bad; }
  return { n, bad };
};

/* ================= テスト ================= */

test("#874 歴代議長・副議長一覧 PDF を県の公表から機械的に読む（錨そのものが読めているか）", () => {
  // 議長と副議長は**別の表**で、同じ日に別の人が就任する。左右を取り違えると錨が嘘になる。
  // **`〃`（前の行と同じ人の再任）の行は錨に使わないので数から外してある。**
  // 表の代の番号は 議長 83代・副議長 93代 まであるが、読める行は下の数になる。
  assert.equal(speakers.length, 56, "錨に使える議長の行");
  assert.equal(vices.length, 70, "錨に使える副議長の行");
  assert.equal(on(speakers, "2026-07-02"), "山根成二");
  assert.equal(on(vices, "2026-07-02"), "吉田雅紀");
  assert.equal(on(speakers, "2026-03-25"), "池田一");
  assert.equal(on(speakers, "2024-06-28"), "中島謙二");
  // **同じ日に議長と副議長が違う人である**ことを固定する（左右の取り違えを落とす）
  assert.notEqual(on(speakers, "2026-07-02"), on(vices, "2026-07-02"));
  assert.notEqual(on(speakers, "2024-06-28"), on(vices, "2024-06-28"));
});

test("#874 検算B（x）: 「議」の列の議員 == 県公表の歴代議長（無改造）", () => {
  const r = sum(checkB);
  // **母数を検算に入れる**（#757）。母数が減れば「静かに空回り」するので、先に母数を固定する
  assert.equal(r.n, 255, "判定できた行の数が変わった（母数が減ると「一致 0 件」は意味を失う）");
  assert.equal(r.bad, 0);
});

test("#874 検算B は x の回転で全行落ちる（記号帯を 1 列 / 2 列 / −1 列）", () => {
  for (const k of [1, 2, -1]) {
    const r = sum(checkB, { cellCol: k });
    assert.equal(r.n, 255);
    assert.equal(r.bad, 255, `記号帯を ${k} 列回しても ${r.bad} 行しか落ちない`);
  }
  // 名簿の側を回しても同じだけ落ちる（列の対応は「記号と議員の対」であって、どちらを回しても同じ）
  const m = sum(checkB, { member: 1 });
  assert.equal(m.bad, 255);
});

test("#874 検算B は y をほとんど捕まえない（x しか見ていない証拠。**これが検算C・E が要る理由**）", () => {
  // 記号帯だけを行方向に回しても、議長の列は議長の列のまま
  assert.equal(sum(checkB, { cellRow: 1 }).bad, 0);
  assert.equal(sum(checkB, { cellRow: 2 }).bad, 0);
  // −1 行だけは 3 行落ちる（辞職の行が母数の外から中へ回り込むため）。**「y も見ている」ではない**
  assert.equal(sum(checkB, { cellRow: -1 }).bad, 3);
});

test("#874 検算C（y）: 公表の賛成者数・反対者数 == その行の ○・● の数（無改造）", () => {
  const r = sum(checkC);
  assert.equal(r.n, 267, "母数（錨を当てた 6 本の行の合計）");
  assert.equal(r.bad, 0);
});

test("#874 検算C は y の回転で落ちるが、**x の回転は 1 件も捕まえない**（恒真の記録）", () => {
  assert.equal(sum(checkC, { cellRow: 1 }).bad, 72);
  assert.equal(sum(checkC, { cellRow: -1 }).bad, 72);
  assert.equal(sum(checkC, { cellRow: 2 }).bad, 81);
  // **記号帯を列方向に回しても ○ と ● の個数は変わらない**（置換だから）。
  // **公表数との突き合わせを x の検算に使ってはいけない**——PO が三重 0/378・宮城 1/327 で実測した形。
  for (const k of [1, 2, -1]) assert.equal(sum(checkC, { cellCol: k }).bad, 0, `x を ${k} 列回して ${sum(checkC, { cellCol: k }).bad} 件落ちた（恒真でなくなった）`);
});

test("#874 検算C は 267 行中 72 行しか落ちない——**弱い**（同じ人数の行が並ぶため）", () => {
  // 「y を見ている検算がある」とは言えるが、「y が正しいことを示した」とは言えない。
  // 2026-02 は 82 行中 73 行が 33/0 で、1 行ずらしても数が変わらない。
  const r = sum(checkC, { cellRow: 1 });
  assert.equal(r.bad, 72);
  assert.ok(r.bad / r.n < 0.3, "落ちる割合が 3 割未満であること（弱さの記録。ここが上がったら測り直す）");
});

test("#874 検算E（y）: result == 議決結果一覧 PDF（別の一次資料）", () => {
  const r = sum(checkE);
  assert.equal(r.n, 233, "母数（議決結果一覧に載っている議案の行。請願・その他表決は載らない）");
  assert.equal(r.bad, 0);
});

test("#874 検算E は「議決結果の欄だけが 1 行ずれる」形を捕まえる。ただし 233 行中 21 行だけ", () => {
  assert.equal(sum(checkE, { result: 1 }).bad, 21);
  assert.equal(sum(checkE, { result: -1 }).bad, 21);
  // **x は 1 件も捕まえない**（result は記号帯を見ていない）
  assert.equal(sum(checkE, { cellCol: 1 }).bad, 0);
  assert.equal(sum(checkE, { cellRow: 1 }).bad, 0);
});

test("#874 検算A: 「(副)議長辞職」の行の 除斥 == 県公表の直前の (副)議長", () => {
  const r = sum(checkA);
  assert.equal(r.n, 12, "母数（辞職の行。2026-06 / 2025-06 / 2024-06 に 4 行ずつ）");
  assert.equal(r.bad, 0);
  // **母数が 8 しかない。** y を「測った」とは言えるが「正しいと示した」とは言えない。
  assert.ok(r.n < 20, "母数が小さいことを記録に残す");
});

test("#874 検算A は y と x の両方を捕まえる（だから y 専用の検算C・E の代わりにならない）", () => {
  assert.equal(sum(checkA, { cellRow: 1 }).bad, 6);
  assert.equal(sum(checkA, { cellRow: 2 }).bad, 12);
  assert.equal(sum(checkA, { cellCol: 1 }).bad, 12);
  assert.equal(sum(checkA, { title: 1 }).bad, 6);
});

test("#874 副議長の表を錨にすると 255 行中 253 行で落ちる（錨の取り違えを検出する）", () => {
  // 同じ PDF の左右に 2 つの表が並んでいる。右（副議長）を使うとほぼ全行が食い違う。
  // **`alt`（議長辞職の日に副議長が議長席に座る許し）は外して測る**——
  // **付けたままだと「副議長でも通る」ので、錨の取り違えを見逃す**（実測で 255 行中 166 行しか落ちない）。
  const r = sum((sid, v) => checkB(sid, v, vices, false));
  assert.equal(r.n, 255);
  // **255 行ではなく 253 行である**——**2025-07-02 の 2 行（特別委員会の設置 / 特別委員の選任）は
  // 実際に副議長 高橋雅彦 が議長席に座っているので、副議長の表と「たまたま一致する」**（#901 の実測）。
  // **「全行落ちる」と書くとこの 2 行を嘘で塗ることになるので、落ちない 2 行を数ごと残す。**
  assert.equal(r.bad, 253);
});

/**
 * **`alt`（議長辞職の日に副議長が議長席に座る許し）を、辞職の無い会期にまで広げてはいけない。**
 *
 * **広げても回転の検算は 255 / 255 のままで落ちない**（実測。**副議長は普段は議長席に座らないため**）——
 * **つまり回転のテストはこの緩みを捕まえない。** **だからここで別に固定する。**
 *
 * **緩めると何が起きるか**: **辞職の無い 3 会期でも「副議長なら通る」ことになり、
 * 議長席の列が副議長の列と入れ替わっていても気づけなくなる。**
 */
test("#901 alt は辞職のあった会期にだけ効く（辞職の無い会期では副議長を許さない）", () => {
  for (const b of BOOKS.filter((x) => x.resignedOn === "")) {
    const v = view(books.get(b.sessionId)!.pdf);
    const vice = on(vices, b.decidedOn);
    const spk = on(speakers, b.decidedOn);
    assert.notEqual(vice, spk, `${b.sessionId}: 議長と副議長が別人`);
    // **その会期の議長席に副議長が座っている行は 1 つも無い**（だから許す理由が無い）
    const seats = books.get(b.sessionId)!.pdf.rows.map((_, i) =>
      v.cells[i].map((c, ci) => (isGicho(c) ? v.members[ci] : null)).filter((x): x is string => x !== null));
    assert.deepEqual(seats.filter((w) => w.length === 1 && w[0] === vice), [], `${b.sessionId}: 副議長が議長席の行`);
  }
  // **`checkB` 自身が、辞職の無い会期で副議長を許していないこと。**
  // **上のデータの性質だけでは、`alt` を全会期に広げる変異を捕まえられない**
  //（**広げても実データでは差が出ないため**）。**そこで「副議長だけを議長席に置いた見え方」を作って、
  // 辞職の無い会期では落ち、辞職のあった会期では落ちないことを見る。**
  const onlyVice = (sid: string): { n: number; bad: number } => {
    const pdf = books.get(sid)!.pdf;
    const vice = on(vices, BOOKS.find((x) => x.sessionId === sid)!.decidedOn);
    const vi = pdf.members.indexOf(vice);
    assert.notEqual(vi, -1, `${sid}: 副議長が名簿に居る`);
    const v = view(pdf);
    // 議長席のセルを全部「副議長の列だけ」に付け替える
    v.cells = pdf.rows.map((r) => r.cells.map((c, ci) => (isGicho(c) ? "○" : ci === vi ? "議長" : c)));
    return checkB(sid, v);
  };
  for (const b of BOOKS.filter((x) => x.resignedOn === "")) {
    const r = onlyVice(b.sessionId);
    assert.equal(r.bad, r.n, `${b.sessionId}: 副議長を議長席に置いたら全行落ちる（許していない）`);
    assert.ok(r.n > 0, `${b.sessionId}: 母数`);
  }
  // **辞職のあった会期では、同じ置き換えがほとんど落ちない**（そこだけ副議長を許しているため）。
  // **0 ではない**——**2025-06 の 2 行は元から副議長が議長席なので、置き換えで「議長席が 2 つ」になる。**
  for (const b of BOOKS.filter((x) => x.resignedOn !== "")) {
    const r = onlyVice(b.sessionId);
    assert.ok(r.bad * 10 < r.n, `${b.sessionId}: 辞職のあった会期は副議長を許す（${r.bad}/${r.n}）`);
  }
});

test("#874 議長辞職の当日は、1 本の中に議長席が 2 人いる（島根で実測。母数から外した 8 行の中身）", () => {
  // 2026-06: 主たる議長は 山根成二（83代・令和8年6月9日 就任）だが、
  //          「議⾧辞職」の 2 行だけ 高橋雅彦（92代 副議長・令和7年6月9日 就任）が議長席に座る。
  const jun = books.get("2026-06")!.pdf;
  const resign = jun.rows.filter((r) => isResignRow(r.title) && !/副議[長⾧]辞職/.test(r.title));
  assert.equal(resign.length, 2, "2026-06 の「議長辞職」の行");
  for (const row of resign) {
    const who = row.cells.map((c, ci) => (isGicho(c) ? jun.members[ci] : null)).filter((x): x is string => x !== null);
    assert.deepEqual(who, [before(vices, "2026-06-09")], `${row.title}: 議長席は辞職直前の副議長`);
    assert.equal(before(vices, "2026-06-09"), "高橋雅彦");
    // 辞職する本人（直前の議長 池田一）は 除斥
    const jos = row.cells.map((c, ci) => (/除斥/.test(c) ? jun.members[ci] : null)).filter((x): x is string => x !== null);
    assert.deepEqual(jos, [before(speakers, "2026-06-09")]);
    assert.equal(before(speakers, "2026-06-09"), "池田一");
  }
});

test("#874 2024-06 は既存の 2 本と作りが違う（Producer が DocuWorks・議員 36 人・除斥 が 2 つ繋がる）", () => {
  const jun = books.get("2024-06")!.pdf;
  // **議員は 36 人**（2026 年の 35 人と違う。令和5年改選後に 1 人減っている）
  assert.equal(jun.members.length, 36);
  assert.ok(jun.members.includes("出川桃子"), "2024-06 にだけ居る議員");
  // **既存 2 本には無い欠陥がこの本にある**（#874 が見つけた。**この PBI では直さない**）:
  //   1. 隣り合う 2 つの「除斥」セルが 1 つに繋がって「除斥除斥」になる（4 セル）
  const joined = jun.rows.flatMap((r) => r.cells).filter((c) => c === "除斥除斥");
  assert.equal(joined.length, 4, "「除斥除斥」（2 つのセルが繋がったもの）");
  //   2. 置けなかったセルが 1 つある（既存 2 本は 0）
  assert.equal(jun.unknownCells, 1);
  // **凡例の値も末尾の「は」まで取り込まれている**（改行の位置が違うため）
  assert.equal(jun.legend.get("除斥"), "議案と一定の利害関係を有する議員は");
  // 凡例の「欠席」の記号は U+2212（既存 2 本は U+FF0D）——**同じ議会で字が違う**
  assert.ok(jun.legend.has("−"), "2024-06 の凡例の横棒は U+2212");
  assert.ok(books.get("2026-06")!.pdf.legend.has("－"), "2026-06 の凡例の横棒は U+FF0D");
});

test("#901 2025-11 は読める（#874 / #896 の「読めない」を直した）——付託委員会の名前が**中央揃え**である", async () => {
  // **#874 と #896 はここで「読めない」を固定していた**（`付託委員会 is 4.2pt off the row centre`）。
  // **#901 が機序そのものを直したので、いまは読める。**
  // **機序は消えていない**——**この本の委員会名が中央揃えであることは下でそのまま固定する。**
  // **変わったのは `leftAlignedBoundary` が欄の中心も見るようになったこと**（`votes-pdf.ts` の docblock）。
  const pdf = await parseVotePdf(fixture("r0711_giinbetu_kekka.pdf"));
  // **55 行である**（引き継ぎ時点の版は 62 と書いていたが、実測は 55。
  // **`origin/main` ではこの本は読めなかったので、62 は測らずに書かれた数だった**）。
  assert.equal(pdf.rows.length, 55, "2025-11 の行数");
  // **付託委員会が 1 行も空でない**（母数を書く。#757）
  assert.equal(pdf.rows.filter((r) => r.referredCommittees.length > 0).length, 55, "付託委員会のある行");
  // **件名に委員会名がこぼれていない**
  assert.deepEqual(pdf.rows.filter((r) => /^[^※]{2,12}(委員会|審査会)$/.test(r.title)).map((r) => r.number), []);
  // **機序**: 12 本では委員会名が**左端を揃えて**書かれるが、2025-11 だけ**中心が揃っている**（中心 x=350.0）。
  // **「一番多く並んでいる左端の x」だけを欄の左端とみなすと、長い名前を取りこぼす。**
  const pages = await readPages(fixture("r0711_giinbetu_kekka.pdf"));
  const lefts = new Map<string, Set<number>>();
  for (const page of pages) {
    const head = page.items.find((i) => i.str === "付託委員会")!;
    for (const i of page.items) {
      if (i.y >= head.y - 6 || !/委員会$/.test(i.str.trim())) continue;
      const k = i.str.trim();
      if (!lefts.has(k)) lefts.set(k, new Set());
      lefts.get(k)!.add(Number((i.x + i.w / 2).toFixed(0)));
    }
  }
  // **中心はどの名前でも同じ 350**、**左端は名前の長さで違う**
  for (const [name, centres] of lefts) assert.deepEqual([...centres], [350], `${name} の中心`);
  assert.ok(lefts.size >= 4, "委員会の名前は 4 種類以上ある（長さが違うことが機序の要）");
});

test("#874 凡例の記号は 3 本すべてで同じ 5 種類（横棒の符号位置だけが違う）", () => {
  for (const b of BOOKS) {
    const { pdf } = books.get(b.sessionId)!;
    const keys = [...pdf.legend.keys()].filter((k) => !isGicho(k));
    assert.equal(keys.length, 5, `${b.sessionId} の凡例`);
    assert.ok(keys.includes("○") && keys.includes("●") && keys.includes("棄権") && keys.includes("除斥"), b.sessionId);
    assert.ok(keys.some((k) => k === "－" || k === "−"), `${b.sessionId} の横棒`);
  }
});

test("#874 実際に現れた記号（267 行・9,381 セル。**棄権 は 1 つも無い**）", () => {
  const tally = new Map<string, number>();
  let cells = 0;
  for (const b of BOOKS) for (const row of books.get(b.sessionId)!.pdf.rows) for (const c of row.cells) { tally.set(c, (tally.get(c) ?? 0) + 1); cells++; }
  assert.equal(cells, 9381);
  assert.equal([...tally.values()].reduce((a, x) => a + x, 0), 9381);
  // 凡例にある「棄権」は 9,381 セルに 1 度も現れない（**凡例にあっても実物を見ていない記号がある**）
  assert.equal(tally.get("棄権") ?? 0, 0);
  assert.equal(tally.get("○"), 8862);
  assert.equal(tally.get("●"), 124);
  // **中身を全部並べる**（「5 種類」と書くと、下の 2 つを数えていないことになる）。
  // **`不明` 1 と `除斥除斥` 4 はどちらも 2024-06 の本にだけ在る**——
  // **2024-06 は既定の 5 会期の外なので、`data/` には出ていない**（本番の unknownCells は 0）。
  assert.deepEqual(Object.fromEntries([...tally].sort()), {
    "−": 35, "○": 8862, "●": 124, "不明": 1, "議⾧": 167, "議長": 99, "除斥": 8, "除斥除斥": 4, "－": 81,
  });
});
