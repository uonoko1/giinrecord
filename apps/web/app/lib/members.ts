import type { MemberSummary } from "./dataset";

/**
 * `members/index.json`（議員名簿の全件）。Issue 441
 *
 * **ここは減らさない。** `/members`（一覧を描く）と `/assemblies/{id}`（その議会の議員を並べる）は
 * `name` / `kana` / `district` / `group` / `termEnd` を全部使うので、全件が要る
 * （1,057 行 / raw 259KB / gzip 40KB）。**元職も含む**——`/members` は元職をトグルで出し、
 * `/assemblies/{id}` は「元職」の印つきで一覧に載せる（収録していることを示すため。設計どおり）。
 *
 * 分けてあるのは、**数えるだけの画面まで 40KB を読んでいた**から（#441）。
 * `/`・`/assemblies`・`/coverage` が使うのは「議会ごとに何人か」だけなので、
 * あちらは ETL の集計（**lib/members-by-assembly.ts**、gzip 187B）を読む。
 * ここを import してよいのは、**議員 1 人ずつの中身が要るところだけ**。
 */
const files = import.meta.glob<MemberSummary[]>("../../../../data/members/index.json", { eager: true, import: "default" });

export const members: MemberSummary[] = Object.values(files)[0] ?? [];
