/**
 * #901 島根: 会期を 1 つずつ広げながら測る。data/ には一切書かない。
 * 各会期について: 表決 PDF が読めたか / 採決件数 / セル数 / unknownCells /
 * **PDF に出る氏名の集合**（名簿と突き合わせる前の生の氏名）/ 名簿に寄らなかった氏名。
 */
import { PoliteFetcher } from "../src/sources/local/polite-fetch.ts";
import { SHIMANE_HOST, SHIMANE_ROSTER_URL } from "../src/sources/local/shimane/site.ts";
import { DISTRICT_PAGES, parseDistrictIndex, parseRoster } from "../src/sources/local/shimane/roster.ts";
import { parseSessionIndex, parseSessionPage, SESSION_ARCHIVE_URL, SESSION_INDEX_URL } from "../src/sources/local/shimane/sessions.ts";
import { parseResultsPdf, parseVotePdf } from "../src/sources/local/shimane/votes-pdf.ts";
import { toLocalRollCalls } from "../src/sources/local/shimane/rollcalls.ts";
import { SessionTally } from "../src/sources/local/session-tally.ts";

const LIMIT = Number(process.argv[2] ?? "20");
const raw = new PoliteFetcher(SHIMANE_HOST);
/** 一時的な `fetch failed` で会期が落ちると「読めない」と取り違えるので、3 回まで再試行する（#901） */
const retry = async <T>(fn: () => Promise<T>, what: string): Promise<T> => {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try { return await fn(); } catch (e) { last = e; console.error(`  retry ${i + 1}/3 ${what}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  throw last;
};
const f = { text: (u: string) => retry(() => raw.text(u), u), bytes: (u: string) => retry(() => raw.bytes(u), u) };

const districts = parseDistrictIndex(await f.text(SHIMANE_ROSTER_URL), SHIMANE_ROSTER_URL);
const pages: { district: string; url: string; html: string }[] = [];
for (const d of districts) pages.push({ district: d.district, url: d.url, html: await f.text(d.url) });
const roster = parseRoster(pages);
console.error(`roster: ${roster.members.length} members, asOf ${roster.asOf}`);

const tally = new SessionTally();
const recent = parseSessionIndex(await f.text(SESSION_INDEX_URL), SESSION_INDEX_URL, tally);
const archived = parseSessionIndex(await f.text(SESSION_ARCHIVE_URL), SESSION_ARCHIVE_URL, tally);
const index = [...recent];
for (const s of archived) if (!index.some((x) => x.url === s.url)) index.push(s);
index.sort((a, b) => b.year * 100 + b.month - (a.year * 100 + a.month));
console.error(`session index: ${index.length} sessions`);

type Out = {
  ord: number; sessionId: string; sessionLabel: string; url: string;
  pdfUrl?: string; resultsPdfUrl?: string;
  status: string; error?: string;
  rows?: number; members?: number; cells?: number; unknownCells?: number;
  names?: string[]; unmatched?: string[]; lastDate?: string;
};
const out: Out[] = [];
let withPdf = 0;
for (const s of index) {
  if (withPdf >= LIMIT) break;
  const rec: Out = { ord: withPdf + 1, sessionId: s.sessionId, sessionLabel: s.sessionLabel, url: s.url, status: "" };
  let page;
  try { page = parseSessionPage(await f.text(s.url), s.url, { sessionLabel: s.sessionLabel }); }
  catch (e) { rec.status = "session-page-throw"; rec.error = e instanceof Error ? e.message : String(e); rec.ord = 0; out.push(rec); continue; }
  if (page.pdfUrls.length === 0) { continue; }  // 議員別 PDF なし＝実装は飛ばす
  withPdf++;
  rec.ord = withPdf;
  rec.pdfUrl = page.pdfUrls[0];
  rec.resultsPdfUrl = page.resultsPdfUrl;
  if (page.pdfUrls.length > 1) { rec.status = "multi-vote-pdf"; rec.error = `${page.pdfUrls.length} PDFs`; out.push(rec); continue; }
  if (!page.resultsPdfUrl) { rec.status = "no-results-pdf"; out.push(rec); continue; }
  let pdf;
  try { pdf = await parseVotePdf(await f.bytes(page.pdfUrls[0])); }
  catch (e) { rec.status = "vote-pdf-throw"; rec.error = e instanceof Error ? e.message : String(e); out.push(rec); continue; }
  rec.members = pdf.members.length;
  rec.names = [...pdf.members];
  rec.unknownCells = pdf.unknownCells;
  let results;
  try { results = await parseResultsPdf(await f.bytes(page.resultsPdfUrl)); }
  catch (e) { rec.status = "results-pdf-throw"; rec.error = e instanceof Error ? e.message : String(e); out.push(rec); continue; }
  const dateList = [...results.values()].map((r) => r.date);
  if (dateList.length === 0) { rec.status = "no-dates"; out.push(rec); continue; }
  const lastDate = dateList.reduce((a, b) => (a > b ? a : b));
  rec.lastDate = lastDate;
  try {
    const conv = toLocalRollCalls([{ pdf, pdfUrl: page.pdfUrls[0] }], roster.members, { sessionId: s.sessionId, sessionLabel: s.sessionLabel }, { results, lastDate });
    rec.rows = conv.rollCalls.length;
    rec.cells = conv.rollCalls.reduce((n, r) => n + r.votes.length, 0);
    rec.unmatched = conv.unmatched.map((u) => u.nameText);
    rec.status = "ok";
  } catch (e) { rec.status = "convert-throw"; rec.error = e instanceof Error ? e.message : String(e); }
  out.push(rec);
}
console.log(JSON.stringify({ rosterAsOf: roster.asOf, rosterNames: roster.members.map((m) => m.name), indexSessions: index.length, sessions: out }, null, 1));
