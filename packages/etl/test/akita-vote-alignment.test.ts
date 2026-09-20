import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseVotePdf, type VotePdf } from "../src/sources/local/akita/votes-pdf.ts";

/**
 * # 秋田の x と y の錨——**`--sessions 29` で増えた本会議日にも当たるか**（Issue #901 / #819）
 *
 * ## なぜ要るか
 *
 * **「件数が増えた」は「正しく増えた」ではない**（#901）。
 * **`--sessions` を 2 → 29 に広げると本番の採決が 27 → 785 件になるが、
 * その 758 件が正しい位置に置かれているかは、件数からは分からない。**
 *
 * **だから「外の一次資料と結んだ錨」を置き、記号帯を回して落ちることを測る。**
 *
 * ## 測り方の約束（#891 / #911 / #901）
 *
 * - **回転で測る**（ずらしではない）。**ずらしは「空の列に落ちた」という安い理由で落ちる。**
 * - **「半セル未満」を x の根拠にしない**（#891。**1 列ずらしても 98% が通る**）。
 * - **公表数との突き合わせを x の検算に使わない**（**6 県すべてで x を 1 件も捕まえなかった**）。
 *   **秋田の PDF には `表決者数` `賛成者数` `反対者数` の欄があるが、
 *   これは y の錨にしかならない**——**記号帯を x に回しても ○ と × の個数は変わらない。**
 * - **「回転で落ちる行数が多いほど錨が強い」と読まない**（#911）。
 * - **母数を必ず出す**（#757）。**「判定できた行が 0」なら 0 と書く。**
 *
 * ## **検算A（x の錨）**: **`議` の列 ↔ 県が公表する歴代議長**
 *
 * **秋田の賛否 PDF は、その日の議長の列に `議` を 1 つ置く**（`akita-published-data.test.ts` の #759）。
 * **議長が誰であったかは、この ETL が読む PDF の外にある**——
 * **県議会「歴代正副議長一覧」**（https://pref.akita.gsl-service.net/doc/2019042400028/ の
 * `file_contents/250514.pdf`）**に代ごとの氏名と就退任年月日がある。**
 *
 * **記号帯を 1 列回せば `議` は隣の議員に移る**ので、**公表と食い違う。**
 * **これは「PDF の中で辻褄が合っているか」ではなく「外の事実と合っているか」の検算である。**
 *
 * ## **検算B（y の錨）**: **`表決者数` `賛成者数` `反対者数` ↔ 記号の個数**
 *
 * **左の欄の数字は、その行の記号の個数と合う。** **記号帯を 1 行回せば行がずれて食い違う。**
 * **x には効かない**（回しても個数は変わらない）——**だから A と B は別の軸を押さえている。**
 *
 * ## フィクスチャの母数
 *
 * **9 本。うち 3 本（`514.pdf` / `430.pdf` / `05516hyoketsu.pdf`）はこの PR で足した**——
 * **`--sessions 2` の窓（2026-07-03 / 2026-06-15）には 1 本も入らない範囲である。**
 * **`430.pdf`（2025-04-30、北林丈正）と `514.pdf`（2025-05-14、工藤嘉範）は議長交代をまたぐ 2 本で、
 * 「その日どちらだったか」を錨が言い当てられるかを直に見る。**
 */

const DIR = fileURLToPath(new URL("./fixtures/akita/", import.meta.url));

/** 氏名の比較用。空白と異体字セレクタを落とす（`髙`/`高` はここでは寄せない——別人になりうる）。 */
const norm = (s: string): string => s.replace(/[\s　\u{E0100}-\u{E01EF}]/gu, "").normalize("NFKC");

/** **回転**（ずらしではない）。端から出た要素は反対の端へ戻る。 */
function rot<T>(a: readonly T[], k: number): T[] {
  const n = a.length;
  if (n === 0) return [];
  return a.map((_, i) => a[(((i - k) % n) + n) % n]);
}

