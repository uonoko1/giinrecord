import { test } from "node:test";
import assert from "node:assert/strict";
import { glyphVariantPairs, legendKey } from "../src/sources/local/glyph-variants.ts";
import { localNameKey } from "../src/sources/local/name-match.ts";
import { checkCellsAgainstLegend as kochiCheck } from "../src/sources/local/kochi/votes-pdf.ts";
import { checkCellsAgainstLegend as mieCheck } from "../src/sources/local/mie/votes-pdf.ts";
import { checkCellsAgainstLegend as miyagiCheck } from "../src/sources/local/miyagi/votes-pdf.ts";
import { checkCellsAgainstLegend as naraCheck } from "../src/sources/local/nara/votes-pdf.ts";
import { checkCellsAgainstLegend as tokushimaCheck } from "../src/sources/local/tokushima/votes-pdf.ts";
import { checkCellsAgainstLegend as tottoriCheck } from "../src/sources/local/tottori/votes-pdf.ts";
import { legendOf as kochiLegendOf, mapLegend as kochiMap } from "../src/sources/local/kochi/rollcalls.ts";
import { legendOf as mieLegendOf, mapLegend as mieMap } from "../src/sources/local/mie/rollcalls.ts";
import { legendOf as miyagiLegendOf, mapLegend as miyagiMap } from "../src/sources/local/miyagi/rollcalls.ts";
import { legendOf as naraLegendOf, mapLegend as naraMap } from "../src/sources/local/nara/rollcalls.ts";
import { legendOf as shimaneLegendOf, mapLegend as shimaneMap } from "../src/sources/local/shimane/rollcalls.ts";
import { mapLegend as tokushimaMap } from "../src/sources/local/tokushima/rollcalls.ts";
import { legendOf as tottoriLegendOf, mapLegend as tottoriMap } from "../src/sources/local/tottori/rollcalls.ts";

/**
 * 表決 PDF の記号の字形の揺れ（Issue #674）。
 * #671 が 5 本の PDF で実測した「凡例の記号と本文セルの記号のコードポイントが違う」を、7 県で一様に扱う。
 * ここが見るのは 3 つ:
 *   1. 寄せる表そのもの（legendKey）
 *   2. 7 県の凡例照合（checkCellsAgainstLegend）が寄せてから引くこと
 *   3. 7 県の凡例引き（mapLegend）が寄せてから引き、それでも raw は原文のまま返すこと
 * **実データ（既存 7 県のフィクスチャ）にはまだ `✕` U+2715 は出ていない**（PO 実測 / 本 PR で 21 本の PDF を再実測）。
 * 出ていない揺れも守れているかは、ここで見本を作って確かめる。
 */

/* ---------- 1. 寄せる表 ---------- */

test("#674 legendKey: 〇 U+3007 を ○ U+25CB に寄せる（広島 Ｒ07.4 は本文が全部これで、凡例の字では 1 票も取れない）", () => {
  assert.equal("〇".codePointAt(0), 0x3007);
  assert.equal("○".codePointAt(0), 0x25cb);
  assert.equal(legendKey("〇"), "○");
});

test("#674 legendKey: ✕ U+2715 を × U+00D7 に寄せる（熊本県 令和5年2月の唯一の反対票。落とすと全会一致に見える）", () => {
  assert.equal("✕".codePointAt(0), 0x2715);
  assert.equal("×".codePointAt(0), 0x00d7);
  assert.equal(legendKey("✕"), "×");
});

test("#674 legendKey: 表に無い記号は原文のまま返す（勝手に増やさない）", () => {
  // 凡例に出る記号は素通り
  for (const c of ["○", "×", "●", "－", "議", "欠", "除", "退", "棄", "副", "白", "―"]) assert.equal(legendKey(c), c);
  // 意味の推定はしない（△ を ○ にしない。#569）
  assert.equal(legendKey("△"), "△");
  assert.equal(legendKey("▲"), "▲");
  assert.equal(legendKey("□"), "□"); // 滋賀の 辻→□ は字が失われた形。寄せる先が無い
  assert.equal(legendKey("不明"), "不明"); // UNKNOWN_CELL
  assert.equal(legendKey(""), "");
});

test("#674 legendKey: 2 文字以上のセルも 1 文字ずつ寄せる（島根の「棄権」「除斥」「議⾧」）", () => {
  // 島根の本文セルは実測で ○ / 議⾧ / － / ● / 除斥 の 5 種。うち 2 文字のものは寄せる字を含まないので素通り
  assert.equal(legendKey("棄権"), "棄権");
  assert.equal(legendKey("除斥"), "除斥");
  assert.equal(legendKey("議⾧"), "議⾧"); // 康熙部首 U+2FA7 のまま（島根は凡例側も同じ字。氏名の表とは別）
  // 寄せる字が 2 文字セルの中に混じっても、その 1 文字だけが寄る（文字列を丸ごと引く実装だと寄らない）
  assert.equal(legendKey("〇〇"), "○○");
  assert.equal(legendKey("〇議"), "○議");
  assert.equal(legendKey("議〇"), "議○");
  assert.equal(legendKey("棄〇権"), "棄○権");
  assert.equal(legendKey("✕〇"), "×○");
});

