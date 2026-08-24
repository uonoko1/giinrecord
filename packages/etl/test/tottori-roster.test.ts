import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRoster, TOTTORI_ROSTER_URL } from "../src/sources/local/tottori/roster.ts";
import { TOTTORI_ASSEMBLY } from "../src/sources/local/tottori/site.ts";

// 鳥取県議会 議員名簿（五十音順）（Issue #184）。1 ページに全議員。各議員は h2 のリンク「姓　名（かな）」と、
// その下のカテゴリのリンク（選挙区・委員会・会派）。id はプロフィールページ（/item/{番号}.htm）の番号から作る（氏名からは作らない）。
//   https://www.pref.tottori.lg.jp/75928.htm（2026-08-24 取得）
const html = readFileSync(new URL("./fixtures/tottori/75928.htm", import.meta.url), "utf8");

test("parseRoster: 35 人。id は p_31_item_{番号}、氏名は名簿の表記（全角空白は半角 1 つ）、かな・会派・選挙区はカテゴリのリンクから", () => {
  const roster = parseRoster(html);
  assert.equal(roster.members.length, 35);
  assert.deepEqual(roster.members[0], {
    id: "p_31_item_1165907",
    assemblyId: "pref-31",
    name: "市谷 知子",
    kana: "いちたに ともこ",
    group: "無所属",
    district: "鳥取市選挙区",
    profileUrl: "https://www.pref.tottori.lg.jp/item/1165907.htm",
    current: true,
    asOf: "2023-04-30",
    sourceUrl: TOTTORI_ROSTER_URL,
    counts: { rollcalls: 0 },
  });
  const byName = new Map(roster.members.map((m) => [m.name, m]));
  assert.equal(byName.get("浜田 一哉")?.group, "自由民主党");
  assert.equal(byName.get("浜田 妙子")?.group, "民主とっとり");
  assert.equal(byName.get("銀杏 泰利")?.group, "公明党");
  assert.equal(byName.get("内田 博長")?.district, "日野郡選挙区");
  assert.equal(roster.members.every((m) => m.assemblyId === TOTTORI_ASSEMBLY.id && m.sourceUrl === TOTTORI_ROSTER_URL), true);
  // 会派ごとの人数（PDF の会派見出しと同じ 4 会派）
  const groups = new Map<string, number>();
  for (const m of roster.members) groups.set(m.group, (groups.get(m.group) ?? 0) + 1);
  assert.deepEqual([...groups.entries()].sort(), [["公明党", 3], ["民主とっとり", 6], ["無所属", 7], ["自由民主党", 19]]);
});

test("parseRoster: as-of は各議員の項目の掲載日のうち最新（ページに掲載日が無いので取得日で代用しない）", () => {
  const roster = parseRoster(html);
  assert.equal(roster.asOf, "2023-04-30");
  assert.equal(roster.members.every((m) => m.asOf === "2023-04-30"), true);
});

test("parseRoster: 会派（選挙区でも委員会でもないカテゴリ）が 1 つに決まらない・選挙区が無い・かなが読めない議員がいれば失敗する（推定しない）", () => {
  const one = (cats: string, title = "山田　太郎（やまだ　たろう）") =>
    `<html><div id="ContentPane"><p class="CreatedDate">2023年4月30日</p><h2 class="Title"><a href="/item/1.htm#itemid1">${title}</a></h2><p class="Status">in ${cats}</p></div></html>`;
  const cat = (name: string) => `<a href="/dd.aspx?moduleid=155189&amp;BlogCategory=1">${name}</a>`;
  assert.equal(parseRoster(one(`${cat("鳥取市選挙区")},${cat("総務教育常任委員会")},${cat("無所属")}`)).members[0].group, "無所属");
  assert.throws(() => parseRoster(one(`${cat("鳥取市選挙区")},${cat("総務教育常任委員会")}`)), /会派/);
  assert.throws(() => parseRoster(one(`${cat("鳥取市選挙区")},${cat("無所属")},${cat("公明党")}`)), /会派/);
  assert.throws(() => parseRoster(one(`${cat("総務教育常任委員会")},${cat("無所属")}`)), /選挙区/);
  assert.throws(() => parseRoster(one(`${cat("鳥取市選挙区")},${cat("無所属")}`, "山田　太郎")), /かな/);
  assert.throws(() => parseRoster("<html><div id='ContentPane'></div></html>"), /no members/);
});
