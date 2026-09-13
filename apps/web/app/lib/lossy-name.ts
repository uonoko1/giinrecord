/**
 * **字が落ちたまま名簿に寄った氏名**（`meta.lossyNameMatches`）を画面へ出すための読み側（#800）。
 *
 * **何が問題だったか**: #778（PR #794）で `lossyNameMatches` を 11 県すべての `meta.json` に入れたが、
 * **`apps/web` に `lossyNameMatches` は 1 か所も無く**、`data/assemblies/pref-{2桁}/meta.json` は
 * `/data/` でも配信されない（バンドルされるのは `import.meta.glob` が取り込むものだけ）。
 * **`git clone` した人しか読めなかった。** 「記録した」は「見えるようにした」ではない。
 *
 * **判定はここに無い。** どれが lossy かを決めるのは ETL（`packages/etl/src/local-assemblies.ts` の
 * `lossyNameMatchesOf` / `sources/local/name-match.ts` の `isLossyName`）で、**#800 は判定を変えない**。
 * ここは `meta.json` が既に書いた行を引くだけである。
 *
 * **`unmatched.json` とは別物**（docs/DATA_CONTRACT.md「字が落ちたまま寄った氏名を画面に出す」）:
 * `unmatched` は**突き合わなかった**（票が誰にも付いていない）、`lossyNameMatches` は
 * **字が落ちたまま突き合わせた**（票は本人に付いている）。**後者の方が利用者から見えにくい**ので出す。
 */
import type { LocalAssemblyMeta } from "./data-contract";

export type LossyNameMatch = NonNullable<LocalAssemblyMeta["lossyNameMatches"]>[number];

/**
 * その議員の行（無ければ null）。議員ページが「この人の票は字が落ちた氏名で突き合わせた」と書くために引く。
 * **欄が無い県（11 県中 10 県）と、欄はあるがこの議員が載っていない場合を区別しない**——
 * どちらも「この議員については記録が無い」で、画面に出すことは同じだから。
 */
export function lossyNameMatchFor(meta: LocalAssemblyMeta | null, memberId: string): LossyNameMatch | null {
  return meta?.lossyNameMatches?.find((m) => m.memberId === memberId) ?? null;
}

export interface LossyNameSummary {
  /** 字が落ちた氏名で突き合わせた議員の人数 */
  members: number;
  /** その議員に付いた表決の件数の合計（同じ表決を 2 人が数えることはある。人ではなく行の数） */
  rollCalls: number;
  /** 母数（#757）: `counts.rollcalls`。**「0 件」と「1 件も読めていない」を同じ出力にしないため** */
  totalRollCalls: number;
}

/**
 * 議会ごとの集計（`/coverage` が出す）。**meta が無ければ null**——
 * 「0 件」ではなく「**その議会をまだ読んでいない**」なので、0 と同じ形にしてはいけない（#757）。
 * 欄が無い県は `members: 0` で、**母数は返す**（0 件だと言い切れる根拠が母数だから）。
 */
export function lossyNameSummary(meta: LocalAssemblyMeta | null): LossyNameSummary | null {
  if (!meta) return null;
  const rows = meta.lossyNameMatches ?? [];
  return {
    members: rows.length,
    rollCalls: rows.reduce((n, r) => n + r.rollCalls, 0),
    totalRollCalls: meta.counts.rollcalls,
  };
}
