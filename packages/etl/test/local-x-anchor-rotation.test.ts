import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "node-html-parser";

/**
 * **5 県（宮城・奈良・鳥取・島根・徳島）の x の錨に、`1 / 2 / −1 / −2` の 4 回転を全部当てる**（Issue #906 の前半）。
 *
 * ## なぜこれを測るか
 *
 * **高知（#876）で、`−1` 回転**だけ**が錨をすり抜ける形が見つかった**——
 * **議長交代の当日に前任と後任が隣の列に居ると、回転が「許される 2 人」の間を移るだけになる。**
 * **「この形は高知に固有とは限らない」**（#906）。**だから 5 県で同じことを測る。**
 *
 * **各県の `*-vote-alignment.test.ts` は既にそれぞれ回転を当てているが、当てている k が揃っていない**
 * （実測: **`−2` を当てているのは鳥取だけ**。奈良・宮城・島根・徳島は `1 / 2 / −1` の 3 つだけ）。
 * **ここは 5 県を同じ物差しで、同じ 4 つの回転で測る。**
 *
 * ## 測り方の約束
 *
 * - **回転で測る**（ずらしではない）。**ずらしは「空の列に落ちた」という安い理由で落ちるので根拠にならない。**
 * - **「半セル未満」は使わない**（#891。**1 列ずらしても 98〜99% が「半セル未満」になる**ので、ほぼ恒真）。
 * - **公表数との突き合わせを x の検算に使わない**（**6 県すべてで x を 1 件も捕まえなかった**）。
 * - **母数を必ず出す**（#757）。**「判定できた行が 0」なら 0 と書く。**
 * - **実装も `data/` も 1 行も変えていない。** **読むだけの測定である。**
 *
 * ## 「交代当日をどう扱うか」で数字が変わる。だから 2 通り測る
 *
 * **錨は「その日の議長」を県の公表から引くが、交代の当日は 1 冊の中に議長が 2 人いる。**
 * **扱いは 2 通りあり、どちらを採るかで回転が捕まえる行数が変わる**——**両方を出す。**
 *
 * | 扱い | 意味 |
 * |---|---|
 * | **`strict`** | **その日に就任した人だけを許す。** 交代当日の行は前任が議事を執っていれば落ちる |
 * | **`allowPrev`** | **前任も許す**（高知 #876 と宮城が採っている形）。**落ちにくくなる = 錨が緩む** |
 *
 * **`allowPrev` は「PDF が議決の前後を書いていないので決められない」という正直な扱いであって、
 * 手抜きではない**（#569: 推測で議員を紐づけない）。**だが緩むぶんは数字で残す。**
 */

const T = fileURLToPath(new URL("./", import.meta.url));

/** **回転**（ずらしではない）。端から出た要素は反対の端へ戻る。 */
function rot<T>(a: readonly T[], k: number): T[] {
  const n = a.length;
  return a.map((_, i) => a[(((i - k) % n) + n) % n]);
}

/** 氏名の比較用。空白と異体字セレクタ（`芦󠄀髙清友` のような IVS 付き）を落とす。 */
const norm = (s: string): string => s.replace(/[\s　\u{E0100}-\u{E01EF}]/gu, "").normalize("NFKC");

/** この測定で当てる回転。**`−2` まで当てる**（高知の穴は `−1` でしか出なかった）。 */
const ROTATIONS = [1, 2, -1, -2] as const;

/** 1 回の測定の結果。**母数を必ず持つ**（#757）。 */
interface Measured {
  /** 判定できた行（`議` がちょうど 1 つ立ち、県の公表で議長を引けた行） */
  judged: number;
  /** 県の公表と食い違った行 */
  mismatch: number;
  /** そのうち「議長交代の当日」だった行（**この行では錨が 2 人のどちらかしか言えない**） */
  handover: number;
}

/** 県ごとの測定器。`k` は記号帯を回す列数、`mode` は交代当日の扱い。 */
type Prober = (k: number, mode: "strict" | "allowPrev") => Measured;

/* ============================================================ *
 * 奈良
 * ============================================================ */

const { parseVotePdf: parseNara } = await import("../src/sources/local/nara/votes-pdf.ts");
const naraDir = T + "fixtures/nara/";
const naraBooks: { name: string; pdf: Awaited<ReturnType<typeof parseNara>> }[] = [];
for (const f of readdirSync(naraDir).filter((x) => x.endsWith(".pdf")).sort()) {
  naraBooks.push({ name: f, pdf: await parseNara(readFileSync(naraDir + f)) });
}

/**
 * **奈良県議会 歴代議長**（一次資料 https://www.pref.nara.lg.jp/documents/13374/r080702ichiran.pdf ）。
 * **`nara-vote-alignment.test.ts` が #872 で写したものと同じ表である**（**別々に写して食い違わせない**）。
 */
