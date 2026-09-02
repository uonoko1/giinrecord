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

/** その院の現職か。 */
export const isCurrentOf = (house: "sangiin" | "shugiin") => (m: Pick<MemberSummary, "house" | "current">): boolean =>
  m.house === house && isCurrentMember(m);
