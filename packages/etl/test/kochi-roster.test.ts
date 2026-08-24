import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRoster } from "../src/sources/local/kochi/roster.ts";

// 高知県議会 議員名簿（会派別）（Issue #220。2026-08-24 取得）。
// /member/categories/ の 1 ページに全議員。会派の見出し行（「自由民主党（20人）」）＋
// 見出し行（議席番号・氏名・常任委員会・選挙区）＋議員の行が会派ごとに繰り返される。
// 議員ごとのプロフィールページは無い（リンクが張られていない）ので profileUrl は名簿ページ自身。
const html = readFileSync(new URL("./fixtures/kochi/member-categories.html", import.meta.url), "utf-8");
const roster = parseRoster(html);

test("parseRoster: 名簿の掲載日（（令和8年7月30日現在））を as-of にする", () => {
  assert.equal(roster.asOf, "2026-07-30");
});

test("parseRoster: 現員（欠員を除く）の議員を会派の順に読む", () => {
  // 定数37人・現員36人（欠員1人。議席番号 23 が空き）
  assert.equal(roster.members.length, 36);
  assert.equal(roster.members[0].name, "浜口 卓也");
  assert.equal(roster.members[0].kana, "はまぐち たくや");
  assert.equal(roster.members[0].group, "自由民主党");
  assert.equal(roster.members[0].district, "高知市");
  assert.equal(roster.members[roster.members.length - 1].name, "塚地 佐智");
  assert.equal(roster.members[roster.members.length - 1].group, "日本共産党");
});

test("parseRoster: id は議席番号から作る（プロフィールページが無いので氏名からは作らない）", () => {
  assert.equal(roster.members[0].id, "p_39_1");
  // 議席番号 23 は欠員なので飛ぶ（24 が公明党の先頭）
  const komei = roster.members.filter((m) => m.group === "公明党");
  assert.equal(komei.length, 3);
  assert.equal(komei[0].id, "p_39_24");
  assert.equal(komei[0].name, "西森 美和");
  assert.ok(!roster.members.some((m) => m.id === "p_39_23"));
});

test("parseRoster: 会派ごとの人数が見出しの「（N人）」と合う", () => {
  const counts = new Map<string, number>();
  for (const m of roster.members) counts.set(m.group, (counts.get(m.group) ?? 0) + 1);
  assert.deepEqual([...counts.entries()], [
    ["自由民主党", 20], ["一燈立志の会", 2], ["公明党", 3], ["自由の風", 1], ["県民の会", 4], ["日本共産党", 6],
  ]);
});

test("parseRoster: すべての行に議会・出典・プロフィール（名簿ページ）が入る", () => {
  for (const m of roster.members) {
    assert.equal(m.assemblyId, "pref-39");
    assert.equal(m.sourceUrl, "https://gikai.pref.kochi.lg.jp/member/categories/");
    assert.equal(m.profileUrl, "https://gikai.pref.kochi.lg.jp/member/categories/");
    assert.equal(m.current, true);
    assert.equal(m.asOf, "2026-07-30");
    assert.deepEqual(m.counts, { rollcalls: 0 });
    assert.notEqual(m.kana, "");
    assert.notEqual(m.district, "");
  }
});