test("#674 表決の記号と氏名の字形は別の表（混ぜない）", () => {
  // 氏名の異体字は legendKey では寄らない（name-match.ts の管轄）
  assert.equal(legendKey("髙"), "髙");
  assert.equal(legendKey("⾧"), "⾧");
  // 逆に、表決の記号は localNameKey では寄らない
  assert.equal(localNameKey("〇"), "〇");
  assert.equal(localNameKey("✕"), "✕");
});

test("#674 寄せる表は「同じ字形の別コードポイント」だけ（意味の違う字を畳んでいない）", () => {
  const pairs = glyphVariantPairs();
  assert.ok(pairs.length >= 2);
  for (const [from, to] of pairs) {
    assert.equal([...from].length, 1, `${from} は 1 文字であること`);
    assert.equal([...to].length, 1, `${to} は 1 文字であること`);
    assert.notEqual(from, to);
    // 寄せ先が更に寄る（連鎖する）ことは無い＝表が閉じている
    assert.equal(legendKey(to), to, `${to} が更に寄っている`);
  }
});

/* ---------- 2. 7 県の凡例照合 ---------- */

const CHECKS: [string, (cells: readonly string[], legend: Record<string, string>, label: string) => void][] = [
  ["kochi", kochiCheck],
  ["mie", mieCheck],
  ["miyagi", miyagiCheck],
  ["nara", naraCheck],
  ["tokushima", tokushimaCheck],
  ["tottori", tottoriCheck],
];

const LEGEND = { "○": "賛成", "×": "反対", "議": "議長" };

for (const [pref, check] of CHECKS) {
  test(`#674 ${pref}: 本文の 〇 U+3007 を凡例の ○ U+25CB として通す（凡例の字で照合すると賛成票を全部落とす）`, () => {
    assert.doesNotThrow(() => check(["〇", "○", "議"], LEGEND, pref));
  });

  test(`#674 ${pref}: 本文の ✕ U+2715 を凡例の × U+00D7 として通す（熊本県型。落とすと全会一致に見える）`, () => {
    assert.doesNotThrow(() => check(["✕", "○"], LEGEND, pref));
  });

  test(`#674 ${pref}: 寄せても凡例に無い値は例外のまま（#569 推定しない。を緩めていない）`, () => {
    // △ は寄せる表に無いので、そのまま凡例に無い値
    assert.throws(() => check(["△"], LEGEND, pref), /is not in the legend/);
    // 寄せ先の × が凡例に無ければ、✕ も通らない
    assert.throws(() => check(["✕"], { "○": "賛成" }, pref), /is not in the legend/);
    assert.throws(() => check(["〇"], { "×": "反対" }, pref), /is not in the legend/);
  });
}

/* ---------- 3. 7 県の凡例引き（raw は原文のまま） ---------- */

/**
 * 7 県の「セルの原文 → 凡例の意味 → LocalVote」。凡例は 賛成/反対 だけの最小の見本。
 * 徳島だけ mapLegend が凡例そのものを取る（元からその形）。他の 6 県は legendOf が引いてから mapLegend に渡す。
 */
const VOTES = { "○": "賛成", "×": "反対" };
const MAPS: [string, (raw: string) => { raw: string; legend: string }][] = [
  ["kochi", (raw) => kochiMap(raw, kochiLegendOf(raw, VOTES, "kochi"))],
  ["mie", (raw) => mieMap(raw, mieLegendOf(raw, VOTES, "mie"))],
  ["miyagi", (raw) => miyagiMap(raw, miyagiLegendOf(raw, VOTES, "miyagi"))],
  ["nara", (raw) => naraMap(raw, naraLegendOf(raw, VOTES, "nara"))],
  ["tokushima", (raw) => tokushimaMap(raw, VOTES, "tokushima")],
  ["tottori", (raw) => tottoriMap(raw, tottoriLegendOf(raw, VOTES, "tottori"))],
  ["shimane", (raw) => shimaneMap(raw, shimaneLegendOf(raw, new Map(Object.entries(VOTES)), "shimane"))],
];

for (const [pref, map] of MAPS) {
  test(`#674 ${pref} mapLegend: 〇 U+3007 は ○ の凡例で読むが、raw は原文のまま残す`, () => {
    const v = map("〇");
    assert.equal(v.raw, "〇"); // 原文（U+3007）。寄せた ○ を保存しない
    assert.equal(v.raw.codePointAt(0), 0x3007);
    assert.equal(v.legend, "賛成");
  });

  test(`#674 ${pref} mapLegend: ✕ U+2715 は × の凡例で読むが、raw は原文のまま残す`, () => {
    const v = map("✕");
    assert.equal(v.raw, "✕");
    assert.equal(v.raw.codePointAt(0), 0x2715);
    assert.equal(v.legend, "反対");
  });

  test(`#674 ${pref} mapLegend: 寄せても凡例に無い値は例外のまま`, () => {
    assert.throws(() => map("△"), /legend/);
  });
}
