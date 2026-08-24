import type { LocalAssemblyMeta, LocalRollCall, LocalUnmatchedName } from "@seiji-kiroku/shared";
import { PoliteFetcher } from "../polite-fetch.ts";
import { NARA_HOST, NARA_ROSTER_URL } from "./site.ts";
import { parseRoster, type Roster } from "./roster.ts";
import { parseSessionIndex, parseSessionPage, SESSION_INDEX_URL } from "./sessions.ts";
import { parseVotePdf } from "./votes-pdf.ts";
import { toLocalRollCalls, type PdfSource } from "./rollcalls.ts";

/**
 * 奈良県議会 ETL の取得部（Issue #202）。名簿（五十音順、1 ページ）→ 会期 index →「…定例会の概要」ページ →
 * 議決日ごとの「議員別の議案等に対する表決結果」PDF。
 * 取得先は県の公式ホストだけ（PoliteFetcher。UA 明記・1 秒以上間隔・robots.txt 遵守）。PDF はキャッシュ、HTML は毎回取得。
 * 表決 PDF がまだ無い会期（会期中・議決前）は飛ばして、表決 PDF のある会期を新しい順に N 会期読む。
 */
export interface Fetcher {
  text(url: string): Promise<string>;
  bytes(url: string): Promise<Buffer>;
}

export interface NaraRun {
  roster: Roster;
  rollCalls: LocalRollCall[];
  unmatched: LocalUnmatchedName[];
  sessions: LocalAssemblyMeta["sessions"];
  sources: LocalAssemblyMeta["sources"];
  /** 会期ごとの PDF 解析の要約（ログ用） */
  summary: { sessionId: string; sessionLabel: string; members: number; rows: number; unknownCells: number; pdfUrls: string[] }[];
}

export async function runNara(opts: { sessions: number; fetchedAt: string; fetcher?: Fetcher; log?: (line: string) => void }): Promise<NaraRun> {
  const log = opts.log ?? (() => {});
  const f: Fetcher = opts.fetcher ?? new PoliteFetcher(NARA_HOST);
  const roster = parseRoster(await f.text(NARA_ROSTER_URL));
  log(`roster: ${roster.members.length} members (as of ${roster.asOf})`);

  const index = parseSessionIndex(await f.text(SESSION_INDEX_URL), SESSION_INDEX_URL);
  const targets: { sessionId: string; sessionLabel: string; url: string; pdfUrls: string[] }[] = [];
  for (const s of index) {
    if (targets.length >= opts.sessions) break;
    const page = parseSessionPage(await f.text(s.url), s.url, { sessionLabel: s.sessionLabel });
    if (page.pdfUrls.length === 0) { log(`  ${s.sessionLabel}: no 議員別の議案等に対する表決結果 PDF yet (skip)`); continue; }
    targets.push({ sessionId: s.sessionId, sessionLabel: s.sessionLabel, url: s.url, pdfUrls: page.pdfUrls });
  }
  if (targets.length === 0) throw new Error("no session with a 議員別の議案等に対する表決結果 PDF found");
  log(`sessions: ${targets.map((t) => `${t.sessionId}（${t.sessionLabel}）`).join(" / ")}`);

  const rollCalls: LocalRollCall[] = [];
  const unmatched = new Map<string, LocalUnmatchedName>();
  const sessions: LocalAssemblyMeta["sessions"] = [];
  const sources: LocalAssemblyMeta["sources"] = [
    { name: "奈良県議会 議員名簿（五十音順）", url: NARA_ROSTER_URL, fetchedAt: opts.fetchedAt },
    { name: "奈良県議会 定例（臨時）県議会の概要", url: SESSION_INDEX_URL, fetchedAt: opts.fetchedAt },
  ];
  const summary: NaraRun["summary"] = [];
  for (const t of targets) {
    const pdfs: PdfSource[] = [];
    for (const pdfUrl of t.pdfUrls) pdfs.push({ pdf: await parseVotePdf(await f.bytes(pdfUrl)), pdfUrl });
    const converted = toLocalRollCalls(pdfs, roster.members, { sessionId: t.sessionId, sessionLabel: t.sessionLabel });
    rollCalls.push(...converted.rollCalls);
    for (const u of converted.unmatched) {
      const key = `${u.nameText}\t${u.group}`;
      const cur = unmatched.get(key) ?? { nameText: u.nameText, group: u.group, rollCallIds: [], ...(u.candidates ? { candidates: u.candidates } : {}) };
      cur.rollCallIds.push(...u.rollCallIds);
      unmatched.set(key, cur);
    }
    const unknownCells = pdfs.reduce((n, p) => n + p.pdf.unknownCells, 0);
    sessions.push({ sessionId: t.sessionId, sessionLabel: t.sessionLabel, sourceUrl: t.url, pdfUrl: t.pdfUrls[0], pdfUrls: t.pdfUrls, rollcalls: converted.rollCalls.length, unknownCells });
    sources.push({ name: `奈良県議会 ${t.sessionLabel}の概要`, url: t.url, fetchedAt: opts.fetchedAt });
    for (const p of pdfs) sources.push({ name: `奈良県議会 議員別の議案等に対する表決結果（${t.sessionLabel} ${p.pdf.date}議決分）`, url: p.pdfUrl, fetchedAt: opts.fetchedAt });
    const members = pdfs[0].pdf.members.length;
    summary.push({ sessionId: t.sessionId, sessionLabel: t.sessionLabel, members, rows: converted.rollCalls.length, unknownCells, pdfUrls: t.pdfUrls });
    log(`  ${t.sessionLabel}: ${converted.rollCalls.length} roll calls × ${members} members from ${pdfs.length} PDFs, unknown cells ${unknownCells}, unmatched names ${converted.unmatched.length} (${t.url})`);
  }
  return { roster, rollCalls, unmatched: [...unmatched.values()], sessions, sources, summary };
}
