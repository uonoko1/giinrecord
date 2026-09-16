import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseVotePdf, type VotePdf } from "../src/sources/local/tokushima/votes-pdf.ts";
import { parseSessionIndex, parseSessionPage } from "../src/sources/local/tokushima/sessions.ts";
import { readPages } from "../src/sources/local/pdf-table.ts";

/**
 * 徳島県議会の賛否 PDF を **87 本すべて開いて測った**（Issue #875、2026-09-16）。
 *
 * **徳島は既に本番に出ている**（`data/assemblies/pref-36`、**採決 105 件・3,780 セル・名簿 36 人**）。
 * **だが一次資料を全数開いた測定は一度も行われていなかった。**
 * **これは「出ているものを確かめる」測定であって、「出ているから正しい」ではない。**
 *
 * **測った結果、87 本のうち `parseVotePdf` が読めるのは 7 本（8.0%）だった。**
 * **同じ形で測った 5 県（三重 10%・宮城 10.4%・奈良 22%・鳥取 20.3%・島根 21%）より低い。**
 *
 * ## このファイルが主張すること
 *
 * 1. **x 方向（列）は外の一次資料に結べている**——`議` の列 ⇔ 県公表の議長（とくしま県議会だより）。
 *    **記号帯を 1 列でも回すと 132 / 132 行が落ちる。**
 * 2. **y 方向（行）は、記号帯については ほぼ測れていない**——**132 行中 110 行（83.3%）が
 *    隣の行と記号の並びが同一**なので、**1 行回しても 22 行しか値が変わらない。**
 *    **外の一次資料に結べる y の錨は「件名 ⇔ 提出議案 PDF」だけで、母数は 13 行。**
 *    **これは弱い。弱いことを、弱いまま固定する。**
 * 3. **`counts` が 1 件も無く `○`/`●` に `mapped` が付かない**という徳島固有の形は
 *    `tokushima-published-data.test.ts` が見張っている。**ここでは触らない。**
 *
 * ## **「(記号, 議員) の対が半セル未満か」は根拠にしていない**
 *
 * **PO が #891 で実測したとおり、この指標は 1 列ずらしても 98% が「半セル未満」になる**
 * （宮城 98.26%・PO の独立計算 98.21%）。**列の割り当てを測れるのは回転だけである。**
 */

