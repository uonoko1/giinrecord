import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";
import { jstDate, runShiga, type Fetcher } from "../src/sources/local/shiga/index.ts";
import { buildLocalAssembly } from "../src/local-assemblies.ts";
import { SHIGA_ASSEMBLY } from "../src/sources/local/shiga/site.ts";

const fixture = (name: string): Buffer => readFileSync(fileURLToPath(new URL(`fixtures/shiga/${name}`, import.meta.url)));

/**
 * 取得部（`runShiga`）をフィクスチャで回す（Issue #741）。**ネットワークには出ない。**
 * 会期ページは 1 本ぶんしか置いていないので、`--sessions 1` に相当する形で確かめる。
 */
function fetcher(pdfFor: Record<string, string>): Fetcher & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async textShiftJis(url: string) {
      urls.push(url);
      const u = new URL(url);
      if (u.pathname === "/g07_giinlistP.asp") return iconv.decode(fixture("giinlist.html"), "Shift_JIS");
      if (u.searchParams.get("YMSel") === "9999") return iconv.decode(fixture("years.html"), "Shift_JIS");
      if (u.searchParams.get("Y1") === "2026") return iconv.decode(fixture(u.searchParams.get("Tmode") === "0" ? "year-2026-t0.html" : "year-2026.html"), "Shift_JIS");
      if (u.searchParams.has("Y1")) return "<html><body></body></html>"; // 他の年は空（フィクスチャを置かない）
      if (u.searchParams.get("KaigiID") === "256") return iconv.decode(fixture("kaigi-256.html"), "Shift_JIS");
      return "<html><body></body></html>";
    },
    async bytes(url: string) {
      urls.push(url);
      const name = pdfFor[url];
      if (!name) throw new Error(`no fixture for ${url}`);
      return fixture(name);
    },
  };
}

const PDFS = {
  "https://www.shigaken-gikai.jp/voices/GikaiDoc/attach/Congress/Kg900_sanpi-0722-2.pdf": "Kg907_sanpi-080810-1.pdf",
  "https://www.shigaken-gikai.jp/voices/GikaiDoc/attach/Congress/Kg907_sanpi-080810-1.pdf": "Kg907_sanpi-080810-1.pdf",
};

test("#741 jstDate: 取得日（JST）。UTC の夜は翌日になる", () => {
  assert.equal(jstDate("2026-09-12T20:20:52.955Z"), "2026-09-13");
  assert.equal(jstDate("2026-09-13T00:00:00.000Z"), "2026-09-13");
  assert.equal(jstDate("2026-09-12T14:59:59.000Z"), "2026-09-12");
});

