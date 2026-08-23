import type { Assembly } from "@seiji-kiroku/shared";

/**
 * 徳島県議会（Issue #183、Phase 1 第2号）。取得先は県の公式ホストだけ（許可リスト）。
 * すべての出力レコードの sourceUrl はこのホストに限る（validateLocalAssemblies）。
 */
export const TOKUSHIMA_HOST = "www.pref.tokushima.lg.jp";
export const TOKUSHIMA_ORIGIN = `https://${TOKUSHIMA_HOST}`;
/** 議員紹介の入口（Assembly.sourceUrl）。 */
export const TOKUSHIMA_ROSTER_INDEX_URL = `${TOKUSHIMA_ORIGIN}/gikai/giin/`;

export const TOKUSHIMA_ASSEMBLY: Assembly = {
  id: "pref-36",
  kind: "prefectural",
  name: "徳島県議会",
  prefCode: "36",
  sourceUrl: TOKUSHIMA_ROSTER_INDEX_URL,
};

/** 相対 URL を県の公式ホストの絶対 URL にする。別ホストなら例外（取得先の許可リスト）。href の前後の空白は落とす（index に " https://…" がある）。 */
export function resolveTokushimaUrl(href: string, base: string): string {
  const url = new URL(href.trim(), base);
  if (url.protocol !== "https:" || url.host !== TOKUSHIMA_HOST) throw new Error(`URL not on ${TOKUSHIMA_HOST}: ${url.href}`);
  url.hash = "";
  return url.href;
}

/** HTML の実体参照と空白を寄せる（&nbsp; → 半角空白、連続空白は 1 つ、前後は削る）。 */
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
