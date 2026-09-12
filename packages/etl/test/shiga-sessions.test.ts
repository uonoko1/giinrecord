import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";
import { parseSanpiPage, parseYearIndex, parseYearPage } from "../src/sources/local/shiga/sessions.ts";
import { shigaYearUrl } from "../src/sources/local/shiga/site.ts";

const sjis = (name: string): string => iconv.decode(readFileSync(fileURLToPath(new URL(`fixtures/shiga/${name}`, import.meta.url))), "Shift_JIS");

test("#741 parseYearIndex: 年の一覧から Y1= を拾う（昇順・重複なし）", () => {
  const years = parseYearIndex(sjis("years.html"));
  assert.equal(years.length, 40);
  assert.equal(years[0], 1987);
  assert.equal(years[years.length - 1], 2026);
  assert.deepEqual([...years].sort((a, b) => a - b), years);
  assert.throws(() => parseYearIndex("<html><body>なし</body></html>"), /Y1= のリンクが 1 つも無い/);
});

test("#741 **年ページは年度版と暦年版の 2 通り。片方だけでは会期が落ちる**", () => {
  const fiscal = parseYearPage(sjis("year-2026.html"), shigaYearUrl(2026, "fiscal"));
  const calendar = parseYearPage(sjis("year-2026-t0.html"), shigaYearUrl(2026, "calendar"));
  // **年度版（4月〜翌3月）**: 7月定例会議・6月臨時会議・4月招集会議
  assert.deepEqual(fiscal.map((s) => s.sessionId), ["2026-07", "2026-06-rinji", "2026-04-rinji"]);
  // **暦年版（1月〜12月）**: 6月臨時会議・1月臨時会議。**7月定例会議がここには無い**
  assert.deepEqual(calendar.map((s) => s.sessionId), ["2026-06-rinji", "2026-01-rinji"]);
  // **暦年版だけを読むと、最新の会期（2026-07）を丸ごと落とす。**
  // 落ちても「その会期の採決は無かった」ようにしか見えないので、利用者からは検出できない。
  assert.equal(calendar.some((s) => s.sessionId === "2026-07"), false);
  // **年度版だけを読むと 1月臨時会議を落とす**（逆向きにも落ちる）
  assert.equal(fiscal.some((s) => s.sessionId === "2026-01-rinji"), false);

  // 会期名は h2 の原文（全角数字・全角空白のまま）。KaigiID は年ページから拾う（組み立てない）
  assert.equal(fiscal[0].sessionLabel, "令和8年 7月定例会議");
  assert.equal(fiscal[0].kaigiId, 256);
  assert.equal(fiscal[0].kaigiUrl, "https://www.shigaken-gikai.jp/g07_gian_sanpi.asp?KaigiID=256");
  assert.deepEqual([fiscal[0].year, fiscal[0].month], [2026, 7]);
  // **臨時会議・招集会議は -rinji、定例会議は付けない**
  assert.equal(fiscal[1].sessionId, "2026-06-rinji");
  assert.equal(fiscal[2].sessionId, "2026-04-rinji");
});

test("#741 parseYearPage: **賛否状況のリンクが無い会期は返さない**（公表されていない事実を作らない）", () => {
  const fiscal = parseYearPage(sjis("year-2026.html"), shigaYearUrl(2026, "fiscal"));
  // フィクスチャの年ページには「令和8年　9月定例会議」の h2 もあるが、
  // **賛否状況のリンクがまだ無い**（会期中）ので返さない
  assert.equal(sjis("year-2026.html").includes("9月定例会議"), true);
  assert.equal(fiscal.some((s) => s.sessionId === "2026-09"), false);
});

test("#741 parseSanpiPage: 会期ページの賛否 PDF（空白入りのファイル名はエンコードする）", () => {
  const links = parseSanpiPage(sjis("kaigi-256.html"), "https://www.shigaken-gikai.jp/g07_gian_sanpi.asp?KaigiID=256");
  assert.equal(links.length, 2);
  assert.deepEqual(links.map((l) => l.url), [
    "https://www.shigaken-gikai.jp/voices/GikaiDoc/attach/Congress/Kg900_sanpi-0722-2.pdf",
    "https://www.shigaken-gikai.jp/voices/GikaiDoc/attach/Congress/Kg907_sanpi-080810-1.pdf",
  ]);
  // リンク文言は原文のまま（どの議決日の本かが分かる）
  assert.match(links[0].text, /賛否状況/);
  // PDF の無い会期は空（例外にしない。会期中なら後から出る）
  assert.deepEqual(parseSanpiPage("<html><body><p>準備中</p></body></html>", "https://www.shigaken-gikai.jp/g07_gian_sanpi.asp?KaigiID=1"), []);
});

test("#741 shigaYearUrl: Tmode の有無で年度版と暦年版を作り分ける", () => {
  assert.equal(shigaYearUrl(2012, "fiscal"), "https://www.shigaken-gikai.jp/voices/g07_Congress.asp?Y1=2012");
  assert.equal(shigaYearUrl(2012, "calendar"), "https://www.shigaken-gikai.jp/voices/g07_Congress.asp?Y1=2012&Tmode=0");
});
