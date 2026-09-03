import type { BillSessionCount } from "@seiji-kiroku/shared";

/**
 * `bills/by-session.json`（院・回次ごとの議案の件数）。Issue 411
 *
 * **`/coverage` が議案について使うのは `house` と `session` だけ**なのに、
 * 以前はここが `bills/index.json` 全件（raw 573KB / gzip 55KB）を読んでいた。
 * `id` / `kind` / `title` / `status` / `sourceUrl` は**この画面で一度も読まれない**。
 *
 * ETL が `bills/index.json` を院・回次ごとに数えた 25 行（raw 1.5KB / gzip 231B）を出し、
 * ここはそれだけを読む。集計が index.json と一致することは ETL 側
 * （`validateDataset` の `bills/by-session.json` の検査）が固定する。
 *
 * `bills/index.json` そのものは議員ページ側の紐づけで使うので残っている。
 * ここを import してよいのは、**院・回次ごとの議案の件数が要るところだけ**。
 * 議員 1 人あたりの件数なら `members[].counts.bills` にある（そちらはデータを読まない）。
 */
const billFiles = import.meta.glob<BillSessionCount[]>("../../../../data/bills/by-session.json", { eager: true, import: "default" });

export const billsBySession: BillSessionCount[] = Object.values(billFiles)[0] ?? [];
