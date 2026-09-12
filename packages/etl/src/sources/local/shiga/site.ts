import type { Assembly } from "@seiji-kiroku/shared";

/**
 * 滋賀県議会（Issue #741、地方議会 8 議会目）。取得先は県議会の公式ホストだけ（許可リスト）。
 * すべての出力レコードの sourceUrl はこのホストに限る（validateLocalAssemblies）。
 *
 * robots.txt（2026-09-13 取得、1,621 B）の `User-agent: *` ブロックが Disallow するのは
 * `/voices/cgi/`・`/voices2/cgi/`・`/gikai/cgi/`、`g07_Video*_View*.asp` / `g08_Video*_View*.asp`（映像）、
 * `/voices/gikaidoc/index.html` と `index2.html`（および `/gikai/` 配下の同名）だけ。
 * 名簿（`/g07_giinlistP.asp`）・年ページ（`/voices/g07_Congress.asp`）・会期ページ（`/g07_gian_sanpi.asp`）・
 * 賛否 PDF（`/voices/GikaiDoc/attach/Congress/*.pdf`）は **どの Disallow の下でもない**（実測。#741）。
 * 取得のたびに robots.txt を読んで従う（polite-fetch.ts）。
 *
 * 「著作権・リンク等」（`/copyright.asp`、2026-09-13 取得）に機械取得を禁じる文言は無い。原文（抜粋）:
 *   「『滋賀県議会ホームページ』の利用者は、私的使用その他法律で認める範囲内において使用する場合にのみ、
 *     個々の情報をダウンロード等により複製することができます。」
 * この ETL が公開するのは**採決の賛否という事実**であって PDF の表現ではない
 * （docs/DATA_CONTRACT.md「一次資料の取得と再公開（#537）」）。
 *
 * **このサイトは Shift_JIS**（`charset=shift_jis`）。HTML は `textShiftJis` で読む。
 */
export const SHIGA_HOST = "www.shigaken-gikai.jp";
export const SHIGA_ORIGIN = `https://${SHIGA_HOST}`;
/** 議員名簿（五十音順、1 ページ）。Assembly.sourceUrl */
export const SHIGA_ROSTER_URL = `${SHIGA_ORIGIN}/g07_giinlistP.asp`;
/** 本会議の開催状況（年の一覧。ここから年ページを辿る） */
export const SHIGA_YEAR_INDEX_URL = `${SHIGA_ORIGIN}/voices/g07_Congress.asp?YMSel=9999`;

/**
 * 年ページ。**2 通りある**（実測 #741）:
 *   - `Tmode` 無し ＝ **年度**（4月〜翌3月）
 *   - `Tmode=0` ＝ **暦年**（1月〜12月）
 * **片方だけでは会期が落ちる**（2012 年は年度版で 1 会期・暦年版で 6 会期、
 * 2014 年は年度版で 6 会期・暦年版で 1 会期。2026 年は年度版に 7月定例会議があり暦年版に無い）。
 * **両方読んで KaigiID の和を取る**と 81 会期・147 本になり、#680 が数えた本数と一致する。
 */
export const shigaYearUrl = (year: number, mode: "fiscal" | "calendar"): string =>
  mode === "calendar" ? `${SHIGA_ORIGIN}/voices/g07_Congress.asp?Y1=${year}&Tmode=0` : `${SHIGA_ORIGIN}/voices/g07_Congress.asp?Y1=${year}`;
/** 会期の賛否ページ。**`KaigiID` は年ページから拾うしかない**（連番に見えて飛ぶので組み立てない。#670） */
export const shigaSanpiUrl = (kaigiId: number): string => `${SHIGA_ORIGIN}/g07_gian_sanpi.asp?KaigiID=${kaigiId}`;

export const SHIGA_ASSEMBLY: Assembly = {
  id: "pref-25",
  kind: "prefectural",
  name: "滋賀県議会",
  prefCode: "25",
  sourceUrl: SHIGA_ROSTER_URL,
};

/** 相対 URL を県議会の公式ホストの絶対 URL にする。別ホストなら例外（取得先の許可リスト）。フラグメントは落とす。 */
export function resolveShigaUrl(href: string, base: string): string {
  const url = new URL(href.trim(), base);
  if (url.protocol !== "https:" || url.host !== SHIGA_HOST) throw new Error(`URL not on ${SHIGA_HOST}: ${url.href}`);
  url.hash = "";
  return url.href;
}

/** HTML の実体参照と空白を寄せる（&nbsp; → 半角空白、全角空白も含め連続空白は半角 1 つ、前後は削る）。 */
export function cleanText(s: string): string {
  return s
    .replace(/&nbsp;| /g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[\s　]+/g, " ")
    .trim();
}

/** 和暦（令和N年・平成N年。全角数字も）→ 西暦。元年は 1。 */
export function warekiYear(era: string, n: string): number {
  const num = n === "元" ? 1 : Number(n.normalize("NFKC"));
  if (!Number.isInteger(num) || num < 1) throw new Error(`bad wareki year ${era}${n}`);
  if (era === "令和") return 2018 + num;
  if (era === "平成") return 1988 + num;
  throw new Error(`unknown era ${era}`);
}

export const isoDate = (y: number, m: number, d: number): string => {
  if (m < 1 || m > 12 || d < 1 || d > 31) throw new Error(`date out of range ${y}-${m}-${d}`);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};