const NARA_SPEAKERS: { from: string; name: string }[] = [
  { from: "2024-07-03", name: "中野雅史" },
  { from: "2025-07-02", name: "田中惟允" },
  { from: "2026-07-02", name: "乾浩之" },
];

/** その日に在任していた議長（就任日当日はその人）。 */
function speakerOn(table: readonly { from: string; name: string }[], date: string): string | undefined {
  const past = table.filter((s) => s.from <= date);
  return past.length ? past[past.length - 1].name : undefined;
}
/** その日の**直前**に在任していた議長（就任日当日は前任）。 */
function speakerBefore(table: readonly { from: string; name: string }[], date: string): string | undefined {
  const past = table.filter((s) => s.from < date);
  return past.length ? past[past.length - 1].name : undefined;
}

const probeNara: Prober = (k, mode) => {
  const m: Measured = { judged: 0, mismatch: 0, handover: 0 };
  for (const b of naraBooks) {
    const cur = speakerOn(NARA_SPEAKERS, b.pdf.date);
    if (cur === undefined) continue; // 表に無い日付は判定外（推定しない）
    const prev = speakerBefore(NARA_SPEAKERS, b.pdf.date);
    const isHandover = NARA_SPEAKERS.some((s) => s.from === b.pdf.date) && prev !== undefined && norm(prev) !== norm(cur);
    for (const r of b.pdf.rows) {
      const cells = k === 0 ? r.cells : rot(r.cells, k);
      const idx = cells.flatMap((c, i) => (c === "議" ? [i] : []));
      if (idx.length !== 1) continue;
      m.judged++;
      if (isHandover) m.handover++;
      const got = norm(b.pdf.members[idx[0]].nameText);
      const okPrev = mode === "allowPrev" && isHandover && prev !== undefined && got === norm(prev);
      if (got !== norm(cur) && !okPrev) m.mismatch++;
    }
  }
  return m;
};

/* ============================================================ *
 * 鳥取
 * ============================================================ */

const { parseVotePdf: parseTottori } = await import("../src/sources/local/tottori/votes-pdf.ts");
const { cleanText } = await import("../src/sources/local/tottori/site.ts");
const TOTTORI_FILES = [
  "R8.6giketsukekka0629.pdf",
  "R8.6.29_seiganchinjogiketsukekka.pdf",
  "R8.6.29_giinteishutsugian_giketsukekka.pdf",
  "R0802sengikekka.pdf",
  "R8.2giketsukekka0325.pdf",
];
const tottoriBooks: Awaited<ReturnType<typeof parseTottori>>[] = [];
for (const f of TOTTORI_FILES) tottoriBooks.push(await parseTottori(readFileSync(T + "fixtures/tottori/" + f)));

/** 「令和7.6.9」→ ISO。**元号を 1 文字に略した行がある**ので略字も受ける。読めなければ undefined。 */
function eraIso(text: string): string | undefined {
  const t = text.normalize("NFKC").replace(/[\s　]/g, "");
  const m = t.match(/(令和|平成|昭和|大正|明治|令|平|昭|大|明)(\d+|元)\.(\d+)\.(\d+)/);
  if (!m) return undefined;
  const n = m[2] === "元" ? 1 : Number(m[2]);
  const base: Record<string, number> = { 令和: 2018, 平成: 1988, 昭和: 1925, 大正: 1911, 明治: 1867, 令: 2018, 平: 1988, 昭: 1925, 大: 1911, 明: 1867 };
  return `${base[m[1]] + n}-${String(m[3]).padStart(2, "0")}-${String(m[4]).padStart(2, "0")}`;
}

/** 歴代正副議長ページ → 議長の表（**見出しで選ぶ。位置では選ばない**）。 */
function readTottoriChairs(html: string): { name: string; iso: string }[] {
  const cp = parse(html).querySelector("#ContentPane");
  if (!cp) throw new Error("#ContentPane not found");
  for (const t of cp.querySelectorAll("table")) {
    const head = t.querySelectorAll("tr")[0]?.querySelectorAll("th,td").map((c) => cleanText(c.text)) ?? [];
    if (head[0] !== "代" || head[1] !== "議長") continue;
    const rows: { name: string; iso: string }[] = [];
    for (const tr of t.querySelectorAll("tr")) {
      const c = tr.querySelectorAll("th,td").map((x) => cleanText(x.text));
      if (c.length !== 3 || !/^\d+$/.test(c[0])) continue;
      const iso = eraIso(c[2]);
      if (!iso) throw new Error(`就任年月日が読めない: ${c.join(" ")}`);
      rows.push({ name: c[1], iso });
    }
    return rows.sort((a, b) => (a.iso < b.iso ? -1 : 1));
  }
  throw new Error("議長の表が見つからない");
}

