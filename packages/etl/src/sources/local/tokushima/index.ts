import type { LocalAssemblyMeta, LocalRollCall, LocalUnmatchedName } from "@seiji-kiroku/shared";
import { PoliteFetcher } from "../polite-fetch.ts";
import { TOKUSHIMA_HOST, TOKUSHIMA_ROSTER_INDEX_URL } from "./site.ts";
import { parseRoster, ROSTER_URLS, type Roster } from "./roster.ts";
import { parseSessionIndex, parseSessionPage, sessionIndexUrl, type SessionLink } from "./sessions.ts";
import { parseVotePdf } from "./votes-pdf.ts";
import { toLocalRollCalls } from "./rollcalls.ts";

/**
 * 徳島県議会 ETL の取得部（Issue #183）。議員紹介 2 ページ → 定例会の概要（今年。足りなければ前年の年ページ）→ 直近 N 会期の会期ページ → 採決日ごとの表決 PDF。
 * 取得先は県の公式ホストだけ。PDF はキャッシュ、HTML は毎回取得。
 * 名簿に掲載日が無いので as-of は取得日（JST）。
 */
export interface TokushimaRun {
  roster: Roster;
  rollCalls: LocalRollCall[];
  unmatched: LocalUnmatchedName[];
  sessions: LocalAssemblyMeta["sessions"];
  sources: LocalAssemblyMeta["sources"];
  summary: { sessionId: string; sessionLabel: string; members: number; rows: number; unknownCells: number; pdfUrls: string[] }[];
}

/** 取得日時（ISO, UTC）→ 日本時間の日付（ISO date）。 */
export const jstDate = (isoDateTime: string): string => new Date(new Date(isoDateTime).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

export async function runTokushima(opts: { sessions: number; fetchedAt: string; log?: (line: string) => void }): Promise<TokushimaRun> {
  const log = opts.log ?? (() => {});
  const f = new PoliteFetcher(TOKUSHIMA_HOST);
  const roster = parseRoster({ kaihabetu: await f.text(ROSTER_URLS.kaihabetu), senkyoku: await f.text(ROSTER_URLS.senkyoku) }, { asOf: jstDate(opts.fetchedAt) });
  log(`roster: ${roster.members.length} members (定数 ${roster.seats}, as of ${roster.asOf} = fetch date; the page has no 掲載日)`);

  // 会期 index: 今年のページから。N 会期に足りなければ前年の年ページへ（左ナビのリンク）
  const indexUrls: string[] = [];
  const targets: SessionLink[] = [];
  let url: string | undefined = sessionIndexUrl;
  while (url && targets.length < opts.sessions) {
    indexUrls.push(url);
    const index = parseSessionIndex(await f.text(url), url);
    targets.push(...index.sessions);
    url = index.previousYearUrl;
  }
  if (targets.length < opts.sessions) throw new Error(`only ${targets.length} sessions found (wanted ${opts.sessions})`);
  targets.length = opts.sessions;
  log(`sessions: ${targets.map((s) => s.sessionId).join(" / ")}`);

  const rollCalls: LocalRollCall[] = [];
  const unmatched = new Map<string, LocalUnmatchedName>();
  const sessions: LocalAssemblyMeta["sessions"] = [];
  const summary: TokushimaRun["summary"] = [];
  const pdfSources: LocalAssemblyMeta["sources"] = [];
  for (const s of targets) {
    const page = parseSessionPage(await f.text(s.url), s.url);
    const expectedId = `${page.year}-${String(page.month).padStart(2, "0")}`;
    if (expectedId !== s.sessionId) throw new Error(`${s.url}: page says ${page.sessionLabel} (${expectedId}) but index says ${s.sessionId}`);
    let rows = 0;
    let unknownCells = 0;
    let members = 0;
    for (const link of page.pdfs) {
      const pdf = await parseVotePdf(await f.bytes(link.url));
      const [, m, d] = pdf.date.split("-").map(Number);
      if (m !== link.month || d !== link.day) throw new Error(`${link.url}: PDF title says ${pdf.date} but the link says ${link.text}`);
      const converted = toLocalRollCalls(pdf, roster.members, { sessionId: s.sessionId, sessionLabel: page.sessionLabel, pdfUrl: link.url });
      rollCalls.push(...converted.rollCalls);
      for (const u of converted.unmatched) {
        const key = `${u.nameText}\t${u.group}`;
        const cur = unmatched.get(key) ?? { nameText: u.nameText, group: u.group, rollCallIds: [] };
        cur.rollCallIds.push(...u.rollCallIds);
        unmatched.set(key, cur);
      }
      rows += converted.rollCalls.length;
      unknownCells += pdf.unknownCells;
      members = pdf.members.length;
      pdfSources.push({ name: `徳島県議会 ${link.text}（${page.sessionLabel}）`, url: link.url, fetchedAt: opts.fetchedAt });
      log(`  ${page.sessionLabel} ${link.text}: ${converted.rollCalls.length} rows × ${pdf.members.length} members, unknown cells ${pdf.unknownCells}, unmatched names ${converted.unmatched.length} (${link.url})`);
    }
    const pdfUrls = page.pdfs.map((p) => p.url);
    sessions.push({ sessionId: s.sessionId, sessionLabel: page.sessionLabel, sourceUrl: s.url, pdfUrl: pdfUrls[0], pdfUrls, rollcalls: rows, unknownCells });
    summary.push({ sessionId: s.sessionId, sessionLabel: page.sessionLabel, members, rows, unknownCells, pdfUrls });
  }
  const sources: LocalAssemblyMeta["sources"] = [
    { name: "徳島県議会 会派別 議員紹介", url: ROSTER_URLS.kaihabetu, fetchedAt: opts.fetchedAt },
    { name: "徳島県議会 選挙区別 議員紹介", url: ROSTER_URLS.senkyoku, fetchedAt: opts.fetchedAt },
    ...indexUrls.map((u) => ({ name: "徳島県議会 定例会の概要", url: u, fetchedAt: opts.fetchedAt })),
    ...pdfSources,
  ];
  return { roster, rollCalls, unmatched: [...unmatched.values()], sessions, sources, summary };
}

export { TOKUSHIMA_ROSTER_INDEX_URL };
