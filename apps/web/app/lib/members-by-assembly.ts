import type { AssemblyId, House, MemberAssemblyCount } from "@seiji-kiroku/shared";
import { DIET_ASSEMBLY_IDS } from "./data-contract";

/**
 * `members/by-assembly.json`（議会ごとの議員の人数）。Issue 441
 *
 * **`/`・`/assemblies`・`/coverage` が議員について使うのは「議会ごとに何人か」だけ**なのに、
 * 以前はここが `members/index.json` 全件（1,057 行 / raw 259KB / gzip 40KB）を読んでいた。
 * `name` / `kana` / `district` / `group` / `termEnd` は**この3画面で一度も読まれない**。
 *
 * ETL が `members/index.json` を議会ごとに数えた 9 行（raw 602B / gzip 187B）を出し、
 * ここはそれだけを読む。集計が index.json と一致することは ETL 側
 * （`validateDataset` の `members/by-assembly.json` の検査）が固定する。
 *
 * `members/index.json` そのものは `/members` の一覧と `/compare` の詳細で使うので残っている
 * （**あちらは全件が要る。減らさない**）。ここを import してよいのは、
 * **議会ごとの人数だけが要るところ**。
 */
const files = import.meta.glob<MemberAssemblyCount[]>("../../../../data/members/by-assembly.json", { eager: true, import: "default" });

export const membersByAssembly: MemberAssemblyCount[] = Object.values(files)[0] ?? [];

/**
 * その議会の**現職**の人数（`current !== false` の行数）。行が無ければ 0（無い＝0 人）。
 *
 * 数えるのは現職だけ（#351、#355）。元職を足すと参議院が 307 名になり、**定数248を超える**——
 * 読者は「参議院議員が307人いる」と読むし、`/members` の既定（現職のみ）とも食い違う。
 * **収録範囲（`/coverage`）はこれを使わない。** あちらは「何を収録しているか」なので
 * 元職を含めて数えるのが正しい（`totalMembersOf`）。
 */
export function currentMembersOf(rows: readonly MemberAssemblyCount[], assemblyId: AssemblyId): number {
  return rows.find((r) => r.assemblyId === assemblyId)?.current ?? 0;
}

/** その議会の**元職を含む**人数（その議会の `members/index.json` の行数）。行が無ければ 0。 */
export function totalMembersOf(rows: readonly MemberAssemblyCount[], assemblyId: AssemblyId): number {
  return rows.find((r) => r.assemblyId === assemblyId)?.total ?? 0;
}

/** その院（参議院・衆議院）の現職の人数。`house` → 議会 id は `memberAssemblyId` と同じ規則（`diet-{house}`）。 */
export function currentMembersOfHouse(rows: readonly MemberAssemblyCount[], house: House): number {
  return currentMembersOf(rows, DIET_ASSEMBLY_IDS[house]);
}
