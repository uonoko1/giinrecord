/**
 * **会期ごとに「その名簿がその会期をどれだけ写しているか」**（`meta.sessionRosterCoverage`）を
 * 画面へ出すための読み側（#951）。
 *
 * **何が問題だったか**: **一般選挙の境をまたぐと、票が今の名簿に黙って寄る。**
 * **#950 が奈良で実測した**——**境の向こうの 2,952 票のうち 1,656 票（56.1%）が
 * 2026 年の名簿に寄り、痕跡が 1 つも残らない。**
 * **「再選した本人」でも「同姓同名の別人」でも、出力が 1 バイトも違わない**（#569 の重いほう）。
 *
 * **既存の守りは 4 つとも黙る**: **#928（`rosterAsOf` の窓）は境の直前なら 1 任期の内側／
 * `unmatched` は寄ってしまうので出ない／`lossyNameMatches` は字が落ちていない／
 * `sourceConflict` は一次資料どうしが食い違っていない。**
 *
 * **判定はここに無い。** 何を数えるかを決めるのは ETL（`packages/etl/src/local-assemblies.ts` の
 * `sessionRosterCoverageOf`）で、ここは `meta.json` が既に書いた行を引くだけである。
 *
 * **`git clone` した人にしか読めない記録を作らない**（#800。`lossyNameMatches` が 1 度そうなった）。
 *
 * **誰が誰に替わったかは書かない**（それは推定であり #569 が禁じる側）。
 * **「選挙があった」とも書かない**——**選挙かまとまった辞職かは、我々の一次資料からは区別できない。**
 */
import type { LocalAssemblyMeta } from "./data-contract";

export type SessionRosterCoverage = LocalAssemblyMeta["sessionRosterCoverage"][number];

/**
 * **`seatsChanged` がこの数以上の会期を画面で名指しする**（ETL の `SEATS_CHANGED_FLAG` と同じ値）。
 *
 * **これは「ここから先は選挙だ」という線ではない。**
 * **今までに実際に起きた幅の外、という線だけを引いている**——
 * **実測 2026-09-25（本番 `data/` の 11 議会 119 会期）で `seatsChanged` の最大は 5（滋賀）で、10 以上は 0 件。**
 *
 * **⚠ 「0 件」は「境が無い」ではない**（#990 / #1007）——
 * **11 県の境を測り直すと、測れた 8 県のうち 2 県（秋田 9・佐賀 4）の境がこの線の下にある。**
 *
 * **ETL と web の 2 か所に同じ値がある**のは、`packages/shared` が型だけで定数を持たないため
 * （`DIET_ASSEMBLY_IDS` と同じ形）。**ずれたら `session-roster-coverage.test.ts` が落ちる。**
 */
export const SEATS_CHANGED_FLAG = 10;

export interface SessionRosterCoverageSummary {
  /** 見た会期の数（母数。#757） */
  sessions: number;
  /** **印が付いた会期**（`seatsChanged >= SEATS_CHANGED_FLAG`） */
  flagged: SessionRosterCoverage[];
  /** その議会でいちばん大きい `seatsChanged`（会期が 0 なら 0） */
  maxSeatsChanged: number;
  /** 名簿の人数（`counts.members`。`seatsChanged` はこれを見ないと読めない） */
  rosterSize: number;
}

/**
 * 議会ごとの集計（`/coverage` が出す）。**meta が無ければ null**——
 * 「0 件」ではなく「**その議会をまだ読んでいない**」なので、0 と同じ形にしてはいけない（#757）。
 * **印が 0 件の議会でも返す**（母数が無ければ「0 件」に意味が無い）。
 */
export function sessionRosterCoverageSummary(meta: LocalAssemblyMeta | null): SessionRosterCoverageSummary | null {
  if (!meta?.sessionRosterCoverage) return null;
  const rows = meta.sessionRosterCoverage;
  return {
    sessions: rows.length,
    flagged: rows.filter((r) => r.seatsChanged >= SEATS_CHANGED_FLAG),
    maxSeatsChanged: rows.reduce((n, r) => Math.max(n, r.seatsChanged), 0),
    rosterSize: meta.counts.members,
  };
}
