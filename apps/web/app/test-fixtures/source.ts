import type { DatasetSource, SourceHouse, SourceKind } from "../lib/data-contract";

/**
 * テスト用の出典1件。`house` / `kind`（#339）の既定を埋めるだけで、
 * 各テストは自分が関心のあるフィールドだけ書けばよい。
 */
export const source = (o: Partial<DatasetSource> & { name: string; url: string }): DatasetSource => ({
  fetchedAt: "2026-08-24T00:00:00.000Z",
  house: houseFromUrl(o.url),
  kind: "roster",
  ...o,
});

const houseFromUrl = (url: string): SourceHouse => (url.includes("shugiin.go.jp") ? "shugiin" : "sangiin");

export const sources = (list: (Partial<DatasetSource> & { name: string; url: string })[]): DatasetSource[] => list.map(source);
export type { SourceKind };