const tottoriChairs = readTottoriChairs(readFileSync(T + "fixtures/tottori/76208-rekidai-seifukugicho.htm", "utf8"));
const chairOnIso = (ts: readonly { name: string; iso: string }[], d: string) => { let cur: { name: string; iso: string } | undefined; for (const t of ts) if (t.iso <= d) cur = t; return cur; };
const chairBeforeIso = (ts: readonly { name: string; iso: string }[], d: string) => { let cur: { name: string; iso: string } | undefined; for (const t of ts) if (t.iso < d) cur = t; return cur; };
/** **鳥取の PDF は姓だけ印刷する**（同姓は名の 1 文字を添える）。公表の氏名の先頭と突き合わせる。 */
const tottoriMatches = (chairName: string, nameText: string): boolean => {
  const surname = nameText.replace(/議員$/, "");
  return surname !== "" && chairName.replace(/[\s　]/g, "").startsWith(surname);
};

const probeTottori: Prober = (k, mode) => {
  const m: Measured = { judged: 0, mismatch: 0, handover: 0 };
  for (const pdf of tottoriBooks) {
    const cur = chairOnIso(tottoriChairs, pdf.date);
    if (!cur) continue;
    const prev = chairBeforeIso(tottoriChairs, pdf.date);
    const isHandover = cur.iso === pdf.date && prev !== undefined && prev.name !== cur.name;
    for (const r of pdf.rows) {
      const cells = k === 0 ? r.cells : rot(r.cells, k);
      const idx = cells.flatMap((c, i) => (c === "議" ? [i] : []));
      if (idx.length !== 1) continue;
      m.judged++;
      if (isHandover) m.handover++;
      const nt = pdf.members[idx[0]].nameText;
      const okPrev = mode === "allowPrev" && isHandover && prev !== undefined && tottoriMatches(prev.name, nt);
      if (!tottoriMatches(cur.name, nt) && !okPrev) m.mismatch++;
    }
  }
  return m;
};

/* ============================================================ *
 * 島根
 * ============================================================ */

const { parseVotePdf: parseShimane } = await import("../src/sources/local/shimane/votes-pdf.ts");
const { readPages } = await import("../src/sources/local/pdf-table.ts");
const SHIMANE_BOOKS = [
  { file: "r0806_giinbetu_kekka.pdf", decidedOn: "2026-07-02" },
  { file: "r0802_giinbetu_kekka.pdf", decidedOn: "2026-03-25" },
  { file: "r0606_giinbetu_kekka.pdf", decidedOn: "2024-06-28" },
];
const shimaneBooks: { decidedOn: string; pdf: Awaited<ReturnType<typeof parseShimane>> }[] = [];
for (const b of SHIMANE_BOOKS) shimaneBooks.push({ decidedOn: b.decidedOn, pdf: await parseShimane(readFileSync(T + "fixtures/shimane/" + b.file)) });

/**
 * 島根「歴代議長・副議長一覧」PDF → 議長の表だけ。
 * **左に議長・右に副議長が並んでおり、同じ日に別の人が就任する**——**見出しの x で左右を分ける。**
 */
function readShimaneSpeakers(pages: Awaited<ReturnType<typeof readPages>>): { from: string; name: string }[] {
  const out: { from: string; name: string }[] = [];
  for (const page of pages) {
    const byY = new Map<number, typeof page.items>();
    for (const it of page.items) {
      const key = [...byY.keys()].find((v) => Math.abs(v - it.y) < 3) ?? it.y;
      if (!byY.has(key)) byY.set(key, []);
      byY.get(key)!.push(it);
    }
    const headSpk = page.items.find((i) => i.str.trim() === "議長");
    const headVic = page.items.find((i) => i.str.trim() === "副議長");
    if (!headSpk || !headVic) continue;
    const split = (headSpk.x + headSpk.w + headVic.x) / 2;
    for (const [, items] of byY) {
      const inSide = items.filter((i) => i.x < split).sort((a, b) => a.x - b.x);
      const line = inSide.map((i) => i.str).join(" ").replace(/[\s　]+/g, " ").trim().normalize("NFKC");
      const m = line.match(/^(\d+)\s+(.+?)\s+(昭和|平成|令和)(\d+|元)年(\d{1,2})月(\d{1,2})日$/);
      if (!m) continue;
      const era = m[3] === "令和" ? 2018 : m[3] === "平成" ? 1988 : 1925;
      const y = era + (m[4] === "元" ? 1 : Number(m[4]));
      const name = m[2].replace(/[\s　]+/g, "");
      if (name === "〃") continue; // 同じ人の再任（錨に使わない）
      out.push({ from: `${y}-${String(Number(m[5])).padStart(2, "0")}-${String(Number(m[6])).padStart(2, "0")}`, name });
    }
  }
  return out.sort((a, b) => (a.from < b.from ? -1 : 1));
}

