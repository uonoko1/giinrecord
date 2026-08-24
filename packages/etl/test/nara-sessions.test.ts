import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSessionIndex, parseSessionPage, SESSION_INDEX_URL } from "../src/sources/local/nara/sessions.ts";

// 奈良県議会「定例（臨時）県議会の概要」（/n161/18579.html）と会期ページ（/n161/p114029.html など。2026-08-24 取得）。
// index は #tmp_contents の ul に「令和8年6月定例会の概要」のリンクが新しい順。会期ページには
// 「議員別の議案等に対する表決結果（PDF：…）」が議決日ごとに並ぶ（右ナビの「同じカテゴリから探す」は読まない）。
const fixture = (name: string) => readFileSync(new URL(`./fixtures/nara/${name}`, import.meta.url), "utf8");
const origin = "https://www.pref.nara.lg.jp";
const index = parseSessionIndex(fixture("18579.html"), SESSION_INDEX_URL);

test("parseSessionIndex: 新しい順。sessionId は {西暦}-{月2桁}（臨時会は -rinji）、label はリンク文言から「の概要」を除いた原文", () => {
  assert.deepEqual(index[0], { sessionId: "2026-06", sessionLabel: "令和8年6月定例会", year: 2026, month: 6, url: `${origin}/n161/p114029.html` });
  assert.deepEqual(index[1], { sessionId: "2026-02", sessionLabel: "令和8年2月定例会", year: 2026, month: 2, url: `${origin}/n161/p114001.html` });
  assert.equal(index[2].sessionId, "2025-12");
  // 臨時会（令和2年4月）は -rinji、令和元年は 2019
  assert.ok(index.some((s) => s.sessionId === "2020-04-rinji" && s.sessionLabel === "令和2年4月臨時会"));
  assert.ok(index.some((s) => s.sessionId === "2019-05-rinji"));
  // 右ナビや別ページのリンクを拾っていない（すべて会期の id）
  assert.equal(new Set(index.map((s) => s.sessionId)).size, index.length);
  for (let i = 1; i < index.length; i++) {
    assert.ok(index[i - 1].year * 100 + index[i - 1].month >= index[i].year * 100 + index[i].month, "descending");
  }
});

test("parseSessionPage: h1 が index のリンク文言と一致し、「議員別の議案等に対する表決結果」の PDF を並び順で返す", () => {
  const june = parseSessionPage(fixture("p114029.html"), `${origin}/n161/p114029.html`, { sessionLabel: "令和8年6月定例会" });
  assert.equal(june.sessionLabel, "令和8年6月定例会");
  assert.deepEqual(june.pdfUrls, [`${origin}/documents/24098/20260702_giinbetsu_hyoketsu.pdf`]);
  const feb = parseSessionPage(fixture("p114001.html"), `${origin}/n161/p114001.html`, { sessionLabel: "令和8年2月定例会" });
  assert.deepEqual(feb.pdfUrls, [`${origin}/documents/21459/20260325_giinbetsu_hyoketsu.pdf`]);
});

test("parseSessionPage: h1 が index のリンク文言と食い違えば例外（別の会期のページを黙って読まない）", () => {
  assert.throws(
    () => parseSessionPage(fixture("p114029.html"), `${origin}/n161/p114029.html`, { sessionLabel: "令和8年2月定例会" }),
    /does not match/,
  );
});

test("parseSessionPage: 表決 PDF のリンクが無ければ pdfUrls は []（会期中＝まだ議決していない。呼び出し側が飛ばす）", () => {
  // 会期中のページを再現: 実ページから表決結果のリンク文言を消す（他の添付（議事日程など）だけが残る）
  const inSession = fixture("p114029.html").replaceAll("議員別の議案等に対する表決結果", "（未掲載）");
  const page = parseSessionPage(inSession, `${origin}/n161/p114029.html`, { sessionLabel: "令和8年6月定例会" });
  assert.deepEqual(page.pdfUrls, []);
});
