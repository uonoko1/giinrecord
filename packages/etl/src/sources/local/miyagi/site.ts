import type { Assembly } from "@seiji-kiroku/shared";

/**
 * 宮城県議会（Issue #157、Phase 1 第1号）。取得先は県の公式ホストだけ（許可リスト）。
 * すべての出力レコードの sourceUrl はこのホストに限る（validateLocalAssemblies）。
 */
export const MIYAGI_HOST = "www.pref.miyagi.jp";
export const MIYAGI_ORIGIN = `https://${MIYAGI_HOST}`;
/** 議員名簿の入口（Assembly.sourceUrl）。 */
export const MIYAGI_ROSTER_INDEX_URL = `${MIYAGI_ORIGIN}/site/kengikai/meibo/index.html`;

export const MIYAGI_ASSEMBLY: Assembly = {
  id: "pref-04",
  kind: "prefectural",
  name: "宮城県議会",
  prefCode: "04",
  sourceUrl: MIYAGI_ROSTER_INDEX_URL,
};

/** 相対 URL を県の公式ホストの絶対 URL にする。別ホストなら例外（取得先の許可リスト）。 */
export function resolveMiyagiUrl(href: string, base: string): string {
  const url = new URL(href, base);
  if (url.protocol !== "https:" || url.host !== MIYAGI_HOST) throw new Error(`URL not on ${MIYAGI_HOST}: ${url.href}`);
  url.hash = "";
  return url.href;
}

/** ページの「掲載日：2026年4月23日」を ISO にする（as-of）。無ければ例外（取得日で代用しない）。 */
export function parsePostedDate(html: string): string {
  const m = html.match(/掲載日：\s*(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (!m) throw new Error("掲載日 not found");
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

/** HTML の実体参照と空白を寄せる（&nbsp; → 半角空白、連続空白は 1 つ、前後は削る）。 */
export function cleanText(s: string): string {
  return s
    .replace(/&nbsp;| /g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[\s　]+/g, " ")
    .trim();
}
