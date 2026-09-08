import { test } from "node:test";
import assert from "node:assert/strict";
import { localNameKey, matchByExact, matchBySubsequence, matchBySurnamePrefix } from "../src/sources/local/name-match.ts";

/**
 * 地方議会の氏名突き合わせ（Issue #636）。7 県に 4 通りあった実装を 1 か所にまとめたもの。
 * ここは「1 か所にまとめた実装が、まとめる前の 7 県それぞれの判定を保つか」を見る。
 * 規則そのものの差の表は name-normalization-table.test.ts（#581）にある。
 */

const roster = (...names: string[]) => names.map((name, i) => ({ id: `m${i + 1}`, name }));

test("#636 localNameKey: 半角・全角の空白を除く", () => {
  assert.equal(localNameKey("山田 太郎"), "山田太郎");
  assert.equal(localNameKey("山田　太郎"), "山田太郎");
  assert.equal(localNameKey(" 山　田 太 郎 "), "山田太郎");
});

test("#636 localNameKey: 異体字セレクタ（U+FE00-FE0F, U+E0100-E01EF）を除く", () => {
  // 三重の実データ: PDF に IVS 付き、名簿に無し
  assert.equal(localNameKey("辻\u{E0100}内 裕也"), localNameKey("辻内 裕也"));
  // U+FE00 台（SVS）も同じく落とす
  assert.equal(localNameKey("辻︀内"), "辻内");
  // 落とす前後で他の字を巻き込まない
  assert.equal(localNameKey("辻\u{E0100}内"), "辻内");
});

test("#636 localNameKey: 字形違い（髙﨑𠮷德⾧）を寄せる", () => {
  // 本番の名簿で実際に効いている 2 名
  assert.equal(localNameKey("髙橋 伸二"), localNameKey("高橋 伸二"));
  assert.equal(localNameKey("岡﨑 哲也"), localNameKey("岡崎 哲也"));
  assert.equal(localNameKey("𠮷田"), localNameKey("吉田"));
  assert.equal(localNameKey("德田"), localNameKey("徳田"));
  // ⾧ は康熙部首（U+2FA7）。長 に寄せる（島根 #221）
  assert.equal(localNameKey("⾧岡"), localNameKey("長岡"));
});

test("#636 localNameKey: 人名用の別字は寄せない（畳みすぎると別人の記録を作る。#569）", () => {
  assert.notEqual(localNameKey("澤田"), localNameKey("沢田"));
  assert.notEqual(localNameKey("和田寛司"), localNameKey("和田寬司"));
  assert.notEqual(localNameKey("渡邊"), localNameKey("渡辺"));
  assert.notEqual(localNameKey("濵田"), localNameKey("浜田"));
});

test("#636 matchByExact: 完全一致が 1 人ならその人、0 人・2 人以上は選ばない", () => {
  const r = roster("山田 太郎", "田中 花子", "山田 太郎");
  assert.equal(matchByExact("田中花子", r).memberId, "m2");
  // 同じキーが 2 人なら選ばず、候補を全部返す
  const dup = matchByExact("山田太郎", r);
  assert.equal(dup.memberId, "");
  assert.deepEqual(dup.candidates.map((c) => c.id), ["m1", "m3"]);
  // 0 人なら候補も空
  assert.deepEqual(matchByExact("鈴木一郎", r), { memberId: "", candidates: [] });
  // 空文字は決めない
  assert.deepEqual(matchByExact("　 ", r), { memberId: "", candidates: [] });
});

test("#636 matchBySubsequence: 完全一致を優先し、無いときだけ部分列で 1 人に決まれば寄せる", () => {
  const r = roster("芦高 清友", "西川 均", "山田 太郎");
  // 完全一致
  assert.equal(matchBySubsequence("山田太郎", r).memberId, "m3");
  // 奈良の実データ: 外字「芦」が文字層から落ちる → 「髙清友」
  assert.equal(matchBySubsequence("髙清友", r).memberId, "m1");
  // 奈良の実データ: 末尾の「均」が落ちる → 「西川」
  assert.equal(matchBySubsequence("西川", r).memberId, "m2");
});

