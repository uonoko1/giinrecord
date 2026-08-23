import { parse } from "node-html-parser";
import { cleanText, resolveTokushimaUrl, TOKUSHIMA_ORIGIN, warekiYear } from "./site.ts";

/**
 * 徳島県議会「定例会の概要」（Issue #183）。
 *   /gikai/honkaigi/gaiyou/        今年の会期（h2「令和N年 定例会の概要」、figure ごとに figcaption「M月 定例会」＋リンク「各議員の表決態度（審議の結果）」）
 *   /gikai/honkaigi/gaiyou/r07/    前年以前の年ページ（h1「令和7年 定例会の概要」。左ナビに年ページへのリンクが並ぶ）
 *   会期ページ（/gikai/honkaigi/r08/{id}/、id に規則性は無い）: h1「令和8年6月定例会 各議員の表決態度(審議の結果）」と
 *   添付「各議員の表決態度（M月D日採決）」PDF（採決日ごとに 1 本。請願審査報告書の PDF は表決ではない）。
 * 会期の id は「{西暦}-{月2桁}」（例 2026-06）。
 */
export const sessionIndexUrl = `${TOKUSHIMA_ORIGIN}/gikai/honkaigi/gaiyou/`;

export interface SessionLink {
  /** 議会内で一意: 西暦-月（「2026-06」） */
  sessionId: string;
  month: number;
  /** figcaption の原文（「6月 定例会」） */
  heading: string;
  /** 「各議員の表決態度（審議の結果）」ページ */
  url: string;
}

export interface SessionIndex {
  /** 「令和8年」 */
  yearLabel: string;
  year: number;
  /** 新しい順 */
  sessions: SessionLink[];
  /** 前年の年ページ（左ナビ）。無ければ undefined */
  previousYearUrl?: string;
}

const YEAR_HEADING = /^(令和|平成)(\d+|元)年 定例会の概要$/;
const SESSION_HEADING = /^(\d+)月 (定例会|臨時会)$/;

/** 会期 index（今年のページ・年ページ）→ 年と会期（新しい順）。見出しの形が崩れていれば例外（別のページを黙って読まない）。 */
export function parseSessionIndex(html: string, baseUrl: string): SessionIndex {
  const root = parse(html);
  const yearHeads = root.querySelectorAll("h1, h2").map((h) => cleanText(h.text)).filter((t) => YEAR_HEADING.test(t));
  if (yearHeads.length !== 1) throw new Error(`${baseUrl}: expected one year heading (令和N年 定例会の概要), got ${yearHeads.length}`);
  const ym = yearHeads[0].match(YEAR_HEADING)!;
  const year = warekiYear(ym[1], ym[2]);
  const yearLabel = `${ym[1]}${ym[2]}年`;
  const sessions: SessionLink[] = [];
  for (const fig of root.querySelectorAll("figure")) {
    const caption = fig.querySelector("figcaption");
    if (!caption) continue;
    const heading = cleanText(caption.text);
    const m = heading.match(SESSION_HEADING);
    if (!m) continue;
    const links = fig.querySelectorAll("a").filter((a) => cleanText(a.text).startsWith("各議員の表決態度"));
    if (links.length !== 1) throw new Error(`${baseUrl} ${heading}: expected exactly one 各議員の表決態度 link, got ${links.length}`);
    const month = Number(m[1]);
    if (month < 1 || month > 12) throw new Error(`${baseUrl} ${heading}: bad month`);
    const sessionId = `${year}-${String(month).padStart(2, "0")}`;
    if (sessions.some((s) => s.sessionId === sessionId)) throw new Error(`${baseUrl}: duplicate session ${sessionId}`);
    sessions.push({ sessionId, month, heading, url: resolveTokushimaUrl(links[0].getAttribute("href") ?? "", baseUrl) });
  }
  if (sessions.length === 0) throw new Error(`${baseUrl}: no sessions found`);
  for (let i = 1; i < sessions.length; i++) {
    if (sessions[i - 1].month <= sessions[i].month) throw new Error(`${baseUrl}: sessions not in descending order at ${sessions[i].heading}`);
  }
  // 前年の年ページ: 左ナビの「令和N年 定例会の概要」リンクのうち前年のもの（令和2年の前年は「平成31年・令和元年」なので見つからない → undefined）
  const prevLabel = year - 1 >= 2019 ? `令和${year - 1 - 2018}年 定例会の概要` : `平成${year - 1 - 1988}年 定例会の概要`;
  const prev = root.querySelectorAll("a").find((a) => cleanText(a.text) === prevLabel);
  const previousYearUrl = prev ? resolveTokushimaUrl(prev.getAttribute("href") ?? "", baseUrl) : undefined;
  return previousYearUrl ? { yearLabel, year, sessions, previousYearUrl } : { yearLabel, year, sessions };
}

export interface SessionPage {
  /** h1 の会期部分の原文（「令和8年6月定例会」） */
  sessionLabel: string;
  year: number;
  month: number;
  /** 採決日ごとの表決 PDF（ページの並び順） */
  pdfs: { text: string; month: number; day: number; url: string }[];
}

const H1 = /^(令和|平成)(\d+|元)年(\d+)月(定例会|臨時会)\s*各議員の表決態度/;
const PDF_TEXT = /^各議員の表決態度（(\d+)月(\d+)日採決）$/;

/** 会期ページ → 会期の原文と表決 PDF の一覧。表決態度の PDF が 1 本も無ければ例外。 */
export function parseSessionPage(html: string, baseUrl: string): SessionPage {
  const root = parse(html);
  const h1 = cleanText(root.querySelector("h1")?.text ?? "");
  const m = h1.match(H1);
  if (!m) throw new Error(`${baseUrl}: h1 "${h1}" is not 令和N年M月定例会 各議員の表決態度`);
  const year = warekiYear(m[1], m[2]);
  const month = Number(m[3]);
  const sessionLabel = `${m[1]}${m[2]}年${m[3]}月${m[4]}`;
  const pdfs: SessionPage["pdfs"] = [];
  for (const a of root.querySelectorAll("a")) {
    const href = a.getAttribute("href") ?? "";
    if (!/\.pdf$/i.test(href.trim())) continue;
    const text = cleanText(a.text);
    const pm = text.match(PDF_TEXT);
    if (!pm) continue;
    pdfs.push({ text, month: Number(pm[1]), day: Number(pm[2]), url: resolveTokushimaUrl(href, baseUrl) });
  }
  if (pdfs.length === 0) throw new Error(`${baseUrl}: no 各議員の表決態度 PDF`);
  return { sessionLabel, year, month, pdfs };
}
