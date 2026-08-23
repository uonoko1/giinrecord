import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseResultsPage, parseSessionIndex, parseSessionPage, SESSION_INDEX_URL } from "../src/sources/local/tottori/sessions.ts";

// 鳥取県議会「定例会・臨時会の概要」→ 会期ページ →「議案等の議決結果」ページ → 賛否 PDF（Issue #184）。
//   概要（会期 index）: https://www.pref.tottori.lg.jp/87621.htm（年ごとの h2「◆令和８年」の下に「9月定例会 ／ 6月定例会 ／ 2月定例会」のリンク。2026-08-24 取得）
//   会期ページ: /328133.htm（令和8年6月定例会の日程。サブメニューに「議案等の議決結果」）、/329482.htm（令和8年9月定例会。議決結果のリンクはまだ無い）
//   議決結果ページ: /328150.htm（令和8年6月定例会）、/326506.htm（令和8年2月定例会。先議 3/9 と 3/25 の 2 つの議決日）
const fixture = (name: string) => readFileSync(new URL(`./fixtures/tottori/${name}`, import.meta.url), "utf8");
const origin = "https://www.pref.tottori.lg.jp";

test("parseSessionIndex: 年の見出しと会期のリンクから、会期（id は年-月、ラベルは「令和N年M月定例会」）を新しい順に取る", () => {
  const sessions = parseSessionIndex(fixture("87621.htm"), SESSION_INDEX_URL);
  assert.ok(sessions.length >= 50, `expected many sessions, got ${sessions.length}`);
  assert.deepEqual(sessions.slice(0, 4), [
    { sessionId: "2026-09", sessionLabel: "令和8年9月定例会", url: `${origin}/329482.htm` },
    { sessionId: "2026-06", sessionLabel: "令和8年6月定例会", url: `${origin}/328133.htm` },
    { sessionId: "2026-02", sessionLabel: "令和8年2月定例会", url: `${origin}/326488.htm` },
    { sessionId: "2025-12", sessionLabel: "令和7年12月定例会", url: `${origin}/325233.htm` },
  ]);
  // 臨時会は id に rinji を付けて定例会と分ける（令和5年は 8月臨時会・5月臨時会）。全角の月（「９月定例会」）は NFKC で半角に
  assert.deepEqual(sessions.find((s) => s.sessionId === "2023-08-rinji"), { sessionId: "2023-08-rinji", sessionLabel: "令和5年8月臨時会", url: `${origin}/312422.htm` });
  assert.deepEqual(sessions.find((s) => s.sessionId === "2023-09"), { sessionId: "2023-09", sessionLabel: "令和5年9月定例会", url: `${origin}/311637.htm` });
  // 「平成３１（令和元）年」の見出し
  assert.deepEqual(sessions.find((s) => s.sessionId === "2019-11"), { sessionId: "2019-11", sessionLabel: "令和元年11月定例会", url: `${origin}/287811.htm` });
  const ids = new Set<string>();
  for (let i = 0; i < sessions.length; i++) {
    assert.match(sessions[i].sessionLabel, /^(令和|平成)(\d+|元)年\d{1,2}月(定例会|臨時会)$/, sessions[i].sessionLabel);
    assert.ok(!ids.has(sessions[i].sessionId), `duplicate ${sessions[i].sessionId}`);
    ids.add(sessions[i].sessionId);
    if (i > 0) assert.ok(sessions[i - 1].sessionId.slice(0, 7) >= sessions[i].sessionId.slice(0, 7), `not descending at ${sessions[i].sessionId}`);
  }
});

test("parseSessionIndex: 年の見出しが読めない・会期の文言が「M月定例会／臨時会」でない・会期が 1 つも無いページは失敗する", () => {
  assert.throws(() => parseSessionIndex("<html><h2 class='Title'>◆令和８年</h2><a href='/1.htm'>6月の日程</a></html>", SESSION_INDEX_URL), /no sessions/);
  assert.throws(() => parseSessionIndex("<html><h2 class='Title'>◆西暦2026年</h2><a href='/1.htm'>6月定例会</a></html>", SESSION_INDEX_URL), /year heading/);
  const dup = "<html><h2 class='Title'>◆令和８年</h2><a href='/1.htm'>6月定例会</a><a href='/2.htm'>6月定例会</a></html>";
  assert.throws(() => parseSessionIndex(dup, SESSION_INDEX_URL), /duplicate/);
});

test("parseSessionPage: 会期ページの「議案等の議決結果」リンクを取る。無ければ undefined（まだ議決していない会期）", () => {
  assert.equal(parseSessionPage(fixture("328133.htm"), `${origin}/328133.htm`), `${origin}/328150.htm`);
  assert.equal(parseSessionPage(fixture("329482.htm"), `${origin}/329482.htm`), undefined);
  assert.equal(parseSessionPage(fixture("326488.htm") ?? "", `${origin}/326488.htm`), `${origin}/326506.htm`);
});

test("parseResultsPage: 見出しと、議決日付きの結果リンク（「6月29日可決」など）と「議員別の賛否の状況」の PDF を文書順・重複なしで取る。陳情ごとの結果 PDF（「不採択」）は取らない", () => {
  const june = parseResultsPage(fixture("328150.htm"), `${origin}/328150.htm`);
  assert.equal(june.title, "議案等の議決結果");
  assert.deepEqual(june.pdfUrls, [
    `${origin}/secure/1422217/R8.6giketsukekka0629.pdf`,
    `${origin}/secure/1422215/r8.6.29giketsukekka.pdf`,
    `${origin}/secure/1422215/R8.6.29%20giinteishutsugian_giketsukekka.pdf`,
    `${origin}/secure/1422216/R8.6.29_seiganchinjogiketsukekka.pdf`,
  ]);
  const feb = parseResultsPage(fixture("326506.htm"), `${origin}/326506.htm`);
  assert.deepEqual(feb.pdfUrls, [
    `${origin}/secure/1412313/R0802sengikekka.pdf`,
    `${origin}/secure/1412311/R8.2giketsukekka0325.pdf`,
    `${origin}/secure/1412309/R8.2giketsukekka0325.pdf`,
    `${origin}/secure/1412310/R8.2giketsukekka0325.pdf`,
  ]);
});

test("parseResultsPage: 結果 PDF のリンクが 1 本も無いページは空（まだ掲載が無い）。PDF 以外のリンク・別ホストは取らない", () => {
  assert.deepEqual(parseResultsPage("<html><div id='ContentPane'><h1>議案等の議決結果</h1><p><a href='/1.htm'>6月29日可決</a></p></div></html>", `${origin}/1.htm`).pdfUrls, []);
  assert.throws(() => parseResultsPage("<html><div id='ContentPane'><a href='https://example.com/a.pdf'>6月29日可決</a></div></html>", `${origin}/1.htm`), /not on/);
});
