import type { LocalAssemblyMeta, LocalMember, LocalRollCall, LocalUnmatchedName } from "@seiji-kiroku/shared";
import { PoliteFetcher } from "../polite-fetch.ts";
import { MIYAGI_HOST, MIYAGI_ROSTER_INDEX_URL } from "./site.ts";
import { parseRoster, ROSTER_URLS, type Roster } from "./roster.ts";
import { parseSessionIndex, parseSessionPage, sessionIndexUrl, type SessionLink } from "./sessions.ts";
import { parseVotePdf } from "./votes-pdf.ts";
import { toLocalRollCalls } from "./rollcalls.ts";

/**
 * 宮城県議会 ETL の取得部（Issue #157）。名簿 3 ページ → 会期 index → 直近 N 会期の会期ページ → 表決 PDF。
 * 取得先は県の公式ホストだけ。PDF はキャッシュ、HTML は毎回取得。
 */
export interface MiyagiRun {
  roster: Roster;
  rollCalls: LocalRollCall[];
  unmatched: LocalUnmatchedName[];
  sessions: LocalAssemblyMeta["sessions"];
  sources: LocalAssemblyMeta["sources"];
  /** 会期ごとの PDF 解析の要約（ログ用） */
  summary: { sessionId: string; sessionLabel: string; members: number; rows: number; unknownCells: number; pdfUrl: string }[];
}

export async function runMiyagi(opts: { sessions: number; fetchedAt: string; log?: (line: string) => void }): Promise<MiyagiRun> {
  const log = opts.log ?? (() => {});
  const f = new PoliteFetcher(MIYAGI_HOST);
  const roster = parseRoster({
    kaiha: await f.text(ROSTER_URLS.kaiha),
    kubetu: await f.text(ROSTER_URLS.kubetu),
    gojuuon: await f.text(ROSTER_URLS.gojuuon),
  });
  log(`roster: ${roster.members.length} members (as of ${roster.asOf}, vacancies ${roster.vacancies})`);

  const index = parseSessionIndex(await f.text(sessionIndexUrl), sessionIndexUrl);
  const targets: SessionLink[] = index.slice(0, opts.sessions);
  log(`sessions: ${targets.map((s) => `${s.sessionId}（${s.sessionLabel}）`).join(" / ")}`);

  const rollCalls: LocalRollCall[] = [];
  const unmatched = new Map<string, LocalUnmatchedName>();
  const sessions: LocalAssemblyMeta["sessions"] = [];
  const summary: MiyagiRun["summary"] = [];
  for (const s of targets) {
    const pdfUrl = s.kind === "pdf" ? s.url : parseSessionPage(await f.text(s.url), s.url).pdfUrl;
    const pdf = await parseVotePdf(await f.bytes(pdfUrl));
    if (pdf.sessionId !== s.sessionId) throw new Error(`${s.sessionLabel}: PDF says 第${pdf.sessionId}回`);
    const converted = toLocalRollCalls(pdf, roster.members, { sessionLabel: s.sessionLabel, pdfUrl });
    rollCalls.push(...converted.rollCalls);
    for (const u of converted.unmatched) {
      const key = `${u.nameText}\t${u.group}`;
      const cur = unmatched.get(key) ?? { nameText: u.nameText, group: u.group, rollCallIds: [] };
      cur.rollCallIds.push(...u.rollCallIds);
      unmatched.set(key, cur);
    }
    sessions.push({ sessionId: s.sessionId, sessionLabel: s.sessionLabel, sourceUrl: s.url, pdfUrl, rollcalls: pdf.rows.length, unknownCells: pdf.unknownCells });
    summary.push({ sessionId: s.sessionId, sessionLabel: s.sessionLabel, members: pdf.members.length, rows: pdf.rows.length, unknownCells: pdf.unknownCells, pdfUrl });
    log(`  ${s.sessionLabel}: ${pdf.rows.length} rows × ${pdf.members.length} members, unknown cells ${pdf.unknownCells}, unmatched names ${converted.unmatched.length} (${pdfUrl})`);
  }
  const sources: LocalAssemblyMeta["sources"] = [
    { name: "宮城県議会 議員名簿（会派別）", url: ROSTER_URLS.kaiha, fetchedAt: opts.fetchedAt },
    { name: "宮城県議会 議員名簿（選挙区別）", url: ROSTER_URLS.kubetu, fetchedAt: opts.fetchedAt },
    { name: "宮城県議会 議員名簿（五十音順）", url: ROSTER_URLS.gojuuon, fetchedAt: opts.fetchedAt },
    { name: "宮城県議会 過去の本会議情報", url: sessionIndexUrl, fetchedAt: opts.fetchedAt },
    ...sessions.map((s) => ({ name: `宮城県議会 各議員の表決状況（${s.sessionLabel}）`, url: s.pdfUrl, fetchedAt: opts.fetchedAt })),
  ];
  return { roster, rollCalls, unmatched: [...unmatched.values()], sessions, sources, summary };
}

export { MIYAGI_ROSTER_INDEX_URL };
export type { LocalMember };
