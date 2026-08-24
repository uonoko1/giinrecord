import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runKochi, type Fetcher } from "../src/sources/local/kochi/index.ts";
import { KOCHI_ASSEMBLY } from "../src/sources/local/kochi/site.ts";
import { buildLocalAssembly, validateLocalAssemblies, writeLocalAssembly } from "../src/local-assemblies.ts";

// 高知県議会 ETL の取得部（Issue #220）: 名簿（会派別）→「議員別賛否の状況」index → 会期ごとの議決結果一覧 PDF。
// HTTP は境界なので、フィクスチャ（2026-08-24 取得）を返す Fetcher を差し込む。取得先 URL はすべて県議会の公式ホスト。
const origin = "https://gikai.pref.kochi.lg.jp";
const files: Record<string, string> = {
  [`${origin}/member/categories/`]: "member-categories.html",
  [`${origin}/activity/decision.html`]: "decision.html",
  [`${origin}/_files/00156424/0806.pdf`]: "0806.pdf",
  [`${origin}/_files/00141109/0706.pdf`]: "0706.pdf",
};
function fakeFetcher(): Fetcher & { urls: string[] } {
  const urls: string[] = [];
  const read = (url: string) => {
    const f = files[url];
    if (!f) throw new Error(`unexpected fetch ${url}`);
    urls.push(url);
    return readFileSync(new URL(`./fixtures/kochi/${f}`, import.meta.url));
  };
  return { urls, text: async (url) => read(url).toString("utf8"), bytes: async (url) => read(url) };
}

test("runKochi: 会期の PDF を読み、会期ごとに件数・出典を返す。取得先はすべて公式ホスト", async () => {
  const f = fakeFetcher();
  const log: string[] = [];
  // フィクスチャに置いた 2 会期（令和8年6月・令和7年6月）だけを読む
  const run = await runKochi({ sessions: 1, fetchedAt: "2026-08-24T00:00:00.000Z", fetcher: f, log: (l) => log.push(l) });
  assert.equal(run.roster.members.length, 36);
  assert.equal(run.roster.asOf, "2026-07-30");
  assert.deepEqual(run.sessions.map((s) => [s.sessionId, s.sessionLabel, s.rollcalls, s.unknownCells, s.pdfUrl]), [
    ["2026-06", "令和８年６月定例会", 23, 0, `${origin}/_files/00156424/0806.pdf`],
  ]);
  assert.equal(run.rollCalls.length, 23);
  assert.deepEqual(run.unmatched, []);
  assert.equal(run.sources[0].name, "高知県議会 議員名簿（会派別）");
  assert.equal(run.sources[0].url, `${origin}/member/categories/`);
  assert.equal(run.sources[1].url, `${origin}/activity/decision.html`);
  assert.ok(run.sources.some((s) => s.url === `${origin}/_files/00156424/0806.pdf`));
  assert.ok(run.sources.every((s) => s.fetchedAt === "2026-08-24T00:00:00.000Z"));
  // 取得順: 名簿 → index → PDF。すべて公式ホスト。同じ URL は 1 回
  assert.equal(f.urls[0], `${origin}/member/categories/`);
  assert.equal(f.urls[1], `${origin}/activity/decision.html`);
  assert.ok(f.urls.every((u) => u.startsWith(`${origin}/`)));
  assert.equal(new Set(f.urls).size, f.urls.length);
  assert.ok(log.some((l) => /roster: 36 members/.test(l)));
});

/**
 * 会期をまたぐテスト用の Fetcher。index は実物だが、フィクスチャに PDF を置いた 2 会期
 * （令和8年6月・令和7年6月）だけが並ぶように index の他の行を落とす
 * （全会期ぶんの PDF をリポジトリに置かないため。パーサの入力は実物のまま）。
 */
function twoSessionFetcher(): Fetcher & { urls: string[] } {
  const base = fakeFetcher();
  const keep = ["/_files/00156424/0806.pdf", "/_files/00141109/0706.pdf"];
  return {
    urls: base.urls,
    bytes: base.bytes,
    text: async (url) => {
      const html = await base.text(url);
      if (!url.endsWith("/activity/decision.html")) return html;
      return html.replace(/<a [^>]*href="(\/_files\/[^"]*\.pdf)"[^>]*>[^<]*<\/a>/g, (tag, href: string) => (keep.includes(href) ? tag : ""));
    },
  };
}

test("runKochi: 会期をまたいで読める（表決時点の会派・顔ぶれは会期ごとに PDF から）", async () => {
  const run = await runKochi({ sessions: 2, fetchedAt: "2026-08-24T00:00:00.000Z", fetcher: twoSessionFetcher() });
  assert.equal(run.sessions.length, 2);
  assert.deepEqual(run.sessions.map((s) => s.sessionId), ["2026-06", "2025-06"]);
  assert.equal(run.rollCalls.length, 23 + 24);
  // 令和7年6月の PDF にだけ居る議員（武石利彦・田所裕介・橋本敏男）は今の名簿に無いので unmatched に出る
  const names = run.unmatched.map((u) => u.nameText).sort();
  assert.deepEqual(names, ["武石利彦", "橋本敏男", "田所裕介"].sort());
  for (const u of run.unmatched) assert.ok(u.rollCallIds.length > 0);
});

test("runKochi + buildLocalAssembly + writeLocalAssembly: 契約どおりに書けて validateLocalAssemblies の違反 0", async () => {
  const run = await runKochi({ sessions: 2, fetchedAt: "2026-08-24T00:00:00.000Z", fetcher: twoSessionFetcher() });
  const built = buildLocalAssembly({
    assembly: KOCHI_ASSEMBLY, members: run.roster.members, rollCalls: run.rollCalls, fetchedAt: "2026-08-24T00:00:00.000Z",
    rosterAsOf: run.roster.asOf, sources: run.sources, sessions: run.sessions, unmatched: run.unmatched,
  });
  assert.equal(built.meta.counts.members, 36);
  assert.equal(built.meta.counts.rollcalls, 47);
  assert.equal(built.meta.counts.unknownCells, 0);
  assert.deepEqual(built.sessions.map((s) => [s.id, s.label, s.date, s.rollcalls]), [
    ["2026-06", "令和８年６月定例会", "2026-07-10", 23],
    ["2025-06", "令和７年６月定例会", "2025-06-27", 24],
  ]);
  const dir = await mkdtemp(join(tmpdir(), "gikailog-kochi-"));
  await writeLocalAssembly(dir, built);
  assert.deepEqual(await validateLocalAssemblies(dir), []);
  // 表決の原本に一次資料（PDF）の URL が入る
  const rc = JSON.parse(readFileSync(join(dir, "assemblies", "pref-39", "rollcalls", "2026-06", "pref-39-2026-06-20260710-知事提出議案-第1号.json"), "utf8"));
  assert.equal(rc.title, "令和８年度高知県一般会計予算");
  assert.equal(rc.result, "原案可決");
  assert.equal(rc.sourceUrl, `${origin}/_files/00156424/0806.pdf`);
  assert.equal(rc.votes.length, 36);
  assert.deepEqual(rc.votes[0].value, { legend: "賛成", mapped: "賛成", raw: "○" });
  assert.ok(!("method" in rc));
});