/**
 * **県議会「歴代正副議長一覧」から読んだ議長**（63代〜70代。原文の和暦をそのまま ISO に直した）。
 *
 * 一次資料: https://pref.akita.gsl-service.net/doc/2019042400028/
 *   → `file_contents/250514.pdf`（公開日 2025年5月14日。**この PR が取得して読んだ**）
 *
 * | 代 | 氏名 | 原文の就退任年月日 |
 * |---:|---|---|
 * | 63 | 大里祐一 | 平23. 5.11〜25. 5. 9 |
 * | 64 | 能登祐一 | 平25. 5. 9〜27. 4.29 |
 * | 65 | 渋谷正敏 | 平27. 5.11〜29. 5.11 |
 * | 66 | 鶴田有司 | 平29. 5.11〜31. 4.29 |
 * | 67 | 加藤鉱一 | 令元. 5.13〜 3. 5.13 |
 * | 68 | 柴田正敏 | 令3. 5.13〜 5. 4.29 |
 * | 69 | 北林丈正 | 令5. 5.15〜 7. 5.14 |
 * | 70 | 工藤嘉範 | 令7. 5.14〜 |
 *
 * **氏名は公表の原文のまま**（推定で字形を寄せていない。#569）。
 */
const SPEAKERS: { name: string; from: string; to?: string }[] = [
  { name: "大里祐一", from: "2011-05-11", to: "2013-05-09" },
  { name: "能登祐一", from: "2013-05-09", to: "2015-04-29" },
  { name: "渋谷正敏", from: "2015-05-11", to: "2017-05-11" },
  { name: "鶴田有司", from: "2017-05-11", to: "2019-04-29" },
  { name: "加藤鉱一", from: "2019-05-13", to: "2021-05-13" },
  { name: "柴田正敏", from: "2021-05-13", to: "2023-04-29" },
  { name: "北林丈正", from: "2023-05-15", to: "2025-05-14" },
  { name: "工藤嘉範", from: "2025-05-14" },
];

/**
 * **その日に議長でありうる人**（交代の当日は 2 人になる）。
 *
 * **交代の当日に前任と後任のどちらが議事を執ったかは、PDF にも公表にも書かれていない。**
 * **だから両方を許す**——**推定で 1 人に決めない**（#569）。
 * **緩むぶんは数字で残す**（下の `handover`）。
 */
function speakersOn(date: string): string[] {
  return SPEAKERS.filter((s) => s.from <= date && (s.to === undefined || date <= s.to)).map((s) => s.name);
}

/** フィクスチャ 9 本。**`sessions` の窓に入るかどうかも持つ**（増えた範囲だけに絞って測るため）。 */
const BOOKS: { file: string; date: string; sessionsIndex: number }[] = [
  // **`--sessions 2` の窓（2026-07-03 / 2026-06-15）には、フィクスチャが 1 本も無い**
  { file: "080319.pdf", date: "2026-03-19", sessionsIndex: 4 },
  { file: "514.pdf", date: "2025-05-14", sessionsIndex: 12 },
  { file: "430.pdf", date: "2025-04-30", sessionsIndex: 13 },
  { file: "060220hyoketsu.pdf", date: "2024-02-20", sessionsIndex: 22 },
  { file: "05516hyoketsu.pdf", date: "2023-05-16", sessionsIndex: 29 },
  // **`--sessions 29` の外**（2023年4月の一般選挙より前。**出さない範囲だが、錨は当たる**）
  { file: "041222hyoketsu.pdf", date: "2022-12-22", sessionsIndex: 33 },
  { file: "R41102hyoketsu.pdf", date: "2022-11-02", sessionsIndex: 34 },
  { file: "h291222giketu.pdf", date: "2017-12-22", sessionsIndex: 93 },
  { file: "h231202giketu.pdf", date: "2011-12-02", sessionsIndex: 149 },
];

const pdfs = new Map<string, VotePdf>();
for (const b of BOOKS) pdfs.set(b.file, await parseVotePdf(readFileSync(DIR + b.file)));

/** 1 回の測定の結果。**母数を必ず持つ**（#757）。 */
interface Measured {
  /** 判定できた行（`議` がちょうど 1 つ立ち、公表で議長を引けた行） */
  judged: number;
  /** 公表と食い違った行 */
  mismatch: number;
  /** そのうち「議長交代の当日」だった行（**この行では錨が 2 人のどちらかしか言えない**） */
  handover: number;
}

