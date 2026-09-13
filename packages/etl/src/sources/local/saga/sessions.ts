import { parse, type HTMLElement } from "node-html-parser";
import { cleanText, resolveSagaUrl, SAGA_INDEX_URL, warekiYear } from "./site.ts";

/**
 * 佐賀県議会の会期の索引（Issue #768）。**5 階層下りる:**
 * ```
 *   /gikai/list01707.html              議案等の審議結果（年の一覧）
 *     → /gikai/list06635.html          令和8年
 *       → /gikai/list06636.html        定例会（/ list06670 臨時会 / 決算特別委員会 / 閉会中の委員会審議）
 *         → /gikai/list06680.html      令和8年6月定例会
 *           → /gikai/kiji003119791/    議案件名一覧表（**ここに初めて「議員ごとの採決結果」が出る**）
 *             → …up_cda325jj.pdf       賛否 PDF
 * ```
 * **#670 が書いたとおり、リンクの名前は会期ページからは見えない。1 階層下りないと分からない。**
 *
 * ## **左のサイドバーを読んではいけない**（この PR が実測した罠）
 * **どのページにも、その年のすべての会期とその下の記事が展開された `LeftArea` がある。**
 * **ページ全体の `<a>` を読むと、令和8年9月定例会のページから令和8年2月・6月の
 * 議案件名一覧表が拾える**（実測: `list06701.html` の `<a>` に `kiji003117512`（2月）が出る）。
 * **必ず `div.RightArea`（一覧ページ）または `div#mainShosai`（記事ページ）の中だけを読む。**
 *
 * ## **#689 の罠 7（別会期の票が付く）は、いま起きない。ただし塞いである**
 * **#689（2026-09-09）は「令和8年9月定例会のページに令和8年2月の議案件名一覧表が出る」と
 * 記録した。** **2026-09-13 に見ると出ない**——**9月定例会の下は `list06730`〜`list06738` という
 * 空の一覧ページに変わっており、議案件名一覧表（`list06732`）の中身は空である**（実測）。
 * **サイドバーを読まなければ、そもそも別会期の記事は拾わない。**
 * **そのうえで `index.ts` が PDF の表題と会期名を突き合わせる**（二重の守り）。
 *
 * ## **議案件名一覧表への導線は 3 通りある**（実測、67 会期）
 *   1. **記事ページに直接**（`kiji003119791/index.html`）——**ほとんどの会期**
 *   2. **`議案件名一覧`（`表` が無い）**——令和4年11月定・令和4年1月臨の 2 会期
 *   3. **一覧ページを 1 枚はさむ**（`list04388.html` → `kiji00375147/index.html`）——令和2年6月定の 1 会期
 * **`議案件名一覧表` の完全一致で拾うと 3 会期が落ちる**（うち 1 会期は読める PDF ではないが、
 * **「落ちたことに気づけない」のが問題**）。**前方一致 `議案件名一覧` にし、一覧ページなら 1 階層下りる。**
 *
 * ## **賛否 PDF のリンクの文言は 6 通りある**（実測、63 会期）
 * `議員ごとの採決結果` 49 / `採決結果` 5 / `こちら` 2 / `議員ごとの採決結果はこちら` 2 /
 * `個人ごとの採決結果` 1 / `採決結果一覧` 1、**さらに文言が空のもの**（PDF アイコンだけの `<a>`）。
 * **文言では選べない。** **議案件名一覧表のページにある `.pdf` を全部候補にし、
 * URL で重複を除いて、読めた PDF だけを採る**（読めない PDF は `unreadableSources` に残る）。
 * **同じ PDF が 2 つの URL で配られることがある**（#670 が 議案件名一覧表 と 意見書案件名一覧表 で実測）が、
 * **意見書案側は開かない**ので、この実装ではぶつからない。
 */

export interface SessionLink {
  /** 会期の名前の原文（`令和8年6月定例会`） */
  sessionLabel: string;
  /** `sessionId`（`2026-06-teirei` の形。**PDF の表題ではなく会期ページの名前から作る**） */
  sessionId: string;
  /** 会期ページの URL（`sources` に出す） */
  sessionUrl: string;
  /** 会期の西暦の年 */
  year: number;
  /** 会期の月 */
  month: number;
  /** 定例会 / 臨時会 / そのほか（原文） */
  kind: string;
}

