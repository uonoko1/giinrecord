/**
 * `data/` の中身のうち、見出し家族 700 で描かれる欄の字を集める（#477）。
 *
 * ビルド済み HTML を舐めるだけでは足りない。**折りたたみとタブの向こう側は HTML に入らない**。
 * 詳しい表は `head-font-data-chars.test.ts` の冒頭に書いた。
 *
 * ここは純粋関数。`data/` を読むのは `scripts/font-subset.ts`。
 */

/** 明朝 700 で描かれる欄だけを取り出した、`data/` の要約。 */
export interface HeadFontDataSource {
  /** `.members-item__name` / `.assembly-member__name`（氏名）と、`/members` の絞り込みが作る見出し（会派・選挙区） */
  members?: { name?: string; group?: string; district?: string }[];
  /** `.member-position`：会議録の `speakerPosition` の原文（例「国土交通大臣」） */
  speakerPositions?: string[];
  /**
   * `.rollcall-group-name`：採決ページの会派名。
   * **`groups[]` だけでなく `votes[].group` も入れる**（#520 のレビュー指摘）。
   * `rollcall.tsx` の `unlistedGroups()` は **`votes` にしか無い会派名**を拾って同じクラスで描くので、
   * `groups[]` だけ読むと「票にだけ現れた新しい会派」が**静かにシステム書体になる**。
   */
  rollCallGroups?: string[];
  /**
   * `.coverage-assembly__name`：`/coverage` が明朝700 で描く議会名（`data/assemblies/index.json` の `name`）。
   * **ETL が新しい県議会を足す経路**なので、読まないと追加のたびに気づけない穴になる。
   */
  assemblyNames?: string[];
  /** `.member-stamp`：地方議会の表決の原文（○×議欠－棄白） */
  localVoteMarks?: string[];
}

/**
 * **異体字セレクタは字ではない**（SVS U+FE00–FE0F / IVS U+E0100–E01EF）。
 * **幅 0 で、それ自体は 1 つも描かれない**——直前の字の字形を選ぶだけの符号である。
 * **サブセットに入れろと言っても、フォントにその符号のグリフは無い**ので、
 * 「`.txt` が主張する字が woff2 に入っていない」という退行の検査に**偽陽性**で引っ掛かる。
 *
 * **2026-09-13、青森県議会（#750）を足して実際に引っ掛かった**——
 * 名簿の `櫛󠄁引 ユキ子` の `櫛` が `U+6ADB U+E0101` で、**U+E0101 が字として集まった。**
 * **`櫛` U+6ADB のほうは入っている**ので、**この議員の氏名は明朝で描ける**（欠けていない）。
 * **落とすのが正しい。**
 */
const VARIATION_SELECTOR = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u;

/** 与えた欄に出てくる**異なり字**。`undefined` の欄は無視する（ETL 前・古いデータでも落ちない）。 */
export function dataHeadChars(source: HeadFontDataSource): Set<string> {
  const out = new Set<string>();
  const add = (text: string | undefined) => {
    if (typeof text !== "string") return;
    for (const ch of text) if (!VARIATION_SELECTOR.test(ch)) out.add(ch);
  };
  for (const m of source.members ?? []) {
    add(m.name);
    add(m.group);
    add(m.district);
  }
  for (const p of source.speakerPositions ?? []) add(p);
  for (const g of source.rollCallGroups ?? []) add(g);
  for (const a of source.assemblyNames ?? []) add(a);
  for (const v of source.localVoteMarks ?? []) add(v);
  return out;
}
