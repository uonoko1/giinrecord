import type { Assembly } from "@seiji-kiroku/shared";

/**
 * 秋田県議会（Issue #759、地方議会 10 議会目）。取得先は県議会の公式ホストだけ（許可リスト）。
 * すべての出力レコードの sourceUrl はこのホストに限る（validateLocalAssemblies）。
 *
 * ## **ホストは `pref.*.lg.jp` ではない**
 * **秋田県議会は `pref.akita.gsl-service.net` に載っている**（県のサイト `www.pref.akita.lg.jp`
 * とは別ホスト。トップから `美の国あきたネットへ` のリンクで県のサイトに出る）。
 * **滋賀（`www.shigaken-gikai.jp`、#741）と同じ形**で、**`scripts/ci/test/link-check.test.sh` の
 * 公式ドメインの許可に名指しで足してある**（広いパターンにはしない。誰でも取れるドメインが通る）。
 *
 * robots.txt（#615 が 2026-09-07、#753 が 2026-09-12、この PR が 2026-09-13 に取り直し。
 * **いずれも 33 B で全文が次の 2 行**）:
 *   User-agent: GPTBot
 *   Disallow: /
 * **`giinrecord-etl` に対する Disallow は無く、賛否 PDF も議会のページも対象外。**
 * 取得のたびに robots.txt を読んで従う（polite-fetch.ts）。
 *
 * 利用条件（**独立したページは無い**。#753 が `/sitemap.html` のリンク 11 本とトップページを
 * 走査して「利用」「著作」「免責」のリンクが無いことを確かめた。この PR で再確認）。
 * **全ページのフッタに 1 文あるだけ**（原文）:
 *   Copyright(c)2018 AKITA Prefecture All Rights Reserved.
 *   各ページの記載記事、写真の無断転載を禁じます。
 * **「無断転載を禁じます」とだけ書かれており、機械的な取得についての記述は無い。**
 * この ETL が公開するのは**採決の賛否という事実**であって PDF の表現ではない
 * （docs/DATA_CONTRACT.md「一次資料の取得と再公開（#537）」）。
 * **#537（事務局への事前照会をしていない）がそのまま当てはまる。**
 *
 * **このサイトは UTF-8**（滋賀の `textShiftJis` は使わない）。
 */
export const AKITA_HOST = "pref.akita.gsl-service.net";
export const AKITA_ORIGIN = `https://${AKITA_HOST}`;

/**
 * 議員紹介。Assembly.sourceUrl。**五十音別・選挙区別・委員会別・会派別の 4 つの一覧が 1 ページ**にある。
 * **定数 43 に対して 41 人**（実測 2026-09-13。欠員 2）。**定数を議員数として使わない。**
 */
export const AKITA_ROSTER_URL = `${AKITA_ORIGIN}/doc/2018042300017/`;

/**
 * 会期の索引は **2 段**（#753 が #615 の「体系的にたどる方法を確立できていない」を解いた）:
 *   1. `/doc/2018051000199/`（定例会・臨時会の概要）← 最新年度ぶんと、下の 2 へのリンク
 *   2. `/doc/2018051000205/`（平成18年〜前年の一覧）← **20 の年度ページへのリンク**
 * **カテゴリページ（`/category/category/gaiyou/`）の記事一覧は空**なので使えない（#753 が実測）。
 */
export const AKITA_HUB_URL = `${AKITA_ORIGIN}/doc/2018051000199/`;
export const AKITA_YEARS_URL = `${AKITA_ORIGIN}/doc/2018051000205/`;

export const AKITA_ASSEMBLY: Assembly = {
  id: "pref-05",
  kind: "prefectural",
  name: "秋田県議会",
  prefCode: "05",
  sourceUrl: AKITA_ROSTER_URL,
};

/**
 * 相対 URL を県議会の公式ホストの絶対 URL にする。別ホストなら例外（取得先の許可リスト）。
 *
 * ## **`http://` のリンクを `https://` に直す**（秋田固有。実測 2026-09-13）
 * **同じ資料へのリンクが `http://` と `https://` で混在する**——
 * 年度一覧のページでは `http://pref.akita.gsl-service.net/doc/2025021700027/#R7-1208` と
 * `https://pref.akita.gsl-service.net/doc/2025021700027/#R07619` が並び、
 * **議員紹介ページの `川邉隼之介` は 3 つの `<a>` に割れていて、2 つが `http://`、1 つが `https://`**
 * （`http://…/profile/2025040700015/` と `https://…/profile/2025040700015/`）。
 * **直さないと同じ資料が 2 つの URL に見え、重複除去も突き合わせも壊れる。**
 * **ホストが同じであることは確かめてから直す**（別ホストの `http://` は通さない）。
 * フラグメントは落とす（`#R7-1208` は同じページの中の位置でしかない）。
 */
export function resolveAkitaUrl(href: string, base: string): string {
  const url = new URL(href.trim(), base);
  if (url.host !== AKITA_HOST) throw new Error(`URL not on ${AKITA_HOST}: ${url.href}`);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`URL not http(s): ${url.href}`);
  url.protocol = "https:";
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
  if (era === "昭和") return 1925 + num;
  throw new Error(`unknown era ${era}`);
}

export const isoDate = (y: number, m: number, d: number): string => {
  if (m < 1 || m > 12 || d < 1 || d > 31) throw new Error(`date out of range ${y}-${m}-${d}`);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};
