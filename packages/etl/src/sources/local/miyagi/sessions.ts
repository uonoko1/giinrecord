import { parse } from "node-html-parser";
import { cleanText, MIYAGI_ORIGIN, resolveMiyagiUrl } from "./site.ts";

/**
 * 宮城県議会「過去の本会議情報」（Issue #157）。会期ごとに h2「令和N年M月定例会（第NNN回）」があり、その下の ul に
 * 「各議員の表決状況」へのリンクが 1 本ある（2013-10 より前は PDF への直リンク、2008 年以前はリンク無し。slug は hyoketu080318 / hyouketsu070314 / hyouketu-271005 / hyo-ketu378 / 030705 と揺れるので、
 * 規則性は「見出しの形」と「リンク文言が 1 本」で固定し、slug には頼らない）。
 * 会期ページは表決 PDF へのリンクを 1 本持つ。
 */
export const sessionIndexUrl = `${MIYAGI_ORIGIN}/site/kengikai/kakohonkaigi.html`;

export interface SessionLink {
  /** 通算回次（「第398回」→ "398"）。議会内で一意 */
  sessionId: string;
  /** 見出しの原文（「令和7年11月定例会（第398回）」） */
  sessionLabel: string;
  /** 「各議員の表決状況」ページ（kind: "page"、2013-10 以降）か、表決 PDF そのもの（kind: "pdf"、それ以前）。リンクの無い古い会期は載せない */
  url: string;
  kind: "page" | "pdf";
}

const SESSION_LABEL = /^(令和|平成)\d+年\d+月(定例会|臨時会)（第(\d+)回）$/;

/** 会期 index → 新しい順の会期リンク。見出しの形・リンクの規則性が崩れていれば例外（別のページを黙って読まない）。 */
export function parseSessionIndex(html: string, baseUrl: string): SessionLink[] {
  const root = parse(html);
  const out: SessionLink[] = [];
  const seen = new Set<string>();
  for (const h2 of root.querySelectorAll("h2")) {
    const label = cleanText(h2.text);
    const m = label.match(SESSION_LABEL);
    if (!m) continue;
    const list = h2.nextElementSibling;
    if (!list || list.tagName !== "UL") throw new Error(`${label}: no link list after heading`);
    const links = list.querySelectorAll("a").filter((a) => cleanText(a.text).startsWith("各議員の表決状況"));
    if (links.length > 1) throw new Error(`${label}: expected at most one 各議員の表決状況 link, got ${links.length}`);
    const sessionId = m[3];
    if (seen.has(sessionId)) throw new Error(`duplicate session ${sessionId}`);
    seen.add(sessionId);
    if (links.length === 0) continue; // 2008 年以前は表決状況の公開が無い（事実として載せない）
    const url = resolveMiyagiUrl(links[0].getAttribute("href") ?? "", baseUrl);
    const kind = /\.pdf$/i.test(url) ? "pdf" : /\/(site|soshiki)\/kengikai\/[A-Za-z0-9_-]+\.html$/.test(url) ? "page" : undefined;
    if (!kind) throw new Error(`${label}: unexpected 表決状況 URL ${url}`);
    out.push({ sessionId, sessionLabel: label, url, kind });
  }
  if (out.length === 0) throw new Error("no 各議員の表決状況 links found in session index");
  for (let i = 1; i < out.length; i++) {
    if (Number(out[i - 1].sessionId) <= Number(out[i].sessionId)) throw new Error(`session index not in descending order at ${out[i].sessionId}`);
  }
  return out;
}

/** 会期ページ（各議員の表決状況）→ 見出しと表決 PDF の URL。PDF リンクが 1 本でなければ例外。 */
export function parseSessionPage(html: string, baseUrl: string): { title: string; pdfUrl: string } {
  const root = parse(html);
  const contents = root.querySelector("#tmp_contents") ?? root;
  const title = cleanText(contents.querySelector("h1")?.text ?? "");
  const pdfs = contents.querySelectorAll("a").map((a) => a.getAttribute("href") ?? "").filter((h) => /\.pdf$/i.test(h));
  if (pdfs.length !== 1) throw new Error(`${baseUrl}: expected exactly one PDF link, got ${pdfs.length}`);
  return { title, pdfUrl: resolveMiyagiUrl(pdfs[0], baseUrl) };
}
