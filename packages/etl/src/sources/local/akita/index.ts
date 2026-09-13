import type { LocalAssemblyMeta, LocalRollCall, LocalUnmatchedName } from "@seiji-kiroku/shared";
import { PoliteFetcher } from "../polite-fetch.ts";
import { AKITA_HOST, AKITA_HUB_URL, AKITA_ROSTER_URL, AKITA_YEARS_URL } from "./site.ts";
import { parseRoster, type Roster } from "./roster.ts";
import { parseYearPage, parseYearPages, type PdfLink } from "./sessions.ts";
import { parseVotePdf } from "./votes-pdf.ts";
import { sessionOf, toLocalRollCalls, type PdfSource } from "./rollcalls.ts";

/**
 * 秋田県議会 ETL の取得部（Issue #759、地方議会 10 議会目）。
 *   名簿（1 ページ）→ 概要ハブ → 年度の一覧 → 年度ページ（20＋1）→ 賛否 PDF（154 本）。
 * 取得先は県議会の公式ホストだけ（PoliteFetcher。UA 明記・1 秒以上間隔・robots.txt 遵守）。
 * **HTML は UTF-8**（滋賀の `textShiftJis` は使わない）。PDF はキャッシュ、HTML は毎回取得。
 *
 * ## **`sessions` は「本会議日」の単位である**（既存 9 県と違う）
 * **秋田の賛否 PDF は 1 本会議日に 1 本**（#615 / #753）で、**1 つの定例会に 7 本ある年もある**
 * （令和6年第1回定例会《2月議会》は 2月20日・2月28日・3月19日の 3 本）。
 * **`sessionId` を「定例会」の単位にすると、1 つの会期に PDF が 7 本入る形になり、
 * 年度ページの会期の名前が 154 本のうち 8 本で読めない**（`第１定例会` のように `回` が無い形。
 * `sessions.ts` の docblock）。
 * **だから `sessionId` は `{西暦}-{月2桁}-{日2桁}`（議決日）にする**——
 * **これは PDF 自身の中にある事実だけから決まり、HTML の文言の揺れに依らない。**
 * **同じ議決日に 2 本の PDF があることは無い**（実測: 154 本の議決日は 154 通り）。
 *
 * ## **HTTP リクエストは 3 ＋ 年度ページ数 ＋ PDF の本数**
 * **`--sessions N` は「新しいほうから N 本の PDF」**（既存 9 県と同じ数え方だが、単位が本会議日）。
 * **既定の N = 2 なら、年度ページ 1〜2 本と PDF 2 本で済む**（新しい年度から順に見て、
 * **N 本ぶん集まったら残りの年度ページは取りに行かない**）。
 * **154 本すべてを取ると 154 リクエストになる**（4 秒間隔で 10 分強）。
 *
 * ## **議員ごとのプロフィールページは取りに行かない**（青森 #750 と同じ判断）
 * **41 名ぶんで毎月 41 リクエスト増える。** **ふりがなは `roster.ts` の docblock のとおり空にする。**
 *
 * ## **読めない PDF は落とさずに数える**（滋賀 #741 と同じ扱い）
 * **秋田は 154 本すべてに文字層があり、実測では 1 本も読めない本が無い**（2026-09-13）が、
 * **将来 1 本が画像 PDF に差し替わったときに、その日の採決が黙って消えないようにする。**
 * **`meta.unreadableSources` に URL と理由を残す**——書かないと「その日の採決は無かった」と読めてしまう。
 */
export interface Fetcher {
  text(url: string): Promise<string>;
  bytes(url: string): Promise<Buffer>;
}

export interface AkitaRun {
  roster: Roster;
  rollCalls: LocalRollCall[];
  unmatched: LocalUnmatchedName[];
  sessions: LocalAssemblyMeta["sessions"];
  sources: LocalAssemblyMeta["sources"];
  unreadableSources: { url: string; reason: string }[];
  summary: { sessionId: string; sessionLabel: string; members: number; rows: number; unknownCells: number; skippedRows: number; pdfUrls: string[] }[];
}