const FX = (name: string): Buffer => readFileSync(fileURLToPath(new URL(`./fixtures/tokushima/${name}`, import.meta.url)));
const HTML = (name: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/tokushima/${name}`, import.meta.url)), "utf-8");

/** 読めた 7 本のうち、フィクスチャに置いた 7 本すべて（測定は 87 本を開いた） */
const READABLE = [
  { file: "1075652.pdf", date: "2026-09-11", rows: 1, members: 36 },
  { file: "1064407.pdf", date: "2026-07-03", rows: 20, members: 36 },
  { file: "1036105.pdf", date: "2026-02-13", rows: 1, members: 36 },
  { file: "1038136.pdf", date: "2026-02-20", rows: 1, members: 36 },
  { file: "1042426.pdf", date: "2026-03-11", rows: 83, members: 36 },
  { file: "1024978.pdf", date: "2025-11-28", rows: 7, members: 38 },
  { file: "1017725.pdf", date: "2025-10-07", rows: 19, members: 38 },
] as const;

interface Row { kind: string; number: string; title: string; committeeResult: string; result: string; cells: string[] }
interface Book { date: string; members: string[]; rows: Row[] }

const flatten = (pdf: VotePdf): Row[] =>
  pdf.sections.flatMap((s) => s.rows.map((r) => ({ kind: s.kind, number: r.number, title: r.title, committeeResult: r.committeeResult, result: r.result, cells: r.cells })));

let cached: Book[] | undefined;
async function books(): Promise<Book[]> {
  if (cached) return cached;
  const out: Book[] = [];
  for (const r of READABLE) {
    const pdf = await parseVotePdf(FX(r.file));
    out.push({ date: pdf.date, members: pdf.members.map((m) => m.nameText), rows: flatten(pdf) });
  }
  cached = out.sort((a, b) => a.date.localeCompare(b.date));
  return cached;
}

/** **回転**（ずらしではない）。ずらしは「空の列に落ちた」という安い理由で落ちるので使わない。 */
const rot = <T,>(a: readonly T[], k: number): T[] => a.map((_, i) => a[((i - k) % a.length + a.length) % a.length]);
const rotCells = (rows: readonly Row[], k: number): Row[] => rows.map((r, i) => ({ ...r, cells: rows[((i - k) % rows.length + rows.length) % rows.length].cells }));
const rotField = (rows: readonly Row[], k: number, f: "result" | "committeeResult" | "title" | "number"): Row[] =>
  rows.map((r, i) => ({ ...r, [f]: rows[((i - k) % rows.length + rows.length) % rows.length][f] }));

/* ---------------- 外の一次資料に結ぶ錨 ---------------- */

/**
 * **県が公表した議長**（とくしま県議会だより。**姓だけしか書かれていない**）:
 * - 第125号（令和7年5月11日発行）: **「正副議長選挙が行われ、議長に須見議員、副議長に大塚議員が選ばれました」**
 *   https://www.pref.tokushima.lg.jp/file/attachment/991261.pdf
 * - 第129号: **「３月11日、正副議長選挙が行われ、議長に井川議員、副議長に眞貝議員が選ばれました」**
 *   https://www.pref.tokushima.lg.jp/file/attachment/1052029.pdf
 *
 * **境目が「3月11日の翌日」なのは実測に基づく**——**3月11日の採決 83 件は、まだ 須見 が議長席にいる**
 * （選挙はその日の議事の中で行われる）。**境目を「3月11日から井川」にすると 83 行が落ちる。**
 * **この 83 行は「実装が壊れている」のではなく「境目の引き方が違う」ことを示す。**
 * **だからこの境目そのものを、下のテストで固定する。**
 */
const GICHO = [
  { from: "2025-03-12", to: "2026-03-11", surname: "須見", source: "とくしま県議会だより 第125号" },
  { from: "2026-03-12", to: "2099-12-31", surname: "井川", source: "とくしま県議会だより 第129号" },
] as const;
const surnameOf = (n: string): string => n.replace(/[\s　]/g, "").slice(0, 2);

/**
 * **検算B（x）**: **`議` が付いている列の議員の姓 ⇔ 県公表の議長。**
 * **判定できた行と、一致しなかった行を返す**（#757: 母数を書かずに「全部一致」と書かない）。
 */
function checkB(bs: readonly Book[]): { n: number; bad: number } {
  let n = 0, bad = 0;
  for (const b of bs) {
    const want = GICHO.find((g) => b.date >= g.from && b.date <= g.to);
    if (!want) continue;
    for (const r of b.rows) {
      const gi = r.cells.map((c, i) => (c === "議" ? b.members[i] : undefined)).filter((x): x is string => x !== undefined);
      n++;
      if (gi.length !== 1 || surnameOf(gi[0]) !== want.surname) bad++;
    }
  }
  return { n, bad };
}

/**
 * **検算D（y、弱い）**: **議決結果が委員会審査結果に従ったか ⇔ `○` が `●` より多いか。**
 *
 * **`○` は「議案に賛成した」ではない**——凡例は **「委員会審査結果又は議長宣告に起立（賛成）した者」**。
 * **請願が委員会で不採択なら、`○` は請願を退けた側である**（`tokushima/rollcalls.ts` の注記）。
 * **だから「不採択なのに ○ が多い」は矛盾ではない。** **委員会に付託された行だけを母数にする。**
 */
function checkD(bs: readonly Book[]): { n: number; bad: number } {
  let n = 0, bad = 0;
  for (const b of bs) {
    for (const r of b.rows) {
      const cr = r.committeeResult.replace(/[\s　]/g, "");
      if (cr === "-" || cr === "－" || cr === "") continue;
      const yes = r.cells.filter((c) => c === "○" || c === "〇").length;
      const no = r.cells.filter((c) => c === "●").length;
      if (yes + no === 0) continue;
      n++;
      if ((cr === r.result.replace(/[\s　]/g, "")) !== (yes > no)) bad++;
    }
  }
  return { n, bad };
}

/** **検算E（y、PDF の中だけ）**: 委員会審査結果 ⇔ 議決結果（付託された行だけ）。**外の資料ではない。** */
function checkE(bs: readonly Book[]): { n: number; bad: number } {
  let n = 0, bad = 0;
  for (const b of bs) for (const r of b.rows) {
    const cr = r.committeeResult.replace(/[\s　]/g, "");
    if (cr === "-" || cr === "－" || cr === "") continue;
    n++;
    if (cr !== r.result.replace(/[\s　]/g, "")) bad++;
  }
  return { n, bad };
}

/**
 * **検算F（y、外の一次資料）**: **表決 PDF の (種別, 議案番号, 件名) ⇔ 提出議案 PDF の (議第N号, 件名)。**
 *
 * **一次資料**: 会期ページ「議案等」の下の提出議案 PDF。
 * **ここで使うのは 令和8年6月定例会 7月3日提出**
 * https://www.pref.tokushima.lg.jp/file/attachment/1064168.pdf
 * **「議第２号 安定的な皇位継承を確保するための法整備の早期実現を求める意見書」** と書いてある。
 *
 * **母数は 13 行しかない**——**提出議案 PDF の多くは文字層の無いスキャン画像である**（実測）。
 * **「y を見ている検算がある」とは言えるが、「y が正しいことを示した」とは言えない。**
 */
const GIAN_ANCHORS = [{ kind: "議員提出議案", number: "2", title: "安定的な皇位継承を確保するための法整備の早期実現を求める意見書", date: "2026-07-03" }] as const;
const normTitle = (s: string): string => s.normalize("NFKC").replace(/[\s　・，,。．.…（）()]/g, "");

function checkF(bs: readonly Book[]): { n: number; bad: number } {
  let n = 0, bad = 0;
  for (const b of bs) for (const r of b.rows) {
    const a = GIAN_ANCHORS.find((x) => x.date === b.date && x.kind === r.kind && x.number === r.number.normalize("NFKC").replace(/[第号]/g, ""));
    if (!a) continue;
    n++;
    const x = normTitle(a.title), y = normTitle(r.title);
    if (!(y.includes(x) || x.includes(y))) bad++;
  }
  return { n, bad };
}

/* ---------------- 母数（0 件を見て緑にならないように） ---------------- */

test("#875 母数: 読めた 7 本・132 行・4,804 セル・議員は本ごとに 36 または 38", async () => {
  const bs = await books();
  assert.equal(bs.length, 7, "読めた本");
  assert.equal(bs.reduce((s, b) => s + b.rows.length, 0), 132, "行");
  assert.equal(bs.reduce((s, b) => s + b.rows.length * b.members.length, 0), 4_804, "セル");
  assert.deepEqual(bs.map((b) => [b.date, b.rows.length, b.members.length]), [
    ["2025-10-07", 19, 38], ["2025-11-28", 7, 38], ["2026-02-13", 1, 36],
    ["2026-02-20", 1, 36], ["2026-03-11", 83, 36], ["2026-07-03", 20, 36], ["2026-09-11", 1, 36],
  ]);
});

test("#875 記号の内訳（4,804 セルを 7 つの記号に分類しきる）", async () => {
  const bs = await books();
  const m = new Map<string, number>();
  for (const b of bs) for (const r of b.rows) for (const c of r.cells) m.set(c, (m.get(c) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries([...m].sort()), { "●": 98, "〇": 77, "○": 4393, "欠": 92, "議": 132, "退": 10, "除": 2 });
  assert.equal([...m.values()].reduce((a, b) => a + b, 0), 4_804, "母数");
  // **`不明`（UNKNOWN_CELL）が 1 つも無い**
  assert.equal(m.get("不明") ?? 0, 0, "抽出不能のセル");
});

/* ---------------- x 方向（列）——**回転で測る** ---------------- */

test("#875 検算B（x）: `議` の列 ⇔ 県公表の議長。無改造 0 / 132、1 列回すと 132 / 132 落ちる", async () => {
  const bs = await books();
  const base = checkB(bs);
  assert.equal(base.n, 132, "**判定できた行**（母数を書かずに「全部一致」と書かない。#757）");
  assert.equal(base.bad, 0, "不一致");

  // **回転（ずらしではない）。1 / 2 / 3 / −1 / 18 列、どれでも全行が落ちる**
  for (const k of [1, 2, 3, -1, 18]) {
    const r = checkB(bs.map((b) => ({ ...b, rows: b.rows.map((x) => ({ ...x, cells: rot(x.cells, k) })) })));
    assert.equal(r.n, 132, `${k} 列回転: 母数`);
    assert.equal(r.bad, 132, `**記号帯を ${k} 列回すと 132 / 132 行が落ちる**`);
  }
  // **名簿の側を回しても同じ**（どちらを動かしても対応が壊れる）
  for (const k of [1, -1]) {
    const r = checkB(bs.map((b) => ({ ...b, members: rot(b.members, k) })));
    assert.equal(r.bad, 132, `名簿を ${k} つ回す`);
  }
});

test("#875 検算B は y を 1 件も捕まえない（x しか見ていないことの確認）", async () => {
  const bs = await books();
  for (const k of [1, 2, -1]) {
    const r = checkB(bs.map((b) => ({ ...b, rows: rotCells(b.rows, k) })));
    assert.equal(r.bad, 0, `**記号帯を y に ${k} 行回しても検算B は 0 件**——議の列ごと動くため`);
  }
});

/**
 * **議長の交代の境目は「3月11日の翌日」である**（**この境目そのものを固定する**）。
 *
 * **とくしま県議会だより 第129号 は「３月11日、正副議長選挙が行われ…議長に井川議員」と書いている。**
 * **だが 3月11日 の採決 83 件は、まだ 須見 が `議` である**（実測）。
 * **選挙はその日の議事の中で行われるので、同じ日の議案審査は前任者が議長席にいる。**
 * **境目を「3月11日から井川」にすると 83 行が落ちる**——**それを数字で残す。**
 */
test("#875 議長の交代の境目: 3月11日の採決 83 件はまだ 須見。境目を 1 日早めると 83 行落ちる", async () => {
  const bs = await books();
  const early = [{ from: "2025-03-12", to: "2026-03-10", surname: "須見", source: "" }, { from: "2026-03-11", to: "2099-12-31", surname: "井川", source: "" }];
  let n = 0, bad = 0;
  for (const b of bs) {
    const want = early.find((g) => b.date >= g.from && b.date <= g.to);
    if (!want) continue;
    for (const r of b.rows) {
      const gi = r.cells.map((c, i) => (c === "議" ? b.members[i] : undefined)).filter((x): x is string => x !== undefined);
      n++;
      if (gi.length !== 1 || surnameOf(gi[0]) !== want.surname) bad++;
    }
  }
  assert.equal(n, 132, "母数");
  assert.equal(bad, 83, "**3月11日の 83 行**（`1042426.pdf` の全行）");
  // **その 83 行は 1 本に収まっている**
  const march = bs.find((b) => b.date === "2026-03-11")!;
  assert.equal(march.rows.length, 83);
  const names = new Set(march.rows.flatMap((r) => r.cells.map((c, i) => (c === "議" ? march.members[i] : undefined)).filter(Boolean)));
  assert.deepEqual([...names], ["須見 一仁"], "3月11日の議長");
});

test("#875 `議` は 132 行すべてでちょうど 1 個（ただしこれは x の検算ではない）", async () => {
  const bs = await books();
  const per = new Map<number, number>();
  for (const b of bs) for (const r of b.rows) {
    const k = r.cells.filter((c) => c === "議").length;
    per.set(k, (per.get(k) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(per), { 1: 132 });
  // **回転しても 1 個のまま**——**「議が 1 個」は列のずれを 1 件も捕まえない**（#743 が青森で実測した恒真性）
  for (const b of await books()) for (const r of b.rows) {
    assert.equal(rot(r.cells, 7).filter((c) => c === "議").length, 1, "**7 列回しても `議` は 1 個。これは恒真である**");
  }
});

/* ---------------- y 方向（行）——**弱いことを、弱いまま固定する** ---------------- */

/**
 * **y の弱さの正体**: **132 行中 110 行（83.3%）が、隣の行と記号の並びが同一である。**
 * **だから記号帯を 1 行回しても、値が実際に変わる行は 22 行しかない。**
 */
test("#875 y の弱さ: 132 行中 110 行が隣と同じ記号の並び。1 行回しても 22 行しか変わらない", async () => {
  const bs = await books();
  for (const k of [1, -1, 2]) {
    let changed = 0, total = 0;
    for (const b of bs) for (let i = 0; i < b.rows.length; i++) {
      total++;
      const j = ((i - k) % b.rows.length + b.rows.length) % b.rows.length;
      if (b.rows[i].cells.join("") !== b.rows[j].cells.join("")) changed++;
    }
    assert.equal(total, 132, "母数");
    assert.equal(changed, 22, `**y に ${k} 行回して記号の並びが実際に変わる行は 22 / 132（16.7%）**`);
  }
  // **記号の並びのユニーク数は 20 通りしかない**
  const pat = new Set<string>();
  for (const b of bs) for (const r of b.rows) pat.add(r.cells.join(""));
  assert.equal(pat.size, 20, "**132 行の記号の並びは 20 通りしかない**");
  // **全会一致（○ / 〇 と 議 だけ）の行が 36 行ある。この行どうしを入れ替えても誰も気づかない**
  const unan = bs.flatMap((b) => b.rows).filter((r) => r.cells.every((c) => c === "○" || c === "〇" || c === "議"));
  assert.equal(unan.length, 36, "**全会一致の行**");
});

test("#875 検算D（y）: 結果の追従 ⇔ ○●の多数。無改造 0 / 115。だが y を回しても 1 件しか捕まえない", async () => {
  const bs = await books();
  const base = checkD(bs);
  assert.equal(base.n, 115, "**判定できた行**（委員会に付託されなかった 17 行を母数から外した）");
  assert.equal(base.bad, 0, "不一致");
  for (const k of [1, -1, 2]) {
    const r = checkD(bs.map((b) => ({ ...b, rows: rotCells(b.rows, k) })));
    assert.equal(r.n, 115, `${k} 行回転: 母数`);
    assert.equal(r.bad, 1, `**記号帯を y に ${k} 行回しても 115 行中 1 行しか落ちない。これは弱い**`);
  }
  // **x を回しても検算D は 0 件**（記号帯を回しても ○ と ● の**個数**は変わらない）
  for (const k of [1, -1]) {
    const r = checkD(bs.map((b) => ({ ...b, rows: b.rows.map((x) => ({ ...x, cells: rot(x.cells, k) })) })));
    assert.equal(r.bad, 0, `**x に ${k} 列回しても検算D は 0 件。公表数の形の検算は x を捕まえない**（#891）`);
  }
});

