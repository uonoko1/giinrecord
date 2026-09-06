import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeName } from "../src/match-votes.ts";
import { nameKey as shimaneKey } from "../src/sources/local/shimane/rollcalls.ts";
import { nameKey as kochiKey } from "../src/sources/local/kochi/rollcalls.ts";
import { nameKey as naraKey } from "../src/sources/local/nara/rollcalls.ts";
import { nameKey as mieKey } from "../src/sources/local/mie/rollcalls.ts";
import { nameKey as tottoriKey } from "../src/sources/local/tottori/rollcalls.ts";
import { nameKey as tokushimaKey } from "../src/sources/local/tokushima/rollcalls.ts";
import { nameKey as miyagiKey } from "../src/sources/local/miyagi/rollcalls.ts";

/**
 * 氏名の正規化関数は8つあり、規則が4通りに分かれている（#569 の調査＝PR #576、Issue #581）。
 * ここは「どれがどれを畳むか」を1か所の表として固定するだけで、統一するかどうかは決めない
 * （畳みすぎは別人の記録を作る。#569「迷ったら出さない側に倒す」）。
 *
 * 4通りの規則（実装を見て確認済み）:
 *   国会（match-votes.normalizeName）: NFKC + 空白除去 + 髙﨑德濵邊邉の5字だけを畳む。IVS は見ない。
 *   島根・高知・奈良          : 空白除去 + IVS 除去（U+FE00-FE0F, U+E0100-E01EF） + 髙﨑𠮷（島根はさらに德⾧）。
 *   三重                      : 空白除去 + IVS 除去のみ。字体そのものは畳まない。
 *   鳥取・徳島・宮城          : 空白除去のみ。IVS も字体も畳まない。
 *
 * この表がどれか1つでも崩れたら、この Issue が固定した「規則の差」が変わったということなので、
 * 変える判断（統一するかどうか含む）は改めてこの表を直しに来た人が Issue を切って判断すること。
 */

const RULES: Record<string, (s: string) => string> = {
  国会: normalizeName,
  島根: shimaneKey,
  高知: kochiKey,
  奈良: naraKey,
  三重: mieKey,
  鳥取: tottoriKey,
  徳島: tokushimaKey,
  宮城: miyagiKey,
};

// 入力の組は #576（PR #576 本文の表）そのまま。○＝一致（畳む）、×＝不一致（畳まない）。
// 実データの2件（辻内/辻󠄀内は三重、芦高/芦󠄀髙清友は奈良）は本番で実際に発火している。
const CASES: { label: string; a: string; b: string; expect: Record<string, boolean> }[] = [
  {
    label: "辻内 裕也 vs 辻󠄀内 裕也（三重の実データ。PDF に IVS 付き、名簿に無し）",
    a: "辻内 裕也",
    b: "辻\u{E0100}内 裕也",
    expect: { 国会: false, 島根: true, 高知: true, 奈良: true, 三重: true, 鳥取: false, 徳島: false, 宮城: false },
  },
  {
    label: "芦高 清友 vs 芦󠄀髙清友（奈良の実データ。IVS と 髙/高 の字体ゆれが重なる）",
    a: "芦高 清友",
    b: "芦\u{E0100}髙清友",
    expect: { 国会: false, 島根: true, 高知: true, 奈良: true, 三重: false, 鳥取: false, 徳島: false, 宮城: false },
  },
  {
    label: "和田寛司 vs 和田寬司（#529 の青森。寛/寬 はどの規則の ITAIJI 表にも無い）",
    a: "和田寛司",
    b: "和田寬司",
    expect: { 国会: false, 島根: false, 高知: false, 奈良: false, 三重: false, 鳥取: false, 徳島: false, 宮城: false },
  },
  {
    label: "岡崎 哲也 vs 岡﨑 哲也（﨑=U+FA11 は 国会・島根・高知・奈良の ITAIJI/VARIANTS にある）",
    a: "岡崎 哲也",
    b: "岡﨑 哲也",
    expect: { 国会: true, 島根: true, 高知: true, 奈良: true, 三重: false, 鳥取: false, 徳島: false, 宮城: false },
  },
];

for (const { label, a, b, expect } of CASES) {
  test(`名寄せキーの表: ${label}`, () => {
    const actual: Record<string, boolean> = {};
    for (const [name, fn] of Object.entries(RULES)) actual[name] = fn(a) === fn(b);
    assert.deepEqual(actual, expect, `入力 ${JSON.stringify(a)} vs ${JSON.stringify(b)} の一致/不一致が想定と違う`);
  });
}

test("鳥取・徳島・宮城の nameKey は同じ実装（空白除去のみ）。3つがずれたらこの表そのものが古くなっている", () => {
  const inputs = ["髙橋 伸二", "岡﨑 哲也", "辻\u{E0100}内 裕也", "  混在　空白  "];
  for (const s of inputs) {
    assert.equal(tottoriKey(s), tokushimaKey(s));
    assert.equal(tokushimaKey(s), miyagiKey(s));
  }
});