/**
 * **検算A**: 記号帯を `k` 列回して、`議` の列の議員が公表の議長と合うかを数える。
 * **`only` を渡すとその本だけ測る**（増えた範囲だけに絞るため）。
 */
function probeSpeaker(k: number, only?: (b: (typeof BOOKS)[number]) => boolean): Measured {
  let judged = 0, mismatch = 0, handover = 0;
  for (const b of BOOKS) {
    if (only && !only(b)) continue;
    const pdf = pdfs.get(b.file)!;
    const names = pdf.members.map((m) => norm(m.nameText));
    const allowed = speakersOn(b.date);
    if (allowed.length === 0) continue; // 公表で引けない日（この 9 本には無いが、黙って通さない）
    for (const row of pdf.rows) {
      const cells = rot(row.cells, k);
      const ix = cells.map((c, i) => (c === "議" ? i : -1)).filter((i) => i >= 0);
      if (ix.length !== 1) continue; // `議` が 0 個か 2 個以上の行は判定しない（母数から外す）
      judged++;
      if (allowed.length > 1) handover++;
      if (!allowed.includes(names[ix[0]])) mismatch++;
    }
  }
  return { judged, mismatch, handover };
}

/**
 * **検算B**: 記号帯を `k` 行回して、左の欄の `賛成者数` / `反対者数` が記号の個数と合うかを数える。
 * **x には効かない**——**列を回しても ○ と × の個数は変わらない**（#891 / #901）。
 */
function probeCounts(k: number): { judged: number; mismatch: number } {
  let judged = 0, mismatch = 0;
  for (const b of BOOKS) {
    const pdf = pdfs.get(b.file)!;
    const cellsByRow = pdf.rows.map((r) => r.cells);
    for (const [i, row] of pdf.rows.entries()) {
      if (!row.counts) continue; // 公表数の欄が無い行（母数から外す）
      const cells = rot(cellsByRow, k)[i];
      judged++;
      const yes = cells.filter((c) => c === "○").length;
      const no = cells.filter((c) => c === "×").length;
      if (yes !== row.counts.yes || no !== row.counts.no) mismatch++;
    }
  }
  return { judged, mismatch };
}

/* ============================================================ *
 * 検算A（x の錨）
 * ============================================================ */

test("#901 検算A: 無改造なら `議` の列が県公表の歴代議長と 1 行も食い違わない（9 本 / 母数つき）", () => {
  const m = probeSpeaker(0);
  // **母数**: 9 本の 223 行すべて（**223 / 223 行で `議` がちょうど 1 つ立つ**）
  assert.equal(m.judged, 223, `判定できた行（${m.judged}）`);
  assert.equal(m.mismatch, 0, `公表と食い違った行（${m.mismatch} / ${m.judged}）`);
  // **交代当日の行は 3**（`514.pdf` の 3 行）——**69代の退任と 70代の就任が同じ 2025-05-14 なので、
  // この日は 2 人が許される。** **錨が緩んでいるぶんを、数として残す**（#901: 限界を限界のまま書く）。
  // **223 行のうち 3 行だけ**なので、**残り 220 行は 1 人しか許していない。**
  assert.equal(m.handover, 3, `交代当日の行（${m.handover} / ${m.judged}）`);
  // **緩めても、`514.pdf` が実際に指しているのは 工藤嘉範 1 人である**（下の「交代をまたぐ 2 本」の検査）。
});

test("#901 検算A: 記号帯を x に回すと落ちる（1 / 2 / −1 / −2 の 4 回転すべて）", () => {
  const base = probeSpeaker(0);
  const got: Record<number, Measured> = {};
  for (const k of [1, 2, -1, -2]) got[k] = probeSpeaker(k);
  // **4 回転とも、判定できた行の全部が落ちる**（`議` は 1 列しか立たないので、回せば必ず隣に移る）
  for (const k of [1, 2, -1, -2]) {
    assert.equal(got[k].judged, base.judged, `k=${k}: 母数が変わっていない（${got[k].judged}）`);
    assert.equal(got[k].mismatch, base.judged, `k=${k}: 落ちた行（${got[k].mismatch} / ${got[k].judged}）`);
  }
  // **「落ちる行数が多いほど強い」とは読まない**（#911）。**ここで言えるのは「4 回転とも通らない」だけ。**
});

