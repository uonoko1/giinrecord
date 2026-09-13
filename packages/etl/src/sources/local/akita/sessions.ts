import { parse } from "node-html-parser";
import { AKITA_HUB_URL, AKITA_YEARS_URL, cleanText, resolveAkitaUrl } from "./site.ts";

/**
 * 秋田県議会の会期の索引（Issue #759）。**索引は 2 段ある**（#753 が #615 の行き詰まりを解いた）:
 *
 * 1. **`/doc/2018051000199/`（定例会・臨時会の概要）**——最新の年度ぶんの PDF ＋ 下の 2 へのリンク
 * 2. **`/doc/2018051000205/`（平成18年〜前年の一覧）**——**20 の年度ページへのリンク**
 *
 * **カテゴリページ（`/category/category/gaiyou/`）の記事一覧は空**なので使えない（#753 が実測。
 * `<ul class="feed">` の下に記事が 1 本も無く、RSS も 300 B の空チャンネル）。
 * **#615 は「トップページの新着情報からたまたま見つけた形」と書いたが、本文側のリンクからたどれる。**
 *
 * ## **PDF は 154 本。数え方で 2 / 22 / 154 と変わる**（#748 と同じ罠。#753 が数えた）
 * **年度ページ 21 本にある `.pdf` リンクのうち、賛否 PDF は 154 本である。**
 *
 * - **`<a>` のテキストに「表決状況」を含むもので数えると 22 本にしかならない**——
 *   **令和6年以降の 3 年度だけが `各議員の表決状況はこちら（…版）` と `<a>` の中に書き、
 *   それ以前は `<a>` が `こちら（平成２９年１２月２２日版）` だけで、
 *   「各議員の表決状況は」が `<a>` の外（直前の地の文）にある**（#753）。
 * - **`<a>` の直前の地の文を見れば 154 本すべてが拾える。**
 * - **`.pdf` リンクをそのまま数えると 176 本**（実測 2026-09-13）——
 *   **各年度ページのサイドバーに `SNS_unyouhoushin_R071010.pdf`（SNS 運用方針）が 1 本ある**（21 本ぶん）。
 *   **記事本文の中だけを見ることで落ちる。**
 * - **重複を除かないと 155 本になる**（実測 2026-09-13。**#753 は 154 と書いた**）——
 *   **令和8年のページで `file_contents/080213.pdf` へのリンクが 2 つある**:
 *   ```html
 *   <a href="file_contents/080213.pdf">…各議員の表決状況はこちら（令和8年2月13日版</a>
 *   <a href="file_contents/080213.pdf">）</a>
 *   ```
 *   **`<a>` が閉じ括弧の前で切れていて、閉じ括弧だけの `<a>` がもう 1 つある。**
 *   **URL で重複を除くと 154 本になり、#753 の数と一致する。**
 *
 * ## **URL を組み立てない**（#615 の結論を #753 が 154 本で確かめた）
 * **URL の形は 16 通りある**（`h######giketu.pdf` 68 / `######giketu.pdf` 30 /
 * `R######hyoketsu.pdf` 15 / `file_contents/######.pdf` 11 / … `giketu` / `giketsu` / `hyoketsu` /
 * `hyouketsu` と綴りまで揺れる）。**必ず年度ページのリンクから拾う。**
 * **`http://` と `https://` が混在する**（`resolveAkitaUrl` が `https:` に寄せる）。
 *
 * ## **平成22年以前は PDF が無い**（#753 が実測）
 * **5 つの年度ページ（平成18〜22）には `.pdf` リンクが 1 本も無い。**
 * **遡れるのは平成23年12月からである。**
 *
 * ## **会期の見出しは `sessionId` に使えない**（実測 2026-09-13）
 * **リンクの前の地の文にある会期の名前は形が揃っていない**——
 * **154 本のうち 8 本が `(元号)N年第M回(定例会|臨時会)` の形にならない**:
 *   - `平成２８年第１定例会《２月２９日本会議》`（**`回` が無い**）
 *   - `平成２３年９月定例会《１２月２２日本会議》`（**`第M回` が無く、月が付く**）
 * **だから `sessionId` は PDF 自身の議決日から作る**（`rollcalls.ts`）——
 * **議決日は 154 / 154 本の本文の `M月D日` 列にあり、和暦の年も見出しにある**（#753）。
 * **ここが返すのは「どの年度ページのどのリンクか」という事実だけである。**
 */

