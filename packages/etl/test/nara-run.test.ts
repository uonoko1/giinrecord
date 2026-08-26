import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNara, type Fetcher } from "../src/sources/local/nara/index.ts";
import { NARA_ASSEMBLY } from "../src/sources/local/nara/site.ts";
import { buildLocalAssembly, validateLocalAssemblies, writeLocalAssembly } from "../src/local-assemblies.ts";

// 奈良県議会 ETL の取得部（Issue #202）: 名簿（五十音順）→ 会期 index → 会期ページ → 議決日ごとの表決 PDF。
// HTTP は境界なので、フィクスチャ（2026-08-24 取得）を返す Fetcher を差し込む。取得先 URL はすべて県の公式ホスト。
const origin = "https://www.pref.nara.lg.jp";
const files: Record<string, string> = {
  [`${origin}/n161/52534.html`]: "52534.html",
  [`${origin}/n161/18579.html`]: "18579.html",
  [`${origin}/n161/p114029.html`]: "p114029.html",
  [`${origin}/n161/p114001.html`]: "p114001.html",
  [`${origin}/documents/24098/20260702_giinbetsu_hyoketsu.pdf`]: "20260702_giinbetsu_hyoketsu.pdf",
  [`${origin}/documents/21459/20260325_giinbetsu_hyoketsu.pdf`]: "20260325_giinbetsu_hyoketsu.pdf",
};
function fakeFetcher(): Fetcher & { urls: string[] } {
  const urls: string[] = [];
  const read = (url: string) => {
    const f = files[url];
    if (!f) throw new Error(`unexpected fetch ${url}`);
    urls.push(url);
    return readFileSync(new URL(`./fixtures/nara/${f}`, import.meta.url));
  };
  return { urls, text: async (url) => read(url).toString("utf8"), bytes: async (url) => read(url) };
}

test("runNara: 直近 2 会期の表決 PDF を読み、会期ごとに件数・出典を返す。取得先はすべて公式ホスト", async () => {
  const f = fakeFetcher();
  const log: string[] = [];
  const run = await runNara({ sessions: 2, fetchedAt: "2026-08-24T00:00:00.000Z", fetcher: f, log: (l) => log.push(l) });
  assert.equal(run.roster.members.length, 40);
  assert.equal(run.roster.asOf, "2026-04-24");
  assert.deepEqual(run.sessions.map((s) => [s.sessionId, s.sessionLabel, s.rollcalls, s.unknownCells, s.sourceUrl, s.pdfUrl]), [
    ["2026-06", "令和8年6月定例会", 37, 0, `${origin}/n161/p114029.html`, `${origin}/documents/24098/20260702_giinbetsu_hyoketsu.pdf`],
    ["2026-02", "令和8年2月定例会", 88, 0, `${origin}/n161/p114001.html`, `${origin}/documents/21459/20260325_giinbetsu_hyoketsu.pdf`],
  ]);
  assert.equal(run.rollCalls.length, 125);
  assert.deepEqual(run.unmatched, []);
  assert.equal(run.sources[0].name, "奈良県議会 議員名簿（五十音順）");
  assert.equal(run.sources[1].url, `${origin}/n161/18579.html`);
  assert.ok(run.sources.some((s) => s.url === `${origin}/documents/24098/20260702_giinbetsu_hyoketsu.pdf` && s.name.includes("2026-07-02議決分")));
  assert.ok(run.sources.every((s) => s.fetchedAt === "2026-08-24T00:00:00.000Z"));
  // 取得順: 名簿 → index → 会期ページ → PDF。すべて公式ホスト。同じ URL は 1 回
  assert.equal(f.urls[0], `${origin}/n161/52534.html`);
  assert.equal(f.urls[1], `${origin}/n161/18579.html`);
  assert.ok(f.urls.every((u) => u.startsWith(`${origin}/`)));
  assert.equal(new Set(f.urls).size, f.urls.length);
  assert.ok(log.some((l) => /roster: 40 members/.test(l)));
});

test("runNara + buildLocalAssembly + writeLocalAssembly: 契約どおりに書けて validateLocalAssemblies の違反 0", async () => {
  const run = await runNara({ sessions: 2, fetchedAt: "2026-08-24T00:00:00.000Z", fetcher: fakeFetcher() });
  const built = buildLocalAssembly({
    assembly: NARA_ASSEMBLY, members: run.roster.members, rollCalls: run.rollCalls, fetchedAt: "2026-08-24T00:00:00.000Z",
    rosterAsOf: run.roster.asOf, sources: run.sources, sessions: run.sessions, unmatched: run.unmatched,
  });
  assert.equal(built.meta.counts.members, 40);
  assert.equal(built.meta.counts.rollcalls, 125);
  assert.equal(built.meta.counts.cells, 125 * 40);
  assert.equal(built.meta.counts.unknownCells, 0);
  assert.equal(built.meta.counts.unmatchedNames, 0);
  assert.deepEqual(built.sessions.map((s) => [s.id, s.label, s.date, s.rollcalls]), [
    ["2026-06", "令和8年6月定例会", "2026-07-02", 37],
    ["2026-02", "令和8年2月定例会", "2026-03-25", 88],
  ]);
  // 名簿の全員に票が付く（文字層で氏名が欠ける 芦高清友・西川均 も含む）。欠席が続いた議員にも欠席の票が残る
  assert.ok(built.details.every((d) => d.counts.rollcalls === 125));
  const ashitaka = built.details.find((d) => d.id === "p_29_52536")!;
  assert.equal(ashitaka.timeline.length, 125);
  assert.equal(ashitaka.timeline[0].date, "2026-07-02");
  const dir = await mkdtemp(join(tmpdir(), "giinrecord-nara-"));
  await writeLocalAssembly(dir, built);
  assert.deepEqual(await validateLocalAssemblies(dir), []);
  const rc = JSON.parse(readFileSync(join(dir, "assemblies", "pref-29", "rollcalls", "2026-02", "pref-29-2026-02-20260325-決議-第1号.json"), "utf8"));
  assert.equal(rc.title, "第85回国民スポーツ大会及び第30回全国パラスポーツ大会の開催に関する決議");
  assert.equal(rc.result, "原案可決");
  assert.ok(!("method" in rc));
  assert.ok(!("counts" in rc));
});
