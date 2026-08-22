import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRollCall } from "../src/sources/sangiin-votes.ts";

const BASE = "https://www.sangiin.go.jp/japanese/touhyoulist/221";
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.htm`, import.meta.url), "utf-8");
const sumSizes = (groups: { size: number }[]) => groups.reduce((a, g) => a + g.size, 0);

describe("実HTML: 221-0605-v001（令和八年度一般会計補正予算）", () => {
  const rc = parseRollCall(fixture("221-0605-v001"), `${BASE}/221-0605-v001.htm`, 221);

  test("id・日付・案件名・総数が取れる", () => {
    assert.equal(rc.id, "221-0605-v001");
    assert.equal(rc.session, 221);
    assert.equal(rc.date, "2026-06-05");
    assert.equal(rc.title, "日程第１　令和八年度一般会計補正予算（第１号）");
    assert.deepEqual(rc.totals, { total: 242, yes: 148, no: 94 });
    assert.equal(rc.sourceUrl, `${BASE}/221-0605-v001.htm`);
  });

  test("会派ブロックが人数・賛否つきで取れる", () => {
    assert.equal(rc.groups[0]?.group, "自由民主党・無所属の会");
    assert.deepEqual(rc.groups[0], { group: "自由民主党・無所属の会", size: 101, yes: 97, no: 0 });
    assert.ok(rc.groups.length >= 10);
  });

  test("個人票数 === Σ 会派人数", () => {
    assert.ok(rc.votes.length > 0, "個人票が0件");
    assert.equal(rc.votes.length, sumSizes(rc.groups));
  });

  test("値は 賛成 | 反対 | 投票なし の3種のみ", () => {
    const values = new Set(rc.votes.map((v) => v.value));
    for (const v of values) assert.ok(["賛成", "反対", "投票なし"].includes(v), `unexpected value: ${v}`);
    assert.ok(values.has("投票なし"), "「投票 なし」の表記ゆれを吸収できていない");
  });

  test("会派ごとの賛成・反対数が個人票の集計と一致する", () => {
    for (const g of rc.groups) {
      const own = rc.votes.filter((v) => v.group === g.group);
      assert.equal(own.length, g.size, `${g.group} size`);
      assert.equal(own.filter((v) => v.value === "賛成").length, g.yes, `${g.group} yes`);
      assert.equal(own.filter((v) => v.value === "反対").length, g.no, `${g.group} no`);
    }
  });

  test("総数と個人票の集計が一致する（投票なしは総数に含まれない）", () => {
    assert.equal(rc.votes.filter((v) => v.value === "賛成").length, rc.totals.yes);
    assert.equal(rc.votes.filter((v) => v.value === "反対").length, rc.totals.no);
    assert.equal(rc.votes.filter((v) => v.value !== "投票なし").length, rc.totals.total);
  });

  test("氏名は公式表記（全角スペース連続は半角1つ、ひらがな表記を壊さない）", () => {
    const names = rc.votes.map((v) => v.nameText);
    assert.ok(names.includes("青木 一彦"));
    assert.ok(names.includes("赤松 健"), "「赤松　　　健」→「赤松 健」");
    assert.ok(names.includes("阿達 雅志"), "半角・全角混在スペース「阿達 　 雅志」→「阿達 雅志」");
    assert.ok(names.includes("いんどう周作"));
    assert.ok(names.includes("こやり 隆史"));
    assert.ok(names.includes("三原じゅん子"));
    assert.ok(names.includes("蓮舫"));
    for (const n of names) {
      assert.ok(!/[　\t\n]/.test(n) && !/  /.test(n) && n === n.trim(), `未正規化: ${JSON.stringify(n)}`);
    }
  });

  test("memberId は名寄せ前なので空文字", () => {
    for (const v of rc.votes) assert.equal(v.memberId, "");
  });
});

describe("実HTML: 221-0724-v001（国民投票法改正案）", () => {
  const rc = parseRollCall(fixture("221-0724-v001"), `${BASE}/221-0724-v001.htm`, 221);

  test("日付・案件名・総数", () => {
    assert.equal(rc.date, "2026-07-24");
    assert.equal(rc.title, "日程第１　日本国憲法の改正手続に関する法律の一部を改正する法律案（衆議院提出）");
    assert.deepEqual(rc.totals, { total: 243, yes: 227, no: 16 });
  });

  test("個人票数 === Σ 会派人数 === 247", () => {
    assert.equal(sumSizes(rc.groups), 247);
    assert.equal(rc.votes.length, 247);
  });

  test("会派名の全角括弧内の空白（「( 40名)」「(  7名)」）を吸収する", () => {
    const byName = Object.fromEntries(rc.groups.map((g) => [g.group, g]));
    assert.deepEqual(byName["立憲民主・無所属"], { group: "立憲民主・無所属", size: 40, yes: 39, no: 0 });
    assert.deepEqual(byName["日本共産党"], { group: "日本共産党", size: 7, yes: 0, no: 7 });
    assert.deepEqual(byName["各派に属しない議員"], { group: "各派に属しない議員", size: 6, yes: 5, no: 0 });
  });

  test("反対票の議員は反対として記録される", () => {
    const kyosan = rc.votes.filter((v) => v.group === "日本共産党");
    assert.equal(kyosan.length, 7);
    assert.ok(kyosan.every((v) => v.value === "反対"));
  });
});

describe("異常系: 黙って空を返さず例外を投げる", () => {
  const url = `${BASE}/221-9999-v999.htm`;
  const page = (body: string) => `<html><body><div id="ContentsBox">${body}</div></body></html>`;
  const group = (name: string, size: number, yes: number, no: number, lis: string) =>
    `<h4 class="party">${name}(${size}名)</h4><dl class="sanpilist"><dt class="party">賛成票 ${yes} 反対票 ${no}</dt><dd><ul>${lis}</ul></dd></dl>`;
  const li = (value: string, name: string) =>
    value === "投票なし"
      ? `<li class="giin"><span class="novote"><span class="fhalf">投票</span><span class="shalf">なし</span></span><span class="names">${name}</span></li>`
      : `<li class="giin"><span class="pros">${value === "賛成" ? "賛成" : ""}</span><span class="cons">${value === "反対" ? "反対" : ""}</span><span class="names">${name}</span></li>`;
  const head = `<h2 class="kaiji_nichiji">第221回国会<br>2026年 6月 5日<br>投票結果</h2>`;
  const anken = `<dl class="ankenmei"><dt>案件名：</dt><dd>日程第１　テスト案件</dd></dl>`;
  const totals = `<h3 class="tohyosousu">投票総数　2<br><span>賛成票　1　　　反対票　1</span></h3>`;

  test("正常な最小HTMLは通る（テストの土台確認）", () => {
    const rc = parseRollCall(page(head + anken + totals + group("甲", 2, 1, 1, li("賛成", "青木　　一彦") + li("反対", "蓮舫"))), url, 221);
    assert.equal(rc.votes.length, 2);
  });

  test("案件名が取れないと例外", () => {
    assert.throws(() => parseRollCall(page(head + totals + group("甲", 1, 1, 0, li("賛成", "青木　　一彦"))), url, 221), /案件名/);
  });

  test("会派ブロックが0件だと例外", () => {
    assert.throws(() => parseRollCall(page(head + anken + totals), url, 221), /会派/);
  });

  test("会派人数と個人票数が一致しないと例外", () => {
    assert.throws(() => parseRollCall(page(head + anken + totals + group("甲", 3, 1, 1, li("賛成", "青木　　一彦") + li("反対", "蓮舫"))), url, 221), /人数/);
  });

  test("票の値が判別できない行があると例外", () => {
    const bad = `<li class="giin"><span class="pros"></span><span class="cons"></span><span class="names">誰か</span></li>`;
    assert.throws(() => parseRollCall(page(head + anken + totals + group("甲", 1, 0, 0, bad)), url, 221), /票/);
  });

  test("日付が取れないと例外", () => {
    assert.throws(() => parseRollCall(page(anken + totals + group("甲", 1, 1, 0, li("賛成", "青木　　一彦"))), url, 221), /日付/);
  });
});