const shimaneRekidai = readFileSync(T + "fixtures/shimane/rekidai-gicho.pdf");
const shimaneSpeakers = readShimaneSpeakers(await readPages(shimaneRekidai));
const isGicho = (c: string): boolean => /^議[長⾧]$/.test(c);
const isShimaneResignRow = (t: string): boolean => /議[長⾧]辞職/.test(t);

const probeShimane: Prober = (k, mode) => {
  const m: Measured = { judged: 0, mismatch: 0, handover: 0 };
  for (const b of shimaneBooks) {
    const cur = speakerOn(shimaneSpeakers, b.decidedOn);
    if (cur === undefined) continue;
    const prev = speakerBefore(shimaneSpeakers, b.decidedOn);
    const isHandover = shimaneSpeakers.some((s) => s.from === b.decidedOn) && prev !== undefined && norm(prev) !== norm(cur);
    for (const r of b.pdf.rows) {
      // **「議長辞職」の行は、その日の議長ではなく副議長が議長席に座る**（#874 が実測）。母数から外す。
      if (isShimaneResignRow(r.title)) continue;
      const cells = k === 0 ? r.cells : rot(r.cells, k);
      const who = cells.flatMap((c, ci) => (isGicho(c) ? [b.pdf.members[ci]] : []));
      m.judged++;
      if (isHandover) m.handover++;
      const okPrev = mode === "allowPrev" && isHandover && who.length === 1 && prev !== undefined && norm(who[0]) === norm(prev);
      if ((who.length !== 1 || norm(who[0]) !== norm(cur)) && !okPrev) m.mismatch++;
    }
  }
  return m;
};

/* ============================================================ *
 * 徳島
 * ============================================================ */

const { parseVotePdf: parseTokushima } = await import("../src/sources/local/tokushima/votes-pdf.ts");
const TOKUSHIMA_FILES = ["1075652.pdf", "1064407.pdf", "1036105.pdf", "1038136.pdf", "1042426.pdf", "1024978.pdf", "1017725.pdf"];
const tokushimaBooks: { date: string; members: string[]; rows: { cells: string[] }[] }[] = [];
for (const f of TOKUSHIMA_FILES) {
  const p = await parseTokushima(readFileSync(T + "fixtures/tokushima/" + f));
  tokushimaBooks.push({ date: p.date, members: p.members.map((x) => x.nameText), rows: p.sections.flatMap((s) => s.rows.map((r) => ({ cells: r.cells }))) });
}

/**
 * **徳島の議長**（とくしま県議会だより。**姓だけしか書かれていない**）。
 * **境目が「3月11日の翌日」なのは #875 の実測に基づく**——**選挙の当日はまだ前任が議長席にいる。**
 * **つまり徳島では「交代当日」が錨の外に出ており、`allowPrev` を使う必要が無い**（下のテストで固定する）。
 */
const TOKUSHIMA_GICHO = [
  { from: "2025-03-12", to: "2026-03-11", surname: "須見" },
  { from: "2026-03-12", to: "2099-12-31", surname: "井川" },
] as const;
const surnameOf = (n: string): string => n.replace(/[\s　]/g, "").slice(0, 2);

const probeTokushima: Prober = (k) => {
  // **`mode` を使わない**——**境目を一次資料で確定させてあるので、交代当日の行が 1 つも無い。**
  const m: Measured = { judged: 0, mismatch: 0, handover: 0 };
  for (const b of tokushimaBooks) {
    const want = TOKUSHIMA_GICHO.find((g) => b.date >= g.from && b.date <= g.to);
    if (!want) continue;
    for (const r of b.rows) {
      const cells = k === 0 ? r.cells : rot(r.cells, k);
      const gi = cells.flatMap((c, i) => (c === "議" ? [b.members[i]] : []));
      m.judged++;
      if (gi.length !== 1 || surnameOf(gi[0]) !== want.surname) m.mismatch++;
    }
  }
  return m;
};

/* ============================================================ *
 * 宮城
 * ============================================================ */

const { parseVotePdf: parseMiyagi } = await import("../src/sources/local/miyagi/votes-pdf.ts");
const { toIsoDate } = await import("../src/sources/local/miyagi/rollcalls.ts");
const { localNameKey } = await import("../src/sources/local/name-match.ts");
const MIYAGI_FILES = [
  "hyoketu080707.pdf", "syuusei_hyouketsu080318.pdf", "hyouketsu071217.pdf", "hyouketsu061017.pdf",
  "hyouketsu060701.pdf", "hyouketsu051219.pdf", "hyouketsu051004.pdf", "hyouketsu050704.pdf",
];
const miyagiBooks: Awaited<ReturnType<typeof parseMiyagi>>[] = [];
for (const f of MIYAGI_FILES) miyagiBooks.push(await parseMiyagi(readFileSync(T + "fixtures/miyagi/" + f)));

