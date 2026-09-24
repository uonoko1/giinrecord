import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cluster, readPages } from "../src/sources/local/pdf-table.ts";
import { MEMBER_COLUMN_TOLERANCE, memberColumns, parseVotePdf, UNKNOWN_CELL } from "../src/sources/local/saga/votes-pdf.ts";

/**
 * **佐賀 `MEMBER_COLUMN_TOLERANCE`（±8%）を動かさせないための回帰**（Issue #1004）。
 *
 * **この許容は「正しい値だが、余裕が非対称」**である。
 * **#1004 が二分探索で測った安全帯**（フィクスチャ 9 本 29 ページで出力が 1 ビットも変わらない区間）:
 *
 * ```
 * 安全帯 [0.020162, 0.086955]   選んだ値 0.080
 *   下の余裕 0.0598             上の余裕 0.0070
 * ```
 *
 * **実データの列間隔のばらつきは最大 1.63%** なので下は潤沢、**上は 1 桁少ない。**
 *
 * **上に外すと議員の並びが丸ごと 1 つずれ、しかも例外は飛ばない**（#569 の重いほう）。
 * **#968 の担当者は 0.30 への変更を、当てて測ってから取り消した。**
 * **測らずに「少しだけ」緩める人を止めるものが無かったので、ここに置く。**
 *
 * **ここは `parseVotePdf` を通さず、罫線の x だけを使う**（PDF の読み直しが重いので
 * `saga-votes-pdf.test.ts` とは別に、幾何だけを何通りもの許容で回せる形にしてある）。
 */

const FIXTURES = [
  "3_111805_349057_up_7elgmado.pdf",
  "3_112934_353517_up_h8tpjpnt.pdf",
  "3_114143_360206_up_8onm36yv.pdf",
  "3_119136_389175_up_bkhi5h10.pdf",
  "3_119791_394982_up_cda325jj.pdf",
  "3_48014_3948_up_zea78qos.pdf",
  "3_87962_253631_up_ita1q1dw.pdf",
  "3_95237_272348_up_pqtj45d7.pdf",
  "3_96145_279859_up_jsqwevkw.pdf",
] as const;

const bytes = (name: string): Buffer => readFileSync(new URL(`./fixtures/saga/${name}`, import.meta.url));

/** 全フィクスチャの全ページの縦罫線の x（`readPages` は重いので 1 回だけ回す）。 */
type PageVx = { file: string; page: number; vx: { x: number }[] };
let cachedPages: PageVx[] | undefined;
async function allPageVx(): Promise<PageVx[]> {
  if (cachedPages) return cachedPages;
  const out: PageVx[] = [];
  for (const file of FIXTURES) {
    const pages = await readPages(bytes(file));
    pages.forEach((p, i) => out.push({ file, page: i + 1, vx: p.vlines.map((v) => ({ x: v.x })) }));
  }
  cachedPages = out;
  return out;
}

/**
 * `memberColumns` を許容 `tol` で回したもの（**本体と同じ式を書き写している**）。
 * **本体を変えたらここも変える**——**写しがずれると「安全帯を測っている」が嘘になる**ので、
 * 下の「写しが本体と一致する」テストが `MEMBER_COLUMN_TOLERANCE` での出力を突き合わせる。
 */
function memberColumnsAt(vlines: readonly { x: number }[], tol: number): number[] {
  const vx = cluster(vlines.map((v) => v.x));
  if (vx.length < 10) return [];
  const gaps = vx.slice(1).map((v, k) => v - vx[k]);
  let i = gaps.length - 1;
  while (i > 0) {
    const run = gaps.slice(i - 1);
    const sorted = [...run].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    if (run.some((g) => Math.abs(g - med) > med * tol)) break;
    i--;
  }
  const cols = vx.slice(i);
  return cols.length >= 10 ? cols : [];
}

/** 全ページの列の本数（`cols.length`。0 は表紙）。出力が変わったかを見る指紋。 */
const fingerprintAt = async (tol: number): Promise<string> =>
  (await allPageVx()).map((p) => `${p.file}#${p.page}:${memberColumnsAt(p.vx, tol).map((v) => v.toFixed(3)).join(",")}`).join("|");