test("#875 検算E（y、PDF の中だけ）: 委員会結果 ⇔ 議決結果。結果の欄を 1 行回すと 10 行落ちる", async () => {
  const bs = await books();
  const base = checkE(bs);
  assert.equal(base.n, 115, "判定できた行");
  assert.equal(base.bad, 0, "不一致");
  assert.equal(checkE(bs.map((b) => ({ ...b, rows: rotField(b.rows, 1, "result") }))).bad, 10, "議決結果の欄を +1 行");
  assert.equal(checkE(bs.map((b) => ({ ...b, rows: rotField(b.rows, -1, "result") }))).bad, 9, "議決結果の欄を −1 行");
  assert.equal(checkE(bs.map((b) => ({ ...b, rows: rotField(b.rows, 1, "committeeResult") }))).bad, 9, "委員会結果の欄を +1 行");
  // **検算E は記号帯の y を 1 件も捕まえない**（記号を見ていないので当然。ここを固定して独立性を示す）
  for (const k of [1, -1]) assert.equal(checkE(bs.map((b) => ({ ...b, rows: rotCells(b.rows, k) }))).bad, 0, `記号帯を y に ${k} 行`);
});

test("#875 検算F（y、外の一次資料）: 件名 ⇔ 提出議案 PDF。母数 13、件名を 1 行回すと 11 行落ちる", async () => {
  const bs = await books();
  // **錨そのものを一次資料から取り直す**（テストに書き写した文字列が原本と違ったら落ちる）
  const gian = await readPages(FX("gian-1064168.pdf"));
  const txt = gian.map((p) => p.items.map((i) => i.str).join("")).join("").replace(/[\s　]+/g, "");
  assert.ok(txt.includes("議第２号安定的な皇位継承を確保するための法整備の早期実現を求める意見書"), "**提出議案 PDF の原文**");
  // **同じ PDF が議長の名も書いている**（x の錨の独立な裏取り）
  assert.ok(txt.includes("徳島県議会議長井川龍二"), "**提出議案 PDF は宛先に「徳島県議会議長井川龍二」と書いている**");

  const base = checkF(bs);
  assert.equal(base.n, 1, "**このフィクスチャで判定できた行**（測定では 13 行。提出議案 PDF の多くはスキャン画像）");
  assert.equal(base.bad, 0, "不一致");
  for (const k of [1, -1]) {
    const r = checkF(bs.map((b) => ({ ...b, rows: rotField(b.rows, k, "title") })));
    assert.equal(r.n, 1, `件名を ${k} 行回転: 母数`);
    assert.equal(r.bad, 1, `**件名の欄を y に ${k} 行回すと落ちる**`);
  }
});

