import type { Assembly } from "@seiji-kiroku/shared";

/**
 * 奈良県議会（Issue #202、Phase 1 第4号）。取得先は県の公式ホストだけ（許可リスト）。
 * すべての出力レコードの sourceUrl はこのホストに限る（validateLocalAssemblies）。
 * robots.txt（2026-08 時点）は /documents/22137/* を Disallow するだけで、名簿・会期ページ・表決 PDF（/documents/24098/… など）は対象外。
 * 取得のたびに robots.txt を読んで従う（polite-fetch.ts）。
 */
export const NARA_HOST = "www.pref.nara.lg.jp";
export const NARA_ORIGIN = `https://${NARA_HOST}`;
/** 議員名簿（五十音順）の入口（Assembly.sourceUrl）。 */
export const NARA_ROSTER_URL = `${NARA_ORIGIN}/n161/52534.html`;

export const NARA_ASSEMBLY: Assembly = {
  id: "pref-29",
  kind: "prefectural",
  name: "奈良県議会",
  prefCode: "29",
  sourceUrl: NARA_ROSTER_URL,
};

/** 相対 URL を県の公式ホストの絶対 URL にする。別ホストなら例外（取得先の許可リスト）。フラグメントは落とす。 */
export function resolveNaraUrl(href: string, base: string): string {
  const url = new URL(href.trim(), base);
  if (url.protocol !== "https:" || url.host !== NARA_HOST) throw new Error(`URL not on ${NARA_HOST}: ${url.href}`);
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
  throw new Error(`unknown era ${era}`);
}

export const isoDate = (y: number, m: number, d: number): string => {
  if (m < 1 || m > 12 || d < 1 || d > 31) throw new Error(`date out of range ${y}-${m}-${d}`);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};
