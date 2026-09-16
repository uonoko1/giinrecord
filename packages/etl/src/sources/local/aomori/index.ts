import type { LocalAssemblyMeta, LocalRollCall, LocalUnmatchedName } from "@seiji-kiroku/shared";
import { PoliteFetcher } from "../polite-fetch.ts";
import { SessionTally } from "../session-tally.ts";
import { AOMORI_DISTRICT_URL, AOMORI_HOST, AOMORI_INDEX_URL, AOMORI_ROSTER_URL } from "./site.ts";
import { parseRoster, type Roster } from "./roster.ts";
import { parseIndex, type SessionLink } from "./sessions.ts";
import { parseVotePdf } from "./votes-pdf.ts";
import { toLocalRollCalls, type PdfSource } from "./rollcalls.ts";

/**
 * 青森県議会 ETL の取得部（Issue #750、地方議会 9 議会目）。
 *   名簿（会派別 ＋ 選挙区別の 2 ページ）→ 審査結果 index（**1 ページに全会期**）→ 議決結果 PDF。
 * 取得先は県の公式ホストだけ（PoliteFetcher。UA 明記・1 秒以上間隔・robots.txt 遵守）。
 * **HTML は UTF-8**（滋賀の `textShiftJis` は使わない）。PDF はキャッシュ、HTML は毎回取得。
 *
 * **HTTP リクエストは 3 ＋ 会期数**（名簿 2・index 1・会期ごとに PDF 1 本）。
 * **議員ごとのプロフィールページは取りに行かない**——ふりがなしか無く、46 名ぶんで
 * 毎月 46 リクエスト増える（`roster.ts` の docblock）。
 *
 * **読めない PDF は落とさずに数える**（滋賀 #741 と同じ扱い）。
 * **青森は 56 本すべてに文字層があり、実測では 1 本も読めない本が無い**が、
 * **将来 1 本が画像 PDF に差し替わったときに、その会期が黙って消えないようにする。**
 * **`meta.unreadableSources` に URL と理由を残す**——書かないと「その日の採決は無かった」と読めてしまう。
 */
export interface Fetcher {
  text(url: string): Promise<string>;
  bytes(url: string): Promise<Buffer>;
}

export interface AomoriRun {
  roster: Roster;
  rollCalls: LocalRollCall[];
  unmatched: LocalUnmatchedName[];
  sessions: LocalAssemblyMeta["sessions"];
  sources: LocalAssemblyMeta["sources"];
  unreadableSources: { url: string; reason: string }[];
  summary: { sessionId: string; sessionLabel: string; members: number; rows: number; unknownCells: number; skippedRows: number; pdfUrls: string[] }[];
}

export async function runAomori(opts: { sessions: number; fetchedAt: string; fetcher?: Fetcher; log?: (line: string) => void }): Promise<AomoriRun> {
  const log = opts.log ?? (() => {});
  const f: Fetcher = opts.fetcher ?? new PoliteFetcher(AOMORI_HOST);
  // **名簿は 2 ページを合わせて 1 人ぶんにする**（会派別に選挙区が無い。`roster.ts`）。
  // **突き合わせはプロフィールの URL**（氏名は 2 ページで字が違う。`和田寬司`/`和田寛司`）
  const roster = parseRoster(await f.text(AOMORI_ROSTER_URL), await f.text(AOMORI_DISTRICT_URL));
  log(`roster: ${roster.members.length} members (as of ${roster.asOf}, 名簿ページの更新日付)`);

  // index は 1 ページに全会期（新しい順）。**個人別の範囲（第275回以降）だけが返る**
  const indexTally = new SessionTally();
  const all = parseIndex(await f.text(AOMORI_INDEX_URL), AOMORI_INDEX_URL, indexTally);
  log(`session index: ${indexTally.line()}`);
  const picked: SessionLink[] = all.slice(0, opts.sessions);
  if (picked.length === 0) throw new Error("no session with a 議決結果 PDF found");
  log(`sessions: ${picked.map((t) => `${t.sessionId}（${t.sessionLabel}）`).join(" / ")}`);

  const rollCalls: LocalRollCall[] = [];
  const unmatched = new Map<string, LocalUnmatchedName>();
  const sessions: LocalAssemblyMeta["sessions"] = [];
  const sources: LocalAssemblyMeta["sources"] = [
    { name: "青森県議会 議員の紹介（会派別）", url: AOMORI_ROSTER_URL, fetchedAt: opts.fetchedAt },
    { name: "青森県議会 議員の紹介（選挙区別）", url: AOMORI_DISTRICT_URL, fetchedAt: opts.fetchedAt },
    { name: "青森県議会 本会議・委員会の審査結果", url: AOMORI_INDEX_URL, fetchedAt: opts.fetchedAt },
  ];
  const unreadableSources: AomoriRun["unreadableSources"] = [];
  const summary: AomoriRun["summary"] = [];
  for (const t of picked) {
    const pdfs: PdfSource[] = [];
    for (const url of t.pdfUrls) {
      try {
        pdfs.push({ pdf: await parseVotePdf(await f.bytes(url)), pdfUrl: url });
      } catch (e) {
        // **読めない PDF で会期ごと落とさない**（滋賀 #741 と同じ判断）
        unreadableSources.push({ url, reason: e instanceof Error ? e.message : String(e) });
        log(`  ${t.sessionLabel}: 読めない PDF（${e instanceof Error ? e.message : String(e)}）: ${url}`);
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
      // **会期ごとの中間ページが無い**（1 ページに全会期）ので、会期の出典は index そのもの
      sourceUrl: AOMORI_INDEX_URL,
      pdfUrl: pdfUrls[0],
      pdfUrls,
      rollcalls: converted.rollCalls.length,
      unknownCells,
    });
    for (const p of pdfs) sources.push({ name: `青森県議会 ${t.sessionLabel} 議決結果`, url: p.pdfUrl, fetchedAt: opts.fetchedAt });
    summary.push({ sessionId: t.sessionId, sessionLabel: t.sessionLabel, members: pdfs[0].pdf.members.length, rows: converted.rollCalls.length, unknownCells, skippedRows: converted.skippedRows, pdfUrls });
    log(`  ${t.sessionLabel}: ${converted.rollCalls.length} roll calls × ${pdfs[0].pdf.members.length} members, unknown cells ${unknownCells}, unmatched names ${converted.unmatched.length}, 表決していない行 ${converted.skippedRows} (${pdfUrls.length} PDFs)`);
  }
  if (rollCalls.length === 0) throw new Error("no roll calls read from any session");
  return { roster, rollCalls, unmatched: [...unmatched.values()], sessions, sources, unreadableSources, summary };
}
