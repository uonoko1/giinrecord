import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRoster, ROSTER_URLS } from "../src/sources/local/miyagi/roster.ts";

// 宮城県議会 議員名簿（Issue #157）。3 ページを合わせて 1 人分にする:
//   会派別 https://www.pref.miyagi.jp/site/kengikai/18meibo-kaiha.html（会派の正式名称）
//   選挙区別 https://www.pref.miyagi.jp/site/kengikai/18meibo-kubetu.html（選挙区）
//   五十音順 https://www.pref.miyagi.jp/site/kengikai/18meibo-gojuuon.html（ふりがな）
// いずれも 2026-08-23 取得。名簿は 56 人（定数 59、欠員 3）。
const fixture = (name: string) => readFileSync(new URL(`./fixtures/miyagi/${name}`, import.meta.url), "utf8");
const pages = { kaiha: fixture("18meibo-kaiha.html"), kubetu: fixture("18meibo-kubetu.html"), gojuuon: fixture("18meibo-gojuuon.html") };

test("parseRoster: 3 ページを合わせて 56 人。id はプロフィールページの slug から（氏名からは作らない）", () => {
  const roster = parseRoster(pages);
  assert.equal(roster.members.length, 56);
  const yuzuki = roster.members.find((m) => m.name === "柚木 貴光");
  assert.deepEqual(yuzuki, {
    id: "p_04_meibo_yuzuki",
    assemblyId: "pref-04",
    name: "柚木 貴光",
    kana: "ゆずき たかみつ",
    group: "自由民主党・県民会議",
    district: "宮城",
    profileUrl: "https://www.pref.miyagi.jp/site/kengikai/meibo_yuzuki.html",
    current: true,
    asOf: "2026-04-23",
    sourceUrl: ROSTER_URLS.kaiha,
    counts: { rollcalls: 0 },
  });
});

test("parseRoster: 絶対 URL のリンク・&nbsp;・余分な空白を含む行も同じ形に揃える", () => {
  const roster = parseRoster(pages);
  const byName = new Map(roster.members.map((m) => [m.name, m]));
  // 絶対 URL で書かれているリンク
  assert.equal(byName.get("石川 光次郎")?.id, "p_04_ishikawa");
  assert.equal(byName.get("石川 光次郎")?.district, "宮城野");
  // &nbsp; 区切りの氏名
  assert.equal(byName.get("荒川 洋平")?.kana, "あらかわ ようへい");
  // 氏名とふりがなの間に余分な空白
  assert.equal(byName.get("横山 隆光")?.kana, "よこやま たかみつ");
  assert.equal(byName.get("横山 隆光")?.group, "自由民主党・県民会議");
  // 異体字（髙）はそのまま
  assert.equal(byName.get("髙橋 伸二")?.district, "柴田");
  assert.equal(byName.get("かっち 恵")?.group, "立憲・無所属クラブ");
});

test("parseRoster: 会派別の人数（31・9・5・4・3・2・2）と選挙区別の欠員（3）が原文どおり", () => {
  const roster = parseRoster(pages);
  const sizes = new Map<string, number>();
  for (const m of roster.members) sizes.set(m.group, (sizes.get(m.group) ?? 0) + 1);
  assert.deepEqual([...sizes.entries()], [
    ["自由民主党・県民会議", 31],
    ["みやぎ県民の声", 9],
    ["日本共産党宮城県会議員団", 5],
    ["公明党県議団", 4],
    ["立憲・無所属クラブ", 3],
    ["21世紀クラブ", 2],
    ["日本維新の会", 2],
  ]);
  assert.equal(roster.vacancies, 3);
  assert.equal(roster.asOf, "2026-04-23");
  assert.equal(roster.members.every((m) => m.id.startsWith("p_04_")), true);
  assert.equal(new Set(roster.members.map((m) => m.id)).size, 56);
});

test("parseRoster: 3 ページで人が食い違えば失敗する（どちらかを黙って採用しない）", () => {
  const kubetu = pages.kubetu.replace("meibo_yuzuki.html\">柚木 貴光</a>／", "");
  assert.throws(() => parseRoster({ ...pages, kubetu }), /柚木 貴光/);
});
