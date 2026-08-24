import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSessionIndex, DECISION_URL } from "../src/sources/local/kochi/sessions.ts";
import { resolveKochiUrl } from "../src/sources/local/kochi/site.ts";

// 高知県議会「議員別賛否の状況」（Issue #220。2026-08-24 取得）。
// /activity/decision.html の 1 ページに会期ごとの「令和８年６月定例会議決結果一覧表[PDF：146KB]」が新しい順に並ぶ。
const html = readFileSync(new URL("./fixtures/kochi/decision.html", import.meta.url), "utf-8");
const sessions = parseSessionIndex(html, DECISION_URL);

test("parseSessionIndex: 会期ごとの PDF を新しい順に読む", () => {
  assert.ok(sessions.length >= 30);
  assert.deepEqual(sessions[0], {
    sessionId: "2026-06",
    sessionLabel: "令和８年６月定例会",
    year: 2026,
    month: 6,
    pdfUrl: "https://gikai.pref.kochi.lg.jp/_files/00156424/0806.pdf",
  });
  assert.equal(sessions[1].sessionId, "2026-02");
  assert.equal(sessions[2].sessionId, "2025-12");
  assert.equal(sessions[4].sessionId, "2025-06");
  assert.equal(sessions[4].pdfUrl, "https://gikai.pref.kochi.lg.jp/_files/00141109/0706.pdf");
});

test("parseSessionIndex: 臨時会は sessionId に -rinji を付ける（同じ年月の定例会と衝突させない）", () => {
  const rinji = sessions.filter((s) => s.sessionLabel.includes("臨時会"));
  assert.ok(rinji.length > 0);
  for (const s of rinji) assert.match(s.sessionId, /-rinji$/);
  const r5 = sessions.find((s) => s.sessionId === "2023-05-rinji");
  assert.equal(r5?.sessionLabel, "令和５年５月臨時会");
});

test("parseSessionIndex: sessionId は重複しない。並びは新しい順", () => {
  const ids = sessions.map((s) => s.sessionId);
  assert.equal(new Set(ids).size, ids.length);
  for (let i = 1; i < sessions.length; i++) {
    const a = sessions[i - 1], b = sessions[i];
    assert.ok(a.year * 100 + a.month >= b.year * 100 + b.month, `${a.sessionId} before ${b.sessionId}`);
  }
});

test("parseSessionIndex: PDF は県議会の公式ホストのものだけ", () => {
  for (const s of sessions) assert.match(s.pdfUrl, /^https:\/\/gikai\.pref\.kochi\.lg\.jp\/_files\//);
});

test("parseSessionIndex: 会期が 1 つも無ければ例外（黙って空を返さない）", () => {
  assert.throws(() => parseSessionIndex("<html><body>なにも無い</body></html>", DECISION_URL), /no sessions/);
});

test("resolveKochiUrl: 取得先は県議会の公式ホスト（https）だけ。別ホスト・http・相対の遡りは例外", () => {
  // 相対 URL は名簿・index と同じホストに解決される
  assert.equal(resolveKochiUrl("/_files/00156424/0806.pdf", DECISION_URL), "https://gikai.pref.kochi.lg.jp/_files/00156424/0806.pdf");
  // フラグメントは落とす
  assert.equal(resolveKochiUrl("/activity/decision.html#top", DECISION_URL), "https://gikai.pref.kochi.lg.jp/activity/decision.html");
  // ページに別ホストのリンクが混ざっても取りに行かない（許可リスト）
  assert.throws(() => resolveKochiUrl("https://example.com/x.pdf", DECISION_URL), /not on gikai\.pref\.kochi\.lg\.jp/);
  assert.throws(() => resolveKochiUrl("//example.com/x.pdf", DECISION_URL), /not on gikai\.pref\.kochi\.lg\.jp/);
  // http へのダウングレードもしない
  assert.throws(() => resolveKochiUrl("http://gikai.pref.kochi.lg.jp/x.pdf", DECISION_URL), /not on gikai\.pref\.kochi\.lg\.jp/);
  // 「../」で外に出ても URL のホストは変わらない（パストラバーサルはホスト検査で塞がる）
  assert.equal(resolveKochiUrl("/../../etc/passwd", DECISION_URL), "https://gikai.pref.kochi.lg.jp/etc/passwd");
});
