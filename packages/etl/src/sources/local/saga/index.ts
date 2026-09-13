import type { LocalAssemblyMeta, LocalRollCall, LocalUnmatchedName } from "@seiji-kiroku/shared";
import { PoliteFetcher } from "../polite-fetch.ts";
import { SAGA_HOST, SAGA_INDEX_URL, SAGA_ROSTER_URL } from "./site.ts";
import { parseRoster, type Roster } from "./roster.ts";
import { articleTitle, parseCategoryPage, parseGianPage, parseIndex, parseSessionPage, parseYearPage, type SessionLink } from "./sessions.ts";
import { parseVotePdf, type VotePdf } from "./votes-pdf.ts";
import { toLocalRollCalls, type PdfSource } from "./rollcalls.ts";

/**
 * 佐賀県議会 ETL の取得部（Issue #768、地方議会 11 議会目）。
 *   議員一覧 → 議案等の審議結果（年の一覧）→ 年ページ → 種別ページ → 会期ページ
 *   → 議案件名一覧表 → 賛否 PDF（1 会期に 1 本）。
 * 取得先は県議会の公式ホストだけ（PoliteFetcher。UA 明記・1 秒以上間隔・robots.txt 遵守）。
 * **HTML は UTF-8。** PDF はキャッシュ、HTML は毎回取得。
 *
 * ## **読めない PDF で会期ごと落とさない**
 * **賛否 PDF のリンクは 67 本、取れるのは 64 本、読めるのは 16 本**（実測 2026-09-13）:
 *   - **文字層が無い 32 本**（`ToUnicode` が無い / そもそも `showText` が無い。#689）
 *   - **`/Rotate 90` の 16 本**（平成27年2月〜平成29年11月。**表の作りも違う**。`votes-pdf.ts` の docblock）
 *   - ~~**404 になる 3 本**~~ → **`.pdf` のリンクが張られているのにファイルが無い会期がある**
 *     （平成28年9月定・平成29年9月定・平成29年4月臨の 2 本目のリンク。実測 HTTP 404）
 * **どれも例外で止めず、`unreadableSources` に URL と理由を残して先へ進む。**
 * **「その会期の賛否が公表されていない」ではなく「機械では読めない」**ので、`meta.json` に書く。
 *
 * ## **PDF の表題と会期の名前を突き合わせる**（#689 の罠 7）
 * **#689（2026-09-09）は「令和8年9月定例会のページに令和8年2月の議案件名一覧表が出る」と記録した。**
 * **2026-09-13 には出ない**（9月定例会の下は空の一覧ページに変わっている。実測）。
 * **それでも突き合わせは置く**——**サイドバーを読まない（`sessions.ts`）だけでは、
 * サイトの作りが戻ったときに黙って別会期の票が出る。**
 * **PDF の表題（`令和８年６月定例会 議案採決結果一覧表`）の年・月・種別が
 * 会期ページの名前と食い違ったら、その PDF を出さない。**
 */
export interface Fetcher {
  text(url: string): Promise<string>;
  bytes(url: string): Promise<Buffer>;
}

export interface SagaRun {
  roster: Roster;
  rollCalls: LocalRollCall[];
  unmatched: LocalUnmatchedName[];
  sessions: LocalAssemblyMeta["sessions"];
  sources: LocalAssemblyMeta["sources"];
  /** 読めなかった PDF（文字層なし・回転・404 など）。URL と理由。meta.json の unreadableSources */
  unreadableSources: { url: string; reason: string }[];
  /** 字が落ちたまま名簿に寄った氏名（meta.lossyNameMatches） */
  lossyNameMatches: { nameText: string; memberId: string; rosterName: string; rollCalls: number }[];
  summary: { sessionId: string; sessionLabel: string; members: number; rows: number; unknownCells: number; pdfUrls: string[] }[];
}

/** PDF の表題と会期の名前が同じ会期を指しているか（#689 の罠 7）。 */
export function sameSession(pdf: Pick<VotePdf, "year" | "month" | "kind">, link: Pick<SessionLink, "year" | "month" | "kind">): boolean {
  return pdf.year === link.year && pdf.month === link.month && pdf.kind === link.kind;
}