/**
 * **宮城県議会 歴代議長**（一次資料 https://www.pref.miyagi.jp/site/kengikai/rekidai.html ）。
 * **`miyagi-vote-alignment.test.ts` が #871 で写したものと同じ表である。**
 * **`to` と次の `from` が同日に重なる行がある**——**そこが「交代当日」にあたる。**
 */
const MIYAGI_CHAIRS: { name: string; from: string; to: string | null }[] = [
  { name: "佐々木幸士", from: "2025-11-27", to: null },
  { name: "髙橋伸二", from: "2023-11-28", to: "2025-11-27" },
  { name: "菊地恵一", from: "2021-11-24", to: "2023-11-12" },
  { name: "石川光次郎", from: "2019-11-25", to: "2021-11-24" },
  { name: "相沢光哉", from: "2019-07-03", to: "2019-11-12" },
  { name: "佐藤光樹", from: "2018-11-26", to: "2019-07-03" },
];
const miyagiChairsOn = (d: string) => MIYAGI_CHAIRS.filter((c) => c.from <= d && (c.to === null || d <= c.to));

const probeMiyagi: Prober = (k, mode) => {
  const m: Measured = { judged: 0, mismatch: 0, handover: 0 };
  for (const b of miyagiBooks) {
    for (const r of b.rows) {
      const date = toIsoDate(r.dateText, b.sessionYear, b.sessionMonth);
      const on = miyagiChairsOn(date);
      if (on.length === 0) continue; // 表に無い日付は判定外（推定しない）
      m.judged++;
      // **在任期間が重なる日 = 交代当日**（`to` と次の `from` が同じ日）
      if (on.length > 1) m.handover++;
      // `strict` は「その日に就任した人」だけを許す。`allowPrev` は重なっている全員を許す。
      const want = mode === "strict" ? [on.reduce((a, c) => (a.from > c.from ? a : c))] : on;
      const cells = k === 0 ? r.cells : rot(r.cells, k);
      const at = cells.flatMap((c, x) => (c === "議" ? [x] : []));
      if (at.length !== 1) { m.mismatch++; continue; }
      const got = localNameKey(b.members[at[0]].nameText);
      if (!want.some((c) => localNameKey(c.name) === got)) m.mismatch++;
    }
  }
  return m;
};

/* ============================================================ *
 * 測定
 * ============================================================ */

const PROBES: { pref: string; probe: Prober }[] = [
  { pref: "宮城", probe: probeMiyagi },
  { pref: "奈良", probe: probeNara },
  { pref: "鳥取", probe: probeTottori },
  { pref: "島根", probe: probeShimane },
  { pref: "徳島", probe: probeTokushima },
];

/**
 * **実測した母数**（#757。**先に固定する**——母数が減れば、以降の「全部落ちた」は静かに空回りする）。
 * **`judged` は回転させても変わらない**ことも下で確かめる（変わるなら `議` の数え方が回転に依存している）。
 */
const DENOMINATOR: Record<string, number> = { 宮城: 356, 奈良: 180, 鳥取: 133, 島根: 140, 徳島: 132 };

/** **交代当日の行**（`allowPrev` のとき「2 人のどちらか」しか言えない行）。**実測。** */
const HANDOVER_ROWS: Record<string, number> = { 宮城: 0, 奈良: 37, 鳥取: 0, 島根: 0, 徳島: 0 };

test("#906/#901 母数を先に固定する: 5 県の判定できた行は 356 / 180 / 133 / 140 / 132（計 941）", () => {
  let total = 0;
  for (const { pref, probe } of PROBES) {
    const r = probe(0, "allowPrev");
    assert.equal(r.judged, DENOMINATOR[pref], `${pref} の母数`);
    assert.equal(r.mismatch, 0, `${pref} は無改造で県の公表と一致する`);
    total += r.judged;
  }
  assert.equal(total, 941, "5 県の合計");
});

/**
 * **`strict` は奈良では「正しい扱い」ではない**——**無改造でも 35 行が食い違う。**
 *
 * **奈良の交代当日（2026-07-02）の 37 行のうち 35 行は、前任 田中惟允 が議事を執っている**
 * （#872 が一次資料で 1 行ずつ確かめた）。**`strict`（その日に就任した人だけを許す）は、
 * この 35 行を「食い違い」と呼ぶ。だが食い違っているのは一次資料ではなく、扱いのほうである。**
 *
 * **ここが「回転で落ちた行数」を読むときの落とし穴である**——
 * **無改造で 35 行落ちている錨は、回転させて 90 行落ちても「55 行ぶん捕まえた」としか言えない。**
 * **だから `strict` の数字は、無改造の 35 行と一緒に読む。**
 */
