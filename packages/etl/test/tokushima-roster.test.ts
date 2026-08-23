import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRoster, ROSTER_URLS } from "../src/sources/local/tokushima/roster.ts";

// 徳島県議会 議員紹介（Issue #183）。会派別（会派名・役職）と選挙区別（選挙区・ふりがな・所属会派）の 2 ページを突合する（2026-08-24 取得）。
// ページに掲載日は無いので as-of は呼び出し側（取得日）が渡す。
const html = (name: string) => readFileSync(new URL(`./fixtures/tokushima/${name}`, import.meta.url), "utf8");
const pages = { kaihabetu: html("giin-kaihabetu.html"), senkyoku: html("giin-senkyoku.html") };
const roster = parseRoster(pages, { asOf: "2026-08-24" });

test("parseRoster: 36 人（定数 38）。id はプロフィールページの slug（p_36_kami）、会派・選挙区・ふりがなは原文", () => {
  assert.equal(roster.members.length, 36);
  assert.equal(roster.seats, 38);
  const kami = roster.members.find((m) => m.id === "p_36_kami");
  assert.deepEqual(kami, {
    id: "p_36_kami",
    assemblyId: "pref-36",
    name: "嘉見 博之",
    kana: "かみ ひろゆき",
    group: "徳島県議会自由民主党",
    district: "阿南選挙区",
    profileUrl: "https://www.pref.tokushima.lg.jp/gikai/giin/kami/",
    current: true,
    asOf: "2026-08-24",
    sourceUrl: ROSTER_URLS.kaihabetu,
    counts: { rollcalls: 0 },
  });
  // 「美馬選挙区（2人）」（空白なし）も「三好第一 選挙区（2人）」も 選挙区 の名前に寄せる
  assert.equal(roster.members.find((m) => m.id === "p_36_hara")?.district, "鳴門選挙区");
  assert.equal(roster.members.find((m) => m.id === "p_36_hara")?.kana, "はら てつじ"); // 「（はら てつじ)」半角括弧
  const districts = new Map<string, number>();
  for (const m of roster.members) districts.set(m.district, (districts.get(m.district) ?? 0) + 1);
  assert.equal(districts.get("美馬選挙区"), 2);
  assert.equal(districts.size, 13);
});

test("parseRoster: 会派別の「（N人）」と実際の人数が一致し、会派の並びは会派別ページの順", () => {
  const groups: string[] = [];
  for (const m of roster.members) if (!groups.includes(m.group)) groups.push(m.group);
  assert.deepEqual(groups, ["徳島県議会自由民主党", "新しい県政を創る会", "自由民主党県民会議", "グローカルplus", "真政会", "公明党徳島県議団", "日本共産党", "護民官", "元気とくしま", "日本維新の会"]);
  assert.equal(roster.members.filter((m) => m.group === "徳島県議会自由民主党").length, 17);
});

test("parseRoster: 2 ページで人が食い違う・所属会派が食い違う・人数が合わなければ例外（どちらを正とするか推定しない）", () => {
  const withoutKami = pages.senkyoku.replace(/<li class="list-style-white-space"><a href="https:\/\/www\.pref\.tokushima\.lg\.jp\/gikai\/giin\/kami\/"[^]*?<\/ul><\/li>/, "");
  assert.throws(() => parseRoster({ ...pages, senkyoku: withoutKami }, { asOf: "2026-08-24" }), /阿南 選挙区（4人）: 3 members/);
  assert.throws(() => parseRoster({ ...pages, senkyoku: withoutKami.replace("阿南 選挙区（4人）", "阿南 選挙区（3人）") }, { asOf: "2026-08-24" }), /嘉見 博之 \(kami\) is in 会派別 but not in 選挙区別/);
  const wrongGroup = { ...pages, senkyoku: pages.senkyoku.replace("所属会派：グローカルplus", "所属会派：別の会派") };
  assert.throws(() => parseRoster(wrongGroup, { asOf: "2026-08-24" }), /所属会派/);
  const wrongCount = { ...pages, kaihabetu: pages.kaihabetu.replace("真政会（2人）", "真政会（3人）") };
  assert.throws(() => parseRoster(wrongCount, { asOf: "2026-08-24" }), /真政会/);
});
