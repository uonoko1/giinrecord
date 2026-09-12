import type { LocalAssemblyMeta, LocalRollCall, LocalUnmatchedName } from "@seiji-kiroku/shared";
import { PoliteFetcher } from "../polite-fetch.ts";
import { SHIGA_HOST, SHIGA_ROSTER_URL, SHIGA_YEAR_INDEX_URL, shigaYearUrl } from "./site.ts";
import { parseRoster, type Roster } from "./roster.ts";
import { parseSanpiPage, parseYearIndex, parseYearPage, type SessionLink } from "./sessions.ts";
import { parseVotePdf } from "./votes-pdf.ts";
import { toLocalRollCalls, type PdfSource } from "./rollcalls.ts";

/**
 * 滋賀県議会 ETL の取得部（Issue #741、地方議会 8 議会目）。
 *   名簿（五十音順、1 ページ）→ 年の一覧 → 年ページ（**年度版と暦年版の 2 通り**）
 *   → 会期の賛否ページ（KaigiID）→ 賛否 PDF（1 会期に複数本）。
 * 取得先は県議会の公式ホストだけ（PoliteFetcher。UA 明記・1 秒以上間隔・robots.txt 遵守）。
 * **HTML は Shift_JIS**（`textShiftJis`）。PDF はキャッシュ、HTML は毎回取得。
 *
 * **年ページを 2 通り読む理由**（実測 #741）——`Tmode` 無しは**年度**（4月〜翌3月）、
 * `Tmode=0` は**暦年**で、片方だけでは会期が落ちる。2 つの KaigiID の和を取ると 81 会期・147 本になり、
 * #680 が数えた本数と一致する。
 *
 * **読めない PDF は落とさずに数える**——**文字層の無い画像 PDF が 3 本ある**（#680）。
 * **読めないのが正しい結果**なので、例外で止めずに `unreadable` に記録して先へ進む
 * （その 3 本の賛否は公表されていない、ではなく**機械では読めない**。`meta.json` に書く）。
 */
export interface Fetcher {
  /** Shift_JIS の HTML */
  textShiftJis(url: string): Promise<string>;
  bytes(url: string): Promise<Buffer>;
}

export interface ShigaRun {
  roster: Roster;
  rollCalls: LocalRollCall[];
  unmatched: LocalUnmatchedName[];
  sessions: LocalAssemblyMeta["sessions"];
  sources: LocalAssemblyMeta["sources"];
  /** 読めなかった PDF（文字層が無い等）。URL と理由。meta.json の unreadableSources になる */
  unreadableSources: { url: string; reason: string }[];
  summary: { sessionId: string; sessionLabel: string; members: number; rows: number; unknownCells: number; pdfUrls: string[] }[];
}

