import type { Assembly } from "@seiji-kiroku/shared";

/**
 * 佐賀県議会（Issue #768、地方議会 11 議会目）。取得先は県議会の公式ホストだけ（許可リスト）。
 * すべての出力レコードの sourceUrl はこのホストに限る（validateLocalAssemblies）。
 *
 * ## robots.txt（#689 が 2026-09-09、#765 が 2026-09-13、この PR が 2026-09-13 に取り直し）
 * **3 回とも 219 B・md5 `844393c49b6a0e4fd019e5cfdb2d05b1`・全文 9 行で同じ**（実測）。
 * `User-agent: *` の Disallow は `Calendar.aspx` `calendar.aspx` `Daily.aspx` `daily.aspx`
 * `Weekly.aspx` `weekly.aspx` `Yearly.aspx` `yearly.aspx` の 8 行（いずれも先頭がワイルドカード）だけで、
 * **議案等の審議結果（`/gikai/list…….html`）・記事（`/gikai/kiji……/index.html`）・
 * 賛否 PDF（`/gikai/kiji……/…….pdf`）・議員一覧は 1 つも当たらない。**
 * 取得のたびに robots.txt を読んで従う（polite-fetch.ts）。
 *
 * ## 利用条件のページは存在しない（#765 が探して 0 件。この PR で再確認していない）
 * **#765 の実測**: `/sitemap.html` のリンクを `利用案内|利用規約|著作権|免責|ポリシ|このサイト` で
 * 走査して 0 件、`/riyou.html` `/copyright.html` `/privacy.html` `/site_policy.html` はすべて 404。
 * **議会サイトのフッタにあるのは著作権表示 1 行だけ**（原文 `Copyright© 2016 Saga Prefecture.All Rights Reserved.`）で、
 * **機械的な取得についての記述は無い。**
 * この ETL が公開するのは**採決の賛否という事実**であって PDF の表現ではない
 * （docs/DATA_CONTRACT.md「一次資料の取得と再公開（#537）」）。
 * **#537（事務局への事前照会をしていない）がそのまま当てはまる。**
 *
 * **このサイトは UTF-8**（滋賀の `textShiftJis` は使わない）。
 */
export const SAGA_HOST = "www.pref.saga.lg.jp";
export const SAGA_ORIGIN = `https://${SAGA_HOST}`;

/**
 * 議員一覧。Assembly.sourceUrl。**37 名**（実測 2026-09-13）。
 * **ふりがな・会派・選挙区・期数がすべて 1 ページにある**（青森・秋田と違い `kana` が取れる）。
 */
export const SAGA_ROSTER_URL = `${SAGA_ORIGIN}/gikai/kiji00366725/index.html`;

/**
 * 議案等の審議結果（年の一覧）。ここから
 *   年ページ（`list06635` 令和8年）→ 種別ページ（`list06636` 定例会 / `list06670` 臨時会）
 *   → 会期ページ（`list06680` 令和8年6月定例会）→ 議案件名一覧表（`kiji003119791`）
 *   → 賛否 PDF（`3_119791_394982_up_cda325jj.pdf`）
 * と 5 階層下りる。**「議員ごとの採決結果」のリンク名は会期ページからは見えない**（#670）。
 */
export const SAGA_INDEX_URL = `${SAGA_ORIGIN}/gikai/list01707.html`;

export const SAGA_ASSEMBLY: Assembly = {
  id: "pref-41",
  kind: "prefectural",
  name: "佐賀県議会",
  prefCode: "41",
  sourceUrl: SAGA_ROSTER_URL,
};

/**
 * 相対 URL を県議会の公式ホストの絶対 URL にする。別ホストなら例外（取得先の許可リスト）。
 *
 * **`https://www.pref.saga.lg.jp.e.zg.hp.transer.com/…` のような機械翻訳のミラーが
 * 全ページのヘッダに 4 本ある**（English / 中文簡体 / 中文繁体 / 한국어。実測 2026-09-13）。
 * **ホストの完全一致で弾く**——`endsWith(".pref.saga.lg.jp")` のような書き方だと
 * `transer.com` は通らないが、`evil.pref.saga.lg.jp` のような形が通ってしまう。
 * フラグメントは落とす。
 */
export function resolveSagaUrl(href: string, base: string): string {
  const url = new URL(href.trim(), base);
  if (url.protocol !== "https:") throw new Error(`URL not https: ${url.href}`);
  if (url.host !== SAGA_HOST) throw new Error(`URL not on ${SAGA_HOST}: ${url.href}`);
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
