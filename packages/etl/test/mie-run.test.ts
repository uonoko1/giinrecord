import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMie, type Fetcher } from "../src/sources/local/mie/index.ts";
import { MIE_ASSEMBLY } from "../src/sources/local/mie/site.ts";
import { buildLocalAssembly, validateLocalAssemblies, writeLocalAssembly } from "../src/local-assemblies.ts";

// 三重県議会 ETL の取得部（Issue #203）: 名簿（５０音順 → 選挙区 index → 15 選挙区ページ）→ 議案審議結果一覧 → 月別の賛否 PDF。
// HTTP は境界なので、フィクスチャ（2026-08-24 取得）を返す Fetcher を差し込む。取得先 URL はすべて県の公式ホスト。
const origin = "https://www.pref.mie.lg.jp";
const files: Record<string, string> = {
  [`${origin}/KENGIKAI/08089011294.htm`]: "meibo-50on.htm",
  [`${origin}/KENGIKAI/08096011310.htm`]: "meibo-senkyoku.htm",
  [`${origin}/KENGIKAI/08109011323.htm`]: "senkyoku-08109011323.htm",
  [`${origin}/KENGIKAI/08111011325.htm`]: "senkyoku-08111011325.htm",
  [`${origin}/KENGIKAI/08097011311.htm`]: "senkyoku-08097011311.htm",
  [`${origin}/KENGIKAI/08101011315.htm`]: "senkyoku-08101011315.htm",
  [`${origin}/KENGIKAI/08100011314.htm`]: "senkyoku-08100011314.htm",
  [`${origin}/KENGIKAI/08106011320.htm`]: "senkyoku-08106011320.htm",
  [`${origin}/KENGIKAI/08103011317.htm`]: "senkyoku-08103011317.htm",
  [`${origin}/KENGIKAI/08104011318.htm`]: "senkyoku-08104011318.htm",
  [`${origin}/KENGIKAI/08098011312.htm`]: "senkyoku-08098011312.htm",
  [`${origin}/KENGIKAI/08095011309.htm`]: "senkyoku-08095011309.htm",
  [`${origin}/KENGIKAI/08105011319.htm`]: "senkyoku-08105011319.htm",
  [`${origin}/KENGIKAI/08094011308.htm`]: "senkyoku-08094011308.htm",
  [`${origin}/KENGIKAI/08102011316.htm`]: "senkyoku-08102011316.htm",
  [`${origin}/KENGIKAI/08107011321.htm`]: "senkyoku-08107011321.htm",
  [`${origin}/KENGIKAI/08110011324.htm`]: "senkyoku-08110011324.htm",
  [`${origin}/KENGIKAI/07976009017.htm`]: "07976009017.htm",
  [`${origin}/common/content/001235880.pdf`]: "001235880.pdf",
  [`${origin}/common/content/001242584.pdf`]: "001242584.pdf",
  [`${origin}/common/content/001249930.pdf`]: "001249930.pdf",
  [`${origin}/common/content/001256778.pdf`]: "001256778.pdf",
  [`${origin}/common/content/001263901.pdf`]: "001263901.pdf",
};
function fakeFetcher(): Fetcher & { urls: string[] } {
  const urls: string[] = [];
  const read = (url: string) => {
    const f = files[url];
    if (!f) throw new Error(`unexpected fetch ${url}`);
    urls.push(url);
    return readFileSync(new URL(`./fixtures/mie/${f}`, import.meta.url));
  };
  return { urls, text: async (url) => read(url).toString("utf8"), bytes: async (url) => read(url) };
}

