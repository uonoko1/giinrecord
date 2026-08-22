import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseMemberList, memberIdFromProfileId, toSummary, unmatchedGroups } from "../src/sources/sangiin-members.ts";
import { groupFullName, isKnownGroup, matchesGroup } from "../src/sources/sangiin-groups.ts";

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
  assert.deepEqual(m.terms, [{ house: "sangiin", group: "立憲民主・無所属", district: "比例", from: "", to: "2028-07-25", sessionFrom: 221 }]);
});

test("任期満了 令和13年7月28日 → 2031-07-28 に変換される", () => {
  const members = parseMemberList(html, SRC, 221);
  const ends = new Set(members.map((m) => m.terms[0].to));
  assert.deepEqual([...ends].sort(), ["2028-07-25", "2031-07-28"]);
});

test("Member.id は参院プロフィールIDから決定的に導出し、氏名には依存しない", () => {
  assert.equal(memberIdFromProfileId("7007006"), "m_007006");
  assert.equal(memberIdFromProfileId("7010001"), "m_010001");
  assert.equal(memberIdFromProfileId("5998003"), "m_998003");
  assert.throws(() => memberIdFromProfileId("12"));
});

test("表が無い・空の HTML では例外（0名を黙って通さず index.json を空で上書きしない）", () => {
  assert.throws(() => parseMemberList("<html><body></body></html>", SRC, 221), /no members parsed/);
});

test("プロフィールリンクの無い行はスキップされ、議員が1人も残らなければ例外", () => {
  const h = `<table class="list"><tr><th>議員氏名</th></tr><tr><td>欠員</td><td></td><td></td><td></td><td></td><td></td></tr></table>`;
  assert.throws(() => parseMemberList(h, SRC, 221), /no members parsed/);
});

test("同じ永続IDに解決する行が2つあれば例外（衝突を黙って通さない）", () => {
  const row = (pid: string) => `<tr><td><a href="../profile/${pid}.htm">甲 乙</a></td><td>こう おつ</td><td>自民</td><td>比例</td><td>令和10年7月25日</td><td></td></tr>`;
  assert.throws(() => parseMemberList(`<table>${row("7000001")}${row("5000001")}</table>`, SRC, 221), /duplicate member id/);
});

test("MemberSummary へ変換: counts は 0、group/district/termEnd は terms[0] から。名簿1つだけなら current は true", () => {
  const [m] = parseMemberList(html, SRC, 221);
  assert.deepEqual(toSummary(m), {
    id: "m_007006", name: "青木 愛", kana: "あおき あい", house: "sangiin",
    group: "立憲民主・無所属", district: "比例", termEnd: "2028-07-25", current: true,
    counts: { rollcalls: 0, bills: 0, speeches: 0 },
  });
});

