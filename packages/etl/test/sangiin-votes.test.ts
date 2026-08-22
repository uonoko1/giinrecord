import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRollCall } from "../src/sources/sangiin-votes.ts";

const SAMPLE = `<div id="ContentsBox">本会議投票結果 第221回国会 2026年 6月 5日 投票結果 案件名： 日程第１ 令和八年度一般会計補正予算（第１号）
投票総数 242 賛成票 148 反対票 94
自由民主党・無所属の会(3名) 賛成票 2 反対票 0 賛成 青木 一彦 賛成 赤松 健 投票 なし 越智 俊之
立憲民主・無所属( 2名) 賛成票 0 反対票 2 反対 青木 愛 反対 蓮舫</div>`;

test("parses totals, groups and per-member votes", () => {
  const rc = parseRollCall(SAMPLE, "https://www.sangiin.go.jp/japanese/touhyoulist/221/221-0605-v001.htm", 221);
  assert.equal(rc.id, "221-0605-v001");
  assert.equal(rc.date, "2026-06-05");
  assert.equal(rc.title, "日程第１ 令和八年度一般会計補正予算（第１号）");
  assert.deepEqual(rc.totals, { total: 242, yes: 148, no: 94 });
  assert.equal(rc.groups.length, 2);
  assert.deepEqual(rc.votes.map((v) => [v.nameText, v.value]), [
    ["青木 一彦", "賛成"], ["赤松 健", "賛成"], ["越智 俊之", "投票なし"], ["青木 愛", "反対"], ["蓮舫", "反対"],
  ]);
});
