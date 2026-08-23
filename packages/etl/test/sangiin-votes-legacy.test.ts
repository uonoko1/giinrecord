import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRollCall, RollCallParseError, standingVoteNote } from "../src/sources/sangiin-votes.ts";

const BASE = "https://www.sangiin.go.jp/japanese/touhyoulist";
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.htm`, import.meta.url), "utf-8");
const sumSizes = (groups: { size: number }[]) => groups.reduce((a, g) => a + g.size, 0);

/** 第200〜216回の投票結果ページは table レイアウト（caption.party / td.pro / td.con / td.nam）。Issue #103 */
describe("実HTML（旧レイアウト）: 200-1204-v001（日米貿易協定。反対票あり）", () => {
  const rc = parseRollCall(fixture("200-1204-v001"), `${BASE}/200/200-1204-v001.htm`, 200);

  test("id・日付・案件名・総数が取れる", () => {
    assert.equal(rc.id, "200-1204-v001");
    assert.equal(rc.session, 200);
    assert.equal(rc.date, "2019-12-04");
    assert.equal(rc.title, "日程第１　日本国とアメリカ合衆国との間の貿易協定の締結について承認を求めるの件（衆議院送付）");
    assert.deepEqual(rc.totals, { total: 240, yes: 161, no: 79 });
    assert.equal(rc.sourceUrl, `${BASE}/200/200-1204-v001.htm`);
  });

  test("会派ブロック（caption の「会派名( N名)<br>賛成票 N 反対票 N」）が10件取れる", () => {
    assert.equal(rc.groups.length, 10);
    assert.deepEqual(rc.groups[0], { group: "自由民主党・国民の声", size: 113, yes: 112, no: 0 });
    assert.deepEqual(rc.groups[1], { group: "立憲・国民．新緑風会・社民", size: 61, yes: 1, no: 57 });
    assert.deepEqual(rc.groups[9], { group: "各派に属しない議員", size: 6, yes: 2, no: 3 });
  });

  test("個人票数 === Σ 会派人数（行末の空セルを票に数えない）", () => {
    assert.equal(rc.votes.length, 245);
    assert.equal(rc.votes.length, sumSizes(rc.groups));
  });

  test("値は画像（sansei.jpg / hantai.jpg）から 賛成 | 反対、両方空なら 投票なし", () => {
    const values = new Set(rc.votes.map((v) => v.value));
    assert.deepEqual([...values].sort(), ["反対", "投票なし", "賛成"].sort());
    assert.equal(rc.votes.filter((v) => v.value === "賛成").length, 161);
    assert.equal(rc.votes.filter((v) => v.value === "反対").length, 79);
    assert.equal(rc.votes.filter((v) => v.value === "投票なし").length, 5);
  });

  test("会派ごとの賛成・反対数が個人票の集計と一致する", () => {
    for (const g of rc.groups) {
      const own = rc.votes.filter((v) => v.group === g.group);
      assert.equal(own.length, g.size, `${g.group} size`);
      assert.equal(own.filter((v) => v.value === "賛成").length, g.yes, `${g.group} yes`);
      assert.equal(own.filter((v) => v.value === "反対").length, g.no, `${g.group} no`);
    }
  });

  test("氏名は公式表記（全角スペース連続は半角1つ、ひらがな表記を壊さない）。memberId は空", () => {
    const names = rc.votes.map((v) => v.nameText);
    assert.ok(names.includes("足立 敏之"), "「足立　　敏之」→「足立 敏之」");
    assert.ok(names.includes("阿達 雅志"), "半角・全角混在「阿達 　 雅志」→「阿達 雅志」");
    assert.ok(names.includes("蓮舫"));
    assert.ok(names.includes("三原じゅん子"));
    assert.ok(names.includes("こやり 隆史"));
    for (const n of names) assert.ok(!/[　\t\n]/.test(n) && !/  /.test(n) && n === n.trim() && n.length > 0, `未正規化: ${JSON.stringify(n)}`);
    for (const v of rc.votes) assert.equal(v.memberId, "");
  });
});

describe("実HTML（旧レイアウト）: 200-1206-v001（全会一致）", () => {
  const rc = parseRollCall(fixture("200-1206-v001"), `${BASE}/200/200-1206-v001.htm`, 200);
  test("日付・総数・投票なし", () => {
    assert.equal(rc.date, "2019-12-06");
    assert.deepEqual(rc.totals, { total: 241, yes: 241, no: 0 });
    assert.equal(rc.votes.length, 245);
    assert.equal(rc.votes.filter((v) => v.value === "投票なし").length, 4);
    assert.equal(rc.votes.filter((v) => v.value === "反対").length, 0);
  });
});

describe("起立採決のページ（個人票が無い）", () => {
  test("旧レイアウト 210-1210-v001: standingVoteNote が結果行の原文を返し、parseRollCall は例外", () => {
    const html = fixture("210-1210-v001");
    assert.equal(standingVoteNote(html), "起立採決により可決されました");
    assert.throws(() => parseRollCall(html, `${BASE}/210/210-1210-v001.htm`, 210), RollCallParseError);
  });
  test("新レイアウト 216-1224-v001（p.kiritsu）も同じ", () => {
    const html = fixture("216-1224-v001");
    assert.equal(standingVoteNote(html), "起立採決により可決されました");
    assert.throws(() => parseRollCall(html, `${BASE}/216/216-1224-v001.htm`, 216), RollCallParseError);
  });
  test("押しボタン投票のページでは undefined（新旧どちらも）", () => {
    assert.equal(standingVoteNote(fixture("200-1204-v001")), undefined);
    assert.equal(standingVoteNote(fixture("221-0605-v001")), undefined);
  });
});
