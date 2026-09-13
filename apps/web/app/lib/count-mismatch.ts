/**
 * **記号の数と公表値（賛成者数・反対者数）の食い違い**（`meta.countMismatches` / `meta.countChecked`）を
 * 画面へ出すための読み側（#826）。
 *
 * **何が問題だったか**: **記号の数と `counts` を突き合わせている県は 5 つ**（宮城・鳥取・島根・佐賀・高知）で、
 * **5 つとも `assert.equal` で「エラーで止める」形だった。** **山梨には、公表された賛成者数に
 * 議長の `〇` が入っていない行が 2 つある**（#782／#811）。**佐賀にも同じ事象の行が実在するが、
 * 佐賀では議長を数えているので合っている**（#825）。**同じ事象でも県ごとに数え方が違う。**
 *
 * **止めれば、正しい記録まで出なくなる**（#569 の「記録が出ない」側）。**だから件数として出す**——
 * **記録は出たうえで、人が見に行ける**（#811 の PO の判断）。**出したのに見えなければ意味が無い**ので
 * （#800 で `lossyNameMatches` が `git clone` した人にしか読めていなかった）、**画面に出す。**
 *
 * **判定はここに無い。** 何が食い違いかを決めるのは ETL（`packages/etl/src/local-assemblies.ts` の
 * `countMismatchesOf`）で、ここは `meta.json` が既に書いた行を引くだけである。
 *
 * **どちらが正しいかは書かない**（我々には分からない。推測は評価である）。書くのは
 * **数えた数・公表された数・母数・一次資料**だけ。
 */
import type { LocalAssemblyMeta } from "./data-contract";

export type CountMismatch = NonNullable<LocalAssemblyMeta["countMismatches"]>[number];

export interface CountMismatchSummary {
  /** 記号の数と公表値が食い違った採決の件数 */
  mismatches: number;
  /** 実際に突き合わせた採決の件数（母数。#757） */
  checked: number;
  /** **`counts` の欄が PDF に無い**ので突き合わせられなかった件数 */
  noCounts: number;
  /** **凡例の引けないセルがある**ので突き合わせられなかった件数 */
  unreadableCells: number;
  /** その議会の採決の総数 */
  rows: number;
}

/**
 * 議会ごとの集計（`/coverage` が出す）。**meta が無ければ null**——
 * 「0 件」ではなく「**その議会をまだ読んでいない**」なので、0 と同じ形にしてはいけない（#757）。
 * **突き合わせた件数が 0 の議会でも返す**（母数 0 は「食い違いが無い」ではなく「1 件も見ていない」）。
 */
export function countMismatchSummary(meta: LocalAssemblyMeta | null): CountMismatchSummary | null {
  if (!meta?.countChecked) return null;
  return {
    mismatches: (meta.countMismatches ?? []).length,
    checked: meta.countChecked.checked,
    noCounts: meta.countChecked.noCounts,
    unreadableCells: meta.countChecked.unreadableCells,
    rows: meta.countChecked.rows,
  };
}