test("#901 検算A: 増えた範囲（`--sessions` 3〜29）だけに絞っても当たる（薄まっていない）", () => {
  // **`--sessions 2` の窓（PDF 2 本）にはフィクスチャが 1 本も無いので、この 4 本は全部「増えた範囲」**
  const only = (b: (typeof BOOKS)[number]): boolean => b.sessionsIndex >= 3 && b.sessionsIndex <= 29;
  const base = probeSpeaker(0, only);
  assert.equal(base.judged, 111, `増えた範囲で判定できた行（${base.judged}）`);
  assert.equal(base.mismatch, 0, `無改造で食い違った行（${base.mismatch} / ${base.judged}）`);
  for (const k of [1, 2, -1, -2]) {
    const m = probeSpeaker(k, only);
    assert.equal(m.mismatch, base.judged, `k=${k}: 増えた範囲で落ちた行（${m.mismatch} / ${m.judged}）`);
  }
});

test("#901 検算A: 議長交代をまたぐ 2 本を、錨が別々に言い当てる（`430.pdf` ↔ `514.pdf`）", () => {
  // **同じ議員 41 人・同じ並びの 2 本で、`議` の立つ列だけが違う**——
  // **列がずれているなら、この 2 本が同じ人を指すか、公表と食い違うかのどちらかになる。**
  const g = (file: string): string[] => {
    const pdf = pdfs.get(file)!;
    const names = pdf.members.map((m) => norm(m.nameText));
    const out = new Set<string>();
    for (const row of pdf.rows) {
      const ix = row.cells.map((c, i) => (c === "議" ? i : -1)).filter((i) => i >= 0);
      if (ix.length === 1) out.add(names[ix[0]]);
    }
    return [...out];
  };
  assert.deepEqual(g("430.pdf"), ["北林丈正"], "2025-04-30 は 69代 北林丈正（令5.5.15〜令7.5.14）");
  assert.deepEqual(g("514.pdf"), ["工藤嘉範"], "2025-05-14 は 70代 工藤嘉範（令7.5.14〜）");
  // **並びは同じ**（違う PDF の違う並びを比べているのではない）
  const a = pdfs.get("430.pdf")!.members.map((m) => norm(m.nameText));
  const b = pdfs.get("514.pdf")!.members.map((m) => norm(m.nameText));
  assert.deepEqual(a, b, "2 本の議員の並びが同じ");
  // **`議` の列番号は違う**（同じ並びなのに違う列 ＝ 交代を PDF が書いている）
  const col = (file: string): number => {
    const pdf = pdfs.get(file)!;
    return pdf.rows[0].cells.findIndex((c) => c === "議");
  };
  assert.notEqual(col("430.pdf"), col("514.pdf"), `\`議\` の列（430=${col("430.pdf")} 514=${col("514.pdf")}）`);
});

/* ============================================================ *
 * 検算B（y の錨）
 * ============================================================ */

test("#901 検算B: 無改造なら公表数と記号の個数が 1 行も食い違わない（母数つき）", () => {
  const m = probeCounts(0);
  assert.equal(m.judged, 107, `公表数の欄がある行（${m.judged} / 223）`);
  assert.equal(m.mismatch, 0, `食い違った行（${m.mismatch} / ${m.judged}）`);
});

test("#901 検算B: 記号帯を y に回すと落ちる（1 / −1）", () => {
  const base = probeCounts(0);
  for (const k of [1, -1]) {
    const m = probeCounts(k);
    assert.equal(m.judged, base.judged, `k=${k}: 母数が変わっていない`);
    assert.ok(m.mismatch > 0, `k=${k}: 落ちた行（${m.mismatch} / ${m.judged}）`);
  }
  // **落ちた行数を固定する**（実測。**「多いほど強い」とは読まない**——**0 でないことだけが根拠**）
  assert.deepEqual(
    { "+1": probeCounts(1).mismatch, "-1": probeCounts(-1).mismatch },
    { "+1": 38, "-1": 38 },
    "y を 1 行回したときに落ちる行",
  );
});