/* ---------- 写しが本体と一致していること（この対照が空回りしていないこと） ---------- */

test("#1004 写し: memberColumnsAt(±8%) は本体の memberColumns と 1 ページも違わない", async () => {
  const pages = await allPageVx();
  assert.equal(pages.length, 29, "フィクスチャ 9 本で 29 ページ（母数。実測 2026-09-25）");
  let withCols = 0;
  for (const p of pages) {
    const real = memberColumns(p.vx);
    const copy = memberColumnsAt(p.vx, MEMBER_COLUMN_TOLERANCE);
    assert.deepEqual(copy, real, `${p.file} p${p.page}: 写しが本体とずれている`);
    if (real.length > 0) withCols++;
  }
  assert.equal(withCols, 26, "列が取れるページは 26（残り 3 は表紙。母数を検算に入れる）");
});

/* ---------- 選んだ値そのもの ---------- */

test("#1004 許容は 0.08 ちょうど（安全帯 [0.020162, 0.086955] の中。上の余裕は 0.0070 しかない）", () => {
  assert.equal(MEMBER_COLUMN_TOLERANCE, 0.08);
  // **安全帯の外へ出ていないこと**（丸めた帯で見る。境そのものは下の 2 つの対照が押さえる）
  assert.ok(MEMBER_COLUMN_TOLERANCE >= 0.021, "安全帯の下限 0.021 以上");
  assert.ok(MEMBER_COLUMN_TOLERANCE <= 0.086, "安全帯の上限 0.086 以下");
});

/* ---------- 安全帯の中では出力が 1 ビットも変わらない ---------- */

test("#1004 安全帯 [0.021, 0.086] の中では、29 ページの列が 1 本も変わらない", async () => {
  const base = await fingerprintAt(MEMBER_COLUMN_TOLERANCE);
  for (const tol of [0.021, 0.03, 0.05, 0.0865, 0.086]) {
    assert.equal(await fingerprintAt(tol), base, `tol=${tol}: 安全帯の中なのに出力が変わった`);
  }
});

/* ---------- 上に外すと壊れる（この閾値を緩めるなという根拠） ---------- */

/**
 * **0.087 で 2 本の列が 1 本増える。** 上限 0.086955 を **0.000045** 越えただけ。
 *
 * **議員の並びが丸ごと 1 つずれ、しかも `parseVotePdf` は例外を投げない**——
 * `members.length !== n` の検査は氏名帯も一緒に 1 つ伸びるので通る。**黙って通る。**
 */
test("#1004 上限のすぐ外（0.087）で 2 本の列が +1 本になる——緩めてはいけない", async () => {
  const pages = await allPageVx();
  const changed: string[] = [];
  for (const p of pages) {
    const at8 = memberColumns(p.vx).length;
    const at87 = memberColumnsAt(p.vx, 0.087).length;
    if (at8 !== at87) changed.push(`${p.file} p${p.page}: ${at8 - 1} -> ${at87 - 1}`);
  }
  assert.deepEqual(changed, [
    "3_87962_253631_up_ita1q1dw.pdf p1: 37 -> 38",
    "3_87962_253631_up_ita1q1dw.pdf p2: 37 -> 38",
    "3_87962_253631_up_ita1q1dw.pdf p3: 37 -> 38",
    "3_95237_272348_up_pqtj45d7.pdf p1: 36 -> 37",
    "3_95237_272348_up_pqtj45d7.pdf p2: 36 -> 37",
    "3_95237_272348_up_pqtj45d7.pdf p3: 36 -> 37",
    "3_95237_272348_up_pqtj45d7.pdf p4: 36 -> 37",
    "3_95237_272348_up_pqtj45d7.pdf p5: 36 -> 37",
    "3_95237_272348_up_pqtj45d7.pdf p6: 36 -> 37",
    "3_95237_272348_up_pqtj45d7.pdf p7: 36 -> 37",
  ], "0.087 で列が増えるページ（実測 2026-09-25）");
  // **選んだ値では 1 ページも増えないこと**（「常に増える」実装でも通る対照になっていないこと）
  assert.equal(await fingerprintAt(0.087) === await fingerprintAt(MEMBER_COLUMN_TOLERANCE), false);
});

