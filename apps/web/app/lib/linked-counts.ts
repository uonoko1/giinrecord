/**
 * 「議員ページに実際に出ている記録の件数」（#251）を院ごとに数える純関数。
 *
 * **なぜ独立したファイルなのか（#451）。** この計算は `/coverage`（Vite でバンドルされる画面）と
 * `data-files.ts`（**tsx で直に走るビルドスクリプト**から読まれる）の両方から呼ばれる。
 * 元は `coverage.ts` にあったが、あちらは `assemblies.ts` 経由で `import.meta.glob`（Vite 専用）に
 * 触るので、tsx から値として import すると `import.meta.glob is not a function` でビルドが落ちる。
 * #441 はそれを避けるために **`data-files.ts` へ計算を書き写した**——書き写した側にテストが無く、
 * `questions` を 0 に固定しても web の 925 件が全部緑のままになった。
 *
 * **このファイルは型以外を持ち込まない。** だから Vite からも tsx からも呼べる。
 * **他のモジュールを値として引き込む行をここに足さないこと**——足した瞬間にビルドスクリプトが落ちる。
 * `import` だけでなく **`export { x } from "./assemblies"` の 1 行でも同じように落ちる**
 * （#451 のレビューで実際に破られた。テストは 935 件全部緑のまま、tsx 経路だけが
 * `import.meta.glob is not a function` で落ちた）。型だけなら `import type` / `export type`。
 * その制約は `data-files.test.ts` がソースの形で固定している。
 *
 * `members-count.ts` とは分けてある（#451 レビュー）。あちらは「**議員を人数として数えるときの
 * 現職判定**」（`isCurrentMember` / `isCurrentOf`）で、しかも「**収録範囲（/coverage）はこれを
 * 使わない**」と明記している。ここは逆に `/coverage` が使う「記録の件数」なので、意味が違う。
 */
import type { MemberSummary } from "./data-contract";

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
 * **#451: この計算はここ 1 か所にしか無い。** `coverage.ts` は再 export するだけ、
 * `data-files.ts` はこれを呼ぶだけ。ずれる余地を残していない。
 */
export function linkedRecordCounts(members: readonly CountedMember[], house: MemberSummary["house"]): LinkedRecordCounts | null {
  const rows = members.filter((m) => m.house === house);
  if (rows.length === 0) return null;
  const sum = (pick: (c: CountedMember["counts"]) => number | undefined) => rows.reduce((t, m) => t + (pick(m.counts) ?? 0), 0);
  return { rollcalls: sum((c) => c.rollcalls), bills: sum((c) => c.bills), speeches: sum((c) => c.speeches), questions: sum((c) => c.questions) };
}
