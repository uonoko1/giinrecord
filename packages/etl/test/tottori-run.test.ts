import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalUnmatchedName } from "@seiji-kiroku/shared";
import { runTottori, type Fetcher } from "../src/sources/local/tottori/index.ts";
import { TOTTORI_ASSEMBLY } from "../src/sources/local/tottori/site.ts";
import { buildLocalAssembly, validateLocalAssemblies, writeLocalAssembly } from "../src/local-assemblies.ts";
import { stableJson } from "../src/json.ts";

// 鳥取県議会 ETL の取得部（Issue #184）: 名簿 → 会期 index → 会期ページ → 議決結果ページ → 賛否 PDF。
// HTTP は境界なので、フィクスチャ（2026-08-24 取得）を返す Fetcher を差し込む。取得先 URL はすべて県の公式ホスト。
const origin = "https://www.pref.tottori.lg.jp";
const files: Record<string, string> = {
  [`${origin}/75928.htm`]: "75928.htm",
  [`${origin}/87621.htm`]: "87621.htm",
  [`${origin}/329482.htm`]: "329482.htm",
  [`${origin}/328133.htm`]: "328133.htm",
  [`${origin}/328150.htm`]: "328150.htm",
  [`${origin}/326488.htm`]: "326488.htm",
  [`${origin}/326506.htm`]: "326506.htm",
  [`${origin}/secure/1422217/R8.6giketsukekka0629.pdf`]: "R8.6giketsukekka0629.pdf",
  [`${origin}/secure/1422215/r8.6.29giketsukekka.pdf`]: "R8.6.29_giinteishutsugian_giketsukekka.pdf",
  [`${origin}/secure/1422215/R8.6.29%20giinteishutsugian_giketsukekka.pdf`]: "R8.6.29_giinteishutsugian_giketsukekka.pdf",
  [`${origin}/secure/1422216/R8.6.29_seiganchinjogiketsukekka.pdf`]: "R8.6.29_seiganchinjogiketsukekka.pdf",
  [`${origin}/secure/1412313/R0802sengikekka.pdf`]: "R0802sengikekka.pdf",
  [`${origin}/secure/1412311/R8.2giketsukekka0325.pdf`]: "R8.2giketsukekka0325.pdf",
  [`${origin}/secure/1412309/R8.2giketsukekka0325.pdf`]: "R8.2giketsukekka0325.pdf",
  [`${origin}/secure/1412310/R8.2giketsukekka0325.pdf`]: "R8.2giketsukekka0325.pdf",
};
function fakeFetcher(): Fetcher & { urls: string[] } {
  const urls: string[] = [];
  const read = (url: string) => {
    const f = files[url];
    if (!f) throw new Error(`unexpected fetch ${url}`);
    urls.push(url);
    return readFileSync(new URL(`./fixtures/tottori/${f}`, import.meta.url));
  };
  return { urls, text: async (url) => read(url).toString("utf8"), bytes: async (url) => read(url) };
}

test("runTottori: 直近 2 会期（議決結果ページの無い 9月定例会は飛ばす）の PDF を全部読み、会期ごとに件数・出典を返す", async () => {
  const f = fakeFetcher();
  const log: string[] = [];
  const run = await runTottori({ sessions: 2, fetchedAt: "2026-08-24T00:00:00.000Z", fetcher: f, log: (l) => log.push(l) });
  assert.equal(run.roster.members.length, 35);
  assert.equal(run.roster.asOf, "2023-04-30");
  assert.deepEqual(run.sessions.map((s) => [s.sessionId, s.sessionLabel, s.rollcalls, s.unknownCells, s.sourceUrl]), [
    ["2026-06", "令和8年6月定例会", 30, 0, `${origin}/328150.htm`],
    ["2026-02", "令和8年2月定例会", 88, 0, `${origin}/326506.htm`],
  ]);
  // meta.sessions の pdfUrl は最初の PDF（型は 1 本）。全 PDF は sources に並ぶ
  assert.equal(run.sessions[0].pdfUrl, `${origin}/secure/1422217/R8.6giketsukekka0629.pdf`);
  assert.equal(run.rollCalls.length, 118);
  assert.equal(run.unmatched.length, 0);
  assert.equal(run.sources[0].name, "鳥取県議会 議員名簿（五十音順）");
  assert.equal(run.sources[1].url, `${origin}/87621.htm`);
  assert.ok(run.sources.some((s) => s.url === `${origin}/secure/1422216/R8.6.29_seiganchinjogiketsukekka.pdf` && s.name.includes("令和8年6月定例会")));
  assert.ok(run.sources.some((s) => s.url === `${origin}/secure/1412313/R0802sengikekka.pdf`));
  assert.ok(run.sources.every((s) => s.fetchedAt === "2026-08-24T00:00:00.000Z"));
  // 取得順: 名簿 → index → 会期ページ（9月・6月・2月）→ 議決結果ページ → PDF。すべて公式ホスト。同じ URL は 1 回
  assert.equal(f.urls[0], `${origin}/75928.htm`);
  assert.equal(f.urls[1], `${origin}/87621.htm`);
  assert.ok(f.urls.includes(`${origin}/329482.htm`), "9月定例会の会期ページも見る（議決結果リンクが無いので飛ばす）");
  assert.ok(f.urls.every((u) => u.startsWith(`${origin}/`)));
  assert.equal(new Set(f.urls).size, f.urls.length);
  assert.ok(log.some((l) => /令和8年9月定例会/.test(l) && /skip|no 議決結果/.test(l)));
});

