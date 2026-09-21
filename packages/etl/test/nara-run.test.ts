import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNara, type Fetcher } from "../src/sources/local/nara/index.ts";
import { NARA_ASSEMBLY } from "../src/sources/local/nara/site.ts";
import { buildLocalAssembly, defaultSessionsFor, validateLocalAssemblies, writeLocalAssembly } from "../src/local-assemblies.ts";

// 奈良県議会 ETL の取得部（Issue #202）: 名簿（五十音順）→ 会期 index → 会期ページ → 議決日ごとの表決 PDF。
// HTTP は境界なので、フィクスチャ（2026-08-24 取得）を返す Fetcher を差し込む。取得先 URL はすべて県の公式ホスト。
const origin = "https://www.pref.nara.lg.jp";
const files: Record<string, string> = {
  [`${origin}/n161/52534.html`]: "52534.html",
  [`${origin}/n161/18579.html`]: "18579.html",
  [`${origin}/n161/p114029.html`]: "p114029.html",
  [`${origin}/n161/p114001.html`]: "p114001.html",
  // **#901 で `--sessions` の既定を 2 → 4 にしたので、3・4 会期目のページと PDF も要る**
  [`${origin}/n161/70511.html`]: "70511.html",
  [`${origin}/n161/70052.html`]: "70052.html",
  [`${origin}/documents/24098/20260702_giinbetsu_hyoketsu.pdf`]: "20260702_giinbetsu_hyoketsu.pdf",
  [`${origin}/documents/21459/20260325_giinbetsu_hyoketsu.pdf`]: "20260325_giinbetsu_hyoketsu.pdf",
  [`${origin}/documents/18768/20251215_giinbetsu_hyoketsu.pdf`]: "18768_20251215_giinbetsu_hyoketsu.pdf",
  [`${origin}/documents/18767/20251009_giinbetsu_hyoketsu.pdf`]: "18767_20251009_giinbetsu_hyoketsu.pdf",
  [`${origin}/documents/18767/20251024_giinbetsu_hyoketsu.pdf`]: "18767_20251024_giinbetsu_hyoketsu.pdf",
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

/**
 * **#901: 既定を 2 → 4 にしたので、既定のまま走らせた形を通しで固定する。**
 *
 * **`--sessions` を渡さない月次ワークフロー（`.github/workflows/local-assemblies.yml`）が実際に走る形。**
 * **`defaultSessionsFor("nara")` を直に渡している**ので、**既定を動かせばこのテストが動く**
 * （**数字を手で書き写した定数にすると、既定を変えても気づけない**）。
 */
test("#901 runNara: 既定（`--sessions 4`）で 4 会期 5 本・180 採決。3・4 会期目が増えても未突合 0・不明 0", async () => {
  const f = fakeFetcher();
  const run = await runNara({ sessions: defaultSessionsFor("nara"), fetchedAt: "2026-09-21T00:00:00.000Z", fetcher: f });
  assert.equal(defaultSessionsFor("nara"), 4, "既定（ここが動いたら下の数字も測り直すこと）");
  assert.deepEqual(run.sessions.map((s) => [s.sessionId, s.rollcalls, s.unknownCells, (s.pdfUrls ?? []).length]), [
    ["2026-06", 37, 0, 1],
    ["2026-02", 88, 0, 1],
    ["2025-12", 34, 0, 1],
    // **令和7年9月だけ PDF が 2 本**（議決日が 2 つ。`--sessions 2` の窓には 1 本の会期しか無かった）
    ["2025-09", 21, 0, 2],
  ]);
  assert.equal(run.rollCalls.length, 180);
  assert.equal(37 + 88 + 34 + 21, 180, "母数を式で残す");
  assert.deepEqual(run.unmatched, [], "**名簿に寄らなかった氏名**（増やしても 0 のまま）");
  assert.equal(run.rollCalls.reduce((n, r) => n + r.votes.length, 0), 7_200);
  assert.deepEqual([...new Set(run.rollCalls.map((r) => r.votes.length))], [40], "採決ごとの票数（合計だけ合う形を塞ぐ）");
  assert.deepEqual([...new Set(run.rollCalls.flatMap((r) => r.votes).map((v) => v.memberId === ""))], [false], "`memberId` が空の票");
  // **1 会期に 2 本ある会期で、2 本ぶんの採決が両方入っている**（`pdfUrls[0]` だけを読んでいたら 16 で止まる）
  assert.deepEqual(
    [...new Set(run.rollCalls.filter((r) => r.sessionId === "2025-09").map((r) => r.date))].sort(),
    ["2025-10-09", "2025-10-24"],
  );
  // **出典に 5 本すべての PDF が並ぶ**
  assert.equal(run.sources.filter((s) => s.url.endsWith(".pdf")).length, 5);
  assert.ok(f.urls.every((u) => u.startsWith(`${origin}/`)), "取得先はすべて公式ホスト");
});

test("#901 runNara(4) + buildLocalAssembly: 180 × 40 = 7,200 セル、契約違反 0", async () => {
  const run = await runNara({ sessions: defaultSessionsFor("nara"), fetchedAt: "2026-09-21T00:00:00.000Z", fetcher: fakeFetcher() });
  const built = buildLocalAssembly({
    assembly: NARA_ASSEMBLY, members: run.roster.members, rollCalls: run.rollCalls, fetchedAt: "2026-09-21T00:00:00.000Z",
    rosterAsOf: run.roster.asOf, sources: run.sources, sessions: run.sessions, unmatched: run.unmatched,
  });
  assert.deepEqual(built.meta.counts, { members: 40, rollcalls: 180, cells: 7_200, unknownCells: 0, unmatchedNames: 0 });
  assert.equal(180 * 40, 7_200, "母数を式で残す");
  assert.deepEqual(built.sessions.map((s) => [s.id, s.date, s.rollcalls]), [
    ["2026-06", "2026-07-02", 37],
    ["2026-02", "2026-03-25", 88],
    ["2025-12", "2025-12-15", 34],
    // **2 本ある会期の `date` は新しいほうの議決日**（`sessions.json` の契約）
    ["2025-09", "2025-10-24", 21],
  ]);
  // **40 人全員が 180 本すべてに出る**（1 人でも落ちれば合計は合っても、ここが落ちる）
  assert.deepEqual([...new Set(built.details.map((d) => d.counts.rollcalls))], [180]);
  // **字が落ちたまま寄った氏名**（#750 の欄）。**`西川` は 125 → 180 に増え、`芦高 清友` は 37 のまま。**
  // **増えたのは「新しい欠落が起きた」ではなく「同じ欠落が続く本が増えた」**——
  // **増えた 3 本では `芦󠄀髙清友` と IVS 付きで書かれており、`髙`/`高` の字形だけが違う**
  // （`lossyNameMatchesOf` は `nameText` ごとに数えるので、`芦󠄀髙清友` は「落ちていない」側に入る）。
  assert.deepEqual(
    (built.meta.lossyNameMatches ?? []).map((l) => [l.nameText, l.rosterName, l.rollCalls]).sort(),
    [["西川", "西川 均", 180], ["髙清友", "芦高 清友", 37]],
  );
  const dir = await mkdtemp(join(tmpdir(), "giinrecord-nara4-"));
  await writeLocalAssembly(dir, built);
  assert.deepEqual(await validateLocalAssemblies(dir), [], "**#928 の名簿の窓も含めて違反 0**");
});