/** 取得日（JST）を ISO 日付にする。名簿ページに掲載日が無いので as-of に使う（徳島 #183 と同じ）。 */
export function jstDate(fetchedAt: string): string {
  return new Date(new Date(fetchedAt).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export async function runShiga(opts: { sessions: number; fetchedAt: string; fetcher?: Fetcher; log?: (line: string) => void }): Promise<ShigaRun> {
  const log = opts.log ?? (() => {});
  const f: Fetcher = opts.fetcher ?? new PoliteFetcher(SHIGA_HOST);
  const asOf = jstDate(opts.fetchedAt);
  const roster = parseRoster(await f.textShiftJis(SHIGA_ROSTER_URL), { asOf });
  log(`roster: ${roster.members.length} members (as of ${roster.asOf}, 名簿に掲載日が無いので取得日)`);

  // 年の一覧 → 新しい年から順に、賛否状況のある会期が opts.sessions 本そろうまで年ページを開く
  const years = parseYearIndex(await f.textShiftJis(SHIGA_YEAR_INDEX_URL)).sort((a, b) => b - a);
  const targets: SessionLink[] = [];
  const seen = new Set<string>();
  for (const year of years) {
    if (targets.length >= opts.sessions) break;
    // **年度版と暦年版の両方を読む**（片方だけでは会期が落ちる。site.ts の shigaYearUrl の注）
    for (const mode of ["fiscal", "calendar"] as const) {
      const url = shigaYearUrl(year, mode);
      for (const link of parseYearPage(await f.textShiftJis(url), url)) {
        if (seen.has(link.sessionId)) continue;
        seen.add(link.sessionId);
        targets.push(link);
      }
    }
  }
  // 新しい順（年・月）に並べ、上から opts.sessions 会期
  targets.sort((a, b) => b.year * 100 + b.month - (a.year * 100 + a.month) || b.kaigiId - a.kaigiId);
  const picked = targets.slice(0, opts.sessions);
  if (picked.length === 0) throw new Error("no session with a 賛否状況 page found");
  log(`sessions: ${picked.map((t) => `${t.sessionId}（${t.sessionLabel}）`).join(" / ")}`);

  const rollCalls: LocalRollCall[] = [];
  const unmatched = new Map<string, LocalUnmatchedName>();
  const sessions: LocalAssemblyMeta["sessions"] = [];
  const sources: LocalAssemblyMeta["sources"] = [
    { name: "滋賀県議会 議員名簿（五十音順）", url: SHIGA_ROSTER_URL, fetchedAt: opts.fetchedAt },
    { name: "滋賀県議会 本会議の開催状況（年の一覧）", url: SHIGA_YEAR_INDEX_URL, fetchedAt: opts.fetchedAt },
  ];
  const unreadableSources: ShigaRun["unreadableSources"] = [];
  const summary: ShigaRun["summary"] = [];
  for (const t of picked) {
    const links = parseSanpiPage(await f.textShiftJis(t.kaigiUrl), t.kaigiUrl);
    if (links.length === 0) { log(`  ${t.sessionLabel}: 賛否 PDF が 1 本も無い（飛ばす）`); continue; }
    const pdfs: PdfSource[] = [];
    for (const link of links) {
      try {
        pdfs.push({ pdf: await parseVotePdf(await f.bytes(link.url)), pdfUrl: link.url });
      } catch (e) {
        // **読めない PDF で会期ごと落とさない**——同じ会期の他の本は読める（#680 の案C を採らない理由）
        unreadableSources.push({ url: link.url, reason: e instanceof Error ? e.message : String(e) });
        log(`  ${t.sessionLabel}: 読めない PDF（${e instanceof Error ? e.message : String(e)}）: ${link.url}`);
      }
    }
    if (pdfs.length === 0) { log(`  ${t.sessionLabel}: 読める PDF が 1 本も無い（飛ばす）`); continue; }
    const converted = toLocalRollCalls(pdfs, roster.members, { sessionId: t.sessionId, sessionLabel: t.sessionLabel, year: t.year, month: t.month });
    rollCalls.push(...converted.rollCalls);
    for (const u of converted.unmatched) {
      const key = `${u.nameText}\t${u.group}`;
      const cur = unmatched.get(key) ?? { nameText: u.nameText, group: u.group, rollCallIds: [], ...(u.candidates ? { candidates: u.candidates } : {}), ...(u.reason ? { reason: u.reason } : {}) };
      cur.rollCallIds.push(...u.rollCallIds);
      unmatched.set(key, cur);
    }
    const unknownCells = pdfs.reduce((s, p) => s + p.pdf.unknownCells, 0);
    const pdfUrls = pdfs.map((p) => p.pdfUrl);
    sessions.push({
      sessionId: t.sessionId,
      sessionLabel: t.sessionLabel,
      sourceUrl: t.kaigiUrl,
      pdfUrl: pdfUrls[0],
      pdfUrls,
      rollcalls: converted.rollCalls.length,
      unknownCells,
    });
    sources.push({ name: `滋賀県議会 ${t.sessionLabel}賛否状況`, url: t.kaigiUrl, fetchedAt: opts.fetchedAt });
    for (const p of pdfs) sources.push({ name: `滋賀県議会 ${t.sessionLabel}議案等賛否一覧（${p.pdf.headingText}）`, url: p.pdfUrl, fetchedAt: opts.fetchedAt });
    summary.push({ sessionId: t.sessionId, sessionLabel: t.sessionLabel, members: pdfs[0].pdf.members.length, rows: converted.rollCalls.length, unknownCells, pdfUrls });
    log(`  ${t.sessionLabel}: ${converted.rollCalls.length} roll calls × ${pdfs[0].pdf.members.length} members, unknown cells ${unknownCells}, unmatched names ${converted.unmatched.length} (${pdfUrls.length} PDFs)`);
  }
  if (rollCalls.length === 0) throw new Error("no roll calls read from any session");
  return { roster, rollCalls, unmatched: [...unmatched.values()], sessions, sources, unreadableSources, summary };
}
