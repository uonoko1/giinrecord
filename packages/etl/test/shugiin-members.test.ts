import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import iconv from "iconv-lite";
import {
  decodeRosterPage, memberIdFromName, memberListUrl, parseAsOf, parseShugiinMemberList, ROSTER_PAGES, unmatchedShugiinGroups,
} from "../src/sources/shugiin-members.ts";
import { isKnownShugiinGroup, resolveShugiinGroup, SHUGIIN_GROUPS } from "../src/sources/shugiin-groups.ts";
import { parseMemberList } from "../src/sources/sangiin-members.ts";
import { buildDataset } from "../src/aggregate.ts";
import { stableJson } from "../src/json.ts";

// 名簿は「令和8年2月18日現在」（第51回総選挙後）。Shift_JIS の生バイトのまま保存している。
const fixture = (page: number) => readFileSync(new URL(`./fixtures/shugiin-giin-20260218-${page}.htm`, import.meta.url));
const SRC = memberListUrl(1);
const page1 = decodeRosterPage(fixture(1));
const all = ROSTER_PAGES.flatMap((p) => parseShugiinMemberList(decodeRosterPage(fixture(p)), memberListUrl(p), 221));

test("名簿ページは Shift_JIS: 生バイトをデコードすると氏名が読める（UTF-8 として読むと読めない）", () => {
  assert.match(page1, /逢沢　　一郎君/);
  assert.doesNotMatch(fixture(1).toString("utf-8"), /逢沢/);
});

test("名簿の「令和8年2月18日現在」を ISO 日付で取り出す（いつ時点の名簿かをメタに残す）", () => {
  assert.equal(parseAsOf(page1), "2026-02-18");
  assert.equal(parseAsOf("<html></html>"), undefined);
});

test("あ行ページは 107 名。先頭: 氏名の全角空白は1つに正規化し末尾の「君」を除く。かな・会派（正式名称）・小選挙区・当選回数", () => {
  const members = parseShugiinMemberList(page1, SRC, 221);
  assert.equal(members.length, 107);
  const [m] = members;
  assert.match(m.id, /^h_[0-9a-f]{10}$/);
  assert.equal(m.name, "逢沢 一郎");
  assert.equal(m.kana, "あいさわ いちろう");
  assert.equal(m.house, "shugiin");
  assert.equal(m.sourceUrl, SRC);
  assert.deepEqual(m.terms, [{ house: "shugiin", group: "自由民主党・無所属の会", district: "岡山1", from: "", sessionFrom: 221, timesElected: 14 }]);
});

test("比例代表は「（比）北関東」の表記のまま（末尾の全角空白は落とす）", () => {
  const m = parseShugiinMemberList(page1, SRC, 221).find((x) => x.name === "青木 ひとみ");
  assert.equal(m?.terms[0].district, "（比）北関東");
  assert.equal(m?.terms[0].group, "参政党");
  const districts = new Set(all.map((x) => x.terms[0].district));
  for (const d of districts) assert.doesNotMatch(d, /[\s　]$/, `district has trailing space: "${d}"`);
});

test("当選回数「1（参2）」は衆院の回数 1 を数値に、原文は timesElectedText に残す（参院の回数は推定しない）", () => {
  const m = parseShugiinMemberList(page1, SRC, 221).find((x) => x.name === "青山 繁晴");
  assert.equal(m?.terms[0].timesElected, 1);
  assert.equal(m?.terms[0].timesElectedText, "1（参2）");
  // 単純な数値のときは原文を重複して持たない
  assert.equal(all[0].terms[0].timesElectedText, undefined);
});

test("かな書きの姓も氏名と同じ正規化（「あかま　二郎君」→「あかま 二郎」）", () => {
  const m = parseShugiinMemberList(page1, SRC, 221).find((x) => x.kana === "あかま じろう");
  assert.equal(m?.name, "あかま 二郎");
});

test("10 ページ合計 465 名（会派別所属議員数 480 − 欠員 15）、ID は全員一意、会派は全員が対応表で正式名称に解決される", () => {
  assert.equal(all.length, 465);
  assert.equal(new Set(all.map((m) => m.id)).size, 465);
  assert.deepEqual(unmatchedShugiinGroups(all), []);
  for (const m of all) assert.ok(isKnownShugiinGroup(m.terms[0].group), `${m.name}: ${m.terms[0].group}`);
});

