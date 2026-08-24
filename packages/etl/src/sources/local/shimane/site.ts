import type { Assembly } from "@seiji-kiroku/shared";

/**
 * 島根県議会（Issue #221、Phase 1 第7号）。取得先は県の公式ホストだけ（許可リスト）。
 * すべての出力レコードの sourceUrl はこのホストに限る（validateLocalAssemblies）。
 * robots.txt（2026-08-24 時点）は 404（＝クロールの制限は置かれていない。polite-fetch.ts は 404 を「制限なし」として扱う）。
 * 利用条件は /cl.html「著作権・リンク等について」: 著作権は県または提供者にあり「私的使用のための複製」「引用」など
 * 著作権法上認められた場合を除いて無断転用・引用はできない、リンクは原則自由、という一般的な記載のみ。
 * 機械的な取得（クローリング・スクレイピング）を禁じる文言は無い。取得のたびに robots.txt を読んで従う（polite-fetch.ts）。
 */
export const SHIMANE_HOST = "www.pref.shimane.lg.jp";
export const SHIMANE_ORIGIN = `https://${SHIMANE_HOST}`;
/** 議員名簿（選挙区別）の入口（Assembly.sourceUrl）。 */
export const SHIMANE_ROSTER_URL = `${SHIMANE_ORIGIN}/gikai/gaido/meibo/tiku.html`;

export const SHIMANE_ASSEMBLY: Assembly = {
  id: "pref-32",
  kind: "prefectural",
  name: "島根県議会",
  prefCode: "32",
  sourceUrl: SHIMANE_ROSTER_URL,
};

/** 相対 URL を県の公式ホストの絶対 URL にする。別ホストなら例外（取得先の許可リスト）。フラグメントは落とす。 */
export function resolveShimaneUrl(href: string, base: string): string {
  const url = new URL(href.trim(), base);
  if (url.protocol !== "https:" || url.host !== SHIMANE_HOST) throw new Error(`URL not on ${SHIMANE_HOST}: ${url.href}`);
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
