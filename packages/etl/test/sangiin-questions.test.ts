import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSangiinQuestion, parseSangiinQuestionList, sangiinQuestionListUrl } from "../src/sources/sangiin-questions.ts";

// フィクスチャは UTF-8（2026-08-23 取得）。
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.htm`, import.meta.url), "utf-8");
const BASE = "https://www.sangiin.go.jp/japanese/joho1/kousei/syuisyo/221";

describe("実HTML: syuisyo.htm（第221回 質問主意書・答弁書一覧、参議院）", () => {
  const items = parseSangiinQuestionList(fixture("sangiin-syuisyo-221"), sangiinQuestionListUrl(221));

  test("112件。提出番号・件名・提出者（原文）・詳細ページ（絶対URL）・質問本文・答弁本文（HTML）", () => {
    assert.equal(items.length, 112);
    assert.deepEqual(items[0], {
      number: 1, title: "点字版選挙公報の遅延及び投票環境の不備に関する質問主意書", submitterText: "石垣 のりこ君",
      href: `${BASE}/meisai/m221001.htm`, questionUrl: `${BASE}/syuh/s221001.htm`, answerUrl: `${BASE}/touh/t221001.htm`,
    });
    assert.equal(items[111]?.number, 112);
  });

  test("表が無ければ例外（黙って0件にしない）", () => {
    assert.throws(() => parseSangiinQuestionList("<html><body><p>準備中</p></body></html>", sangiinQuestionListUrl(221)), /質問/);
  });
});

describe("実HTML: 詳細ページ meisai/m221001.htm", () => {
  const url = `${BASE}/meisai/m221001.htm`;
  const q = parseSangiinQuestion(fixture("sangiin-syuisyo-m221001"), url, { questionUrl: `${BASE}/syuh/s221001.htm`, answerUrl: `${BASE}/touh/t221001.htm` });

  test("回次・番号・件名・提出者（原文）・提出日・答弁書受領日を原文から写す。会派・経過状況の欄は無い", () => {
    assert.equal(q.id, "221-sangiin-1");
    assert.equal(q.house, "sangiin");
    assert.equal(q.session, 221);
    assert.equal(q.number, 1);
    assert.equal(q.title, "点字版選挙公報の遅延及び投票環境の不備に関する質問主意書");
    assert.equal(q.submitterText, "石垣 のりこ君");
    assert.deepEqual(q.submitterNames, ["石垣 のりこ"]);
    assert.equal(q.group, undefined);
    assert.equal(q.status, undefined);
    assert.equal(q.date, "2026-02-20");
    assert.equal(q.answerDate, "2026-03-06");
    assert.equal(q.sourceUrl, url);
    assert.equal(q.answerUrl, `${BASE}/touh/t221001.htm`);
  });

  test("提出日が無ければ例外（日付を推定しない）", () => {
    assert.throws(() => parseSangiinQuestion(fixture("sangiin-syuisyo-m221001").replace("令和8年2月20日", ""), url, {}), /提出日/);
  });
});
