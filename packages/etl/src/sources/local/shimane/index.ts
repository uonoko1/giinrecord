import type { LocalAssemblyMeta, LocalRollCall, LocalUnmatchedName } from "@seiji-kiroku/shared";
import { PoliteFetcher } from "../polite-fetch.ts";
import { SHIMANE_HOST, SHIMANE_ROSTER_URL } from "./site.ts";
import { DISTRICT_PAGES, parseDistrictIndex, parseRoster, type Roster } from "./roster.ts";
import { parseSessionIndex, parseSessionPage, SESSION_ARCHIVE_URL, SESSION_INDEX_URL } from "./sessions.ts";
import { parseResultsPdf, parseVotePdf, type ResultRow } from "./votes-pdf.ts";
import { toLocalRollCalls } from "./rollcalls.ts";

/**
 * 島根県議会 ETL の取得部（Issue #221）。
 *   名簿（選挙区別 index → 12 の選挙区ページ）
 *   → 会期 index（「最近の定例会の概要」＋「過去の定例会の概要」を合わせて新しい順）
 *   → 会期ページ →「議員別採決結果一覧」PDF（＋議決日を読むための「議決結果一覧」PDF）。
 * 取得先は県の公式ホストだけ（PoliteFetcher。UA 明記・1 秒以上間隔・robots.txt 遵守）。
 * 表決 PDF がまだ無い会期（会期中・議決前）は飛ばして、表決 PDF のある会期を新しい順に N 会期読む。
 */
export interface Fetcher {
  text(url: string): Promise<string>;
  bytes(url: string): Promise<Buffer>;
}

export interface ShimaneRun {
  roster: Roster;
  rollCalls: LocalRollCall[];
  unmatched: LocalUnmatchedName[];
  sessions: LocalAssemblyMeta["sessions"];
  sources: LocalAssemblyMeta["sources"];
  summary: { sessionId: string; sessionLabel: string; members: number; rows: number; unknownCells: number; pdfUrls: string[] }[];
}

/** 「議決結果一覧」PDF（議決日を読むためだけに使う）。同じ会期ページの「議員別採決結果一覧」の隣にある。 */
const RESULTS_PDF = (votePdfUrl: string): string => votePdfUrl.replace(/_giinbetu_kekka\.pdf$/, "_giketu_kekka.pdf");

