import type { LocalAssemblyMeta, LocalRollCall, LocalUnmatchedName } from "@seiji-kiroku/shared";
import { PoliteFetcher } from "../polite-fetch.ts";
import { TOTTORI_HOST, TOTTORI_ROSTER_URL } from "./site.ts";
import { parseRoster, type Roster } from "./roster.ts";
import { parseResultsPage, parseSessionIndex, parseSessionPage, SESSION_INDEX_URL, type SessionLink } from "./sessions.ts";
import { parseVotePdf } from "./votes-pdf.ts";
import { toLocalRollCalls, type PdfSource } from "./rollcalls.ts";

/**
 * 鳥取県議会 ETL の取得部（Issue #184）。名簿（1 ページ）→ 会期 index → 会期ページ →「議案等の議決結果」ページ → 賛否 PDF（会期に複数）。
 * 取得先は県の公式ホストだけ（PoliteFetcher。UA 明記・1 秒以上間隔・robots.txt 遵守）。PDF はキャッシュ、HTML は毎回取得。
 * 議決結果ページの無い会期（まだ会期中・議決前）は飛ばして、議決結果のある会期を新しい順に N 会期読む。
 */
export interface Fetcher {
  text(url: string): Promise<string>;
  bytes(url: string): Promise<Buffer>;
}

export interface TottoriRun {
  roster: Roster;
  rollCalls: LocalRollCall[];
  unmatched: LocalUnmatchedName[];
  sessions: LocalAssemblyMeta["sessions"];
  sources: LocalAssemblyMeta["sources"];
  /** 会期ごとの PDF 解析の要約（ログ用） */
  summary: { sessionId: string; sessionLabel: string; members: number; rows: number; unknownCells: number; pdfUrls: string[] }[];
}

export async function runTottori(opts: { sessions: number; fetchedAt: string; fetcher?: Fetcher; log?: (line: string) => void }): Promise<TottoriRun> {
  const log = opts.log ?? (() => {});
  const f: Fetcher = opts.fetcher ?? new PoliteFetcher(TOTTORI_HOST);
  const roster = parseRoster(await f.text(TOTTORI_ROSTER_URL));
  log(`roster: ${roster.members.length} members (as of ${roster.asOf})`);

  const index = parseSessionIndex(await f.text(SESSION_INDEX_URL), SESSION_INDEX_URL);
  const targets: { session: SessionLink; resultsUrl: string }[] = [];
  for (const s of index) {
    if (targets.length >= opts.sessions) break;
    const resultsUrl = parseSessionPage(await f.text(s.url), s.url);
    if (!resultsUrl) { log(`  ${s.sessionLabel}: no 議決結果 link yet (skip)`); continue; }
    targets.push({ session: s, resultsUrl });
  }
  if (targets.length === 0) throw new Error("no session with a 議決結果 page found");
  log(`sessions: ${targets.map((t) => `${t.session.sessionId}（${t.session.sessionLabel}）`).join(" / ")}`);

  const rollCalls: LocalRollCall[] = [];
  const unmatched = new Map<string, LocalUnmatchedName>();
  const sessions: LocalAssemblyMeta["sessions"] = [];
  const sources: LocalAssemblyMeta["sources"] = [
    { name: "鳥取県議会 議員名簿（五十音順）", url: TOTTORI_ROSTER_URL, fetchedAt: opts.fetchedAt },
    { name: "鳥取県議会 定例会・臨時会の概要", url: SESSION_INDEX_URL, fetchedAt: opts.fetchedAt },
  ];
  const summary: TottoriRun["summary"] = [];
  for (const { session, resultsUrl } of targets) {
    const results = parseResultsPage(await f.text(resultsUrl), resultsUrl);
    if (results.pdfUrls.length === 0) throw new Error(`${session.sessionLabel}: 議決結果 page ${resultsUrl} has no vote PDF links`);
    const pdfs: PdfSource[] = [];
    for (const pdfUrl of results.pdfUrls) pdfs.push({ pdf: await parseVotePdf(await f.bytes(pdfUrl)), pdfUrl });
    const converted = toLocalRollCalls(pdfs, roster.members, { sessionId: session.sessionId, sessionLabel: session.sessionLabel });
    rollCalls.push(...converted.rollCalls);
    for (const u of converted.unmatched) {
      const key = `${u.nameText}\t${u.group}`;
      const cur = unmatched.get(key) ?? { nameText: u.nameText, group: u.group, rollCallIds: [], ...(u.candidates ? { candidates: u.candidates } : {}) };
      cur.rollCallIds.push(...u.rollCallIds);
      unmatched.set(key, cur);
    }
    const unknownCells = pdfs.reduce((n, p) => n + p.pdf.unknownCells, 0);
    sessions.push({ sessionId: session.sessionId, sessionLabel: session.sessionLabel, sourceUrl: resultsUrl, pdfUrl: results.pdfUrls[0], rollcalls: converted.rollCalls.length, unknownCells });
    sources.push({ name: `鳥取県議会 議案等の議決結果（${session.sessionLabel}）`, url: resultsUrl, fetchedAt: opts.fetchedAt });
    for (const p of pdfs) sources.push({ name: `鳥取県議会 議決結果・議員別の賛否の状況（${session.sessionLabel}、${p.pdf.date}議決分）`, url: p.pdfUrl, fetchedAt: opts.fetchedAt });
    const members = pdfs[0].pdf.members.length;
    summary.push({ sessionId: session.sessionId, sessionLabel: session.sessionLabel, members, rows: converted.rollCalls.length, unknownCells, pdfUrls: results.pdfUrls });
    log(`  ${session.sessionLabel}: ${converted.rollCalls.length} roll calls × ${members} members from ${pdfs.length} PDFs, unknown cells ${unknownCells}, unmatched names ${converted.unmatched.length} (${resultsUrl})`);
  }
  return { roster, rollCalls, unmatched: [...unmatched.values()], sessions, sources, summary };
}