export async function runSaga(opts: { sessions: number; fetchedAt: string; fetcher?: Fetcher; log?: (line: string) => void }): Promise<SagaRun> {
  const log = opts.log ?? (() => {});
  const f: Fetcher = opts.fetcher ?? new PoliteFetcher(SAGA_HOST);
  const roster = parseRoster(await f.text(SAGA_ROSTER_URL));
  log(`roster: ${roster.members.length} members (as of ${roster.asOf}, ${roster.termText})`);

  // 年の一覧 → 年ページ → 種別ページ → 会期。**新しい年から順に、必要な本数がそろうまで**
  const yearPages = parseIndex(await f.text(SAGA_INDEX_URL));
  const targets: SessionLink[] = [];
  for (const yearUrl of yearPages) {
    if (targets.length >= opts.sessions) break;
    for (const catUrl of parseYearPage(await f.text(yearUrl), yearUrl)) {
      for (const s of parseCategoryPage(await f.text(catUrl), catUrl)) {
        if (targets.some((t) => t.sessionUrl === s.sessionUrl)) continue;
        targets.push(s);
      }
    }
  }
  // 新しい順（年・月）に並べる。**同じ年月に 2 本ある会期は sessionId で決める**（安定した順）
  targets.sort((a, b) => b.year * 100 + b.month - (a.year * 100 + a.month) || (a.sessionId < b.sessionId ? 1 : -1));
  if (targets.length === 0) throw new Error("会期が 1 つも見つからない");
  log(`sessions found: ${targets.length}`);

  const rollCalls: LocalRollCall[] = [];
  const unmatched = new Map<string, LocalUnmatchedName>();
  const sessions: LocalAssemblyMeta["sessions"] = [];
  const sources: LocalAssemblyMeta["sources"] = [
    { name: "佐賀県議会 議員一覧", url: SAGA_ROSTER_URL, fetchedAt: opts.fetchedAt },
    { name: "佐賀県議会 議案等の審議結果", url: SAGA_INDEX_URL, fetchedAt: opts.fetchedAt },
  ];
  const unreadableSources: SagaRun["unreadableSources"] = [];
  const lossy = new Map<string, SagaRun["lossyNameMatches"][number]>();
  const summary: SagaRun["summary"] = [];
  /** 同じ PDF を 2 回読まない（#670 が「同じ PDF が 2 つの URL で配られる」を実測） */
  const seenPdf = new Set<string>();
  for (const t of targets) {
    // **読める会期が opts.sessions 本そろったら止める**（読めない会期で枠を使わない）
    if (sessions.length >= opts.sessions) break;
    const gianUrls = parseSessionPage(await f.text(t.sessionUrl), t.sessionUrl);
    const pdfUrls: string[] = [];
    const visited = new Set<string>();
    const queue = [...gianUrls];
    while (queue.length > 0) {
      const url = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);
      const html = await f.text(url);
      const { pdfs, next } = parseGianPage(html, url);
      if (pdfs.length === 0) { queue.push(...next); continue; }
      for (const p of pdfs) if (!pdfUrls.includes(p)) pdfUrls.push(p);
      // 議案件名一覧表の表題は `sources` の名前に使う（`令和8年6月定例会　議案件名一覧表`）
      sources.push({ name: `佐賀県議会 ${articleTitle(html) || t.sessionLabel}`, url, fetchedAt: opts.fetchedAt });
    }
    if (pdfUrls.length === 0) { log(`  ${t.sessionLabel}: 賛否 PDF が 1 本も無い（飛ばす）`); continue; }
    const pdfs: PdfSource[] = [];
    for (const url of pdfUrls) {
      if (seenPdf.has(url)) continue;
      seenPdf.add(url);
      try {
        const pdf = await parseVotePdf(await f.bytes(url));
        // **表題と会期の名前が食い違ったら出さない**（#689 の罠 7。docblock）
        if (!sameSession(pdf, t)) {
          unreadableSources.push({ url, reason: `PDF の表題「${pdf.headingText}」が会期「${t.sessionLabel}」と食い違う（#689 の罠 7）` });
          log(`  ${t.sessionLabel}: 表題が食い違う PDF（${pdf.headingText}）: ${url}`);
          continue;
        }
        pdfs.push({ pdf, pdfUrl: url });
      } catch (e) {
        unreadableSources.push({ url, reason: e instanceof Error ? e.message : String(e) });
        log(`  ${t.sessionLabel}: 読めない PDF（${e instanceof Error ? e.message : String(e)}）: ${url}`);
      }
    }
    if (pdfs.length === 0) { log(`  ${t.sessionLabel}: 読める PDF が 1 本も無い（飛ばす）`); continue; }
    const converted = toLocalRollCalls(pdfs, roster.members, t);
    rollCalls.push(...converted.rollCalls);
    for (const u of converted.unmatched) {
      const key = `${u.nameText}\t${u.group}`;
      const cur = unmatched.get(key) ?? { nameText: u.nameText, group: u.group, rollCallIds: [], ...(u.candidates ? { candidates: u.candidates } : {}) };
      cur.rollCallIds.push(...u.rollCallIds);
      unmatched.set(key, cur);
    }
    for (const l of converted.lossy) {
      const k = `${l.nameText}\t${l.memberId}`;
      const cur = lossy.get(k) ?? { ...l, rollCalls: 0 };
      cur.rollCalls += l.rollCalls;
      lossy.set(k, cur);
    }
    const unknownCells = pdfs.reduce((s, p) => s + p.pdf.unknownCells, 0);
    const urls = pdfs.map((p) => p.pdfUrl);
    sessions.push({
      sessionId: t.sessionId,
      sessionLabel: t.sessionLabel,
      sourceUrl: t.sessionUrl,
      pdfUrl: urls[0],
      pdfUrls: urls,
      rollcalls: converted.rollCalls.length,
      unknownCells,
    });
    for (const p of pdfs) sources.push({ name: `佐賀県議会 ${t.sessionLabel}議案採決結果一覧表`, url: p.pdfUrl, fetchedAt: opts.fetchedAt });
    summary.push({ sessionId: t.sessionId, sessionLabel: t.sessionLabel, members: pdfs[0].pdf.members.length, rows: converted.rollCalls.length, unknownCells, pdfUrls: urls });
    log(`  ${t.sessionLabel}: ${converted.rollCalls.length} roll calls × ${pdfs[0].pdf.members.length} members, unknown cells ${unknownCells}, unmatched names ${converted.unmatched.length}`);
  }
  if (rollCalls.length === 0) throw new Error("no roll calls read from any session");
  return { roster, rollCalls, unmatched: [...unmatched.values()], sessions, sources, unreadableSources, lossyNameMatches: [...lossy.values()], summary };
}