test("MemberSummary へ変換: 統合済み Member の current=false はそのまま（元職）", () => {
  const [m] = parseMemberList(html, SRC, 221);
  assert.equal(toSummary({ ...m, current: false }).current, false);
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

test("フィクスチャに出る会派略称はすべて対応表に載っている（未知なら正式名称に解決されず isKnownGroup が false）", () => {
  const members = parseMemberList(html, SRC, 221);
  const missing = [...new Set(members.map((m) => m.terms[0].group))].filter((g) => !isKnownGroup(g));
  assert.deepEqual(missing, []);
  assert.equal(isKnownGroup("みら"), false);
  assert.equal(isKnownGroup("い党"), false);
});

test("index.json の文字列化: キーはソート済み・末尾改行（DATA_CONTRACT）", async () => {
  const { serializeMembersIndex } = await import("../src/sources/sangiin-members.ts");
  const [m] = parseMemberList(html, SRC, 221);
  const text = serializeMembersIndex([m]);
  assert.ok(text.endsWith("\n"));
  const keys = Object.keys(JSON.parse(text)[0]);
  assert.deepEqual(keys, [...keys].sort());
  assert.deepEqual(Object.keys(JSON.parse(text)[0].counts), ["bills", "rollcalls", "speeches"]);
});

test("通称<BR>[本名] の2行表記は通称だけを name にする（投票ページの nameText と一致させる）", () => {
  const members = parseMemberList(html, SRC, 221);
  const byId = new Map(members.map((m) => [m.id, m]));
  assert.equal(byId.get("m_004060")?.name, "蓮舫");
  assert.equal(byId.get("m_022004")?.name, "生稲 晃子");
  assert.equal(members.filter((m) => /[\[\]［］]/.test(m.name)).length, 0);
});

test("2行表記の最小ケース: <BR> の前を name にし、[本名] は legalName に保持する", () => {
  const h = `<table><tr><td><a href="../profile/7004060.htm">蓮舫<BR>[齊藤　　蓮舫]</a></td><td>れんほう</td><td>立憲</td><td>東京</td><td>令和10年7月25日</td><td></td></tr></table>`;
  const [m] = parseMemberList(h, SRC, 221);
  assert.equal(m.name, "蓮舫");
  assert.equal(m.legalName, "齊藤 蓮舫");
  const [plain] = parseMemberList(`<table><tr><td><a href="../profile/7007006.htm">青木　　愛</a></td><td>あおき あい</td><td>立憲</td><td>比例</td><td>令和10年7月25日</td><td></td></tr></table>`, SRC, 221);
  assert.equal(plain.legalName, undefined);
});

// Issue #14: 会派は回次をまたいで改称する。名簿の略称は最新の正式名称に解決するが、古い投票ページの旧名称とも同一会派として突合する。
test("改称前の正式名称（投票ページ）も同じ略称の会派として matchesGroup が true", () => {
  assert.equal(matchesGroup("自民", "自由民主党"), true);                       // 〜第219回
  assert.equal(matchesGroup("自由民主党・無所属の会", "自由民主党"), true);      // 解決済みの正式名称とも
  assert.equal(matchesGroup("立憲", "立憲民主・社民・無所属"), true);            // 〜第219回
  assert.equal(matchesGroup("Ｎ党", "ＮＨＫから国民を守る党"), true);            // 第216回名簿（第217回中に一時「ＮＨＫ党」）
  assert.equal(matchesGroup("Ｎ党", "ＮＨＫ党"), true);
  assert.equal(matchesGroup("自民", "立憲民主・社民・無所属"), false);
  assert.equal(groupFullName("Ｎ党"), "ＮＨＫから国民を守る党");
});

// Issue #14: 第217回の名簿（れいわ新選組 → 第221回で「いのちの党」に改称）では略称が「れ新」。投票ページの正式名称は「れいわ新選組」。
test("実フィクスチャ（第217回）: 『れ新』の行は正式名称『れいわ新選組』になり、未知略称に残らない", () => {
  const html217 = readFileSync(new URL("./fixtures/sangiin-giin-217.htm", import.meta.url), "utf-8");
  const members = parseMemberList(html217, SRC.replace("221", "217"), 217);
  assert.ok(members.some((m) => m.terms[0].group === "れいわ新選組"));
  assert.deepEqual(unmatchedGroups(members), []);
});

// Issue #36: 名簿の会派セルは「みら」「い党」のような2文字略称で、改行や切り詰めではない（実フィクスチャ 7025008 = い党 など）。
// 利用者に略称をそのまま見せず、会派別所属議員数（giinsu.htm）の正式名称に解決して出す。
test("実フィクスチャ: 『い党』『みら』の行は正式名称『いのちの党』『チームみらい・無所属の会』になる", () => {
  const byId = new Map(parseMemberList(html, SRC, 221).map((m) => [m.id, m]));
  assert.equal(byId.get("m_025008")?.terms[0].group, "いのちの党");
  assert.equal(byId.get("m_025005")?.terms[0].group, "チームみらい・無所属の会");
  assert.equal(byId.get("m_007006")?.terms[0].group, "立憲民主・無所属");
});

test("実フィクスチャ: index.json に略称（2文字の断片）が残らない", () => {
  const members = parseMemberList(html, SRC, 221);
  for (const g of new Set(members.map((m) => toSummary(m).group))) assert.ok(isKnownGroup(g), `unexpected group: ${g}`);
  assert.deepEqual(unmatchedGroups(members), []);
});

test("未知の略称は ETL を止めず、そのまま保持して unmatchedGroups に列挙する", () => {
  const row = (pid: string, g: string) => `<tr><td><a href="../profile/${pid}.htm">甲 乙</a></td><td>こう おつ</td><td>${g}</td><td>比例</td><td>令和10年7月25日</td><td></td></tr>`;
  const members = parseMemberList(`<table>${row("7000001", "新党")}${row("7000002", "新党")}${row("7000003", "自民")}</table>`, SRC, 221);
  assert.equal(members[0].terms[0].group, "新党");
  assert.equal(members[2].terms[0].group, "自由民主党・無所属の会");
  assert.deepEqual(unmatchedGroups(members), [{ group: "新党", memberIds: ["m_000001", "m_000002"], sourceUrl: SRC }]);
});
