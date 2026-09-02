import type { DatasetMeta } from "../lib/data-contract";
import raw from "./meta.json";

/**
 * テスト用の `meta`。JSON から直に import すると `house` / `kind` が `string` に広がって
 * `DatasetMeta` に代入できないので、ここで一度だけ型を付けて配る（#339）。
 *
 * 出典は**衆参それぞれの全種別**を持たせてある。議員ページの出典絞り込み（`memberSources`）が
 * 「参院議員のページに衆院の出典を出さない」ことを、実データに近い形で検査できるようにするため。
 */
export const meta = raw as DatasetMeta;
export default meta;
