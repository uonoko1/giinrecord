import type { Assembly } from "@seiji-kiroku/shared";

/**
 * 鳥取県議会（Issue #184、Phase 1 第3号）。取得先は県の公式ホストだけ（許可リスト）。
 * すべての出力レコードの sourceUrl はこのホストに限る（validateLocalAssemblies）。
 * robots.txt（2026-08 時点）は /secure/221685/ などを Disallow するだけで、議決結果ページと賛否 PDF（/secure/{番号}/…）は対象外。
 * 取得のたびに robots.txt を読んで従う（polite-fetch.ts）。
 */
export const TOTTORI_HOST = "www.pref.tottori.lg.jp";
export const TOTTORI_ORIGIN = `https://${TOTTORI_HOST}`;
/** 議員名簿（五十音順）の入口（Assembly.sourceUrl）。 */
export const TOTTORI_ROSTER_URL = `${TOTTORI_ORIGIN}/75928.htm`;

export const TOTTORI_ASSEMBLY: Assembly = {
  id: "pref-31",
  kind: "prefectural",
  name: "鳥取県議会",
  prefCode: "31",
  sourceUrl: TOTTORI_ROSTER_URL,
};

/** 相対 URL を県の公式ホストの絶対 URL にする。別ホストなら例外（取得先の許可リスト）。フラグメントは落とす。 */
export function resolveTottoriUrl(href: string, base: string): string {
  const url = new URL(href, base);
  if (url.protocol !== "https:" || url.host !== TOTTORI_HOST) throw new Error(`URL not on ${TOTTORI_HOST}: ${url.href}`);
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

/** 「2023年4月30日」「令和8年6月29日」を ISO にする。読めなければ undefined。 */
export function toIsoDate(text: string): string | undefined {
  const t = text.normalize("NFKC");
  const w = t.match(/(令和|平成)\s*(\d+|元)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (w) {
    const n = w[2] === "元" ? 1 : Number(w[2]);
    const year = w[1] === "令和" ? 2018 + n : 1988 + n;
    return `${year}-${w[3].padStart(2, "0")}-${w[4].padStart(2, "0")}`;
  }
  const m = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!m) return undefined;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}