/**
 * **検算G（x と y を同時に結ぶ、徳島でいちばん強い錨）**:
 * **`除`（除斥）のセルが、その行の件名に名前が書かれている本人の列に落ちているか。**
 *
 * **2026-03-11 の 第77号「監査委員の選任について」は 2 行ある**——
 * **`（木下賢功氏）` の行と `（仁木啓人氏）` の行で、それぞれ本人だけが `除` である。**
 *
 * **これは列がずれても行がずれても落ちる**——
 * **列がずれれば `除` が別人の列に行き、行がずれれば `除` が別の議案の行に行く。**
 * **母数は 2 行しかないが、外の事実（件名に書かれた氏名）に結べている唯一の y の錨である。**
 *
 * **既存の `tokushima-votes-pdf.test.ts` が同じことを列番号で固定していた**（`cells[13]` / `cells[17]`）。
 * **ここでは列番号を通さず、件名の氏名と `除` の列の議員名を突き合わせる**——
 * **列番号での固定は、名簿の並びが変わったら意味が変わってしまう。**
 */
function checkG(bs: readonly Book[]): { n: number; bad: number } {
  let n = 0, bad = 0;
  for (const b of bs) for (const r of b.rows) {
    const m = r.title.match(/（(.+?)氏）$/);
    if (!m) continue;
    n++;
    const jo = r.cells.map((c, i) => (c === "除" ? b.members[i] : undefined)).filter((x): x is string => x !== undefined);
    if (jo.length !== 1 || jo[0].replace(/[\s　]/g, "") !== m[1].replace(/[\s　]/g, "")) bad++;
  }
  return { n, bad };
}

