import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSessionIndex, SESSION_INDEX_URL } from "../src/sources/local/mie/sessions.ts";

// 三重県議会「議案審議結果一覧」（Issue #203）。1 ページに全会期。h2「令和８年定例会」（通年議会。年 1 会期。
// 令和5年のように「第２回定例会」「第１回定例会」と分かれる年や、臨時会のある年（平成21年）もある）ごとに、
// h3「議員別の賛否等の状況」の下の ul に月ごとの賛否 PDF（リンク文言「令和８年２月」）が並ぶ。
// sessionId は和暦から機械的に作る（r08 / r05-2 / h21-1-rinji。平成31年と令和元年が同じ 2019 なので西暦では一意にならない）。
// フィクスチャは 2026-08-24 取得の実 HTML。
const html = readFileSync(new URL("./fixtures/mie/07976009017.htm", import.meta.url), "utf8");
const origin = "https://www.pref.mie.lg.jp";

test("parseSessionIndex: 会期（h2）を新しい順に、会期ごとの月別賛否 PDF を読む。賛否 PDF の無い会期（平成19年以前）は載せない", () => {
  const sessions = parseSessionIndex(html, SESSION_INDEX_URL);
  assert.equal(sessions[0].sessionId, "r08");
  assert.equal(sessions[0].sessionLabel, "令和８年定例会");
  assert.equal(sessions[0].year, 2026);
  assert.deepEqual(sessions[0].pdfs.map((p) => [p.month, p.url]), [
    [1, `${origin}/common/content/001235880.pdf`],
    [2, `${origin}/common/content/001242584.pdf`],
    [3, `${origin}/common/content/001249930.pdf`],
    [5, `${origin}/common/content/001256778.pdf`],
    [6, `${origin}/common/content/001263901.pdf`],
  ]);
  assert.deepEqual(sessions[0].pdfs[0], { label: "令和８年１月", month: 1, url: `${origin}/common/content/001235880.pdf` });
  assert.equal(sessions[1].sessionId, "r07");
  assert.equal(sessions[1].year, 2025);
  assert.equal(sessions[1].pdfs.length, 8);
  // 令和5年は第2回・第1回に分かれる
  const r5 = sessions.filter((s) => s.year === 2023);
  assert.deepEqual(r5.map((s) => [s.sessionId, s.sessionLabel]), [
    ["r05-2", "令和５年第２回定例会"],
    ["r05-1", "令和５年第１回定例会"],
  ]);
  // 平成31年と令和元年はどちらも 2019 年（改元）。和暦ベースの id で一意になる
  assert.ok(sessions.some((s) => s.sessionId === "r01" && s.sessionLabel === "令和元年定例会" && s.year === 2019));
  assert.ok(sessions.some((s) => s.sessionId === "h31" && s.sessionLabel === "平成３１年定例会" && s.year === 2019));
  // 臨時会は -rinji（平成21年第1回臨時会）
  assert.ok(sessions.some((s) => s.sessionId === "h21-1-rinji" && s.sessionLabel === "平成２１年第１回臨時会"));
  // sessionId は一意、年は増えない並び
  assert.equal(new Set(sessions.map((s) => s.sessionId)).size, sessions.length);
  for (let i = 1; i < sessions.length; i++) assert.ok(sessions[i - 1].year >= sessions[i].year);
  // 賛否 PDF の無い会期（平成19年以前）は含まれない
  assert.ok(sessions.every((s) => s.pdfs.length > 0));
  assert.ok(!sessions.some((s) => s.year <= 2007));
});

test("parseSessionIndex: PDF リンクの年が会期の年と違えば例外（黙って読まない）", () => {
  const broken = html.replace('001235880.pdf">令和８年１月', '001235880.pdf">令和７年１月');
  assert.throws(() => parseSessionIndex(broken, SESSION_INDEX_URL), /令和７年１月/);
});
