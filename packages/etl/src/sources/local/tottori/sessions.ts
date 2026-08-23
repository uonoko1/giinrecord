import { parse } from "node-html-parser";
import { cleanText, resolveTottoriUrl, TOTTORI_ORIGIN } from "./site.ts";

/**
 * 鳥取県議会の会期の入口（Issue #184）。
 *   「定例会・臨時会の概要」/87621.htm: 年ごとの h2「◆令和８年」の下に「9月定例会 ／ 6月定例会 ／ 2月定例会」のリンク（新しい年・新しい月が先）。
 *   会期ページ（「令和8年6月定例会の日程」）: サブメニューに「議案等の議決結果」のリンク。まだ議決していない会期には無い。
 *   議決結果ページ: 知事提出議案・議員提出議案・請願陳情の表。議決結果の列のリンク文言は「6月29日可決」（議決日＋結果）で、
 *   リンク先が議員別の賛否を載せた PDF。請願・陳情の節には「議員別の賛否の状況」のリンクもある。陳情ごとの「不採択(pdf)」は
 *   陳情の文書であって賛否表ではないので取らない。
 * 会期 id は議会に通算回次の表記が無いので「{西暦}-{月2桁}」（臨時会は「-rinji」を付ける）。ラベルは見出しとリンク文言を NFKC で寄せた「令和8年6月定例会」。
 */
export const SESSION_INDEX_URL = `${TOTTORI_ORIGIN}/87621.htm`;

export interface SessionLink {
  /** 議会内で一意（「2026-06」「2023-08-rinji」） */
  sessionId: string;
  /** 「令和8年6月定例会」 */
  sessionLabel: string;
  /** 会期ページ（日程） */
  url: string;
}

/** 「令和8年」「平成31(令和元)年」（NFKC 後）。括弧があればその中の元号表記をラベルに使う（同じ年） */
const YEAR_HEADING = /(令和|平成)(\d+|元)(?:\((令和|平成)(\d+|元)\))?年/;
const SESSION_TEXT = /^(\d{1,2})月(定例会|臨時会)$/;

function westernYear(era: string, n: string): number {
  const v = n === "元" ? 1 : Number(n);
  return era === "令和" ? 2018 + v : 1988 + v;
}

/** 会期 index → 新しい順の会期。年の見出しが読めない・会期が無い・id が重複すれば例外。 */
export function parseSessionIndex(html: string, baseUrl: string): SessionLink[] {
  const root = parse(html);
  const out: SessionLink[] = [];
  const seen = new Set<string>();
  for (const h2 of root.querySelectorAll("h2")) {
    const heading = cleanText(h2.text).normalize("NFKC");
    if (!heading.startsWith("◆")) continue;
    const ym = heading.match(YEAR_HEADING);
    if (!ym) throw new Error(`year heading not readable: ${heading}`);
    const year = westernYear(ym[1], ym[2]);
    if (ym[3] && westernYear(ym[3], ym[4]) !== year) throw new Error(`year heading inconsistent: ${heading}`);
    const eraLabel = ym[3] ? `${ym[3]}${ym[4]}年` : `${ym[1]}${ym[2]}年`;
    // 見出しの次の h2 までの a 要素（同じ親の中を順に見る）
    for (let el = h2.nextElementSibling; el && el.tagName !== "H2"; el = el.nextElementSibling) {
      for (const a of el.tagName === "A" ? [el] : el.querySelectorAll("a")) {
        const text = cleanText(a.text).normalize("NFKC").replace(/\s+/g, "");
        const m = text.match(SESSION_TEXT);
        if (!m) continue;
        const month = Number(m[1]);
        if (month < 1 || month > 12) throw new Error(`${heading} ${text}: month out of range`);
        const sessionId = `${year}-${String(month).padStart(2, "0")}${m[2] === "臨時会" ? "-rinji" : ""}`;
        if (seen.has(sessionId)) throw new Error(`duplicate session ${sessionId} (${heading} ${text})`);
        seen.add(sessionId);
        out.push({ sessionId, sessionLabel: `${eraLabel}${month}月${m[2]}`, url: resolveTottoriUrl(a.getAttribute("href") ?? "", baseUrl) });
      }
    }
  }
  if (out.length === 0) throw new Error("no sessions found in session index");
  return out;
}

/** 会期ページ → 「議案等の議決結果」のリンク。無ければ undefined。2 本以上なら例外。 */
export function parseSessionPage(html: string, baseUrl: string): string | undefined {
  const root = parse(html);
  const links = root.querySelectorAll("a").filter((a) => cleanText(a.text) === "議案等の議決結果");
  const urls = [...new Set(links.map((a) => resolveTottoriUrl(a.getAttribute("href") ?? "", baseUrl)))];
  if (urls.length > 1) throw new Error(`${baseUrl}: expected one 議案等の議決結果 link, got ${urls.length}`);
  return urls[0];
}

const DATED_RESULT = /^\d{1,2}月\d{1,2}日/;

/** 議決結果ページ → 見出しと賛否 PDF の URL（文書順・重複なし）。 */
export function parseResultsPage(html: string, baseUrl: string): { title: string; pdfUrls: string[] } {
  const root = parse(html);
  const contents = root.querySelector("#ContentPane") ?? root;
  const title = cleanText(root.querySelector("h1")?.text ?? "");
  const urls: string[] = [];
  for (const a of contents.querySelectorAll("a")) {
    const text = cleanText(a.text).normalize("NFKC");
    const href = a.getAttribute("href") ?? "";
    if (!/\.pdf$/i.test(href.trim())) continue;
    if (!DATED_RESULT.test(text) && !text.startsWith("議員別の賛否の状況")) continue;
    const url = resolveTottoriUrl(href.trim(), baseUrl);
    if (!urls.includes(url)) urls.push(url);
  }
  return { title, pdfUrls: urls };
}
