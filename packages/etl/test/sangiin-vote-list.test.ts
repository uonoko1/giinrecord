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
