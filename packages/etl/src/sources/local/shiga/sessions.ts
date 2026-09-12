import { parse } from "node-html-parser";
import { cleanText, resolveShigaUrl, warekiYear } from "./site.ts";

/**
 * 滋賀県議会の会期 index（Issue #741）。3 段:
 *   1. 年の一覧 `/voices/g07_Congress.asp?YMSel=9999` → 年ページの URL（`Y1=2012` …）
 *   2. 年ページ `/voices/g07_Congress.asp?Y1={年}&Tmode=0` → `<h2>平成２４年　１１月定例会</h2>` と
 *      その直後の `<ul>` にある `../g07_gian_sanpi.asp?KaigiID=148`（**KaigiID は飛ぶので組み立てない**。#670）
 *   3. 会期ページ `/g07_gian_sanpi.asp?KaigiID=148` → 賛否 PDF のリンク（**1 会期に複数本ある**）
 *
 * **年ページには 2 通りある**（実測 #741）——`Tmode` 無しは**年度**（4月〜翌3月）、`Tmode=0` は**暦年**。
 * どちらか片方だけでは会期が落ちる（2012 年: `Tmode` 無しで 1 会期、`Tmode=0` で 6 会期。
 * 2014 年: `Tmode` 無しで 6 会期、`Tmode=0` で 1 会期）。**両方読んで KaigiID の和を取る。**
 * 実測で 81 会期・147 本の PDF になり、#680 が数えた本数と一致する。
 *
 * 会期名は年ページの h2（「平成２４年　１１月定例会」。全角数字・全角空白のまま `sessionLabel` にする）。
 * `sessionId` は `{西暦}-{月2桁}`（臨時会・招集会議は `-rinji`。鳥取・奈良・高知と同じ規則）。
 * **定例会議／招集会議という呼び方の会期もある**（平成26年度〜。「定例会」と「定例会議」は別の表記なので
 * ラベルは原文のまま残し、id の `-rinji` は「定例」を含まない会期に付ける）。
 */

export interface SessionLink {
  /** 議会内で一意: 西暦-月（「2012-11」。臨時会・招集会議は「-rinji」付き） */
  sessionId: string;
  /** 年ページの h2 の原文（「平成２４年　１１月定例会」） */
  sessionLabel: string;
  year: number;
  month: number;
  /** 会期の賛否ページ（KaigiID 付き） */
  kaigiUrl: string;
  kaigiId: number;
}

export interface PdfLink {
  /** リンク文言の原文（「賛否状況（8月10日）」） */
  text: string;
  url: string;
}

/** 年の一覧ページの `Y1={年}` を拾う（昇順・重複なし）。 */
export function parseYearIndex(html: string): number[] {
  const years = new Set<number>();
  for (const a of parse(html).querySelectorAll("a")) {
    const m = (a.getAttribute("href") ?? "").match(/[?&]Y1=(\d{4})\b/);
    if (m) years.add(Number(m[1]));
  }
  if (years.size === 0) throw new Error("年の一覧に Y1= のリンクが 1 つも無い");
  return [...years].sort((a, b) => a - b);
}

const SESSION_HEADING = /^(令和|平成|昭和)\s*([０-９0-9]+|元)年\s*([０-９0-9]+)月\s*(.+)$/;

/**
 * 年ページ → 賛否状況のリンクがある会期。**賛否状況のリンクが無い会期は返さない**
 * （会期中、または賛否を公表していない古い会期。**公表されていない事実を作らない**）。
 * h2 と `<ul>` の対応は文書順（h2 の次に現れる `<ul>` がその会期のメニュー）。
 */
export function parseYearPage(html: string, baseUrl: string): SessionLink[] {
  const root = parse(html);
  const out: SessionLink[] = [];
  // 文書順に h2 と ul を並べ、h2 の直後の ul をその会期のメニューとする
  const nodes = root.querySelectorAll("h2, ul");
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].tagName !== "H2") continue;
    const heading = cleanText(nodes[i].text);
    const m = heading.match(SESSION_HEADING);
    if (!m) continue;
    const ul = nodes[i + 1]?.tagName === "UL" ? nodes[i + 1] : undefined;
    if (!ul) continue;
    const link = ul.querySelectorAll("a").find((a) => /g07_gian_sanpi\.asp\?KaigiID=\d+/.test(a.getAttribute("href") ?? ""));
    if (!link) continue; // 賛否状況の無い会期（会期中・古い会期）
    const href = link.getAttribute("href")!;
    const kaigiId = Number(href.match(/KaigiID=(\d+)/)![1]);
    const year = warekiYear(m[1], m[2]);
    const month = Number(m[3].normalize("NFKC"));
    if (month < 1 || month > 12) throw new Error(`${baseUrl} ${heading}: bad month`);
    // 「定例会」「定例会議」は定例、それ以外（臨時会・臨時会議・招集会議）は -rinji
    const kind = m[4];
    const sessionId = `${year}-${String(month).padStart(2, "0")}${kind.startsWith("定例") ? "" : "-rinji"}`;
    out.push({ sessionId, sessionLabel: heading, year, month, kaigiId, kaigiUrl: resolveShigaUrl(href, baseUrl) });
  }
  return out;
}

/** 会期の賛否ページ → 賛否 PDF のリンク（ページの並び順のまま。無ければ空）。 */
export function parseSanpiPage(html: string, baseUrl: string): PdfLink[] {
  const root = parse(html);
  const out: PdfLink[] = [];
  const seen = new Set<string>();
  for (const a of root.querySelectorAll("a")) {
    const href = (a.getAttribute("href") ?? "").trim();
    if (!/GikaiDoc\/attach\/Congress\/.*\.pdf$/i.test(href)) continue;
    // ファイル名に空白が入る本がある（実測 3 本）ので、URL に載せる前にエンコードする
    const url = resolveShigaUrl(href.replace(/ /g, "%20"), baseUrl);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ text: cleanText(a.text), url });
  }
  return out;
}