export interface PdfLink {
  /** 賛否 PDF の絶対 URL（`https:` に寄せてある） */
  url: string;
  /** 年度ページの URL（会期の出典） */
  sourceUrl: string;
  /** 年度ページの見出しの原文（`定例会・臨時会の概要【令和6年】`）。無ければ空 */
  yearLabel: string;
  /** リンクの文言 ＋ 直前の地の文（原文。`sessionLabel` の素材。**推定はしない**） */
  linkText: string;
}

/** 年度ページの見出し「定例会・臨時会の概要【令和6年】」 */
const YEAR_HEADING = /定例会・臨時会の概要【([^】]+)】/;
/** **賛否 PDF であることの目印**（リンクの文言か直前の地の文にある。#753 が 154 本で確かめた） */
const VOTE_PDF_MARK = "表決状況";
/** サイドバーの SNS 運用方針 PDF（賛否 PDF ではない。21 本ある） */
const NOT_A_VOTE_PDF = /SNS_unyouhoushin/;

/**
 * 索引の 2 段目（年度の一覧）→ 年度ページの URL（**重複を除いて、ページの並び順のまま**）。
 * **1 段目（概要ハブ）にも最新年度のリンクがある**ので、両方を渡して合わせる。
 * **`#R7` のようなフラグメントは落とす**（`resolveAkitaUrl`）ので、同じ年度ページは 1 本になる。
 */
export function parseYearPages(htmls: readonly { html: string; baseUrl: string }[]): string[] {
  const out: string[] = [];
  for (const { html, baseUrl } of htmls) {
    const root = parse(html);
    const art = root.querySelector("article.contentGpArticleDoc");
    if (!art) continue; // 記事本文が無いページ（ありえないが、黙って進まない）
    for (const a of art.querySelectorAll("a")) {
      const href = a.getAttribute("href");
      if (!href) continue;
      // **`/doc/{13桁}/` の形だけ**（`/doc/XXXXXXXXXXXXX/` のような未設定のリンクがページにある）
      if (!/\/doc\/\d{13}\/?(#|$)/.test(href)) continue;
      let url: string;
      try { url = resolveAkitaUrl(href, baseUrl); } catch { continue; } // 別ホストのリンクは飛ばす
      if (url === baseUrl) continue; // 自分自身
      if (!out.includes(url)) out.push(url);
    }
  }
  if (out.length === 0) throw new Error("年度ページへのリンクが 1 本も無い");
  return out;
}

/**
 * 年度ページ → 賛否 PDF のリンク（**重複を除いて、ページの並び順のまま**）。
 *
 * **賛否 PDF の見分け方は「リンクの文言か直前の地の文に `表決状況` があるか」**（docblock）。
 * **`<a>` の中だけを見ると 22 本にしかならない**（#753）。
 * **直前の地の文は 400 字ぶん見る**——**実測でいちばん遠いものが 120 字**（議案の一覧が挟まる）。
 * **記事本文の中だけを見る**（サイドバーの SNS 運用方針 PDF を拾わない。21 本ある）。
 */
export function parseYearPage(html: string, baseUrl: string): PdfLink[] {
  const root = parse(html);
  const art = root.querySelector("article.contentGpArticleDoc");
  if (!art) return [];
  const yearLabel = cleanText(root.querySelectorAll("h1").map((h) => h.text).find((t) => YEAR_HEADING.test(t)) ?? "");
  // **地の文は「記事本文のテキスト」から見る**（タグをまたぐので、要素単位では見えない）
  const body = art.innerHTML;
  const out: PdfLink[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/<a[^>]*href="([^"]*\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1];
    if (NOT_A_VOTE_PDF.test(href)) continue;
    const linkText = cleanText(parse(`<div>${m[2]}</div>`).text);
    const before = cleanText(parse(`<div>${body.slice(Math.max(0, m.index - 400), m.index)}</div>`).text);
    if (!linkText.includes(VOTE_PDF_MARK) && !before.includes(VOTE_PDF_MARK)) continue;
    let url: string;
    try { url = resolveAkitaUrl(href, baseUrl); } catch { continue; }
    // **同じ PDF への 2 本目のリンクは飛ばす**（`080213.pdf` は `<a>` が閉じ括弧の前で切れている。docblock）
    if (seen.has(url)) continue;
    seen.add(url);
    // **文言は「地の文の末尾 ＋ リンクの文言」**（会期の名前は地の文の側にある本がある。docblock）
    out.push({ url, sourceUrl: baseUrl, yearLabel, linkText: cleanText(`${before.slice(-120)} ${linkText}`) });
  }
  return out;
}

/** 索引の 1 段目・2 段目の URL（`index.ts` が取りに行く順）。 */
export const INDEX_URLS = [AKITA_HUB_URL, AKITA_YEARS_URL] as const;