/** 年の一覧のリンク（`令和8年` `令和元年・平成31年`） */
const YEAR_LINK = /^(令和|平成)/;
/** 種別の一覧（この 4 つだけ。**決算特別委員会と閉会中の委員会審議には賛否 PDF が無い**が、開いて確かめる） */
const CATEGORIES = new Set(["定例会", "臨時会", "決算特別委員会", "閉会中の委員会審議"]);
/** 会期の名前（`令和8年6月定例会` / `令和5年5月臨時会（5月9日から11日まで）` / `平成27年11月　決算特別委員会`） */
const SESSION_LABEL = /^(令和|平成)([元０-９0-9]+)年\s*([０-９0-9]{1,2})月\s*(定例会|臨時会|決算特別委員会)/;

/** 一覧ページの本文（`div.RightArea`）または記事ページの本文（`div#mainShosai`）。サイドバーを読まない。 */
export function mainArea(html: string): HTMLElement | undefined {
  const root = parse(html);
  return root.querySelector("div.RightArea") ?? root.querySelector("div#mainShosai") ?? undefined;
}

/** 本文の中のリンク（`[絶対URL, 文言]`）。別ホスト（機械翻訳のミラー）は落とす。 */
export function mainLinks(html: string, baseUrl: string): { url: string; text: string }[] {
  const area = mainArea(html);
  if (!area) return [];
  const out: { url: string; text: string }[] = [];
  for (const a of area.querySelectorAll("a")) {
    const href = a.getAttribute("href");
    if (!href || href.startsWith("javascript:")) continue;
    let url: string;
    try { url = resolveSagaUrl(href, baseUrl); } catch { continue; }
    out.push({ url, text: cleanText(a.text) });
  }
  return out;
}

/** 記事ページの表題（`<h1 class="title">令和8年6月定例会　議案件名一覧表</h1>`）。 */
export function articleTitle(html: string): string {
  return cleanText(mainArea(html)?.querySelector("h1.title")?.text ?? "");
}

/** 議案等の審議結果（年の一覧）→ 年ページの URL（ページの並び順、重複なし）。 */
export function parseIndex(html: string): string[] {
  const out: string[] = [];
  for (const { url, text } of mainLinks(html, SAGA_INDEX_URL)) {
    if (!YEAR_LINK.test(text)) continue;
    if (!out.includes(url)) out.push(url);
  }
  if (out.length === 0) throw new Error(`${SAGA_INDEX_URL}: 年ページへのリンクが 1 本も無い`);
  return out;
}

/** 年ページ → 種別ページ（定例会・臨時会…）の URL。 */
export function parseYearPage(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const { url, text } of mainLinks(html, baseUrl)) {
    if (!CATEGORIES.has(text)) continue;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/** 種別ページ → 会期。**`令和8年6月定例会` のような名前のリンクだけ**。 */
export function parseCategoryPage(html: string, baseUrl: string): SessionLink[] {
  const out: SessionLink[] = [];
  for (const { url, text } of mainLinks(html, baseUrl)) {
    const m = SESSION_LABEL.exec(text.replace(/[\s　]+/g, ""));
    if (!m) continue;
    if (out.some((s) => s.sessionUrl === url)) continue;
    const year = warekiYear(m[1], m[2]);
    const month = Number(m[3].normalize("NFKC"));
    const kind = m[4];
    // **同じ年月に臨時会が 2 本ある会期がある**（令和5年5月、平成27年5月）ので、
    // **会期ページの番号を id に混ぜて区別する**（名前の括弧書きは長すぎるし字がぶれる）
    const page = /\/(list\d+|kiji\d+)(?:\/index)?\.html$/.exec(url)?.[1] ?? "";
    const suffix = kind === "定例会" ? "teirei" : kind === "臨時会" ? "rinji" : "sonota";
    out.push({ sessionLabel: text, sessionId: `${year}-${String(month).padStart(2, "0")}-${suffix}-${page}`, sessionUrl: url, year, month, kind });
  }
  return out;
}

/** 会期ページ → 議案件名一覧表（の URL）。**前方一致**（`表` が無い会期がある。docblock）。 */
export function parseSessionPage(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const { url, text } of mainLinks(html, baseUrl)) {
    if (!text.startsWith("議案件名一覧")) continue;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/**
 * 議案件名一覧表のページ → 賛否 PDF（の URL）と、さらに下の議案件名一覧ページ。
 * **`.pdf` はすべて候補**（文言では選べない。docblock）。**重複は URL で除く。**
 */
export function parseGianPage(html: string, baseUrl: string): { pdfs: string[]; next: string[] } {
  const pdfs: string[] = [];
  const next: string[] = [];
  for (const { url, text } of mainLinks(html, baseUrl)) {
    if (/\.pdf$/i.test(new URL(url).pathname)) { if (!pdfs.includes(url)) pdfs.push(url); continue; }
    if (text.includes("議案件名一覧") && !next.includes(url)) next.push(url);
  }
  return { pdfs, next };
}
