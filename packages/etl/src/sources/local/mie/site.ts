import type { Assembly } from "@seiji-kiroku/shared";

/**
 * 三重県議会（Issue #203、Phase 1 第5号）。取得先は県の公式ホストだけ（許可リスト）。
 * すべての出力レコードの sourceUrl はこのホストに限る（validateLocalAssemblies）。
 */
export const MIE_HOST = "www.pref.mie.lg.jp";
export const MIE_ORIGIN = `https://${MIE_HOST}`;
/** 議員名簿（選挙区別５０音順）の入口（Assembly.sourceUrl）。 */
export const MIE_ROSTER_INDEX_URL = `${MIE_ORIGIN}/KENGIKAI/08089011294.htm`;

export const MIE_ASSEMBLY: Assembly = {
  id: "pref-24",
  kind: "prefectural",
  name: "三重県議会",
  prefCode: "24",
  sourceUrl: MIE_ROSTER_INDEX_URL,
};

/** 相対 URL を県の公式ホストの絶対 URL にする。別ホストなら例外（取得先の許可リスト）。 */
export function resolveMieUrl(href: string, base: string): string {
  const url = new URL(href.trim(), base);
  if (url.protocol !== "https:" || url.host !== MIE_HOST) throw new Error(`URL not on ${MIE_HOST}: ${url.href}`);
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

/** 「令和７年１１月１８日」（全角数字）→ ISO 日付。 */
export function warekiDate(era: string, y: string, m: string, d: string): string {
  const year = warekiYear(era, y);
  const month = Number(m.normalize("NFKC"));
  const day = Number(d.normalize("NFKC"));
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error(`date out of range ${era}${y}年${m}月${d}日`);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