test("#875 検算G（x と y を同時に）: `除` は件名に名前がある本人の列。列を回しても行を回しても落ちる", async () => {
  const bs = await books();
  const base = checkG(bs);
  assert.equal(base.n, 2, "**判定できた行**（`（○○氏）` で終わる件名は 2 行しかない）");
  assert.equal(base.bad, 0, "不一致");
  // **x（列）を回すと落ちる**
  for (const k of [1, -1, 4]) {
    const r = checkG(bs.map((b) => ({ ...b, rows: b.rows.map((x) => ({ ...x, cells: rot(x.cells, k) })) })));
    assert.equal(r.bad, 2, `**記号帯を x に ${k} 列回すと 2 / 2 落ちる**`);
  }
  // **y（行）を回しても落ちる**——**記号帯だけを回しても、件名だけを回しても**
  for (const k of [1, -1]) {
    assert.equal(checkG(bs.map((b) => ({ ...b, rows: rotCells(b.rows, k) }))).bad, 2, `記号帯を y に ${k} 行`);
    assert.equal(checkG(bs.map((b) => ({ ...b, rows: rotField(b.rows, k, "title") }))).bad, 2, `件名を y に ${k} 行`);
  }
  // **「同じ記号の内訳を持つ隣の行と入れ替える」——検算D も E も見逃す壊し方でも、これは落ちる**
  const swapped = bs.map((b) => {
    const rows = b.rows.map((r) => ({ ...r }));
    const key = (c: readonly string[]): string => [...c].sort().join("");
    for (let i = 0; i + 1 < rows.length; i++) if (key(rows[i].cells) === key(rows[i + 1].cells)) {
      const t = rows[i].cells; rows[i].cells = rows[i + 1].cells; rows[i + 1].cells = t;
    }
    return { ...b, rows };
  });
  assert.equal(checkD(swapped).bad, 0, "**検算D は見逃す**（記号の内訳が同じなので）");
  assert.equal(checkE(swapped).bad, 0, "**検算E は見逃す**（記号を見ていないので）");
  assert.equal(checkG(swapped).bad, 2, "**検算G だけが捕まえる**");
});

