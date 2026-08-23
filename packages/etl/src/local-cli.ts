import { fileURLToPath } from "node:url";
import { buildLocalAssembly, LOCAL_SOURCES, validateLocalAssemblies, writeLocalAssembly } from "./local-assemblies.ts";
import { DEFAULT_SESSIONS, dietAssemblies, readSessionsOnDisk } from "./dataset.ts";

/**
 * 地方議会 ETL（Issue #157 宮城、#183 徳島）。月次（.github/workflows/local-assemblies.yml）。国会の日次 ETL（cli.ts）・選挙区（districts-cli.ts）とは独立。
 *   議会ごとの取得部（LOCAL_SOURCES: 名簿 × 直近 N 会期の表決 PDF）
 *   → data/members/index.json のその議会の行と data/members/p_{prefCode}_*.json（Web の議員ページが読む。#158）、
 *     data/assemblies/{assemblyId}/{meta.json, sessions.json, rollcalls/, unmatched.json}、data/assemblies/index.json のその議会の行。
 * 推定しない: PDF のセルを確実に置けなければ「不明」（凡例「抽出不能」）として残し、件数をログと meta に出す。
 * 名簿に寄せられない氏名は memberId 空で unmatched.json に出す。凡例に無い値が出たら非 0 終了。
 * Usage: pnpm etl:local <miyagi|tokushima> [--sessions N]   (default N = 2)
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
const args = process.argv.slice(2);
const target = args[0] ?? "";
const sessionsArg = args.indexOf("--sessions");
const sessions = sessionsArg >= 0 ? Number(args[sessionsArg + 1]) : 2;
const source = Object.hasOwn(LOCAL_SOURCES, target) ? LOCAL_SOURCES[target] : undefined;
if (!source || !Number.isInteger(sessions) || sessions < 1) {
  console.error(`Usage: pnpm etl:local <${Object.keys(LOCAL_SOURCES).join("|")}> [--sessions N]`);
  process.exit(2);
}
const fetchedAt = new Date().toISOString();

const run = await source.run({ sessions, fetchedAt, log: (line) => console.log(line) });
const built = buildLocalAssembly({
  assembly: source.assembly,
  members: run.roster.members,
  rollCalls: run.rollCalls,
  fetchedAt,
  rosterAsOf: run.roster.asOf,
  sources: run.sources,
  sessions: run.sessions,
});
console.log(`rollcalls: ${built.meta.counts.rollcalls}, cells: ${built.meta.counts.cells}, unknown cells (kept as 不明, not guessed): ${built.meta.counts.unknownCells}`);
if (built.unmatched.length) {
  console.warn(`names in the PDF not in the roster (memberId left empty; see data/assemblies/${source.assembly.id}/unmatched.json): ${built.unmatched.length}`);
  for (const u of built.unmatched) console.warn(`  ${u.nameText}（${u.group}）: ${u.rollCallIds.length} roll calls`);
}
// assemblies/index.json に国会の 2 行が無ければ（日次 ETL がまだ #156 以降の形で走っていない）国会の行も補う
const national = dietAssemblies(Math.max(...DEFAULT_SESSIONS, ...(await readSessionsOnDisk(DATA))));
await writeLocalAssembly(DATA, built, { national });

const violations = await validateLocalAssemblies(DATA);
if (violations.length) {
  console.error(`local assembly contract violations: ${violations.length}`);
  for (const line of violations) console.error(`  ${line}`);
  process.exit(1);
}
console.log("done");