test("#906 `strict` は奈良では無改造でも 35 行落ちる（**扱いのほうが一次資料と食い違っている**）", () => {
  assert.equal(probeNara(0, "strict").mismatch, 35, "無改造の `strict` で落ちた行");
  assert.equal(probeNara(0, "allowPrev").mismatch, 0, "`allowPrev` なら 0");
  // **ほかの 4 県は交代当日の行が 0 なので、`strict` と `allowPrev` の区別が効かない**
  for (const { pref, probe } of PROBES) {
    if (pref === "奈良") continue;
    assert.equal(probe(0, "strict").mismatch, 0, `${pref} は strict でも無改造 0`);
  }
});

test("#906 母数は回転させても変わらない（変われば `議` の数え方が回転に依存している＝測定が壊れている）", () => {
  for (const { pref, probe } of PROBES) {
    for (const k of ROTATIONS) {
      for (const mode of ["strict", "allowPrev"] as const) {
        assert.equal(probe(k, mode).judged, DENOMINATOR[pref], `${pref} ${k} 列回転 (${mode}) で母数が変わった`);
      }
    }
  }
});

test("#906 交代当日の行: 奈良に 37 行ある。ほかの 4 県は 0 行（**「0 行」も結論である**）", () => {
  for (const { pref, probe } of PROBES) {
    assert.equal(probe(0, "allowPrev").handover, HANDOVER_ROWS[pref], `${pref} の交代当日の行`);
  }
  // **徳島が 0 なのは「交代が無かった」からではない**——**境目を一次資料で確定させたからである**（#875）。
  // **宮城・鳥取・島根が 0 なのは、フィクスチャの議決日が交代日と重ならなかったからである。**
  assert.equal(HANDOVER_ROWS["奈良"], 37);
});

/**
 * **本題**: **`1 / 2 / −1 / −2` の 4 回転で、何行が落ちるか。**
 *
 * **交代当日の行が 0 の 4 県（宮城・鳥取・島根・徳島）は、4 回転とも全行が落ちる。穴は無い。**
 */
test("#906 交代当日が 0 行の 4 県は、4 回転（1 / 2 / −1 / −2）とも全行が落ちる", () => {
  for (const { pref, probe } of PROBES) {
    if (pref === "奈良") continue;
    for (const mode of ["strict", "allowPrev"] as const) {
      for (const k of ROTATIONS) {
        const r = probe(k, mode);
        assert.equal(r.judged, DENOMINATOR[pref], `${pref} ${k} 列回転 (${mode}): 母数`);
        assert.equal(r.mismatch, DENOMINATOR[pref], `${pref} を ${k} 列回して落ちたのは ${r.mismatch} / ${r.judged} 行`);
      }
    }
  }
});

/**
 * **「全回転で全行落ちる」は、それだけでは弱い主張である**（**変異で実測した**）。
 *
 * **宮城の `readMembers` が返す配列を反転させると、名簿と記号帯の対応が丸ごと壊れる。**
 * **だが「4 県は全回転で落ちる」は緑のままだった**——**壊れた状態でも、どの回転でも
 * 「県公表の議長と違う人」になるので `mismatch == 母数` が成り立つからである**（実測: 0 / 1 / 2 / −1 / −2 のすべてで 356 / 356）。
 *
 * **捕まえたのは「無改造で mismatch が 0」のほうだけだった。**
 * **つまりこの 2 つは互いの代わりにならない**——**上の「母数を先に固定する」テストが本体で、
 * 回転のテストは「回転を捕まえられること」しか言っていない。**
 * **回転で落ちた行数を「錨の強さ」として読むときは、無改造の 0 と必ず一緒に読むこと。**
 */
test("#906 回転のテストだけでは名簿の反転を捕まえない（**無改造の 0 と対で読む**）", () => {
  // **ここは機序を言葉で残すためのテストである。** 数字そのものは変異でしか出せない
  // （実装を壊した状態の値なので、無改造のこのテストからは作れない）。
  // **代わりに「無改造で 0」と「全回転で母数」が別々の主張であることを、形の上で固定する。**
  for (const { pref, probe } of PROBES) {
    const base = probe(0, "allowPrev");
    assert.equal(base.mismatch, 0, `${pref} 無改造`);
    // **同じ県で、回転させると母数いっぱいまで上がる**（奈良の `−1` / `+1` を除く）
    if (pref === "奈良") continue;
    assert.equal(probe(1, "allowPrev").mismatch, DENOMINATOR[pref], `${pref} 1 列回転`);
  }
  // **2 つの主張は別物である**: 前者は「今の読みが県の公表と合う」、
  // 後者は「読みをずらすと合わなくなる」。**名簿ごと壊れると前者だけが落ちる。**
  assert.notEqual(0, DENOMINATOR["宮城"], "母数が 0 なら両方とも空回りする（#757）");
});

