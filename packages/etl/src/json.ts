/**
 * `data/` 配下の JSON 書式（docs/DATA_CONTRACT.md）: キーは再帰的にソート、インデント1、末尾改行。
 * 差分を小さくするため、data/ に書くものはすべてこれを通す。
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, sortKeys, 1) + "\n";
}

const sortKeys = (_: string, v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v;