/* ---------------- 87 本のうち 80 本が読めない機序 ---------------- */

/**
 * **A（46 本）: 凡例の文字の高さが `readLegendLines` の窓（8 < h < 11）の外にある。**
 *
 * **読めた 7 本の凡例は h = 9.48 / 9.60 / 9.72。**
 * **読めない 68 本は h = 11.64 / 11.76 / 12.00。**
 * **「凡例が無い」のではなく「窓の外にある」。**
 */
test("#875 A: 凡例の文字高さ。読める本は 9.48〜9.72、読めない 975943.pdf は 12.00", async () => {
  const legendHeights = async (file: string): Promise<number[]> => {
    const pages = await readPages(FX(file));
    const hs = new Set<number>();
    for (const p of pages) for (const it of p.items) if (it.str.startsWith("「○」") && it.str.includes("者")) hs.add(Number(it.h.toFixed(2)));
    return [...hs];
  };
  assert.deepEqual(await legendHeights("1064407.pdf"), [9.72], "読めた本（2026-07-03）");
  assert.deepEqual(await legendHeights("1024978.pdf"), [9.48], "読めた本（2025-11-28）");
  assert.deepEqual(await legendHeights("975943.pdf"), [12.00], "**読めない本（2025-02-12）。窓 8 < h < 11 の外**");
  // **この本には凡例が確かに在る**（無いのではなく、拾えていない）
  const pages = await readPages(FX("975943.pdf"));
  const found = pages.flatMap((p) => p.items).filter((i) => i.str.includes("「○」委員会審査結果又は議長宣告に起立（賛成）した者"));
  assert.equal(found.length, 1, "**凡例の行は 1 本ちゃんと在る**");
  await assert.rejects(parseVotePdf(FX("975943.pdf")), /legend .*not found below its table/, "それでも例外になる");
});

