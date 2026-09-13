// @vitest-environment node
/**
 * Issue #325: 未知のパスを受ける catch-all ルート。
 * これが無いと React Router はどのルートにも一致せず、404 として見せる画面が定義されない
 * （SPA fallback の <title>Loading...</title> のまま止まる）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import routes from "./routes";

type Route = { path?: string; file: string; children?: Route[] };
const flat = routes as unknown as Route[];

describe("catch-all ルート（#325）", () => {
  it("未知のパスを受ける splat ルート `*` がある", () => {
    expect(flat.map((r) => r.path)).toContain("*");
  });

  it("catch-all は routes/not-found.tsx を描く", () => {
    const catchAll = flat.find((r) => r.path === "*");
    expect(catchAll?.file).toBe("routes/not-found.tsx");
  });

  // 順序が要点: React Router は上から順に照合するので、`*` が実在ルートより前にあると
  // /members/ や /coverage/ まで 404 画面になる。
  it("catch-all は最後にある（実在ルートを飲み込まない）", () => {
    expect(flat.at(-1)?.path).toBe("*");
    expect(flat.length).toBeGreaterThan(1);
  });

  it("catch-all は 1 つだけ（重複すると後ろが死ぬ）", () => {
    expect(flat.filter((r) => r.path === "*")).toHaveLength(1);
  });
});

/**
 * `routes.ts` が実際に登録しているパターンの**文字列そのもの**を固定する（#791）。
 *
 * **#791 は「ルートが無いので URL が存在しない」という不具合だった。** 上の #325 の検査は
 * catch-all の位置だけを見ていて、**どのパターンが登録されているか**は誰も見ていなかった。
 * 本番で 200 を返している国会の URL（`/rollcalls/221/221-0724-v007`）は、
 * `rollcalls/:session/:id` というパターンがあって初めて存在する（#504「名前を固定した は 値を固定した ではない」）。
 *
 * 上の `flat` は `routes.ts` を**実行した**結果なので、`data/` の有無で条件分岐するルート
 * （`hasRollCallData` / `hasLocalRollCallData`）は環境次第で入らない。
 * ここは**ソースの文言**を読む（データが無い CI でも「何を登録するつもりか」が固定される）。
 */
describe("routes.ts のパターン（#791）", () => {
  const source = readFileSync(fileURLToPath(new URL("./routes.ts", import.meta.url)), "utf8");
  /** `route("<pattern>", "<module>")` の第 1 引数と第 2 引数 */
  const pairs: [string, string][] = [...source.matchAll(/\broute\(\s*"([^"]+)"\s*,\s*"([^"]+)"/g)].map((m) => [m[1] as string, m[2] as string]);

  /** #791 の「必ず守ること」: 既存の国会側の URL を壊さない */
  it("国会の採決は rollcalls/:session? と rollcalls/:session/:id のまま（/rollcalls/221/221-0724-v007 を成り立たせる）", () => {
    expect(pairs).toContainEqual(["rollcalls/:session?", "routes/rollcalls.tsx"]);
    expect(pairs).toContainEqual(["rollcalls/:session/:id", "routes/rollcall.tsx"]);
  });

  /** #791 本体: 地方の採決は議会ごとの URL 空間に置く（国会の /rollcalls には混ぜない） */
  it("地方の採決は assemblies/:assemblyId/rollcalls とその配下", () => {
    expect(pairs).toContainEqual(["assemblies/:assemblyId/rollcalls", "routes/local-rollcalls.tsx"]);
    expect(pairs).toContainEqual(["assemblies/:assemblyId/rollcalls/:id", "routes/local-rollcall.tsx"]);
  });

  it("議員ページ・議会ページ・議会一覧は変わらない", () => {
    expect(pairs).toContainEqual(["members/:id", "routes/member.tsx"]);
    expect(pairs).toContainEqual(["assemblies/:id", "routes/assembly.tsx"]);
    expect(pairs).toContainEqual(["assemblies", "routes/assemblies.tsx"]);
  });

  /** #325: catch-all は必ず最後（前に置くと実在ルートを飲み込む）。ソースの並びでも固定する */
  it("catch-all はソース上でも最後の route", () => {
    expect(pairs.at(-1)).toEqual(["*", "routes/not-found.tsx"]);
  });

  it("同じパターンを 2 つ登録しない", () => {
    const patterns = pairs.map(([p]) => p);
    expect(new Set(patterns).size).toBe(patterns.length);
  });
});
