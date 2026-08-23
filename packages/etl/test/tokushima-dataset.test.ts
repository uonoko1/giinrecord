import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalMemberDetail, LocalRollCall, AssemblySession } from "@seiji-kiroku/shared";
import { buildLocalAssembly, LOCAL_SOURCES, TOKUSHIMA_ASSEMBLY, validateLocalAssemblies, writeLocalAssembly } from "../src/local-assemblies.ts";
import { parseRoster } from "../src/sources/local/tokushima/roster.ts";
import { parseVotePdf } from "../src/sources/local/tokushima/votes-pdf.ts";
import { toLocalRollCalls } from "../src/sources/local/tokushima/rollcalls.ts";
import { jstDate } from "../src/sources/local/tokushima/index.ts";

// 徳島のフィクスチャ（名簿 2 ページ＋ 2 会期 4 PDF）を buildLocalAssembly → writeLocalAssembly → validateLocalAssemblies に通す（Issue #183）。
// 表決方法・人数の欄が無い議会でも契約（docs/DATA_CONTRACT.md「地方議会」）を満たすこと。
const html = (name: string) => readFileSync(new URL(`./fixtures/tokushima/${name}`, import.meta.url), "utf8");
const bytes = (name: string) => readFileSync(new URL(`./fixtures/tokushima/${name}`, import.meta.url));
const PDF = (id: string) => `https://www.pref.tokushima.lg.jp/file/attachment/${id}.pdf`;
const fetchedAt = "2026-08-24T01:20:00.000Z";
const roster = parseRoster({ kaihabetu: html("giin-kaihabetu.html"), senkyoku: html("giin-senkyoku.html") }, { asOf: jstDate(fetchedAt) });
const jun = { sessionId: "2026-06", sessionLabel: "令和8年6月定例会", sourceUrl: "https://www.pref.tokushima.lg.jp/gikai/honkaigi/r08/7314697/", pdfs: ["1064407"] };
const feb = { sessionId: "2026-02", sessionLabel: "令和8年2月定例会", sourceUrl: "https://www.pref.tokushima.lg.jp/gikai/honkaigi/r08/7310454/", pdfs: ["1036105", "1038136", "1042426"] };
const rollCalls: LocalRollCall[] = [];
const sessions = [];
for (const s of [jun, feb]) {
  let rows = 0;
  let unknownCells = 0;
  for (const id of s.pdfs) {
    const pdf = await parseVotePdf(bytes(`${id}.pdf`));
    const converted = toLocalRollCalls(pdf, roster.members, { sessionId: s.sessionId, sessionLabel: s.sessionLabel, pdfUrl: PDF(id) });
    rollCalls.push(...converted.rollCalls);
    rows += converted.rollCalls.length;
    unknownCells += pdf.unknownCells;
  }
  sessions.push({ sessionId: s.sessionId, sessionLabel: s.sessionLabel, sourceUrl: s.sourceUrl, pdfUrl: PDF(s.pdfs[0]), pdfUrls: s.pdfs.map(PDF), rollcalls: rows, unknownCells });
}
const built = buildLocalAssembly({ assembly: TOKUSHIMA_ASSEMBLY, members: roster.members, rollCalls, fetchedAt, rosterAsOf: roster.asOf, sources: [], sessions });

test("LOCAL_SOURCES: pnpm etl:local tokushima が pref-36（徳島県議会）を指す", () => {
  assert.equal(LOCAL_SOURCES.tokushima.assembly, TOKUSHIMA_ASSEMBLY);
  assert.deepEqual(TOKUSHIMA_ASSEMBLY, { id: "pref-36", kind: "prefectural", name: "徳島県議会", prefCode: "36", sourceUrl: "https://www.pref.tokushima.lg.jp/gikai/giin/" });
  assert.equal(jstDate("2026-08-23T16:20:00.000Z"), "2026-08-24"); // JST の日付
});

test("buildLocalAssembly（徳島）: 2 会期 105 採決、36 人全員に timeline、不明セル 0、未突合 0。timeline の行に method は無く result はある", () => {
  assert.equal(built.meta.counts.rollcalls, 105);
  assert.equal(built.meta.counts.members, 36);
  assert.equal(built.meta.counts.cells, 105 * 36);
  assert.equal(built.meta.counts.unknownCells, 0);
  assert.equal(built.meta.counts.unmatchedNames, 0);
  assert.deepEqual(built.sessions.map((s: AssemblySession) => [s.id, s.label, s.date, s.rollcalls]), [["2026-06", "令和8年6月定例会", "2026-07-03", 20], ["2026-02", "令和8年2月定例会", "2026-03-11", 85]]);
  const kami = built.details.find((d) => d.id === "p_36_kami")!;
  assert.equal(kami.counts.rollcalls, 105);
  assert.deepEqual(kami.terms, [{ group: "徳島県議会自由民主党", district: "阿南選挙区", asOf: "2026-08-24" }]);
  const entry = kami.timeline[0];
  assert.equal(entry.kind, "localVote");
  assert.equal(entry.date, "2026-07-03");
  assert.equal(entry.sessionLabel, "令和8年6月定例会");
  assert.equal(entry.method, undefined);
  assert.equal(entry.result, "可決");
  assert.deepEqual(entry.vote, { raw: "○", legend: "委員会審査結果又は議長宣告に起立（賛成）した者" }); // ○ は委員会審査結果への起立なので mapped 無し
  // 会派で割れた採決（2月20日 動議）: ● は mapped 無しで raw と legend だけ
  const motion = kami.timeline.find((e) => e.rollCallId === "pref-36-2026-02-20260220-動議-無番号1")!;
  assert.deepEqual(motion.vote, { raw: "●", legend: "委員会審査結果又は議長宣告に起立しなかった者" });
  assert.equal(motion.result, "否決");
});

test("writeLocalAssembly + validateLocalAssemblies（徳島）: 契約違反なし。rollcalls/ の JSON に method は無く committeeResult がある。meta.sessions に pdfUrls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tokushima-"));
  await writeLocalAssembly(dir, built, { national: [] });
  assert.deepEqual(await validateLocalAssemblies(dir), []);
  const rc = JSON.parse(await readFile(join(dir, "assemblies/pref-36/rollcalls/2026-06/pref-36-2026-06-20260703-知事提出議案-第1号.json"), "utf8")) as LocalRollCall;
  assert.equal(rc.method, undefined);
  assert.equal(rc.counts, undefined);
  assert.equal(rc.committeeResult, "可決");
  assert.equal(rc.sourceUrl, PDF("1064407"));
  const detail = JSON.parse(await readFile(join(dir, "members/p_36_kami.json"), "utf8")) as LocalMemberDetail;
  assert.ok(!("method" in detail.timeline[0]));
  assert.ok(!("house" in detail));
  const meta = JSON.parse(await readFile(join(dir, "assemblies/pref-36/meta.json"), "utf8")) as { sessions: { pdfUrls?: string[] }[] };
  assert.deepEqual(meta.sessions[1].pdfUrls, [PDF("1036105"), PDF("1038136"), PDF("1042426")]);
});