/**
 * **奈良は `strict` でも `−1` で穴が開く。しかも開き方が逆である。**
 *
 * **`strict` の無改造は 35 行落ちている**（前任が議事を執った 35 行を「食い違い」と呼ぶため）。
 * **`−1` 回すと、その 35 行が「一致」に変わる**——**1 列ずらした表のほうが、錨に対して綺麗に見える。**
 * **落ちた行数は 180 → 145 へ減る**（**#901 で会期を 2 → 4 にする前は 125 → 90。減る幅は 35 で同じ**）。
 * **「回転で落ちる行数が多いほど錨が強い」と読めない例である**（#911）。
 */
test("#906/#901 奈良は `strict` でも `−1` で 145 / 180 しか落ちない（**ずらしたほうが一致が増える**）", () => {
  const byRot: Record<number, number> = {};
  for (const k of ROTATIONS) byRot[k] = probeNara(k, "strict").mismatch;
  assert.equal(byRot[1], 180, "+1 列回転");
  assert.equal(byRot[2], 180, "+2 列回転");
  assert.equal(byRot[-1], 145, "**−1 列回転: 145 / 180 しか落ちない**");
  assert.equal(byRot[-2], 180, "−2 列回転");
  // **無改造 35 落ち → `−1` で 145 落ち。** **交代当日の 37 行だけを見ると 35 → 2 へ「改善」している。**
  assert.equal(probeNara(0, "strict").mismatch, 35, "無改造");
  // **#901 で会期を 2 → 4 にしても、生き残る行は 35 のまま 1 行も増減しない**——
  // **穴は「交代当日の 1 本（2026-07-02）」の中にあり、増やした 3 本は交代日ではないため。**
  assert.equal(180 - byRot[-1], 35, "生き残る行（母数が 125 → 180 に増えても 35 のまま）");
  assert.equal(125 - 90, 35, "広げる前の同じ値（`--sessions 2` の実測）");
  // **その 37 行だけを取り出すと、`−1` のほうが一致が多い**（#891 が高知で見つけたのと同じ向きの罠）。
  assert.ok(byRot[-1] - 35 < 180 - 35, "`−1` は他の回転より捕まえる行が少ない");
});

/**
 * **`allowPrev`（交代当日は前任も許す）にすると、奈良だけが穴を開ける。**
 *
 * **これは高知（#876）で見つかったのと同じ機序である**——
 * **前任 田中惟允 が列 30、後任 乾浩之 が列 29 で隣り合っており、
 * `−1` 列回すと `議` が前任から後任へ移るだけで、「どちらも許す」ので落ちない。**
 *
 * **つまり「交代当日に前任と後任が隣の列に居る」形は高知に固有ではない**（#906 の問い）。
 */
test("#906/#901 `allowPrev`: **奈良が `−1` で 35 行・`+1` で 2 行を取り逃がす**（高知と同じ機序）", () => {
  const nara: Record<number, number> = {};
  for (const k of ROTATIONS) nara[k] = probeNara(k, "allowPrev").mismatch;
  // **母数 180 のうち、落ちるべきなのに落ちない行**
  assert.equal(nara[1], 178, "+1 列回転: 2 行が生き残る");
  assert.equal(nara[2], 180, "+2 列回転: 穴は無い");
  assert.equal(nara[-1], 145, "**−1 列回転: 35 行が生き残る**");
  assert.equal(nara[-2], 180, "−2 列回転: 穴は無い");
  // **#901 で 125 → 180 に広げても、穴の行数は 35 / 2 のまま 1 行も動かない**
  // （**穴は交代当日の 1 本の中にあり、増えた 3 本は交代日ではない**）。
  // **動いたのは割合のほうで、28.0% → 19.4% に薄まっただけである**——
  // **「広げたら錨が強くなった」ではない。穴はそのままそこにある**（#911）。
  assert.equal(DENOMINATOR["奈良"] - nara[-1], 35, "`−1` で生き残る行（広げる前と同じ 35）");
  assert.equal(DENOMINATOR["奈良"] - nara[1], 2, "`+1` で生き残る行（広げる前と同じ 2）");
  assert.equal(Math.round((35 / 125) * 1000) / 10, 28.0, "広げる前の割合");
  assert.equal(Math.round((35 / 180) * 1000) / 10, 19.4, "広げた後の割合（**穴の行数は同じ**）");
  // **高知と同じく `−1` がいちばん深い。** **`−2` では出ない**——**隣の列でなくなるから。**
  assert.ok(nara[-1] < nara[1], "`−1` のほうが `+1` より深い穴である");
  // **ほかの 4 県は `allowPrev` にしても全行落ちる**（交代当日の行が 0 なので扱いが効かない）
  for (const { pref, probe } of PROBES) {
    if (pref === "奈良") continue;
    for (const k of ROTATIONS) assert.equal(probe(k, "allowPrev").mismatch, DENOMINATOR[pref], `${pref} ${k} 列回転 (allowPrev)`);
  }
});