/**
 * **G（1 本）: 一次資料の凡例そのものが不完全。**
 *
 * **`1012533.pdf`（令和7年6月定例会 7月1日採決）の「請願」の節は、凡例に `○` `議` `●` しか書いていない。**
 * **だが表には `退` のセルが 5 つある**（請願第15号、y=423.9 の 5 列）。
 * **これは実装の欠陥ではなく、県の PDF の欠陥である。** **推定で `退席` を足さない**（#569）。
 */
test("#875 G: 1012533.pdf の請願の節は凡例に `退` が無いのに `退` のセルが 5 つある（一次資料の欠陥）", async () => {
  const pages = await readPages(FX("1012533.pdf"));
  // **3 ページ目（請願）の凡例に `退` が無い**
  const legend = pages[2].items.filter((i) => i.str.startsWith("「○」")).map((i) => i.str);
  assert.equal(legend.length, 1, "凡例の行");
  assert.equal(legend[0], "「○」委員会審査結果又は議長宣告に起立（賛成）した者、「議」議長", "**`退` も `欠` も書かれていない**");
  // **だが `退` のセルは 5 つある**
  const tai = pages[2].items.filter((i) => i.str.trim() === "退");
  assert.equal(tai.length, 5, "**`退` のセル**");
  assert.deepEqual([...new Set(tai.map((i) => Number(i.y.toFixed(1))))], [423.9], "**5 つとも同じ行（請願第15号）**");
  // **1 ページ目と 2 ページ目の凡例には `欠` / `退` がある**——**節ごとに凡例が違う**
  assert.ok(pages[0].items.some((i) => i.str.includes("「欠」欠席")), "知事提出議案の節には `欠` がある");
  await assert.rejects(parseVotePdf(FX("1012533.pdf")), /cell value "退" is not in the legend/);
});

/* ---------------- index が本数を取りこぼす ---------------- */

/**
 * **会期 index は 51 本の「各議員の表決態度」ページを持つが、`parseSessionIndex` は 33 本しか返さない。**
 *
 * 1. **figcaption が `11月定例会`（`月` の後に空白が無い）だと、正規表現 `/^(\d+)月 (定例会|臨時会)$/`
 *    に合わず、`continue` で黙って飛ばされる**——**例外にならないので気づけない。** **15 本。**
 * 2. **`平成31年・令和元年 定例会の概要` の年ページは、年見出しの正規表現に合わず例外になる**——**5 本。**
 *    **しかも前年リンクの文言も合わないので、令和2年ページから先へ辿れない。**
 */
test("#875 index: figcaption `11月定例会`（空白なし）が黙って飛ばされる。r06 は 4 本中 2 本しか返らない", () => {
  const url = "https://www.pref.tokushima.lg.jp/gikai/honkaigi/gaiyou/r06/";
  const idx = parseSessionIndex(HTML("year-r06.html"), url);
  assert.deepEqual(idx.sessions.map((s) => s.sessionId), ["2024-06", "2024-02"], "**実装が返す会期**");
  // **実際には 4 本ある**
  const links = [...HTML("year-r06.html").matchAll(/各議員の表決態度/g)];
  assert.ok(links.length >= 4, `「各議員の表決態度」の出現 ${links.length}`);
  // **飛ばされた 2 本の figcaption は `11月定例会` と `9月定例会`**（`月` の後に空白が無い）
  assert.ok(HTML("year-r06.html").includes("11月定例会"), "**空白の無い figcaption**");
  assert.ok(!/11月\s定例会/.test(HTML("year-r06.html")), "**空白ありの形は無い**");
});

