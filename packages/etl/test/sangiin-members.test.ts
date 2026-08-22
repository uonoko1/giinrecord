import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseMemberList, memberIdFromProfileId, toSummary } from "../src/sources/sangiin-members.ts";
import { groupFullName, matchesGroup } from "../src/sources/sangiin-groups.ts";

const SRC = "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm";
const html = readFileSync(new URL("./fixtures/sangiin-giin-221.htm", import.meta.url), "utf-8");

test("第221回の一覧は250行中、見出し・索引行を除き247名（定数248・欠員1）を返す", () => {
  const members = parseMemberList(html, SRC, 221);
  assert.equal(members.length, 247);
  assert.equal(new Set(members.map((m) => m.id)).size, 247);
});

test("先頭の議員: 氏名の全角空白は1つに正規化、かな・会派略称・選挙区・任期満了(ISO)・sessionFrom", () => {
  const [m] = parseMemberList(html, SRC, 221);
  assert.equal(m.id, "m_007006");
  assert.equal(m.name, "青木 愛");
  assert.equal(m.kana, "あおき あい");
  assert.equal(m.house, "sangiin");
  assert.equal(m.sourceUrl, SRC);
  assert.deepEqual(m.terms, [{ house: "sangiin", group: "立憲", district: "比例", from: "", to: "2028-07-25", sessionFrom: 221 }]);
});

test("任期満了 令和13年7月28日 → 2031-07-28 に変換される", () => {
  const members = parseMemberList(html, SRC, 221);
  const ends = new Set(members.map((m) => m.terms[0].to));
  assert.deepEqual([...ends].sort(), ["2028-07-25", "2031-07-28"]);
});

test("Member.id は参院プロフィールIDから決定的に導出し、氏名には依存しない", () => {
  assert.equal(memberIdFromProfileId("7007006"), "m_007006");
  assert.equal(memberIdFromProfileId("7010001"), "m_010001");
  assert.throws(() => memberIdFromProfileId("12"));
});

test("表が無い・空の HTML では空配列を返す", () => {
  assert.deepEqual(parseMemberList("<html><body></body></html>", SRC, 221), []);
});

test("プロフィールリンクの無い行はスキップされる", () => {
  const h = `<table class="list"><tr><th>議員氏名</th></tr><tr><td>欠員</td><td></td><td></td><td></td><td></td><td></td></tr></table>`;
  assert.deepEqual(parseMemberList(h, SRC, 221), []);
});

test("MemberSummary へ変換: counts は 0、group/district/termEnd は terms[0] から", () => {
  const [m] = parseMemberList(html, SRC, 221);
  assert.deepEqual(toSummary(m), {
    id: "m_007006", name: "青木 愛", kana: "あおき あい", house: "sangiin",
    group: "立憲", district: "比例", termEnd: "2028-07-25",
    counts: { rollcalls: 0, bills: 0, speeches: 0 },
  });
});

test("会派略称 → 正式名称。投票ページの会派名と突合できる", () => {
  assert.equal(groupFullName("立憲"), "立憲民主・無所属");
  assert.equal(groupFullName("自民"), "自由民主党・無所属の会");
  assert.equal(groupFullName("無所属"), "各派に属しない議員");
  assert.equal(groupFullName("存在しない"), undefined);
  assert.equal(matchesGroup("立憲", "立憲民主・無所属"), true);
  assert.equal(matchesGroup("立憲民主・無所属", "立憲民主・無所属"), true);
  assert.equal(matchesGroup("自民", "立憲民主・無所属"), false);
});

test("フィクスチャに出る会派略称はすべて対応表に載っている", () => {
  const members = parseMemberList(html, SRC, 221);
  const missing = [...new Set(members.map((m) => m.terms[0].group))].filter((g) => !groupFullName(g));
  assert.deepEqual(missing, []);
});