test("runTottori + buildLocalAssembly + writeLocalAssembly: 契約どおりに書けて validateLocalAssemblies の違反 0。unmatched の候補も残る", async () => {
  const run = await runTottori({ sessions: 1, fetchedAt: "2026-08-24T00:00:00.000Z", fetcher: fakeFetcher() });
  // 候補が残ることを見るため、1 人を姓だけにする（名簿には 浜田 が 2 人）
  for (const rc of run.rollCalls) {
    const v = rc.votes.find((x) => x.nameText === "浜田一議員")!;
    v.nameText = "浜田議員";
    v.memberId = "";
  }
  const unmatched: LocalUnmatchedName[] = [{ nameText: "浜田議員", group: "自由民主党", rollCallIds: run.rollCalls.map((r) => r.id), candidates: [{ id: "p_31_item_1165923", name: "浜田 一哉" }, { id: "p_31_item_1165924", name: "浜田 妙子" }] }];
  const built = buildLocalAssembly({
    assembly: TOTTORI_ASSEMBLY, members: run.roster.members, rollCalls: run.rollCalls, fetchedAt: "2026-08-24T00:00:00.000Z",
    rosterAsOf: run.roster.asOf, sources: run.sources, sessions: run.sessions, unmatched,
  });
  assert.deepEqual(built.unmatched, [{ nameText: "浜田議員", group: "自由民主党", rollCallIds: run.rollCalls.map((r) => r.id).sort(), candidates: unmatched[0].candidates }]);
  assert.equal(built.meta.counts.members, 35);
  assert.equal(built.meta.counts.rollcalls, 30);
  assert.equal(built.meta.counts.cells, 30 * 35);
  assert.equal(built.meta.counts.unmatchedNames, 1);
  assert.deepEqual(built.sessions.map((s) => [s.id, s.date, s.rollcalls]), [["2026-06", "2026-06-29", 30]]);
  assert.equal(built.details.find((d) => d.id === "p_31_item_1165923")!.counts.rollcalls, 0, "姓だけで決められない人には票を付けない");
  assert.equal(built.details.find((d) => d.id === "p_31_item_967688")!.counts.rollcalls, 30);
  const dir = await mkdtemp(join(tmpdir(), "giinrecord-tottori-"));
  await writeLocalAssembly(dir, built);
  assert.deepEqual(await validateLocalAssemblies(dir), []);
  const rc = JSON.parse(readFileSync(join(dir, "assemblies", "pref-31", "rollcalls", "2026-06", "pref-31-2026-06-20260629-陳情-7年-11.json"), "utf8"));
  assert.equal(rc.voteSubject, "委員長報告に対する賛否");
  assert.equal(rc.committeeReport, "研究留保");
  assert.ok(!("present" in rc.counts));
  // 不変条件: voteSubject / committeeReport は空でない文字列、unmatched の候補は名簿の id
  const rcPath = join(dir, "assemblies", "pref-31", "rollcalls", "2026-06", "pref-31-2026-06-20260629-陳情-7年-11.json");
  await writeFile(rcPath, stableJson({ ...rc, voteSubject: "" }));
  assert.ok((await validateLocalAssemblies(dir)).some((x) => /voteSubject/.test(x)));
  await writeFile(rcPath, stableJson(rc));
  const unmatchedPath = join(dir, "assemblies", "pref-31", "unmatched.json");
  await writeFile(unmatchedPath, stableJson([{ ...built.unmatched[0], candidates: [{ id: "p_31_item_nobody", name: "誰" }] }]));
  assert.ok((await validateLocalAssemblies(dir)).some((x) => /candidate p_31_item_nobody/.test(x)));
  await writeFile(unmatchedPath, stableJson([{ ...built.unmatched[0], candidates: [] }]));
  assert.ok((await validateLocalAssemblies(dir)).some((x) => /candidates must be a non-empty array/.test(x)));
});
