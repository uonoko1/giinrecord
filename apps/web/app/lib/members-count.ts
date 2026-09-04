import type { MemberSummary } from "./data-contract";

/**
 * 「今この議会にいる人数」を数えるときの現職判定（#351、#355）。
 *
 * `current: false` は任期満了などで退任した議員。収録は続けるが人数には数えない——
 * 足すと参議院が 307 名になり、**定数248を超える**（読者は「参議院議員が307人いる」と読む）。
 * `current` を持たない古いデータは現職として扱う（`/members` の既定と同じ）。
 *
 * **収録範囲（`/coverage`）はこれを使わない。** あちらは「何を収録しているか」なので
 * 元職を含めて数えるのが正しい（`buildCoverage` のコメント）。
 */
export const isCurrentMember = (m: Pick<MemberSummary, "current">): boolean => m.current !== false;

/**
 * その院の現職か。
 *
 * #441 以降、**画面はこれを使わない**（`/` は名簿の全件を持たなくなり、院ごとの現職数は ETL の集計
 * `members/by-assembly.json` の `current` から出す）。残してあるのは、`isCurrentMember` と同じ
 * 「現職とは何か」の定義を院で絞る形で 1 か所に置いておくため。使うときは、集計と定義がずれていないか
 * （ETL の `membersByAssembly` も `current !== false`）を確かめること。
 */
export const isCurrentOf = (house: "sangiin" | "shugiin") => (m: Pick<MemberSummary, "house" | "current">): boolean =>
  m.house === house && isCurrentMember(m);

/**
 * その院の議員ページに実際に出ている記録の件数（#251）。`members/index.json` の counts の合計で、
 * 「議員ページに出る」ことそのものの実数。取得の有無や名簿の覆う回次からの推論ではないので、
 * ETL の突合条件が変わっても、データを数え直せばそのまま追随する。
 */
export interface LinkedRecordCounts {
  rollcalls: number;
  bills: number;
  speeches: number;
  questions: number;
}

/** `linkedRecordCounts` が数えるのに要る項目だけ（`MemberSummary` の部分集合）。 */
type CountedMember = Pick<MemberSummary, "house" | "counts">;

/**
 * 院ごとに `members/index.json` の counts を合計する。その院の議員が 0 人なら null（無い事実を作らない）。
 * `questions` を持たない古いデータでは 0 として数える（無い項目を欠測にしない）。
 *
 * **#451: この計算はここ 1 か所にしか無い。** もともと `coverage.ts` にあったが、#441 で
 * `/coverage` の件数が loader（Node 側）に移ったとき、`coverage.ts` が `assemblies.ts` 経由で
 * `import.meta.glob`（Vite 専用）に触るため `data-files.ts` から呼べず、**同じ計算が書き写された**。
 * 書き写しの側にはテストが無く、`questions` を 0 に固定しても 925 件が全部緑のままだった。
 *
 * このファイルは型以外を import しない（`data-contract.ts` から型だけ）ので、
 * Vite からも、tsx で直に走るビルドスクリプトからも呼べる。**glob に触る import をここに足さないこと**
 * ——足した瞬間に `data-files.ts` 経由のビルドスクリプトが
 * `import.meta.glob is not a function` で落ちる（#441 が実際に踏んだ罠）。
 */
export function linkedRecordCounts(members: readonly CountedMember[], house: MemberSummary["house"]): LinkedRecordCounts | null {
  const rows = members.filter((m) => m.house === house);
  if (rows.length === 0) return null;
  const sum = (pick: (c: CountedMember["counts"]) => number | undefined) => rows.reduce((t, m) => t + (pick(m.counts) ?? 0), 0);
  return { rollcalls: sum((c) => c.rollcalls), bills: sum((c) => c.bills), speeches: sum((c) => c.speeches), questions: sum((c) => c.questions) };
}
