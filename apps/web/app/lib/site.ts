/**
 * データに触れない定数。`dataset.ts` から切り出したもの（Issue 406）。
 *
 * `dataset.ts` は `import.meta.glob(..., { eager: true })` で `data/` の JSON を5つ
 * **同期で丸ごと**取り込む。そこから定数を1つ import しただけで、
 * **データセット全体が同じチャンクに引きずり込まれる**。
 *
 * 実際、`SiteFooter.tsx` が `REPO_URL`（文字列1つ）のために import していたため、
 * 全ページのフッターが 1MB（gzip 144KB）のチャンクを読んでいた。
 * チャンク名が `SiteFooter-*.js` だったのはその結果で、原因ではない。
 */
export const REPO_URL = "https://github.com/uonoko1/giinrecord";