/**
 * **列が 1 本増えると何が起きるか、`parseVotePdf` の出力で押さえる。**
 *
 * **例外は飛ばない。`members[0]` が `石井秀夫` から `可`（議決結果の欄）に変わり、
 * 議員が全員 1 つ右へずれる。** **これが #569 の「別人の記録が出る」形。**
 *
 * **この 2 本では、ずれた並びのセルがすべて `不明` に落ちた**（測った事実）。
 * **`不明` に落ちるかどうかは罫線と記号の x の偶然で、設計上止まっているわけではない。**
 */
test("#1004 選んだ値では members[0] が氏名で、票が全部読める（0.087 の被害の裏返し）", async () => {
  for (const [file, rows, cells, first] of [
    ["3_87962_253631_up_ita1q1dw.pdf", 26, 962, "石井秀夫"],
    ["3_95237_272348_up_pqtj45d7.pdf", 79, 2844, "石井秀夫"],
  ] as const) {
    const pdf = await parseVotePdf(bytes(file));
    const total = pdf.rows.reduce((s, r) => s + r.cells.length, 0);
    const known = pdf.rows.reduce((s, r) => s + r.cells.filter((c) => c !== UNKNOWN_CELL).length, 0);
    assert.deepEqual(
      { rows: pdf.rows.length, cells: total, known, first: pdf.members[0].nameText },
      { rows, cells: total, known: cells, first },
      `${file}: 0.087 だと members[0] が 可 になり、読めるセルが 0 になる`,
    );
    assert.equal(total, cells, `${file}: セルの総数（母数）`);
    assert.equal(pdf.unknownCells, 0, `${file}: 不明 0`);
  }
});

/* ---------- 下に外すと「記録が出ない」（上とは別の壊れ方） ---------- */

/**
 * **下限のすぐ外（0.020）では、列が取れなくなる**（`cols.length === 0`）。
 * **その表は読めない＝記録が出ない。** **上の「別人が出る」とは重さが違う**（#569）。
 */
test("#1004 下限のすぐ外（0.020）では列が取れなくなる——壊れ方が上と違う（出ない側）", async () => {
  const pages = await allPageVx();
  const lost = pages.filter((p) => memberColumns(p.vx).length > 0 && memberColumnsAt(p.vx, 0.020).length === 0);
  assert.deepEqual(
    lost.map((p) => `${p.file} p${p.page}`),
    [2, 3, 4, 5, 6, 8].map((n) => `3_111805_349057_up_7elgmado.pdf p${n}`),
    "0.020 で列が取れなくなるページ（実測 2026-09-25）",
  );
  // **増えたページは 1 つも無い**（下は「出ない」だけで「別人が出る」にはならない）
  const grew = pages.filter((p) => memberColumnsAt(p.vx, 0.020).length > memberColumns(p.vx).length);
  assert.deepEqual(grew.map((p) => `${p.file} p${p.page}`), [], "下に外しても列は増えない");
});

/* ---------- 等価変異（固定できていないものを、固定できていないと書き残す） ---------- */

/**
 * **`memberColumns` の docblock が長らく主張していた「絶対値（±0.35pt）では落ちる」は、
 * 今のフィクスチャでは成り立たない**（#1004 で測り直した）。
 *
 * **基準点の取り違えだった。** `3_111805_349057_up_7elgmado.pdf` p2 の議員の列は
 * **min 14.580 / max 15.000 / 中央値 14.760** で、
 * **min と max の差は 0.420pt あるが、中央値からの最大距離は 0.240pt。**
 * 検査は `|g - med| > 0.35` なので **0.240 < 0.35 で通る。**
 *
 * **だからこの 2 つは等価変異で、テストでは落とせない。**
 * **落とせないことを書き残す**（「変異で落ちなかった＝テストが足りない」を黙って流さない）。
 * **相対を選んだ判断自体は変えない**——列の幅は本ごとに 10.92〜15.88pt と 1.45 倍ちがう。
 */