export async function runAkita(opts: { sessions: number; fetchedAt: string; fetcher?: Fetcher; log?: (line: string) => void }): Promise<AkitaRun> {
  const log = opts.log ?? (() => {});
  const f: Fetcher = opts.fetcher ?? new PoliteFetcher(AKITA_HOST);
  const roster = parseRoster(await f.text(AKITA_ROSTER_URL));
  log(`roster: ${roster.members.length} members (as of ${roster.asOf}, 議員紹介ページの公開日)`);

  // **索引は 2 段**（`sessions.ts` の docblock）。**ハブに最新年度、一覧に過去 20 年度**
  const hub = await f.text(AKITA_HUB_URL);
  const years = await f.text(AKITA_YEARS_URL);
  const yearPages = parseYearPages([{ html: hub, baseUrl: AKITA_HUB_URL }, { html: years, baseUrl: AKITA_YEARS_URL }]);
  log(`year pages: ${yearPages.length}`);

  // **年度ページは新しいほうから順に見て、必要な本数が集まったらやめる**
  // （既定の N = 2 なら 1〜2 ページで足りる。取りに行くリクエストを増やさない）
  const links: PdfLink[] = [];
  for (const page of yearPages) {
    if (links.length >= opts.sessions) break;
    links.push(...parseYearPage(await f.text(page), page));
  }
  if (links.length === 0) throw new Error("年度ページに賛否 PDF が 1 本も無い");
  const picked = links.slice(0, opts.sessions);
  log(`pdfs: ${picked.length} of ${links.length} found (--sessions ${opts.sessions})`);

  const rollCalls: LocalRollCall[] = [];
  const unmatched = new Map<string, LocalUnmatchedName>();
  const sessions: LocalAssemblyMeta["sessions"] = [];
  const sources: LocalAssemblyMeta["sources"] = [
    { name: "秋田県議会 議員紹介", url: AKITA_ROSTER_URL, fetchedAt: opts.fetchedAt },
    { name: "秋田県議会 定例会・臨時会の概要", url: AKITA_HUB_URL, fetchedAt: opts.fetchedAt },
    { name: "秋田県議会 定例会・臨時会の概要（過去分の一覧）", url: AKITA_YEARS_URL, fetchedAt: opts.fetchedAt },
  ];
  const unreadableSources: AkitaRun["unreadableSources"] = [];
  const summary: AkitaRun["summary"] = [];
  const seenSessionIds = new Set<string>();
  for (const link of picked) {
    let pdf: PdfSource;
    try {
      pdf = { pdf: await parseVotePdf(await f.bytes(link.url)), pdfUrl: link.url };
    } catch (e) {
      // **読めない PDF でその日ごと落とさない**（滋賀 #741 と同じ判断）
      unreadableSources.push({ url: link.url, reason: e instanceof Error ? e.message : String(e) });
      log(`  読めない PDF（${e instanceof Error ? e.message : String(e)}）: ${link.url}`);
      continue;
    }
    // **`sessionId` は議決日から**（HTML の文言に依らない。docblock）
    const s = sessionOf(pdf.pdf, link.url);
    const first = pdf.pdf.rows.map((r) => r.dateText).find((t) => t !== "") ?? "";
    const md = first.normalize("NFKC").replace(/[\s　]/g, "").match(/^(\d{1,2})月(\d{1,2})日$/);
    if (!md) throw new Error(`${link.url}: 議決月日が 1 行も読めない`);
    const day = Number(md[2]);
    const month = Number(md[1]);
    const year = s.month - month >= 6 ? s.year + 1 : s.year;
    const sessionId = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (seenSessionIds.has(sessionId)) throw new Error(`sessionId ${sessionId} が 2 回出た（${link.url}）`);
    seenSessionIds.add(sessionId);
    // **会期の名前は PDF の見出しの原文**（`平成２９年第２回定例会（１２月２２日）`）。
    // **読めなければ年度ページのリンクの文言**（原文のまま。**推定はしない**）
    const sessionLabel = pdf.pdf.headingText !== "" ? pdf.pdf.headingText : link.linkText;
    const converted = toLocalRollCalls([pdf], roster.members, { sessionId, sessionLabel, year: s.year, month: s.month });
    rollCalls.push(...converted.rollCalls);
    for (const u of converted.unmatched) {
      const key = `${u.nameText}\t${u.group}`;
      const cur = unmatched.get(key) ?? { nameText: u.nameText, group: u.group, rollCallIds: [], ...(u.candidates ? { candidates: u.candidates } : {}), ...(u.reason ? { reason: u.reason } : {}) };
      cur.rollCallIds.push(...u.rollCallIds);
      unmatched.set(key, cur);
    }
    sessions.push({
      sessionId,
      sessionLabel,
      // **会期の出典は年度ページ**（その PDF へのリンクが載っているページ）
      sourceUrl: link.sourceUrl,
      pdfUrl: link.url,
      pdfUrls: [link.url],
      rollcalls: converted.rollCalls.length,
      unknownCells: pdf.pdf.unknownCells,
    });
    sources.push({ name: `秋田県議会 ${sessionLabel} 各議員の表決状況`, url: link.url, fetchedAt: opts.fetchedAt });
    summary.push({ sessionId, sessionLabel, members: pdf.pdf.members.length, rows: converted.rollCalls.length, unknownCells: pdf.pdf.unknownCells, skippedRows: converted.skippedRows, pdfUrls: [link.url] });
    log(`  ${sessionId}（${sessionLabel}）: ${converted.rollCalls.length} roll calls × ${pdf.pdf.members.length} members, unknown cells ${pdf.pdf.unknownCells}, unmatched names ${converted.unmatched.length}, 表決していない行 ${converted.skippedRows}`);
  }
  if (rollCalls.length === 0) throw new Error("no roll calls read from any PDF");
  return { roster, rollCalls, unmatched: [...unmatched.values()], sessions, sources, unreadableSources, summary };
}
