import type { BillSummary } from "@seiji-kiroku/shared";

/**
 * `bills/index.json`（議案。衆院の会派態度の裏づけ）。Issue 408
 *
 * **`dataset.ts` から切り出してある。** `dataset.ts` は5つの JSON を1つのオブジェクトに
 * まとめて eager に取り込むので、**どれか1つを使うページは5つ全部を読む**。
 * `bills` はその中でいちばん大きく（gzip 60KB）、**使うのは `/coverage` だけ**だった。
 *
 * 切り出す前は `/about`（`meta` の 1KB だけが要る）まで 60KB を読んでいた。
 *
 * ここを import してよいのは、**実際に議案の一覧が要るところだけ**。
 * 件数だけなら `members[].counts.bills` にある（そちらはデータを読まない）。
 */
const billFiles = import.meta.glob<BillSummary[]>("../../../../data/bills/index.json", { eager: true, import: "default" });

export const bills: BillSummary[] = Object.values(billFiles)[0] ?? [];