/**
 * **検算B は x を 1 件も捕まえない**（#891 / #901 が「公表数を x の検算に使うな」と書いた理由）。
 *
 * **記号帯を列に回しても、その行の ○ と × の個数は 1 つも変わらない**——
 * **だから検算B は y しか押さえていない。** **これを限界のまま固定する。**
 */
test("#901 検算B は x を 1 件も捕まえない（だから検算A が要る）", () => {
  const base = probeCounts(0);
  for (const k of [1, 2, -1, -2]) {
    // 列の回転で counts を測る（行ではなく列を回す）
    let judged = 0, mismatch = 0;
    for (const b of BOOKS) {
      const pdf = pdfs.get(b.file)!;
      for (const row of pdf.rows) {
        if (!row.counts) continue;
        judged++;
        const cells = rot(row.cells, k);
        if (cells.filter((c) => c === "○").length !== row.counts.yes || cells.filter((c) => c === "×").length !== row.counts.no) mismatch++;
      }
    }
    assert.equal(judged, base.judged, `k=${k}: 母数`);
    assert.equal(mismatch, 0, `k=${k}: **列を回しても 1 件も落ちない**（${mismatch} / ${judged}）`);
  }
});

/**
 * ## **誤った読み方を組み立てて被害を数える**（`docs/WORKING_AGREEMENT.md`）
 *
 * **実在した選択肢**: **「`議` は議長なのだから、41 人の並びの中で常に同じ列に立つ」と決めて、
 * 1 本目の列を後の本にも使い回す読み方**——**`sessionId` が本会議日ごとなので、
 * 「1 会期ぶんまとめて 1 列に決める」誘惑が実際にある。**
 *
 * **これを採っていたら何件間違っていたかを数える。**
 */
test("#901 「`議` の列は全期間で同じ」と決めていたら、何件が別人になっていたか", () => {
  // 1 本目（新しい側）の `議` の列を、全部の本に使い回す
  const first = pdfs.get("080319.pdf")!;
  const fixedCol = first.rows[0].cells.findIndex((c) => c === "議");
  assert.ok(fixedCol >= 0, "1 本目に `議` がある");
  let judged = 0, wrong = 0;
  const wrongBooks = new Set<string>();
  for (const b of BOOKS) {
    const pdf = pdfs.get(b.file)!;
    if (pdf.members.length !== first.members.length) continue; // 並びの長さが違う本は比べない
    const names = pdf.members.map((m) => norm(m.nameText));
    const allowed = speakersOn(b.date);
    for (const row of pdf.rows) {
      if (row.cells.filter((c) => c === "議").length !== 1) continue;
      judged++;
      if (!allowed.includes(names[fixedCol])) { wrong++; wrongBooks.add(b.file); }
    }
  }
  // **41 人の本 6 本 / 161 行のうち、70 行で別人が議長にされていた**（実測）
  assert.equal(judged, 161, `判定できた行（${judged}）`);
  assert.equal(wrong, 70, `別人が議長になっていた行（${wrong} / ${judged}）`);
  assert.deepEqual(
    [...wrongBooks].sort(),
    ["05516hyoketsu.pdf", "060220hyoketsu.pdf", "430.pdf", "514.pdf", "h291222giketu.pdf"],
    "壊れる本（**通るのは 1 本目の `080319.pdf` だけ**）",
  );
  // **1 本目と同じ議長（工藤嘉範）の `514.pdf` すら落ちる**——
  // **議長が同じでも、議員の並びが変われば列が変わる**（`514.pdf` は 21 列目、`080319.pdf` は 5 列目）。
  // **「議長は同じ人だから列も同じ」は成り立たない。**
  // **`--sessions 2` の窓（PDF 2 本）にはこの形が 1 件も無い**——
  // **2026-07-03 / 2026-06-15 はどちらも 70代 工藤嘉範なので、使い回しても当たってしまう。**
  // **広げて初めて壊れる形である。**
});