test("#1004 等価変異: 絶対 0.35pt も 平均 も、29 ページの出力を 1 本も変えない（固定できていない）", async () => {
  const pages = await allPageVx();
  const byRule = (vlines: readonly { x: number }[], brk: (g: number, med: number) => boolean): number => {
    const vx = cluster(vlines.map((v) => v.x));
    if (vx.length < 10) return 0;
    const gaps = vx.slice(1).map((v, k) => v - vx[k]);
    let i = gaps.length - 1;
    while (i > 0) {
      const run = gaps.slice(i - 1);
      const sorted = [...run].sort((a, b) => a - b);
      if (run.some((g) => brk(g, sorted[Math.floor(sorted.length / 2)]))) break;
      i--;
    }
    const cols = vx.slice(i);
    return cols.length >= 10 ? cols.length : 0;
  };
  const abs035 = pages.filter((p) => byRule(p.vx, (g, med) => Math.abs(g - med) > 0.35) !== memberColumns(p.vx).length);
  assert.deepEqual(abs035.map((p) => `${p.file} p${p.page}`), [], "絶対 0.35pt でも出力は変わらない（等価変異）");

  const byMean = (vlines: readonly { x: number }[]): number => {
    const vx = cluster(vlines.map((v) => v.x));
    if (vx.length < 10) return 0;
    const gaps = vx.slice(1).map((v, k) => v - vx[k]);
    let i = gaps.length - 1;
    while (i > 0) {
      const run = gaps.slice(i - 1);
      const mean = run.reduce((a, b) => a + b, 0) / run.length;
      if (run.some((g) => Math.abs(g - mean) > mean * MEMBER_COLUMN_TOLERANCE)) break;
      i--;
    }
    const cols = vx.slice(i);
    return cols.length >= 10 ? cols.length : 0;
  };
  const meanDiff = pages.filter((p) => byMean(p.vx) !== memberColumns(p.vx).length);
  assert.deepEqual(meanDiff.map((p) => `${p.file} p${p.page}`), [], "平均でも出力は変わらない（等価変異）");

  // **基準点の取り違えの実体**（「幅 0.42pt」は「±0.35pt で切れる」を意味しない）
  const r7 = pages.find((p) => p.file === "3_111805_349057_up_7elgmado.pdf" && p.page === 2)!;
  const cols = memberColumns(r7.vx);
  const gaps = cols.slice(1).map((v, k) => v - cols[k]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  assert.equal((Math.max(...gaps) - Math.min(...gaps)).toFixed(3), "0.420", "min と max の差は 0.420pt");
  assert.equal(Math.max(...gaps.map((g) => Math.abs(g - med))).toFixed(3), "0.240", "中央値からの最大距離は 0.240pt（0.35 より小さい）");
});

/* ---------- 実データのばらつき（なぜ下が潤沢なのか） ---------- */

test("#1004 実データの列間隔のばらつきは最大 1.63%（許容 8% の 5 分の 1）", async () => {
  const pages = await allPageVx();
  let worst = { where: "", dev: 0, med: 0, n: 0 };
  let measured = 0;
  for (const p of pages) {
    const cols = memberColumns(p.vx);
    if (cols.length === 0) continue;
    measured++;
    const gaps = cols.slice(1).map((v, k) => v - cols[k]);
    const sorted = [...gaps].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const dev = Math.max(...gaps.map((g) => Math.abs(g - med) / med));
    if (dev > worst.dev) worst = { where: `${p.file} p${p.page}`, dev, med, n: gaps.length };
  }
  assert.equal(measured, 26, "列が取れた 26 ページで測った（母数）");
  assert.equal(worst.where, "3_111805_349057_up_7elgmado.pdf p2");
  assert.equal(worst.n, 37, "37 間隔");
  assert.equal(worst.med.toFixed(3), "14.760", "中央値 14.760pt");
  assert.equal((worst.dev * 100).toFixed(2), "1.63", "最大偏差 1.63%");
  assert.ok(worst.dev < MEMBER_COLUMN_TOLERANCE / 4, "実データは許容の 4 分の 1 も使っていない（下は潤沢）");
});
