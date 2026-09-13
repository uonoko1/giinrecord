import type { Assembly } from "@seiji-kiroku/shared";

/**
 * 青森県議会（Issue #750、地方議会 9 議会目）。取得先は県の公式ホストだけ（許可リスト）。
 * すべての出力レコードの sourceUrl はこのホストに限る（validateLocalAssemblies）。
 *
 * robots.txt（#529 が 2026-09-07、#743 が 2026-09-13、#749 が同日に取り直し、いずれも **97 B**・
 * md5 `d453536df0011b2e9cf5e30483f3f703`。全文 4 行）:
 *   User-Agent: *
 *   Disallow: /kensei/kojisotatsu/
 *   User-agent: ndl-japan
 *   Allow: /kensei/kojisotatsu/
 * **議決結果 PDF（`/soshiki/gikai/files/*.pdf`）も議会のページも `Disallow` の下ではない。**
 * 取得のたびに robots.txt を読んで従う（polite-fetch.ts）。
 *
 * 利用条件（`/contents/copyright.html`、更新日付 2021年4月1日、12,411 B。#743 が取り直して
 * 1 字も変わっていないことを確認）の該当部分は原文で:
 *   「これらの情報については、青森県または第三者が著作権を有しており、「私的利用のための複製」や
 *     「引用」など著作権法上認められた場合を除き、無断で複製・転用することはできません。」
 * **機械的な取得（クローリング・スクレイピング）を名指しで禁じる文言は無い。**
 * この ETL が公開するのは**採決の賛否という事実**であって PDF の表現ではない
 * （docs/DATA_CONTRACT.md「一次資料の取得と再公開（#537）」）。
 *
 * **このサイトは UTF-8**（滋賀の `textShiftJis` は使わない）。
 */
export const AOMORI_HOST = "www.pref.aomori.lg.jp";
export const AOMORI_ORIGIN = `https://${AOMORI_HOST}`;
/** 議員の紹介（会派別）。Assembly.sourceUrl。**46 人**（定数 48 とは違う。欠員がある） */
export const AOMORI_ROSTER_URL = `${AOMORI_ORIGIN}/soshiki/gikai/giin-kaiha.html`;
/** 議員の紹介（選挙区別）。**選挙区だけ**をここから補う（会派別ページに選挙区が無い） */
export const AOMORI_DISTRICT_URL = `${AOMORI_ORIGIN}/soshiki/gikai/giin-senkyoku.html`;
/**
 * 審査結果の index。**1 ページに全会期の PDF リンクが並ぶ**（会期ごとの中間ページは無い）。
 * **ファイル名に規則性が無いので URL を組み立てない**（#529 が 37 通りの綴りを数えた）。
 */
export const AOMORI_INDEX_URL = `${AOMORI_ORIGIN}/soshiki/gikai/katsudo-shinsakekka.html`;

export const AOMORI_ASSEMBLY: Assembly = {
  id: "pref-02",
  kind: "prefectural",
  name: "青森県議会",
  prefCode: "02",
  sourceUrl: AOMORI_ROSTER_URL,
};

/** 相対 URL を県の公式ホストの絶対 URL にする。別ホストなら例外（取得先の許可リスト）。フラグメントは落とす。 */
export function resolveAomoriUrl(href: string, base: string): string {
  const url = new URL(href.trim(), base);
  if (url.protocol !== "https:" || url.host !== AOMORI_HOST) throw new Error(`URL not on ${AOMORI_HOST}: ${url.href}`);
  url.hash = "";
  return url.href;
}

/** HTML の実体参照と空白を寄せる（&nbsp; → 半角空白、全角空白も含め連続空白は半角 1 つ、前後は削る）。 */
export function cleanText(s: string): string {
  return s
    .replace(/&nbsp;| /g, " ")
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
  if (era === "昭和") return 1925 + num;
  throw new Error(`unknown era ${era}`);
}

export const isoDate = (y: number, m: number, d: number): string => {
  if (m < 1 || m > 12 || d < 1 || d > 31) throw new Error(`date out of range ${y}-${m}-${d}`);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};
