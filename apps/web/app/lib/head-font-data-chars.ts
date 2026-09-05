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

/** 与えた欄に出てくる**異なり字**。`undefined` の欄は無視する（ETL 前・古いデータでも落ちない）。 */
export function dataHeadChars(source: HeadFontDataSource): Set<string> {
  const out = new Set<string>();
  const add = (text: string | undefined) => {
    if (typeof text !== "string") return;
    for (const ch of text) out.add(ch);
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
