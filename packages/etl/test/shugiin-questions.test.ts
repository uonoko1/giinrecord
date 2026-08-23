import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import iconv from "iconv-lite";
import {
  parseShugiinQuestion, parseShugiinQuestionList, shugiinQuestionListUrl,
} from "../src/sources/shugiin-questions.ts";

// フィクスチャは Shift_JIS の生バイト（2026-08-23 取得）。fetchText と同じく iconv で復号する。
const fixture = (name: string) => iconv.decode(readFileSync(new URL(`./fixtures/${name}.htm`, import.meta.url)), "Shift_JIS");
const BASE = "https://www.shugiin.go.jp/internet/itdb_shitsumon.nsf/html/shitsumon";

describe("実HTML: kaiji221_l.htm（第221回 質問の一覧、衆議院）", () => {
  const items = parseShugiinQuestionList(fixture("shugiin-shitsumon-kaiji221_l"), shugiinQuestionListUrl(221));

  test("42件。番号・件名・提出者（原文）・経過状況・経過ページ（絶対URL）・質問本文・答弁本文（HTML）", () => {
    assert.equal(items.length, 42);
    assert.deepEqual(items[0], {
      number: 1, title: "行き過ぎた緊縮志向に関する質問主意書", submitterText: "緒方林太郎君", status: "答弁受理",
      href: `${BASE}/221001.htm`, questionUrl: `${BASE}/a221001.htm`, answerUrl: `${BASE}/b221001.htm`,
    });
    assert.equal(items[41]?.number, 42);
  });

  test("提出者は全員「○○君」の単独表記（外N名の形は無い）", () => {
    assert.ok(items.every((i) => /君$/.test(i.submitterText)));
  });

  test("表が無ければ例外（黙って0件にしない）", () => {
    assert.throws(() => parseShugiinQuestionList("<html><body><p>準備中</p></body></html>", shugiinQuestionListUrl(221)), /質問/);
  });
});

describe("実HTML: 経過ページ 221001.htm", () => {
  const url = `${BASE}/221001.htm`;
  const q = parseShugiinQuestion(fixture("shugiin-shitsumon-221001"), url, { questionUrl: `${BASE}/a221001.htm`, answerUrl: `${BASE}/b221001.htm` });

  test("回次・番号・件名・提出者名（原文）・会派名・提出日・答弁書受領日・経過状況を原文から写す", () => {
    assert.equal(q.id, "221-shugiin-1");
    assert.equal(q.house, "shugiin");
    assert.equal(q.session, 221);
    assert.equal(q.number, 1);
    assert.equal(q.title, "行き過ぎた緊縮志向に関する質問主意書");
    assert.equal(q.submitterText, "緒方 林太郎君");
    assert.deepEqual(q.submitterNames, ["緒方 林太郎"]);
    assert.equal(q.group, "無所属");
    assert.equal(q.date, "2026-02-19");
    assert.equal(q.answerDate, "2026-03-03");
    assert.equal(q.status, "答弁受理");
    assert.equal(q.sourceUrl, url);
    assert.equal(q.answerUrl, `${BASE}/b221001.htm`);
    assert.equal(q.questionUrl, `${BASE}/a221001.htm`);
  });

  test("答弁本文のリンクが無ければ answerUrl / answerDate は省略（空欄は「未定または無し」なので推定しない）", () => {
    const html = fixture("shugiin-shitsumon-221001").replace("令和 8年 3月 3日", "");
    const q2 = parseShugiinQuestion(html, url, {});
    assert.equal(q2.answerUrl, undefined);
    assert.equal(q2.answerDate, undefined);
  });

  test("提出年月日が無ければ例外（日付を推定しない）", () => {
    const broken = fixture("shugiin-shitsumon-221001").replace("令和 8年 2月19日", "");
    assert.throws(() => parseShugiinQuestion(broken, url, {}), /提出年月日/);
  });
});