test("#875 index: h29（4 本）も 3 本しか返らない／r02（5 本）は 2 本しか返らず前年へも辿れない", () => {
  const h29 = parseSessionIndex(HTML("year-h29.html"), "https://www.pref.tokushima.lg.jp/gikai/honkaigi/gaiyou/h29/");
  assert.deepEqual(h29.sessions.map((s) => s.sessionId), ["2017-09", "2017-06", "2017-02"], "**11月定例会 が落ちる**");
  const r02 = parseSessionIndex(HTML("year-r02.html"), "https://www.pref.tokushima.lg.jp/gikai/honkaigi/gaiyou/r02/");
  assert.deepEqual(r02.sessions.map((s) => s.sessionId), ["2020-04", "2020-02"], "**11月・9月・6月 が落ちる**");
  // **前年（平成31年・令和元年）へのリンクを見つけられない**——`令和1年 定例会の概要` を探すが、実物は `平成31年・令和元年 定例会の概要`
  assert.equal(r02.previousYearUrl, undefined, "**ここで年の連鎖が切れる**");
});

/**
 * **会期ページの PDF も取りこぼす。** **リンク文言が半角括弧 `(…)` や `閉会日採決` だと `PDF_TEXT` に合わない。**
 * **87 本のうち `parseSessionPage` が返すのは 36 本。**
 */
test("#875 会期ページ: `(10月7日採決)`（半角括弧）は PDF_TEXT に合わず、r07 9月定例会は例外になる", () => {
  const url = "https://www.pref.tokushima.lg.jp/gikai/honkaigi/r07/7307585/";
  const html = HTML("sess-r07-7307585.html");
  assert.ok(html.includes("各議員の表決態度(10月7日採決)"), "**ページには半角括弧の文言が在る**");
  assert.throws(() => parseSessionPage(html, url), /no 各議員の表決態度 PDF/, "**それでも「PDF が無い」と言う**");
  // **その PDF は実在して、しかも `parseVotePdf` では読める**（=「取りに行けていない」だけ）
  // 1017725.pdf がその本である（フィクスチャに置いた）
});

test("#875 会期ページ: `閉会日採決` も PDF_TEXT に合わない（h29 11月定例会は 3 本中 1 本）", () => {
  const url = "https://www.pref.tokushima.lg.jp/gikai/honkaigi/h29/gika1711-3.html";
  const page = parseSessionPage(HTML("sess-h29-gika1711-3.html"), url);
  assert.equal(page.pdfs.length, 1, "**実装が返す PDF**");
  assert.ok(HTML("sess-h29-gika1711-3.html").includes("各議員の表決態度（12月15日閉会日採決）"), "**拾えていない 1 本**");
  assert.ok(HTML("sess-h29-gika1711-3.html").includes("各議員の表決態度（11月27日開会日採決）"), "**拾えていない もう 1 本**");
});

/* ---------------- 名簿に無い議員（2025 年の 2 本） ---------------- */

/**
 * **2025 年の 2 本は議員が 38 人で、うち 2 人（`北島 一人`・`古川 広志`）が今の名簿（36 人）に無い。**
 * **`--sessions` を 3 以上にすると、この 2 人は `unmatched` に落ちる**（**推定で紐づけない**。#569）。
 */
test("#875 2025 年の 2 本は 38 人。`北島 一人` と `古川 広志` は今の名簿 36 人に無い", async () => {
  const bs = await books();
  const union = new Set(bs.flatMap((b) => b.members));
  assert.equal(union.size, 38, "**7 本に出る氏名の和集合**");
  const only2025 = [...union].filter((n) => bs.filter((b) => b.members.includes(n)).every((b) => b.date < "2026-01-01"));
  assert.deepEqual(only2025.sort(), ["北島 一人", "古川 広志"], "**2025 年の 2 本にしか出ない議員**");
  for (const b of bs) assert.equal(b.members.length, b.date < "2026-01-01" ? 38 : 36, `${b.date}`);
});