test("#741 runShiga: 名簿 44 名 × 最新 1 会期。**年ページを年度版と暦年版の両方から読む**", async () => {
  const f = fetcher(PDFS);
  const run = await runShiga({ sessions: 1, fetchedAt: "2026-09-12T20:20:52.955Z", fetcher: f });
  assert.equal(run.roster.members.length, 44);
  assert.equal(run.roster.asOf, "2026-09-13");
  assert.equal(run.sessions.length, 1);
  // **年度版にしか無い 2026-07 が選ばれる。** 暦年版だけを読むと 2026-06-rinji になる
  assert.equal(run.sessions[0].sessionId, "2026-07");
  assert.equal(run.sessions[0].sessionLabel, "令和8年 7月定例会議");
  assert.equal(run.sessions[0].sourceUrl, "https://www.shigaken-gikai.jp/g07_gian_sanpi.asp?KaigiID=256");
  assert.equal(run.sessions[0].pdfUrls?.length, 2);
  assert.equal(run.sessions[0].unknownCells, 0);
  // **年ページを両方取りに行っていること**（片方だけなら会期が落ちる）
  assert.ok(f.urls.includes("https://www.shigaken-gikai.jp/voices/g07_Congress.asp?Y1=2026"), "年度版の年ページを取っていない");
  assert.ok(f.urls.includes("https://www.shigaken-gikai.jp/voices/g07_Congress.asp?Y1=2026&Tmode=0"), "暦年版の年ページを取っていない");
  // すべての sourceUrl が県議会の公式ホスト
  for (const s of run.sources) assert.match(s.url, /^https:\/\/www\.shigaken-gikai\.jp\//);
  for (const rc of run.rollCalls) assert.match(rc.sourceUrl, /^https:\/\/www\.shigaken-gikai\.jp\//);
  assert.equal(run.unreadableSources.length, 0);
});

test("#741 runShiga: **読めない PDF で会期ごと落とさない**（#680 の案C を採らない）", async () => {
  // 2 本のうち 1 本を画像 PDF（文字層なし）に差し替える
  const f = fetcher({ ...PDFS, "https://www.shigaken-gikai.jp/voices/GikaiDoc/attach/Congress/Kg900_sanpi-0722-2.pdf": "Kg265_250424-sanpi.pdf" });
  const run = await runShiga({ sessions: 1, fetchedAt: "2026-09-12T20:20:52.955Z", fetcher: f });
  // **読めた 1 本ぶんの記録は残る。** 会期ごと捨てると、壊れていない 44 名の記録まで消える
  assert.equal(run.sessions.length, 1);
  assert.ok(run.rollCalls.length > 0, "読める本があるのに記録が 0 件");
  // **読めなかったことを記録する**——書かないと「その日の採決は無かった」ように見える
  assert.equal(run.unreadableSources.length, 1);
  assert.equal(run.unreadableSources[0].url, "https://www.shigaken-gikai.jp/voices/GikaiDoc/attach/Congress/Kg900_sanpi-0722-2.pdf");
  assert.match(run.unreadableSources[0].reason, /no text layer/);
});

test("#741 buildLocalAssembly: meta に unreadableSources が載る（読めた議会では省略）", async () => {
  const f = fetcher({ ...PDFS, "https://www.shigaken-gikai.jp/voices/GikaiDoc/attach/Congress/Kg900_sanpi-0722-2.pdf": "Kg265_250424-sanpi.pdf" });
  const run = await runShiga({ sessions: 1, fetchedAt: "2026-09-12T20:20:52.955Z", fetcher: f });
  const built = buildLocalAssembly({
    assembly: SHIGA_ASSEMBLY, members: run.roster.members, rollCalls: run.rollCalls,
    fetchedAt: "2026-09-12T20:20:52.955Z", rosterAsOf: run.roster.asOf,
    sources: run.sources, sessions: run.sessions, unmatched: run.unmatched,
    unreadableSources: run.unreadableSources,
  });
  assert.equal(built.meta.unreadableSources?.length, 1);
  assert.match(built.meta.unreadableSources![0].reason, /no text layer/);
  assert.equal(built.meta.counts.unknownCells, 0);
  // 読めた本だけで counts が合う
  assert.equal(built.meta.counts.cells, built.meta.counts.rollcalls * 44);
  // **unreadableSources を渡さない議会では省略される**（7 県の meta.json が変わらない）
  const without = buildLocalAssembly({
    assembly: SHIGA_ASSEMBLY, members: run.roster.members, rollCalls: run.rollCalls,
    fetchedAt: "2026-09-12T20:20:52.955Z", rosterAsOf: run.roster.asOf,
    sources: run.sources, sessions: run.sessions, unmatched: run.unmatched,
  });
  assert.equal("unreadableSources" in without.meta, false);
});

test("#741 runShiga: **読める PDF が 1 本も無い会期は飛ばす**（記録を捏造しない）", async () => {
  const f = fetcher({
    "https://www.shigaken-gikai.jp/voices/GikaiDoc/attach/Congress/Kg900_sanpi-0722-2.pdf": "Kg265_250424-sanpi.pdf",
    "https://www.shigaken-gikai.jp/voices/GikaiDoc/attach/Congress/Kg907_sanpi-080810-1.pdf": "Kg265_250424-sanpi.pdf",
  });
  // 会期がこの 1 本しか無いので、記録は 0 件になり例外で止まる（黙って空の議会を書かない）
  await assert.rejects(() => runShiga({ sessions: 1, fetchedAt: "2026-09-12T20:20:52.955Z", fetcher: f }), /no roll calls/);
});