test("#636 matchBySubsequence: 部分列で 2 人以上なら選ばず候補を返す（#569 出さない側に倒す）", () => {
  const r = roster("西森 美和", "西森 雅和");
  const m = matchBySubsequence("西森和", r);
  assert.equal(m.memberId, "");
  assert.deepEqual(m.candidates.map((c) => c.name), ["西森 美和", "西森 雅和"]);
});

test("#636 matchBySubsequence: 完全一致が 2 人なら部分列に落とさない（選ばない）", () => {
  const r = roster("山田 太郎", "山田 太郎", "山田 太郎次");
  const m = matchBySubsequence("山田太郎", r);
  assert.equal(m.memberId, "");
  assert.deepEqual(m.candidates.map((c) => c.id), ["m1", "m2"]);
});

test("#636 matchBySubsequence: 1 文字は部分列に落とさない（当たりすぎるため）", () => {
  const r = roster("山田 太郎", "田中 花子");
  // 「田」は両方の部分列だが、仮に 1 人でも決めない
  assert.deepEqual(matchBySubsequence("田", r), { memberId: "", candidates: [] });
  const only = roster("山田 太郎");
  assert.deepEqual(matchBySubsequence("山", only), { memberId: "", candidates: [] });
});

test("#636 matchBySurnamePrefix: 鳥取の「○○議員」（姓だけ）→ 前方一致", () => {
  const r = roster("浜田 一心", "浜田 妙子", "銀杏 泰利");
  assert.equal(matchBySurnamePrefix("銀杏議員", r).memberId, "m3");
  // 同姓が 2 人なら選ばず候補を返す
  const dup = matchBySurnamePrefix("浜田議員", r);
  assert.equal(dup.memberId, "");
  assert.deepEqual(dup.candidates.map((c) => c.id), ["m1", "m2"]);
  // 名の 1 文字が付く形（「浜田一議員」）で 1 人に決まる
  assert.equal(matchBySurnamePrefix("浜田一議員", r).memberId, "m1");
  // 「議員」だけなら決めない
  assert.deepEqual(matchBySurnamePrefix("議員", r), { memberId: "", candidates: [] });
});

test("#636 matchBySurnamePrefix でも字形違い・IVS を寄せる（鳥取は寄せていなかった）", () => {
  const r = roster("髙橋 伸二");
  assert.equal(matchBySurnamePrefix("高橋議員", r).memberId, "m1");
  assert.equal(matchBySurnamePrefix("辻\u{E0100}内議員", roster("辻内 裕也")).memberId, "m1");
});

test("#636 鳥取に部分列は使えない: 「森議員」は 1 文字の姓なので部分列だと当たりすぎる", () => {
  // 鳥取の PDF は姓だけ + 「議員」。部分列にすると「議員」の 2 字も名簿と突き合わせてしまい、
  // 前方一致で決まっていた 35 人が決まらなくなる（実測）。だから鳥取だけ前方一致を残す。
  const r = roster("森 雅幹", "島谷 龍司");
  assert.equal(matchBySurnamePrefix("森議員", r).memberId, "m1");
  assert.equal(matchBySubsequence("森議員", r).memberId, "");
});

test("#636 候補は名簿の並び順のまま返す（ETL は選ばない。運用者が見る）", () => {
  const r = roster("高橋 啓", "高橋 克也", "髙橋 伸二", "高橋 宗也");
  const m = matchBySubsequence("高橋", r);
  assert.equal(m.memberId, "");
  assert.deepEqual(m.candidates.map((c) => c.name), ["高橋 啓", "高橋 克也", "髙橋 伸二", "高橋 宗也"]);
});
