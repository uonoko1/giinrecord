import type { Assembly } from "@seiji-kiroku/shared";

/**
 * 高知県議会（Issue #220、地方議会 6 議会目）。取得先は県議会の公式ホストだけ（許可リスト）。
 * すべての出力レコードの sourceUrl はこのホストに限る（validateLocalAssemblies）。
 * robots.txt（2026-08 時点）は /search.html・/reiki/・/*.html.r を Disallow するだけで、
 * 名簿（/member/categories/）・会期 index（/activity/decision.html）・表決 PDF（/_files/…）は対象外。
 * 「ご利用案内」（/use/）は文字サイズ・読み上げなどの操作案内で、機械取得を禁じる文言は無い。
 * 取得のたびに robots.txt を読んで従う（polite-fetch.ts）。
 */
export const KOCHI_HOST = "gikai.pref.kochi.lg.jp";
export const KOCHI_ORIGIN = `https://${KOCHI_HOST}`;
/** 議員名簿（会派別）の入口（Assembly.sourceUrl）。 */
export const KOCHI_ROSTER_URL = `${KOCHI_ORIGIN}/member/categories/`;
/** 「議員別賛否の状況」（会期ごとの議決結果一覧 PDF の index）。 */
export const KOCHI_DECISION_URL = `${KOCHI_ORIGIN}/activity/decision.html`;

export const KOCHI_ASSEMBLY: Assembly = {
  id: "pref-39",
  kind: "prefectural",
  name: "高知県議会",
  prefCode: "39",
  sourceUrl: KOCHI_ROSTER_URL,
};

/** 相対 URL を県議会の公式ホストの絶対 URL にする。別ホストなら例外（取得先の許可リスト）。フラグメントは落とす。 */
export function resolveKochiUrl(href: string, base: string): string {
  const url = new URL(href.trim(), base);
  if (url.protocol !== "https:" || url.host !== KOCHI_HOST) throw new Error(`URL not on ${KOCHI_HOST}: ${url.href}`);
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