test("Member.id は氏名＋かなから決定的に導出し、名簿の掲載順・プロフィールURLの連番には依存しない", () => {
  const id = memberIdFromName("逢沢 一郎", "あいさわ いちろう");
  assert.equal(id, memberIdFromName("逢沢　　一郎", "あいさわ\n　いちろう"));
  assert.match(id, /^h_[0-9a-f]{10}$/);
  assert.notEqual(id, memberIdFromName("逢沢 一郎", "おうさわ いちろう"));
  assert.notEqual(id, memberIdFromName("逢沢 二郎", "あいさわ いちろう"));
  assert.equal(all[0].id, id);
});

test("表が無い・空の HTML では例外（0名を黙って通さない）", () => {
  assert.throws(() => parseShugiinMemberList("<html><body></body></html>", SRC, 221), /no members parsed/);
});

test("同じ氏名・かなの行が2つあれば例外（衝突を黙って通さない）", () => {
  const row = () => `<TR VALIGN = top><TD><TT><a href='../../../../itdb_giinprof.nsf/html/profile/001.html'>甲　乙君</a></TT></TD><TD><TT>こう おつ</TT></TD><TD><TT><CENTER>自民</CENTER></TT></TD><TD><TT>東京1</TT></TD><TD><TT><CENTER>2</CENTER></TT></TD></TR>`;
  assert.throws(() => parseShugiinMemberList(`<table>${row()}${row()}</table>`, SRC, 221), /duplicate member id/);
});

test("対応表に無い会派略称は原文のまま group に入り、unmatchedShugiinGroups に列挙される", () => {
  const row = (name: string, group: string) =>
    `<TR VALIGN = top><TD><TT><a href='../../../../itdb_giinprof.nsf/html/profile/001.html'>${name}君</a></TT></TD><TD><TT>かな ${name}</TT></TD><TD><TT><CENTER>${group}</CENTER></TT></TD><TD><TT>東京1</TT></TD><TD><TT><CENTER>1</CENTER></TT></TD></TR>`;
  const members = parseShugiinMemberList(`<table>${row("甲", "新党")}${row("乙", "新党")}${row("丙", "自民")}</table>`, SRC, 221);
  assert.equal(members[0].terms[0].group, "新党");
  assert.deepEqual(unmatchedShugiinGroups(members), [{ group: "新党", memberIds: [members[0].id, members[1].id], sourceUrl: SRC }]);
});

test("会派略称の対応表は会派名及び会派別所属議員数ページ（令和8年2月18日現在）の略称をすべて含む", () => {
  const html = iconv.decode(readFileSync(new URL("./fixtures/shugiin-kaiha_m-20260218.htm", import.meta.url)), "Shift_JIS");
  const text = html.replace(/<[^>]*>/g, "\n").replace(/[ \t　]+/g, "").split("\n").filter(Boolean);
  const start = text.indexOf("所属議員数") + 1;
  const rows: [string, string][] = [];
  for (let i = start; i + 2 < text.length && text[i] !== "計" && !text[i].startsWith("欠員"); i += 3) rows.push([text[i + 1], text[i]]);
  assert.equal(rows.length, 8);
  for (const [abbr, full] of rows) assert.equal(SHUGIIN_GROUPS[abbr], full, abbr);
  assert.equal(resolveShugiinGroup("無"), "無所属");
  assert.equal(resolveShugiinGroup("未知"), "未知");
});

test("参院名簿と同じ index に統合: 参院側の index 行・詳細は衆院を足しても byte 単位で同じ。衆院行は house=shugiin・current=true・counts 0・termEnd 無し", () => {
  const sangiin = parseMemberList(readFileSync(new URL("./fixtures/sangiin-giin-221.htm", import.meta.url), "utf-8"), "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm", 221);
  const alone = buildDataset(sangiin, []);
  const both = buildDataset([...sangiin, ...all], []);
  assert.equal(stableJson(both.index.slice(0, sangiin.length)), stableJson(alone.index));
  assert.equal(stableJson(both.details.slice(0, sangiin.length)), stableJson(alone.details));
  assert.equal(both.index.length, sangiin.length + 465);
  const row = both.index[sangiin.length];
  assert.deepEqual(row, {
    id: all[0].id, name: "逢沢 一郎", kana: "あいさわ いちろう", house: "shugiin", assemblyId: "diet-shugiin", group: "自由民主党・無所属の会", district: "岡山1",
    termEnd: undefined, current: true, counts: { rollcalls: 0, bills: 0, speeches: 0, questions: 0 },
  });
  assert.deepEqual(both.details[sangiin.length].timeline, []);
});
