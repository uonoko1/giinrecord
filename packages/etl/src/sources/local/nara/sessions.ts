import { parse } from "node-html-parser";
import { cleanText, NARA_ORIGIN, resolveNaraUrl, warekiYear } from "./site.ts";

/**
 * 奈良県議会「定例（臨時）県議会の概要」（Issue #202）。
 *   /n161/18579.html   会期 index。#tmp_contents の ul に「令和8年6月定例会の概要」のリンクが新しい順に並ぶ。
 *   会期ページ（/n161/p114029.html など。id に規則性は無い）: h1 が index のリンク文言と同じで、
 *   添付に「議員別の議案等に対する表決結果（PDF：…）」が並ぶ（議決日ごとに 1 本。無い会期は会期中＝まだ議決していない）。
 * 会期の id は「{西暦}-{月2桁}」（例 2026-06）、臨時会は「-rinji」を足す（鳥取と同じ）。
 */
export const SESSION_INDEX_URL = `${NARA_ORIGIN}/n161/18579.html`;

export interface SessionLink {
  /** 議会内で一意: 西暦-月（「2026-06」。臨時会は「-rinji」付き） */
  sessionId: string;
  /** リンク文言から「の概要」を除いた原文（「令和8年6月定例会」）。sessionLabel になる */
  sessionLabel: string;
  year: number;
  month: number;
  url: string;
}

const LINK_TEXT = /^(令和|平成)(\d+|元)年(\d{1,2})月(定例会|臨時会)の概要$/;

/** 会期 index → 会期のリンク（ページの並び順＝新しい順）。並びが新しい順でなければ例外（別のページを黙って読まない）。 */
export function parseSessionIndex(html: string, baseUrl: string): SessionLink[] {
  const root = parse(html);
  const contents = root.querySelector("#tmp_contents");
  if (!contents) throw new Error(`${baseUrl}: #tmp_contents not found`);
  const sessions: SessionLink[] = [];
  for (const a of contents.querySelectorAll("a")) {
    const text = cleanText(a.text).normalize("NFKC");
    const m = text.match(LINK_TEXT);
    if (!m) continue;
    const year = warekiYear(m[1], m[2]);
    const month = Number(m[3]);
    if (month < 1 || month > 12) throw new Error(`${baseUrl} ${text}: bad month`);
    const sessionId = `${year}-${String(month).padStart(2, "0")}${m[4] === "臨時会" ? "-rinji" : ""}`;
    if (sessions.some((s) => s.sessionId === sessionId)) throw new Error(`${baseUrl}: duplicate session ${sessionId}`);
    sessions.push({ sessionId, sessionLabel: text.replace(/の概要$/, ""), year, month, url: resolveNaraUrl(a.getAttribute("href") ?? "", baseUrl) });
  }
  if (sessions.length === 0) throw new Error(`${baseUrl}: no sessions found`);
  for (let i = 1; i < sessions.length; i++) {
    if (sessions[i - 1].year * 100 + sessions[i - 1].month < sessions[i].year * 100 + sessions[i].month) {
      throw new Error(`${baseUrl}: sessions not in descending order at ${sessions[i].sessionLabel}`);
    }
  }
  return sessions;
}

export interface SessionPage {
  /** h1 の原文から「の概要」を除いたもの（「令和8年6月定例会」） */
  sessionLabel: string;
  /** 「議員別の議案等に対する表決結果」PDF（ページの並び順）。無ければ []（会期中＝まだ議決していない） */
  pdfUrls: string[];
}

const VOTE_PDF_TEXT = /^議員別の議案等に対する表決結果/;

/** 会期ページ → 会期の原文と表決 PDF の一覧。h1 が index のリンク文言と食い違えば例外。 */
export function parseSessionPage(html: string, baseUrl: string, expected: { sessionLabel: string }): SessionPage {
  const root = parse(html);
  const contents = root.querySelector("#tmp_contents");
  if (!contents) throw new Error(`${baseUrl}: #tmp_contents not found`);
  const h1 = cleanText(contents.querySelector("h1")?.text ?? "").normalize("NFKC");
  if (h1 !== `${expected.sessionLabel}の概要`) throw new Error(`${baseUrl}: h1 "${h1}" does not match the index link "${expected.sessionLabel}の概要"`);
  const pdfUrls: string[] = [];
  for (const a of contents.querySelectorAll("a")) {
    const text = cleanText(a.text);
    if (!VOTE_PDF_TEXT.test(text)) continue;
    const href = (a.getAttribute("href") ?? "").trim();
    if (!/\.pdf$/i.test(href)) throw new Error(`${baseUrl}: 議員別の議案等に対する表決結果 link is not a PDF: ${href}`);
    const url = resolveNaraUrl(href, baseUrl);
    if (!pdfUrls.includes(url)) pdfUrls.push(url);
  }
  return { sessionLabel: h1.replace(/の概要$/, ""), pdfUrls };
}
