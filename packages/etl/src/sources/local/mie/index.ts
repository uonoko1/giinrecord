import type { LocalAssemblyMeta, LocalRollCall, LocalUnmatchedName } from "@seiji-kiroku/shared";
import { PoliteFetcher } from "../polite-fetch.ts";
import { MIE_HOST, MIE_ROSTER_INDEX_URL } from "./site.ts";
import { buildRoster, DISTRICT_INDEX_URL, GOJUON_URL, parseDistrictIndex, parseDistrictPage, parseGojuon, type Roster } from "./roster.ts";
import { parseSessionIndex, SESSION_INDEX_URL } from "./sessions.ts";
import { parseVotePdf } from "./votes-pdf.ts";
import { toLocalRollCalls } from "./rollcalls.ts";

/**
 * 三重県議会 ETL の取得部（Issue #203）。名簿（５０音順 → 選挙区 index → 15 選挙区ページ）→ 議案審議結果一覧（1 ページに全会期）
 * → 直近 N 会期（通年議会。年 1 会期が基本）の月別の賛否 PDF。
 * 取得先は県の公式ホストだけ（PoliteFetcher。UA 明記・1 秒以上間隔・robots.txt 遵守）。PDF はキャッシュ、HTML は毎回取得。
 */
export interface Fetcher {
  text(url: string): Promise<string>;
  bytes(url: string): Promise<Buffer>;
}

export interface MieRun {
  roster: Roster;
  rollCalls: LocalRollCall[];
  unmatched: LocalUnmatchedName[];
  sessions: LocalAssemblyMeta["sessions"];
  sources: LocalAssemblyMeta["sources"];
  /** 会期ごとの PDF 解析の要約（ログ用） */
  summary: { sessionId: string; sessionLabel: string; members: number; rows: number; unknownCells: number; pdfUrls: string[] }[];
}

export async function runMie(opts: { sessions: number; fetchedAt: string; fetcher?: Fetcher; log?: (line: string) => void }): Promise<MieRun> {
  const log = opts.log ?? (() => {});
  const f: Fetcher = opts.fetcher ?? new PoliteFetcher(MIE_HOST);
  const gojuon = parseGojuon(await f.text(GOJUON_URL));
  const links = parseDistrictIndex(await f.text(DISTRICT_INDEX_URL), DISTRICT_INDEX_URL);
  const pages = [];
  for (const l of links) pages.push(parseDistrictPage(await f.text(l.url), l.url));
  const roster = buildRoster(gojuon, links, pages);
  log(`roster: ${roster.members.length} members (定数 ${roster.seats}, as of ${roster.asOf}, ${links.length} district pages)`);

  const index = parseSessionIndex(await f.text(SESSION_INDEX_URL), SESSION_INDEX_URL);
  const targets = index.slice(0, opts.sessions);
  if (targets.length < opts.sessions) throw new Error(`only ${targets.length} sessions found (wanted ${opts.sessions})`);
  log(`sessions: ${targets.map((s) => `${s.sessionId}（${s.sessionLabel}）`).join(" / ")}`);

  const rollCalls: LocalRollCall[] = [];
  const unmatched = new Map<string, LocalUnmatchedName>();
  const sessions: LocalAssemblyMeta["sessions"] = [];
  const summary: MieRun["summary"] = [];
  const pdfSources: LocalAssemblyMeta["sources"] = [];
  for (const s of targets) {
    let rows = 0;
    let unknownCells = 0;
    let members = 0;
    for (const link of s.pdfs) {
      const pdf = await parseVotePdf(await f.bytes(link.url));
      if (pdf.year !== s.year || pdf.month !== link.month) throw new Error(`${link.url}: PDF title says ${pdf.title} but the link says ${link.label}`);
      if (pdf.sessionName.normalize("NFKC") !== s.sessionLabel.normalize("NFKC")) throw new Error(`${link.url}: PDF title says ${pdf.sessionName} but the session is ${s.sessionLabel}`);
      const converted = toLocalRollCalls(pdf, roster.members, { sessionId: s.sessionId, sessionLabel: s.sessionLabel, pdfUrl: link.url });
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
      pdfSources.push({ name: `三重県議会 議員別の賛否等の状況（${s.sessionLabel}、${link.label}分）`, url: link.url, fetchedAt: opts.fetchedAt });
      log(`  ${s.sessionLabel} ${link.label}: ${converted.rollCalls.length} rows × ${pdf.members.length} members (${pdf.pages} pages), unknown cells ${pdf.unknownCells}, unmatched names ${converted.unmatched.length} (${link.url})`);
    }
    const pdfUrls = s.pdfs.map((p) => p.url);
    sessions.push({ sessionId: s.sessionId, sessionLabel: s.sessionLabel, sourceUrl: SESSION_INDEX_URL, pdfUrl: pdfUrls[0], pdfUrls, rollcalls: rows, unknownCells });
    summary.push({ sessionId: s.sessionId, sessionLabel: s.sessionLabel, members, rows, unknownCells, pdfUrls });
  }
  const sources: LocalAssemblyMeta["sources"] = [
    { name: "三重県議会 議員名簿（選挙区別５０音順）", url: GOJUON_URL, fetchedAt: opts.fetchedAt },
    { name: "三重県議会 選挙区別名簿", url: DISTRICT_INDEX_URL, fetchedAt: opts.fetchedAt },
    ...links.map((l) => ({ name: `三重県議会 議員の紹介（${l.district}選挙区）`, url: l.url, fetchedAt: opts.fetchedAt })),
    { name: "三重県議会 議案審議結果一覧", url: SESSION_INDEX_URL, fetchedAt: opts.fetchedAt },
    ...pdfSources,
  ];
  return { roster, rollCalls, unmatched: [...unmatched.values()], sessions, sources, summary };
}

export { MIE_ROSTER_INDEX_URL };