test("runMie: 直近 1 会期（令和8年定例会）の月別 PDF 5 本を全部読み、会期ごとに件数・出典を返す", async () => {
  const f = fakeFetcher();
  const log: string[] = [];
  const run = await runMie({ sessions: 1, fetchedAt: "2026-08-24T00:00:00.000Z", fetcher: f, log: (l) => log.push(l) });
  assert.equal(run.roster.members.length, 47);
  assert.equal(run.roster.asOf, "2025-11-18");
  assert.deepEqual(run.sessions.map((s) => [s.sessionId, s.sessionLabel, s.rollcalls, s.unknownCells, s.sourceUrl]), [
    ["r08", "令和８年定例会", 110, 0, `${origin}/KENGIKAI/07976009017.htm`],
  ]);
  assert.equal(run.sessions[0].pdfUrl, `${origin}/common/content/001235880.pdf`);
  assert.deepEqual(run.sessions[0].pdfUrls, [
    `${origin}/common/content/001235880.pdf`,
    `${origin}/common/content/001242584.pdf`,
    `${origin}/common/content/001249930.pdf`,
    `${origin}/common/content/001256778.pdf`,
    `${origin}/common/content/001263901.pdf`,
  ]);
  assert.equal(run.rollCalls.length, 110);
  assert.equal(run.unmatched.length, 0);
  assert.equal(run.sources[0].name, "三重県議会 議員名簿（選挙区別５０音順）");
  assert.ok(run.sources.some((s) => s.url === `${origin}/KENGIKAI/07976009017.htm`));
  assert.ok(run.sources.some((s) => s.url === `${origin}/common/content/001263901.pdf` && s.name.includes("令和８年定例会") && s.name.includes("６月")));
  assert.ok(run.sources.every((s) => s.fetchedAt === "2026-08-24T00:00:00.000Z"));
  // 取得順: ５０音順 → 選挙区 index → 15 選挙区ページ → 議案審議結果一覧 → PDF（月順）。すべて公式ホスト。同じ URL は 1 回
  assert.equal(f.urls[0], `${origin}/KENGIKAI/08089011294.htm`);
  assert.equal(f.urls[1], `${origin}/KENGIKAI/08096011310.htm`);
  assert.ok(f.urls.every((u) => u.startsWith(`${origin}/`)));
  assert.equal(new Set(f.urls).size, f.urls.length);
  assert.equal(f.urls.length, 2 + 15 + 1 + 5);
});

test("runMie + buildLocalAssembly + writeLocalAssembly: 契約どおりに書けて validateLocalAssemblies の違反 0", async () => {
  const run = await runMie({ sessions: 1, fetchedAt: "2026-08-24T00:00:00.000Z", fetcher: fakeFetcher() });
  const built = buildLocalAssembly({
    assembly: MIE_ASSEMBLY, members: run.roster.members, rollCalls: run.rollCalls, fetchedAt: "2026-08-24T00:00:00.000Z",
    rosterAsOf: run.roster.asOf, sources: run.sources, sessions: run.sessions, unmatched: run.unmatched,
  });
  assert.equal(built.meta.counts.members, 47);
  assert.equal(built.meta.counts.rollcalls, 110);
  assert.equal(built.meta.counts.cells, 110 * 47);
  assert.equal(built.meta.counts.unknownCells, 0);
  assert.equal(built.meta.counts.unmatchedNames, 0);
  assert.deepEqual(built.sessions.map((s) => [s.id, s.date, s.rollcalls]), [["r08", "2026-06-30", 110]]);
  // 議長（藤田 宜三）の timeline も 110 件（票を投じない事実も timeline に残る）
  const fujita = built.details.find((d) => d.id === "p_24_fujita_yoshimi15")!;
  assert.equal(fujita.counts.rollcalls, 110);
  const rc = built.rollCalls.find((r) => r.id === "pref-24-r08-20260519-議案-第78号")!;
  assert.deepEqual(rc.votes[8].value, { raw: "除", legend: "除斥", mapped: "投票なし" });
  const dir = await mkdtemp(join(tmpdir(), "gikailog-mie-"));
  await writeLocalAssembly(dir, built);
  assert.deepEqual(await validateLocalAssemblies(dir), []);
  const detail = JSON.parse(readFileSync(join(dir, "members", "p_24_aoki_kenjyun15.json"), "utf8"));
  assert.equal(detail.assemblyId, "pref-24");
  assert.equal(detail.timeline.length, 110);
  assert.equal(detail.timeline[0].sessionLabel, "令和８年定例会");
});