test("#906 奈良の穴の機序: 前任と後任が**隣の列**に居る（列 30 と列 29）", () => {
  const b = naraBooks.find((x) => x.name === "20260702_giinbetsu_hyoketsu.pdf");
  assert.ok(b, "交代当日の本");
  assert.equal(b.pdf.date, "2026-07-02");
  const names = b.pdf.members.map((x) => norm(x.nameText));
  assert.equal(names.indexOf(norm("田中惟允")), 30, "前任の列");
  assert.equal(names.indexOf(norm("乾浩之")), 29, "後任の列");
  // **隣り合っているから、`−1` 回転が「許される 2 人」の間を移るだけになる。**
  assert.equal(Math.abs(30 - 29), 1, "隣の列である");
  // **この本の 37 行のうち、35 行は前任・2 行は後任が議事を執っている**（#872 が一次資料で 1 行ずつ確かめた）。
  const byCol = new Map<number, number>();
  for (const r of b.pdf.rows) {
    const i = r.cells.findIndex((c) => c === "議");
    byCol.set(i, (byCol.get(i) ?? 0) + 1);
  }
  assert.equal(byCol.get(30), 35, "前任が議事を執った行");
  assert.equal(byCol.get(29), 2, "後任が議事を執った行");
  // **`−1` 回すと 35 行が前任 → 後任へ移り、どちらも許されるので生き残る。**
  // **`+1` 回すと 2 行が後任 → 前任へ移り、同じ理由で生き残る。** **合わせて 37 行。**
  assert.equal(35 + 2, 37);
});

/**
 * **だが奈良は塞がっている**——**`nara-vote-alignment.test.ts` が交代当日の 37 行を
 * 「どの行がどちらの議長か」まで 1 行ずつ固定しているからである。**
 *
 * **これが高知との違いである。** **高知の 2 月の本（81 行）は全部が交代当日で、
 * 行ごとの固定が無く、`除` 1 セルだけが塞いでいる。**
 */
test("#906 奈良は行ごとの固定で塞がっている: 37 行を 1 行ずつ固定すると 4 回転とも 37 / 37 落ちる", () => {
  const b = naraBooks.find((x) => x.name === "20260702_giinbetsu_hyoketsu.pdf")!;
  const names = b.pdf.members.map((x) => norm(x.nameText));
  // **#872 が一次資料で確かめた対応**（議第68号・議第69号 だけが新議長）
  const NEW_ROWS = ["議第68号", "議第69号"];
  const check = (k: number): { judged: number; bad: number } => {
    let judged = 0, bad = 0;
    for (const r of b.pdf.rows) {
      const cells = k === 0 ? r.cells : rot(r.cells, k);
      const i = cells.findIndex((c) => c === "議");
      judged++;
      const want = norm(NEW_ROWS.includes(r.number) ? "乾浩之" : "田中惟允");
      if (i < 0 || names[i] !== want) bad++;
    }
    return { judged, bad };
  };
  assert.deepEqual(check(0), { judged: 37, bad: 0 }, "無改造");
  for (const k of ROTATIONS) assert.deepEqual(check(k), { judged: 37, bad: 37 }, `${k} 列回転`);
});

/**
 * **`−2` を当てているのは 5 県のうち鳥取だけだった**（実測）。
 * **高知の穴は `−1` でしか出なかった**ので、**当てる回転が足りていないと穴を見落とす。**
 * **この測定は 5 県に `−2` を当てた最初のものである。**
 */
test("#906 既存の 5 県のテストが当てている回転: `−2` を当てているのは鳥取だけ", () => {
  const found: Record<string, number[]> = {};
  for (const pref of ["nara", "tottori", "miyagi", "shimane", "tokushima"]) {
    const src = readFileSync(T + `${pref}-vote-alignment.test.ts`, "utf8");
    const ks = new Set<number>();
    for (const m of src.matchAll(/for \(const (?:k|shift|rot) of \[([^\]]*)\]/g)) {
      for (const n of m[1].split(",")) { const v = Number(n.trim()); if (Number.isFinite(v)) ks.add(v); }
    }
    found[pref] = [...ks].sort((a, b) => a - b);
  }
  // **`−2` を当てているファイル**
  const withMinus2 = Object.entries(found).filter(([, ks]) => ks.includes(-2)).map(([p]) => p);
  assert.deepEqual(withMinus2, ["tottori"], `\`−2\` を当てているのは ${withMinus2.join(",")}`);
  // **`−1` は 5 県すべてが当てている**（当てていなければ高知の形は誰も測っていないことになる）
  for (const [pref, ks] of Object.entries(found)) assert.ok(ks.includes(-1), `${pref} は −1 を当てていない`);
});
