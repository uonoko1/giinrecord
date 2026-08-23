import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSessionIndex, parseSessionPage, sessionIndexUrl } from "../src/sources/local/miyagi/sessions.ts";

// 宮城県議会「過去の本会議情報」（Issue #157）。会期ごとの h2「令和N年M月定例会（第NNN回）」の下に「各議員の表決状況」のリンクが規則的に並ぶ。
//   https://www.pref.miyagi.jp/site/kengikai/kakohonkaigi.html（2026-08-23 取得）
//   会期ページ https://www.pref.miyagi.jp/site/kengikai/hyoketu080318.html / hyoketu071217.html（同日取得）。表決 PDF へのリンクが 1 本。
const fixture = (name: string) => readFileSync(new URL(`./fixtures/miyagi/${name}`, import.meta.url), "utf8");
const index = fixture("kakohonkaigi.html");

test("parseSessionIndex: 会期（回次・原文ラベル）と「各議員の表決状況」ページの URL を新しい順に取る", () => {
  const sessions = parseSessionIndex(index, sessionIndexUrl);
  assert.ok(sessions.length >= 20, `expected many sessions, got ${sessions.length}`);
  assert.deepEqual(sessions[0], {
    sessionId: "399",
    sessionLabel: "令和8年2月定例会（第399回）",
    url: "https://www.pref.miyagi.jp/site/kengikai/hyoketu080318.html",
  });
  assert.deepEqual(sessions[1], {
    sessionId: "398",
    sessionLabel: "令和7年11月定例会（第398回）",
    url: "https://www.pref.miyagi.jp/site/kengikai/hyoketu071217.html",
  });
});

test("parseSessionIndex: 会期 index の規則性 — ラベルは「令和N年M月定例会／臨時会（第N回）」、URL は hyoketu|hyouketsu{yymmdd}.html、回次は降順で一意", () => {
  const sessions = parseSessionIndex(index, sessionIndexUrl);
  const ids = new Set<string>();
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    assert.match(s.sessionLabel, /^(令和|平成)\d+年\d+月(定例会|臨時会)（第\d+回）$/, s.sessionLabel);
    assert.match(s.url, /^https:\/\/www\.pref\.miyagi\.jp\/site\/kengikai\/(hyoketu|hyouketsu)\d{6}\.html$/, s.url);
    assert.equal(s.sessionId, s.sessionLabel.match(/第(\d+)回/)![1]);
    assert.ok(!ids.has(s.sessionId), `duplicate session ${s.sessionId}`);
    ids.add(s.sessionId);
    if (i > 0) assert.ok(Number(sessions[i - 1].sessionId) > Number(s.sessionId), `not descending at ${s.sessionId}`);
  }
});

test("parseSessionIndex: 表決状況のリンクが無いページは失敗する（別のページを黙って読まない）", () => {
  assert.throws(() => parseSessionIndex("<html><h2>令和8年2月定例会（第399回）</h2><ul><li><a href='/x.html'>日程</a></li></ul></html>", sessionIndexUrl), /各議員の表決状況/);
});

test("parseSessionPage: 会期ページから表決 PDF の URL（絶対 URL）と見出しを取る", () => {
  assert.deepEqual(parseSessionPage(fixture("hyoketu080318.html"), "https://www.pref.miyagi.jp/site/kengikai/hyoketu080318.html"), {
    title: "各議員の表決状況（R8.3.18）",
    pdfUrl: "https://www.pref.miyagi.jp/documents/63622/syuusei_hyouketsu080318.pdf",
  });
  assert.deepEqual(parseSessionPage(fixture("hyoketu071217.html"), "https://www.pref.miyagi.jp/site/kengikai/hyoketu071217.html"), {
    title: "各議員の表決状況（R7.12.17）",
    pdfUrl: "https://www.pref.miyagi.jp/documents/62682/hyouketsu071217.pdf",
  });
});

test("parseSessionPage: PDF リンクが 1 本でなければ失敗する（どれを読むか推定しない）", () => {
  assert.throws(() => parseSessionPage("<div id=\"tmp_contents\"><h1>x</h1><p>no pdf</p></div>", "https://www.pref.miyagi.jp/site/kengikai/x.html"), /PDF/);
  const two = "<div id=\"tmp_contents\"><h1>x</h1><p><a href=\"/documents/1/a.pdf\">a</a><a href=\"/documents/1/b.pdf\">b</a></p></div>";
  assert.throws(() => parseSessionPage(two, "https://www.pref.miyagi.jp/site/kengikai/x.html"), /PDF/);
});
