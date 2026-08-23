import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRollCallList } from "../src/sources/sangiin-votes.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.htm`, import.meta.url), "utf-8");
const BASE = "https://www.sangiin.go.jp/japanese/touhyoulist";

describe("parseRollCallList: 回次ごとの投票結果一覧 vote_ind.htm（実HTML）", () => {
  test("第217回: 136件。href は絶対URL、日付見出しが各行に付く", () => {
    const list = parseRollCallList(fixture("vote_ind-217"), 217);
    assert.equal(list.length, 136);
    assert.equal(list[0].href, `${BASE}/217/217-0620-v001.htm`);
    assert.ok(list.every((x) => x.href.startsWith(`${BASE}/217/217-`)));
    assert.ok(list.every((x) => /令和\d+年\d+月\d+日/.test(x.dateJa)), "日付見出しが欠けている行がある");
  });

  test("第219回: 31件（末尾は 219-1128-v010）", () => {
    const list = parseRollCallList(fixture("vote_ind-219"), 219);
    assert.equal(list.length, 31);
    assert.equal(list.at(-1)?.href, `${BASE}/219/219-1128-v010.htm`);
  });

  test("第218・220回（特別国会・臨時国会で採決なし）は 0 件で例外にならない", () => {
    assert.deepEqual(parseRollCallList(fixture("vote_ind-218"), 218), []);
    assert.deepEqual(parseRollCallList(fixture("vote_ind-220"), 220), []);
  });

  test("第221回の一覧は現行の採決数と同じ件数を返す", () => {
    assert.ok(parseRollCallList(fixture("vote_ind-221"), 221).length >= 120);
  });
});

describe("parseRollCallList: 旧レイアウト（第200〜216回。日付が th.touhyo_date でなく td[scope=row]、リンクは大文字 HREF）#103", () => {
  test("第200回: 34件。日付は rowspan の先頭行から後続行にも引き継がれる", () => {
    const list = parseRollCallList(fixture("vote_ind-200"), 200);
    assert.equal(list.length, 34);
    assert.equal(list[0].href, `${BASE}/200/200-1206-v001.htm`);
    assert.equal(list[0].dateJa, "令和元年12月6日");
    assert.equal(list[1].dateJa, "令和元年12月4日");
    assert.equal(list[6].dateJa, "令和元年12月4日");
    assert.ok(list.every((x) => /令和(元|\d+)年\d+月\d+日/.test(x.dateJa)), "日付見出しが欠けている行がある");
  });

  test("第205回: 実リンクは無く、コメントアウトされた他回次のリンクを拾わない（0件）", () => {
    assert.deepEqual(parseRollCallList(fixture("vote_ind-205"), 205), []);
  });

  test("第210回: 40件、第216回: 25件（起立採決のページも一覧には載る）", () => {
    assert.equal(parseRollCallList(fixture("vote_ind-210"), 210).length, 40);
    const list = parseRollCallList(fixture("vote_ind-216"), 216);
    assert.equal(list.length, 25);
    assert.equal(list[0].dateJa, "令和06年12月24日");
  });
});
