import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCellsAgainstLegend as kochiCheck } from "../src/sources/local/kochi/votes-pdf.ts";
import { checkCellsAgainstLegend as mieCheck } from "../src/sources/local/mie/votes-pdf.ts";
import { checkCellsAgainstLegend as miyagiCheck } from "../src/sources/local/miyagi/votes-pdf.ts";
import { checkCellsAgainstLegend as naraCheck } from "../src/sources/local/nara/votes-pdf.ts";
import { checkCellsAgainstLegend as tokushimaCheck } from "../src/sources/local/tokushima/votes-pdf.ts";
import { checkCellsAgainstLegend as tottoriCheck } from "../src/sources/local/tottori/votes-pdf.ts";
import { legendOf as kochiLegendOf } from "../src/sources/local/kochi/rollcalls.ts";
import { legendOf as mieLegendOf } from "../src/sources/local/mie/rollcalls.ts";
import { legendOf as miyagiLegendOf } from "../src/sources/local/miyagi/rollcalls.ts";
import { legendOf as naraLegendOf } from "../src/sources/local/nara/rollcalls.ts";
import { legendOf as shimaneLegendOf } from "../src/sources/local/shimane/rollcalls.ts";
import { legendOf as tottoriLegendOf } from "../src/sources/local/tottori/rollcalls.ts";
import { mapLegend as tokushimaMap } from "../src/sources/local/tokushima/rollcalls.ts";

/**
 * 「凡例に無いセル」で ETL が落ちたときの失敗メッセージ（Issue #679）。
 *
 * このメッセージは ETL が落ちたとき人間が最初に読むもので、
 * そこから `data/` のどこを見ればいいかが決まる。だから中身に契約がある:
 *   - **label**（どの議会・会期・議案か。呼び出し側が渡す rollCall id）
 *   - **raw**（実際に出たセルの原文。寄せた後の字ではない）
 *   - **凡例の一覧**（何が期待されていたか）
 * これが消えると「どこかで凡例に無い値が出た」としか分からず、`data/` を全部見て探すことになる。
 * #674 で 7 県が共通層（legendKey）を通るようになったので、「どの県か」が消える害は前より大きい。
 *
 * **文言そのものは固定しない。** `label` と `raw` と凡例が「含まれる」ことだけを見る。
 * 文全体を逐語で固定すると、文言を良くするたびにテストを直すことになる（#679 の注意）。
 * 見張っていたのは `local-glyph-variants.test.ts` の `/legend/` 部分一致だけで、
 * それは「例外が飛ぶこと」しか守っていなかった（PO が変異で実測: label と raw を消しても 0 fail）。
 */

/** 実データの label と同じ形（議会 id-会期-日付-種別-番号）。県名がここに入っている。 */
const LABEL = "kochi-pref-2026-6-20260630-議案-第1号";
/** 凡例に無い原文。寄せる表（GLYPH_VARIANTS）にも無いので、寄せても引けない。 */
const RAW = "△";

function assertMentions(fn: () => unknown, what: { label: string; raw: string; legendKeys: readonly string[] }): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error, "凡例に無い値では例外が飛ぶ（#569 推定しない）");
  const msg = err.message;
  assert.ok(msg.includes(what.label), `失敗メッセージに label（どの議会・会期・議案か）が要る: ${msg}`);
  assert.ok(msg.includes(what.raw), `失敗メッセージに raw（実際に出たセルの原文）が要る: ${msg}`);
  for (const k of what.legendKeys) {
    assert.ok(msg.includes(k), `失敗メッセージに凡例の記号 ${k}（何が期待されていたか）が要る: ${msg}`);
  }
}

/* ---------- 1. 表決 PDF の凡例照合（checkCellsAgainstLegend） ---------- */

const LEGEND = { "○": "賛成", "×": "反対" };

const CHECKS: [string, (cells: readonly string[], legend: Record<string, string>, label: string) => void][] = [
  ["kochi", kochiCheck],
  ["mie", mieCheck],
  ["miyagi", miyagiCheck],
  ["nara", naraCheck],
  ["tokushima", tokushimaCheck],
  ["tottori", tottoriCheck],
];

for (const [pref, check] of CHECKS) {
  test(`#679 ${pref} checkCellsAgainstLegend: 失敗メッセージに label とセルの原文と凡例が出る`, () => {
    assertMentions(() => check([RAW], LEGEND, LABEL), { label: LABEL, raw: RAW, legendKeys: ["○", "×"] });
  });

  test(`#679 ${pref} checkCellsAgainstLegend: 否定的対照——凡例にある値では落とさない（上の検査が恒真でないこと）`, () => {
    assert.doesNotThrow(() => check(["○", "×"], LEGEND, LABEL));
  });
}

/* ---------- 2. 表決の凡例引き（legendOf / 徳島は mapLegend） ---------- */

/**
 * 7 県ぶん。徳島だけ legendOf を持たず mapLegend が凡例そのものを取る（元からその形）。
 * label は 7 県とも呼び出し側が渡す rollCall id。
 */
type Lookup = (raw: string, legend: Record<string, string>, label: string) => unknown;

const LOOKUPS: [string, Lookup][] = [
  ["kochi", (raw, legend, label) => kochiLegendOf(raw, legend, label)],
  ["mie", (raw, legend, label) => mieLegendOf(raw, legend, label)],
  ["miyagi", (raw, legend, label) => miyagiLegendOf(raw, legend, label)],
  ["nara", (raw, legend, label) => naraLegendOf(raw, legend, label)],
  ["shimane", (raw, legend, label) => shimaneLegendOf(raw, new Map(Object.entries(legend)), label)],
  ["tokushima", (raw, legend, label) => tokushimaMap(raw, legend, label)],
  ["tottori", (raw, legend, label) => tottoriLegendOf(raw, legend, label)],
];

/** 寄せ先の × を持たない凡例。✕ U+2715 を寄せても引けないので、raw の出方を見られる。 */
const YES_ONLY = { "○": "賛成" };

for (const [pref, lookup] of LOOKUPS) {
  test(`#679 ${pref} 凡例引き: 失敗メッセージに label とセルの原文と凡例が出る`, () => {
    assertMentions(() => lookup(RAW, LEGEND, LABEL), { label: LABEL, raw: RAW, legendKeys: ["○", "×"] });
  });

  test(`#679 ${pref} 凡例引き: raw は寄せる前の原文で出る（✕ U+2715 を × と書き換えない）`, () => {
    // ✕ は × に寄せる（#674）が、寄せ先の × がこの凡例に無いので引けない。
    // このとき出す値は「PDF にこう書いてあった」＝ ✕ でなければ、data/ から探せない。
    assertMentions(() => lookup("✕", YES_ONLY, LABEL), { label: LABEL, raw: "✕", legendKeys: ["○"] });
  });

  test(`#679 ${pref} 凡例引き: 否定的対照——凡例にある値では落とさない（上の検査が恒真でないこと）`, () => {
    assert.doesNotThrow(() => lookup("○", LEGEND, LABEL));
    assert.doesNotThrow(() => lookup("×", LEGEND, LABEL));
    // 寄せてから引く（#674）ので、字形が違う原文も通る
    assert.doesNotThrow(() => lookup("〇", LEGEND, LABEL));
    assert.doesNotThrow(() => lookup("✕", LEGEND, LABEL));
  });
}
