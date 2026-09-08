import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeName } from "../src/match-votes.ts";
import { localNameKey } from "../src/sources/local/name-match.ts";
import { nameKey as shimaneKey } from "../src/sources/local/shimane/rollcalls.ts";
import { nameKey as kochiKey } from "../src/sources/local/kochi/rollcalls.ts";
import { nameKey as naraKey } from "../src/sources/local/nara/rollcalls.ts";
import { nameKey as mieKey } from "../src/sources/local/mie/rollcalls.ts";
import { nameKey as tottoriKey } from "../src/sources/local/tottori/rollcalls.ts";
import { nameKey as tokushimaKey } from "../src/sources/local/tokushima/rollcalls.ts";
import { nameKey as miyagiKey } from "../src/sources/local/miyagi/rollcalls.ts";

/**
 * 氏名の正規化関数の表（#569 の調査＝PR #576、Issue #581、Issue #636）。
 *
 * **#581 の時点では 8 つの実装が 4 通りに分かれており、この表は「どれがどれを畳むか」を固定するだけで
 * 統一するかどうかは決めなかった**（畳みすぎは別人の記録を作る。#569「迷ったら出さない側に倒す」）。
 * **#636 でその判断をした。今は 2 通りある。**
 *
 * 今の 2 通り（実装を見て確認済み）:
 *   国会（match-votes.normalizeName）: NFKC + 空白除去 + 髙﨑德濵邊邉 の 6 字を畳む。IVS は見ない。
 *   地方 7 県（sources/local/name-match.localNameKey）: 空白除去 + IVS 除去（U+FE00-FE0F, U+E0100-E01EF）
 *     + 髙﨑𠮷德⾧ の 5 字を畳む。NFKC は掛けない。
 *
 * ## なぜ地方の 7 県を畳む側へ揃えてよいと判断したか（#636）
 * 「畳む対象を増やす」変更なので、**増やして別人に寄らないか**を実データで測ってから揃えた:
 *   1. 本番 data/ が記録している (nameText → memberId) の判定 290 件を、まとめる前の県別規則で再現できる
 *      ことを確かめた（対照: 差分 0 件）。その上で共通キーで同じ 290 件を引き直して**差分 0 件**。
 *   2. 共通キーにしたときに名簿の中で新しく同じキーになる組が生まれないことを 285 名で確認（**0 組**）。
 *      キーが変わる名簿の氏名は宮城「髙橋 伸二」1 名だけで、同議会の 高橋啓／高橋克也／高橋宗也 とは
 *      名で区別が付く。
 *   3. 名簿の氏名から 1 文字落とした全通り（鳥取以外の 6 県 250 名・988 通り）で、
 *      本人に寄る 975 ／ 決められない 13 ／ **別人に決まる 0**。
 * **畳む字は 5 字の表に限る。**表に無い字（澤/沢・寛/寬・邊/辺・濵/浜）は寄せない——ここを緩めると
 * #569 の「別人の記録」が出る。
 *
 * ## なぜ国会は揃えないか（#636）
 * 2 つの表は出どころが違い、寄せるとどちらかが壊れる:
 *   - 国会の 濵邊邉 は参院名簿と投票ページで実際にぶれた字。地方に持ち込むと、地方の名簿で
 *     「渡邊」と「渡辺」が**別人でも同じキーになる**。
 *   - 地方の 𠮷（BMP 外）と ⾧（康熙部首 U+2FA7）は PDF の文字層に由来する。国会は HTML なので
 *     この 2 字がぶれた記録が無い。**根拠の無い字を国会の表に足さない。**
 *   - 国会は NFKC を掛けるが、地方の実データ（判定 290 件・名簿 285 名）は NFKC で 1 文字も変わらない（実測）。
 * 「似ているから」で畳まず、**それぞれの実測で育てる。**
 *
 * この表がどれか 1 つでも崩れたら規則が変わったということなので、変える判断は改めてこの表を直しに来た人が
 * Issue を切って行うこと（**崩れた行を消して通すのではなく、なぜ畳んでよいかを測って書き直す**）。
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
// 実データの 2 件（辻内/辻󠄀内は三重、芦高/芦󠄀髙清友は奈良）は本番で実際に発火している。
// #636 で地方 7 県が同じ規則になったので、地方の列は 7 つとも同じ値になる（値そのものが変わった行がある）。
const CASES: { label: string; a: string; b: string; expect: Record<string, boolean> }[] = [
  {
    // #636 まで: 三重・島根・高知・奈良のみ ○。鳥取・徳島・宮城は IVS を見ていなかった → 7 県とも ○ に。
    label: "辻内 裕也 vs 辻󠄀内 裕也（三重の実データ。PDF に IVS 付き、名簿に無し）",
    a: "辻内 裕也",
    b: "辻\u{E0100}内 裕也",
    expect: { 国会: false, 島根: true, 高知: true, 奈良: true, 三重: true, 鳥取: true, 徳島: true, 宮城: true },
  },
  {
    // #636 まで: 島根・高知・奈良のみ ○（IVS と 髙/高 の両方が要る）→ 7 県とも ○ に。
    label: "芦高 清友 vs 芦󠄀髙清友（奈良の実データ。IVS と 髙/高 の字体ゆれが重なる）",
    a: "芦高 清友",
    b: "芦\u{E0100}髙清友",
    expect: { 国会: false, 島根: true, 高知: true, 奈良: true, 三重: true, 鳥取: true, 徳島: true, 宮城: true },
  },
  {
    // 8 つ全部 ×。寛/寬 はどの表にも無い（＝別人になりうるので畳まない）。#636 でも変えていない。
    label: "和田寛司 vs 和田寬司（#529 の青森。寛/寬 はどの規則の ITAIJI 表にも無い）",
    a: "和田寛司",
    b: "和田寬司",
    expect: { 国会: false, 島根: false, 高知: false, 奈良: false, 三重: false, 鳥取: false, 徳島: false, 宮城: false },
  },
  {
    // #636 まで: 国会・島根・高知・奈良のみ ○ → 地方 7 県とも ○ に。高知の名簿「岡﨑 哲也」で実際に効く。
    label: "岡崎 哲也 vs 岡﨑 哲也（﨑=U+FA11 は 国会・地方の両方の表にある）",
    a: "岡崎 哲也",
    b: "岡﨑 哲也",
    expect: { 国会: true, 島根: true, 高知: true, 奈良: true, 三重: true, 鳥取: true, 徳島: true, 宮城: true },
  },
  {
    // #636 で足した行。宮城の名簿「髙橋 伸二」で実際に効く（PDF 側が 高 で出たら外れていた）。
    label: "高橋 伸二 vs 髙橋 伸二（宮城の実データ。髙=U+9AD9）",
    a: "高橋 伸二",
    b: "髙橋 伸二",
    expect: { 国会: true, 島根: true, 高知: true, 奈良: true, 三重: true, 鳥取: true, 徳島: true, 宮城: true },
  },
  {
    // #636 で足した行。国会だけが畳む字（濵邊邉）。**地方に持ち込むと別人が同じキーになるので入れない。**
    label: "渡邊 vs 渡辺（国会の表にだけある。地方は畳まない＝別人を作らない）",
    a: "渡邊",
    b: "渡辺",
    expect: { 国会: true, 島根: false, 高知: false, 奈良: false, 三重: false, 鳥取: false, 徳島: false, 宮城: false },
  },
  {
    // #636 で足した行。地方だけが畳む字（𠮷 は BMP 外。国会は根拠が無いので足していない）。
    label: "𠮷田 vs 吉田（𠮷=U+20BB7 は BMP 外。地方の表にだけある）",
    a: "𠮷田",
    b: "吉田",
    expect: { 国会: false, 島根: true, 高知: true, 奈良: true, 三重: true, 鳥取: true, 徳島: true, 宮城: true },
  },
];

for (const { label, a, b, expect } of CASES) {
  test(`名寄せキーの表: ${label}`, () => {
    const actual: Record<string, boolean> = {};
    for (const [name, fn] of Object.entries(RULES)) actual[name] = fn(a) === fn(b);
    assert.deepEqual(actual, expect, `入力 ${JSON.stringify(a)} vs ${JSON.stringify(b)} の一致/不一致が想定と違う`);
  });
}

test("#636 地方 7 県の nameKey は共通の localNameKey そのもの。1 県でもずれたらこの表が古くなっている", () => {
  const inputs = [
    "髙橋 伸二", "岡﨑 哲也", "辻\u{E0100}内 裕也", "  混在　空白  ", "𠮷田", "德田", "⾧岡",
    "芦\u{E0100}髙清友", "渡邊", "澤田", "", "議員",
  ];
  const locals: Record<string, (s: string) => string> = { 島根: shimaneKey, 高知: kochiKey, 奈良: naraKey, 三重: mieKey, 鳥取: tottoriKey, 徳島: tokushimaKey, 宮城: miyagiKey };
  for (const s of inputs) {
    for (const [name, fn] of Object.entries(locals)) {
      assert.equal(fn(s), localNameKey(s), `${name} の nameKey が共通の localNameKey とずれている（入力 ${JSON.stringify(s)}）`);
    }
  }
});

test("#636 国会と地方は別の規則のまま。どちらかの表を相手に写していないこと", () => {
  // 国会だけが畳む字を地方が畳み始めていたら、地方の名簿で別人が同じキーになる
  for (const c of ["濵", "邊", "邉"]) assert.notEqual(localNameKey(c), normalizeName(c), `地方が ${c} を国会と同じに畳んでいる`);
  // 地方だけが畳む字を国会が畳み始めていたら、根拠の無い字が国会の表に入っている
  assert.notEqual(normalizeName("𠮷"), localNameKey("𠮷"), "国会が 𠮷 を地方と同じに畳んでいる");
  // ⾧（康熙部首 U+2FA7）だけは両方とも 長 になるが、経路が違う: 国会は NFKC の副作用、地方は表に書いてある。
  // 「同じ結果だから同じ規則」ではないので、経路が入れ替わっていないかをここで押さえる。
  assert.equal(normalizeName("⾧"), "長");
  assert.equal(localNameKey("⾧"), "長");
  assert.equal("⾧".normalize("NFKC"), "長", "国会が ⾧ を畳めるのは NFKC のため。NFKC が外れたら国会だけ畳まなくなる");
  assert.notEqual(localNameKey("㍻"), "㍻".normalize("NFKC"), "地方は NFKC を掛けない（掛け始めたら規則が変わっている）");
});