export async function runShimane(opts: { sessions: number; fetchedAt: string; fetcher?: Fetcher; log?: (line: string) => void }): Promise<ShimaneRun> {
  const log = opts.log ?? (() => {});
  const f: Fetcher = opts.fetcher ?? new PoliteFetcher(SHIMANE_HOST);

  // 名簿: 選挙区 index → 12 の選挙区ページ
  const districts = parseDistrictIndex(await f.text(SHIMANE_ROSTER_URL), SHIMANE_ROSTER_URL);
  if (districts.length !== DISTRICT_PAGES.length) {
    throw new Error(`選挙区 index has ${districts.length} districts (expected ${DISTRICT_PAGES.length}); the roster pages changed`);
  }
  const pages: { district: string; url: string; html: string }[] = [];
  for (const d of districts) pages.push({ district: d.district, url: d.url, html: await f.text(d.url) });
  const roster = parseRoster(pages);
  log(`roster: ${roster.members.length} members in ${districts.length} districts (as of ${roster.asOf})`);

  // 会期: 「最近の定例会の概要」＋「過去の定例会の概要」を合わせて新しい順（同じ会期ページは 1 つに）
  const recent = parseSessionIndex(await f.text(SESSION_INDEX_URL), SESSION_INDEX_URL);
  const archived = parseSessionIndex(await f.text(SESSION_ARCHIVE_URL), SESSION_ARCHIVE_URL);
  const index = [...recent];
  for (const s of archived) if (!index.some((x) => x.url === s.url)) index.push(s);
  index.sort((a, b) => b.year * 100 + b.month - (a.year * 100 + a.month));

  const targets: { sessionId: string; sessionLabel: string; url: string; pdfUrls: string[] }[] = [];
  for (const s of index) {
    if (targets.length >= opts.sessions) break;
    const page = parseSessionPage(await f.text(s.url), s.url, { sessionLabel: s.sessionLabel });
    if (page.pdfUrls.length === 0) { log(`  ${s.sessionLabel}: no 議員別採決結果一覧 PDF yet (skip)`); continue; }
    targets.push({ sessionId: s.sessionId, sessionLabel: s.sessionLabel, url: s.url, pdfUrls: page.pdfUrls });
  }
  if (targets.length === 0) throw new Error("no session with a 議員別採決結果一覧 PDF found");
  log(`sessions: ${targets.map((t) => `${t.sessionId}（${t.sessionLabel}）`).join(" / ")}`);

  const rollCalls: LocalRollCall[] = [];
  const unmatched = new Map<string, LocalUnmatchedName>();
  const sessions: LocalAssemblyMeta["sessions"] = [];
  const sources: LocalAssemblyMeta["sources"] = [
    { name: "島根県議会 議員名簿（選挙区別）", url: SHIMANE_ROSTER_URL, fetchedAt: opts.fetchedAt },
    { name: "島根県議会 最近の定例会の概要", url: SESSION_INDEX_URL, fetchedAt: opts.fetchedAt },
    { name: "島根県議会 過去の定例会の概要", url: SESSION_ARCHIVE_URL, fetchedAt: opts.fetchedAt },
  ];
  const summary: ShimaneRun["summary"] = [];
  for (const t of targets) {
    const pdfUrl = t.pdfUrls[0];
    if (t.pdfUrls.length > 1) throw new Error(`${t.url}: expected 1 議員別採決結果一覧 PDF, got ${t.pdfUrls.length}`);
    const pdf = await parseVotePdf(await f.bytes(pdfUrl));
    // 議決日は議員別採決結果一覧に書かれていないので、同じ会期ページの「議決結果一覧」から読む
    const resultsUrl = RESULTS_PDF(pdfUrl);
    let results: Map<string, ResultRow>;
    try {
      results = await parseResultsPdf(await f.bytes(resultsUrl));
    } catch (e) {
      throw new Error(`${resultsUrl}: cannot read 議決結果一覧 (議決日 comes from it): ${e instanceof Error ? e.message : String(e)}`);
    }
    const dateList = [...results.values()].map((r) => r.date);
    if (dateList.length === 0) throw new Error(`${resultsUrl}: no 議決日 found`);
    const lastDate = dateList.reduce((a, b) => (a > b ? a : b));
    const converted = toLocalRollCalls([{ pdf, pdfUrl }], roster.members, { sessionId: t.sessionId, sessionLabel: t.sessionLabel }, { results, lastDate });
    rollCalls.push(...converted.rollCalls);
    for (const u of converted.unmatched) {
      const key = `${u.nameText}\t${u.group}`;
      const cur = unmatched.get(key) ?? { nameText: u.nameText, group: u.group, rollCallIds: [], ...(u.candidates ? { candidates: u.candidates } : {}) };
      cur.rollCallIds.push(...u.rollCallIds);
      unmatched.set(key, cur);
    }
    sessions.push({ sessionId: t.sessionId, sessionLabel: t.sessionLabel, sourceUrl: t.url, pdfUrl, rollcalls: converted.rollCalls.length, unknownCells: pdf.unknownCells });
    sources.push({ name: `島根県議会 ${t.sessionLabel}の概要`, url: t.url, fetchedAt: opts.fetchedAt });
    sources.push({ name: `島根県議会 議員別採決結果一覧（${t.sessionLabel}）`, url: pdfUrl, fetchedAt: opts.fetchedAt });
    sources.push({ name: `島根県議会 議決結果一覧（${t.sessionLabel}）`, url: resultsUrl, fetchedAt: opts.fetchedAt });
    summary.push({ sessionId: t.sessionId, sessionLabel: t.sessionLabel, members: pdf.members.length, rows: converted.rollCalls.length, unknownCells: pdf.unknownCells, pdfUrls: t.pdfUrls });
    log(`  ${t.sessionLabel}: ${converted.rollCalls.length} roll calls × ${pdf.members.length} members, unknown cells ${pdf.unknownCells}, unmatched names ${converted.unmatched.length} (${t.url})`);
  }
  return { roster, rollCalls, unmatched: [...unmatched.values()], sessions, sources, summary };
}
