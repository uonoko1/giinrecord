import { parse } from "node-html-parser";
import { cleanText, KOCHI_DECISION_URL, resolveKochiUrl, warekiYear } from "./site.ts";

/**
 * 高知県議会「議員別賛否の状況」（Issue #220）。
 *   /activity/decision.html  1 ページに会期ごとの PDF が新しい順に並ぶ。
 *   リンク文言は「令和８年６月定例会議決結果一覧表[PDF：146KB]」（[PDF：…] は付いたり付かなかったりする）。
 * 奈良・三重と違って会期ごとの中間ページは無く、この index から直接 PDF を取る。
 * 会期の id は「{西暦}-{月2桁}」（例 2026-06）、臨時会は「-rinji」を足す（鳥取・奈良と同じ）。
 */
export const DECISION_URL = KOCHI_DECISION_URL;

export interface SessionLink {
  /** 議会内で一意: 西暦-月（「2026-06」。臨時会は「-rinji」付き） */
  sessionId: string;
  /** リンク文言の会期部分の原文（「令和８年６月定例会」）。sessionLabel になる */
  sessionLabel: string;
  year: number;
  month: number;
  /** 議決結果一覧 PDF */
  pdfUrl: string;
}

// 全角・半角どちらの数字も来る（「令和4年2月定例会」「令和８年６月定例会」）。表記は原文のまま残す。
// index のリンク文言は「議決結果一覧」、PDF の中の表題は「議決結果一覧表」（末尾の「表」の有無が違う）
const LINK_TEXT = /^((令和|平成)([０-９0-9]+|元)年([０-９0-9]+)月(定例会|臨時会))議決結果一覧/;

/**
 * 会期 index → 会期ごとの PDF（ページの並び順＝新しい順）。
 * 並びが新しい順でなければ例外、同じ会期が 2 回出ても例外（別のページを黙って読まない）。
 */
export function parseSessionIndex(html: string, baseUrl: string): SessionLink[] {
  const root = parse(html);
  const sessions: SessionLink[] = [];
  for (const a of root.querySelectorAll("a")) {
    const text = cleanText(a.text);
    const m = text.match(LINK_TEXT);
    if (!m) continue;
    const href = (a.getAttribute("href") ?? "").trim();
    if (!/\.pdf$/i.test(href)) throw new Error(`${baseUrl}: 議決結果一覧表 link is not a PDF: ${href}`);
    const year = warekiYear(m[2], m[3]);
    const month = Number(m[4].normalize("NFKC"));
    if (month < 1 || month > 12) throw new Error(`${baseUrl} ${text}: bad month`);
    const sessionId = `${year}-${String(month).padStart(2, "0")}${m[5] === "臨時会" ? "-rinji" : ""}`;
    if (sessions.some((s) => s.sessionId === sessionId)) throw new Error(`${baseUrl}: duplicate session ${sessionId}`);
    sessions.push({ sessionId, sessionLabel: m[1], year, month, pdfUrl: resolveKochiUrl(href, baseUrl) });
  }
  if (sessions.length === 0) throw new Error(`${baseUrl}: no sessions found`);
  for (let i = 1; i < sessions.length; i++) {
    if (sessions[i - 1].year * 100 + sessions[i - 1].month < sessions[i].year * 100 + sessions[i].month) {
      throw new Error(`${baseUrl}: sessions not in descending order at ${sessions[i].sessionLabel}`);
    }
  }
  return sessions;
}
