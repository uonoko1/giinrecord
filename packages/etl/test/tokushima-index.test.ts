import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSessionIndex, parseSessionPage, sessionIndexUrl } from "../src/sources/local/tokushima/sessions.ts";

// 徳島県議会「定例会の概要」（Issue #183）。https://www.pref.tokushima.lg.jp/gikai/honkaigi/gaiyou/ はその年の会期（新しい順）、
// 前年以前は /gikai/honkaigi/gaiyou/r07/ のような年ページ（左ナビのリンク）。会期ごとに「各議員の表決態度（審議の結果）」ページがあり、
// そこに採決日ごとの表決 PDF が並ぶ（2026-08-24 取得）。
const html = (name: string) => readFileSync(new URL(`./fixtures/tokushima/${name}`, import.meta.url), "utf8");

test("parseSessionIndex: 今年のページは 年（令和8年）と会期（6月・2月、新しい順）、各会期の表決態度ページ、前年のページへのリンクを持つ", () => {
  const index = parseSessionIndex(html("gaiyou.html"), sessionIndexUrl);
  assert.equal(index.yearLabel, "令和8年");
  assert.equal(index.year, 2026);
  assert.deepEqual(index.sessions, [
    { sessionId: "2026-06", month: 6, heading: "6月 定例会", url: "https://www.pref.tokushima.lg.jp/gikai/honkaigi/r08/7314697/" },
    { sessionId: "2026-02", month: 2, heading: "2月 定例会", url: "https://www.pref.tokushima.lg.jp/gikai/honkaigi/r08/7310454/" },
  ]);
  assert.equal(index.previousYearUrl, "https://www.pref.tokushima.lg.jp/gikai/honkaigi/gaiyou/r07/");
});

test("parseSessionIndex: 年ページ（令和7年）は 4 会期。リンク文言の揺れ（審議結果／審議の結果）を吸収し、href の前後の空白は落とす", () => {
  const index = parseSessionIndex(html("gaiyou-r07.html"), "https://www.pref.tokushima.lg.jp/gikai/honkaigi/gaiyou/r07/");
  assert.equal(index.yearLabel, "令和7年");
  assert.equal(index.year, 2025);
  assert.deepEqual(index.sessions.map((s) => [s.sessionId, s.url]), [
    ["2025-11", "https://www.pref.tokushima.lg.jp/gikai/honkaigi/r07/7308466/"],
    ["2025-09", "https://www.pref.tokushima.lg.jp/gikai/honkaigi/r07/7307585/"],
    ["2025-06", "https://www.pref.tokushima.lg.jp/gikai/honkaigi/r07/7304920/"],
    ["2025-02", "https://www.pref.tokushima.lg.jp/gikai/honkaigi/r07/7301493/"],
  ]);
  assert.equal(index.previousYearUrl, "https://www.pref.tokushima.lg.jp/gikai/honkaigi/gaiyou/r06/");
});

test("parseSessionIndex: 会期の見出しが無い・県のホスト以外のリンクなら例外（別のページを黙って読まない）", () => {
  assert.throws(() => parseSessionIndex("<html><body><h2>令和8年 定例会の概要</h2></body></html>", sessionIndexUrl), /no sessions/);
  const evil = html("gaiyou.html").replace("https://www.pref.tokushima.lg.jp/gikai/honkaigi/r08/7314697/", "https://example.com/x/");
  assert.throws(() => parseSessionIndex(evil, sessionIndexUrl), /not on www\.pref\.tokushima\.lg\.jp/);
});

test("parseSessionPage: 会期ページの h1 から会期の原文（令和8年6月定例会）を取り、「各議員の表決態度（M月D日採決）」の PDF だけを採決日つきで並べる（請願審査報告書は除く）", () => {
  const page = parseSessionPage(html("7314697.html"), "https://www.pref.tokushima.lg.jp/gikai/honkaigi/r08/7314697/");
  assert.equal(page.sessionLabel, "令和8年6月定例会");
  assert.equal(page.year, 2026);
  assert.equal(page.month, 6);
  assert.deepEqual(page.pdfs, [{ text: "各議員の表決態度（7月3日採決）", month: 7, day: 3, url: "https://www.pref.tokushima.lg.jp/file/attachment/1064407.pdf" }]);
  const feb = parseSessionPage(html("7310454.html"), "https://www.pref.tokushima.lg.jp/gikai/honkaigi/r08/7310454/");
  assert.equal(feb.sessionLabel, "令和8年2月定例会");
  assert.deepEqual(feb.pdfs.map((p) => [p.text, p.month, p.day, p.url]), [
    ["各議員の表決態度（2月13日採決）", 2, 13, "https://www.pref.tokushima.lg.jp/file/attachment/1036105.pdf"],
    ["各議員の表決態度（2月20日採決）", 2, 20, "https://www.pref.tokushima.lg.jp/file/attachment/1038136.pdf"],
    ["各議員の表決態度（3月11日採決）", 3, 11, "https://www.pref.tokushima.lg.jp/file/attachment/1042426.pdf"],
  ]);
});

test("parseSessionPage: 表決態度の PDF が 1 本も無ければ例外（推定で他の PDF を読まない）", () => {
  const none = html("7314697.html").replace("各議員の表決態度（7月3日採決）", "別の資料");
  assert.throws(() => parseSessionPage(none, "https://www.pref.tokushima.lg.jp/gikai/honkaigi/r08/7314697/"), /no 各議員の表決態度 PDF/);
});
