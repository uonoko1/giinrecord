import { parse } from "node-html-parser";
import { cleanText, resolveAomoriUrl, warekiYear } from "./site.ts";

/**
 * 青森県議会の審査結果 index（Issue #750）。**1 ページに全会期が並ぶ**（中間ページは無い）:
 *   <h2 class="title03">令和8年度</h2>
 *   <h3 clsss="subt01">令和8年6月第326回定例会</h3>     ← **class の綴りが `clsss`**（原文のまま）
 *   <div class="textleft">
 *     <a href="files/326teirei_sanpi.pdf">知事提出議案・議員提出議案議決結果[496KB]</a>
 *     <a href="files/326_giinhatugian.pdf">議員提出議案の内容[848KB]</a>   ← **議決結果ではない**
 *   </div>
 *
 * ## **URL を組み立てない**（#529 が index の 160 本から 37 通りの綴りを数えた）
 * `326teirei_sanpi.pdf` / `307teirei_sanpi_2.pdf` / `96rinji_sanpi.pdf` / `297_sanpi.pdf` /
 * `289_sannpi.pdf`（綴り違い）/ `giketukekka_288.pdf`（s 抜け）/ `275_25.09giketsukekka.pdf` …。
 * **必ず index のリンクから拾う。**
 *
 * ## **リンクの選び方はリンク文言**（ファイル名では選べない）
 * **`sanpi` / `sannpi` を名前に持つのは 41 本だけで、残り 15 本は `giketsukekka` 系**（#743）。
 * **リンク文言に「議決結果」を含むもの**を採ると **56 本**になり、#743 が取得した本数と一致する。
 * 文言は `知事提出議案・議員提出議案議決結果` / `知事提出議案議決結果` /
 * `知事提出議案・議員提出議案・請願・陳情議決結果` などに揺れ、
 * **末尾に `[496KB]` `[PDF.94KB]` が付く会期と付かない会期がある**ので「で終わる」で見ない。
 * **`議員提出議案の内容` は「議決結果」を含まない**ので入らない。
 *
 * ## 会期の見出し
 * `令和8年6月第326回定例会`（56 本すべてこの形。実測）。
 * **PDF には年（和暦）が無い会期が 4 本**（`298` `299` `300` `94rinji`）、
 * **回次が無い会期が 1 本**（`297_sanpi.pdf`）ある（#743）ので、**年も回次もここから採る。**
 * `sessionId` は `{西暦}-{月2桁}`（臨時会は `-rinji`。鳥取・奈良・高知・滋賀と同じ規則）。
 *
 * ## **第275回より前は個人別ではない**
 * index の注記（原文）: `※平成25年9月第275回定例会から、議決結果は議員ごとの賛否状況を掲載しています。`
 * **第274回は会派別で、罫線 0 本・表ではない**（#529 が実際に開いて確かめた）。
 * **個人別でない会期を個人票として読むと、全員ぶんの記録が嘘になる**ので、
 * **回次が 275 未満の定例会は返さない。**
 * 臨時会（第93〜96回）は回次の数え方が別系列なので、**年月で切る**（平成25年9月以降）。
 */

export interface SessionLink {
  /** 議会内で一意: 西暦-月（「2026-06」。臨時会は「-rinji」付き） */
  sessionId: string;
  /** index の見出しの原文（「令和8年6月第326回定例会」） */
  sessionLabel: string;
  year: number;
  month: number;
  /** 回次（「第326回」の 326）。定例会・臨時会それぞれ別系列 */
  round: number;
  /** 定例会か臨時会か（原文） */
  kind: string;
  /** 議決結果 PDF（1 会期に 1 本。複数あれば並び順のまま） */
  pdfUrls: string[];
}

/** 会期の見出し「令和8年6月第326回定例会」 */
const SESSION_HEADING = /^(令和|平成|昭和)\s*([０-９0-9]+|元)年\s*([０-９0-9]+)月\s*第\s*([０-９0-9]+)\s*回\s*(.+)$/;
/** **個人別の賛否が載る最初の定例会**（index の注記。#529 が第274回・第275回の両方を開いて確かめた） */
export const FIRST_PERSONAL_ROUND = 275;
/** 第275回定例会の年月（臨時会はこの年月で切る。回次が別系列なので回次では切れない） */
export const FIRST_PERSONAL_YEAR = 2013;
export const FIRST_PERSONAL_MONTH = 9;

/**
 * index → 個人別の議決結果 PDF を持つ会期（**ページの並び順＝新しい順のまま**）。
 * **見出しの下の `<div>` に並ぶリンクのうち、文言に「議決結果」を含むものだけ**を採る。
 */
export function parseIndex(html: string, baseUrl: string): SessionLink[] {
  const root = parse(html);
  const out: SessionLink[] = [];
  const seen = new Set<string>();
  // 文書順に見出しとリンクの入れ物を並べ、見出しの直後の div をその会期のものとする。
  // **`class` の綴りが `clsss="subt01"` と壊れている**ので、class では選ばずタグ名で選ぶ。
  const nodes = root.querySelectorAll("h3, div.textleft");
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].tagName !== "H3") continue;
    const heading = cleanText(nodes[i].text);
    const m = heading.match(SESSION_HEADING);
    if (!m) continue;
    const box = nodes[i + 1]?.tagName === "DIV" ? nodes[i + 1] : undefined;
    if (!box) continue;
    const year = warekiYear(m[1], m[2]);
    const month = Number(m[3].normalize("NFKC"));
    const round = Number(m[4].normalize("NFKC"));
    const kind = m[5];
    if (month < 1 || month > 12) throw new Error(`${heading}: bad month`);
    // **第275回より前は会派別**（docblock）。定例会は回次で、臨時会は年月で切る
    const isTeirei = kind.startsWith("定例");
    if (isTeirei ? round < FIRST_PERSONAL_ROUND : year * 100 + month < FIRST_PERSONAL_YEAR * 100 + FIRST_PERSONAL_MONTH) continue;
    const pdfUrls: string[] = [];
    for (const a of box.querySelectorAll("a")) {
      const href = a.getAttribute("href");
      if (!href || !/\.pdf$/i.test(href)) continue;
      // **文言で選ぶ**（ファイル名では選べない。docblock）
      if (!cleanText(a.text).includes("議決結果")) continue;
      const url = resolveAomoriUrl(href, baseUrl);
      if (pdfUrls.includes(url)) continue;
      pdfUrls.push(url);
    }
    if (pdfUrls.length === 0) continue; // 議決結果 PDF がまだ載っていない会期（会期中）
    const sessionId = `${year}-${String(month).padStart(2, "0")}${isTeirei ? "" : "-rinji"}`;
    if (seen.has(sessionId)) throw new Error(`sessionId ${sessionId} が 2 回出た（${heading}）`);
    seen.add(sessionId);
    out.push({ sessionId, sessionLabel: heading, year, month, round, kind, pdfUrls });
  }
  if (out.length === 0) throw new Error("index に個人別の議決結果 PDF が 1 本も無い");
  return out;
}
