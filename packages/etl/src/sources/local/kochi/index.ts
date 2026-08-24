import type { LocalAssemblyMeta, LocalRollCall, LocalUnmatchedName } from "@seiji-kiroku/shared";
import { PoliteFetcher } from "../polite-fetch.ts";
import { KOCHI_HOST, KOCHI_ROSTER_URL } from "./site.ts";
import { parseRoster, type Roster } from "./roster.ts";
import { parseSessionIndex, DECISION_URL } from "./sessions.ts";
import { parseVotePdf } from "./votes-pdf.ts";
import { toLocalRollCalls, type PdfSource } from "./rollcalls.ts";

/**
 * 高知県議会 ETL の取得部（Issue #220）。名簿（会派別、1 ページ）→「議員別賛否の状況」index →
 * 会期ごとの「議決結果一覧」PDF。奈良・三重と違って会期ごとの中間ページは無い。
 * 取得先は県議会の公式ホストだけ（PoliteFetcher。UA 明記・1 秒以上間隔・robots.txt 遵守）。
 * PDF はキャッシュ、HTML は毎回取得。index の新しい順に N 会期読む。
 */
export interface Fetcher {
  text(url: string): Promise<string>;
  bytes(url: string): Promise<Buffer>;
}

export interface KochiRun {
  roster: Roster;
  rollCalls: LocalRollCall[];
  unmatched: LocalUnmatchedName[];
  sessions: LocalAssemblyMeta["sessions"];
  sources: LocalAssemblyMeta["sources"];
  /** 会期ごとの PDF 解析の要約（ログ用） */
  summary: { sessionId: string; sessionLabel: string; members: number; rows: number; unknownCells: number; pdfUrl: string }[];
}

export async function runKochi(opts: { sessions: number; fetchedAt: string; fetcher?: Fetcher; log?: (line: string) => void }): Promise<KochiRun> {
  const log = opts.log ?? (() => {});
  const f: Fetcher = opts.fetcher ?? new PoliteFetcher(KOCHI_HOST);
  const roster = parseRoster(await f.text(KOCHI_ROSTER_URL));
  log(`roster: ${roster.members.length} members (as of ${roster.asOf})`);

  const index = parseSessionIndex(await f.text(DECISION_URL), DECISION_URL);
  const targets = index.slice(0, opts.sessions);
  if (targets.length === 0) throw new Error("no session with a 議決結果一覧 PDF found");
  log(`sessions: ${targets.map((t) => `${t.sessionId}（${t.sessionLabel}）`).join(" / ")}`);

  const rollCalls: LocalRollCall[] = [];
  const unmatched = new Map<string, LocalUnmatchedName>();
  const sessions: LocalAssemblyMeta["sessions"] = [];
  const sources: LocalAssemblyMeta["sources"] = [
    { name: "高知県議会 議員名簿（会派別）", url: KOCHI_ROSTER_URL, fetchedAt: opts.fetchedAt },
    { name: "高知県議会 議員別賛否の状況", url: DECISION_URL, fetchedAt: opts.fetchedAt },
  ];
  const summary: KochiRun["summary"] = [];
  for (const t of targets) {
    const pdf = await parseVotePdf(await f.bytes(t.pdfUrl));
    const source: PdfSource = { pdf, pdfUrl: t.pdfUrl };
    const converted = toLocalRollCalls([source], roster.members, { sessionId: t.sessionId, sessionLabel: t.sessionLabel });
    rollCalls.push(...converted.rollCalls);
    for (const u of converted.unmatched) {
      const key = `${u.nameText}\t${u.group}`;
      const cur = unmatched.get(key) ?? { nameText: u.nameText, group: u.group, rollCallIds: [], ...(u.candidates ? { candidates: u.candidates } : {}) };
      cur.rollCallIds.push(...u.rollCallIds);
      unmatched.set(key, cur);
    }
    sessions.push({
      sessionId: t.sessionId,
      sessionLabel: t.sessionLabel,
      sourceUrl: t.pdfUrl,
      pdfUrl: t.pdfUrl,
      pdfUrls: [t.pdfUrl],
      rollcalls: converted.rollCalls.length,
      unknownCells: pdf.unknownCells,
    });
    sources.push({ name: `高知県議会 ${t.sessionLabel}議決結果一覧`, url: t.pdfUrl, fetchedAt: opts.fetchedAt });
    summary.push({ sessionId: t.sessionId, sessionLabel: t.sessionLabel, members: pdf.members.length, rows: converted.rollCalls.length, unknownCells: pdf.unknownCells, pdfUrl: t.pdfUrl });
    log(`  ${t.sessionLabel}: ${converted.rollCalls.length} roll calls × ${pdf.members.length} members, unknown cells ${pdf.unknownCells}, unmatched names ${converted.unmatched.length} (${t.pdfUrl})`);
  }
  return { roster, rollCalls, unmatched: [...unmatched.values()], sessions, sources, summary };
}
