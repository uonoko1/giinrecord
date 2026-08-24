import { parse, type HTMLElement } from "node-html-parser";
import { cleanText, MIE_ORIGIN, resolveMieUrl, warekiYear } from "./site.ts";

/**
 * 三重県議会「議案審議結果一覧」（Issue #203）。1 ページに全会期が並ぶ。
 *   h2「令和８年定例会」（通年議会。年 1 会期が基本。令和5年のように「第２回定例会」「第１回定例会」と分かれる年、
 *   臨時会のある年（平成21年）もある）→ 議決日ごとの審議結果ページの ul → h3「議員別の賛否等の状況」→ 月別の賛否 PDF の ul。
 * sessionId は和暦から機械的に作る: 令和8年定例会 → r08、令和5年第2回定例会 → r05-2、平成21年第1回臨時会 → h21-1-rinji
 * （平成31年と令和元年がどちらも 2019 年なので、西暦だけでは一意にならない）。
 * 賛否 PDF の無い会期（平成19年以前）は載せない（公表されていない事実。推定しない）。
 */
export const SESSION_INDEX_URL = `${MIE_ORIGIN}/KENGIKAI/07976009017.htm`;

const SESSION_HEADING = /^(令和|平成)([０-９0-9]+|元)年(?:第([０-９0-9]+)回)?(定例会|臨時会)/;
const PDF_LABEL = /^(令和|平成)([０-９0-9]+|元)年([０-９0-9]+)月$/;
const PDF_HEADING = "議員別の賛否等の状況";

export interface SessionPdfLink {
  /** リンク文言の原文（「令和８年１月」） */
  label: string;
  month: number;
  url: string;
}

export interface MieSession {
  /** 和暦ベースの一意な id（r08 / r05-2 / h21-1-rinji） */
  sessionId: string;
  /** h2 の原文（「令和８年定例会」） */
  sessionLabel: string;
  year: number;
  /** 月別の賛否 PDF（ページの並び順＝月の昇順） */
  pdfs: SessionPdfLink[];
}

/** 会期 index → 賛否 PDF のある会期（新しい順）。見出し・リンクの形が崩れていれば例外（黙って読まない）。 */
export function parseSessionIndex(html: string, baseUrl: string): MieSession[] {
  const root = parse(html);
  const out: MieSession[] = [];
  const seen = new Set<string>();
  for (const h2 of root.querySelectorAll("h2")) {
    const label = cleanText(h2.text);
    const m = label.match(SESSION_HEADING);
    if (!m) continue;
    const year = warekiYear(m[1], m[2]);
    const era = m[1] === "令和" ? "r" : "h";
    const n = m[2] === "元" ? 1 : Number(m[2].normalize("NFKC"));
    let sessionId = `${era}${String(n).padStart(2, "0")}`;
    if (m[3]) sessionId += `-${Number(m[3].normalize("NFKC"))}`;
    if (m[4] === "臨時会") sessionId += "-rinji";
    if (seen.has(sessionId)) throw new Error(`${baseUrl}: duplicate session ${sessionId} (${label})`);
    seen.add(sessionId);
    // h2 の次から次の h2 までに、h3「議員別の賛否等の状況」→ 月別 PDF の ul がある（無い会期＝平成19年以前は公表が無い）
    let pdfList: HTMLElement | null = null;
    for (let el = h2.nextElementSibling; el && el.tagName !== "H2"; el = el.nextElementSibling) {
      if (el.tagName === "H3" && cleanText(el.text) === PDF_HEADING) {
        const ul = el.nextElementSibling;
        if (!ul || ul.tagName !== "UL") throw new Error(`${label}: no list after ${PDF_HEADING}`);
        pdfList = ul;
        break;
      }
    }
    if (!pdfList) continue;
    const pdfs: SessionPdfLink[] = [];
    for (const a of pdfList.querySelectorAll("a")) {
      const text = cleanText(a.text);
      const url = resolveMieUrl(a.getAttribute("href") ?? "", baseUrl);
      if (!/\.pdf$/i.test(url)) throw new Error(`${label}: 賛否 link "${text}" is not a PDF (${url})`);
      const pm = text.match(PDF_LABEL);
      if (!pm) throw new Error(`${label}: 賛否 link "${text}" is not 令和N年M月`);
      if (warekiYear(pm[1], pm[2]) !== year) throw new Error(`${label}: 賛否 link "${text}" is not in ${year}`);
      const month = Number(pm[3].normalize("NFKC"));
      if (month < 1 || month > 12) throw new Error(`${label}: bad month in "${text}"`);
      if (pdfs.some((p) => p.month === month)) throw new Error(`${label}: duplicate month in "${text}"`);
      pdfs.push({ label: text, month, url });
    }
    if (pdfs.length === 0) throw new Error(`${label}: ${PDF_HEADING} has no links`);
    out.push({ sessionId, sessionLabel: label, year, pdfs });
  }
  if (out.length === 0) throw new Error(`${baseUrl}: no sessions with 賛否 PDF found`);
  for (let i = 1; i < out.length; i++) {
    if (out[i - 1].year < out[i].year) throw new Error(`${baseUrl}: sessions not in descending year order at ${out[i].sessionLabel}`);
  }
  return out;
}
