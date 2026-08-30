// @vitest-environment node
/**
 * Issue #325: 未知のパスを受ける catch-all ルート。
 * これが無いと React Router はどのルートにも一致せず、404 として見せる画面が定義されない
 * （SPA fallback の <title>Loading...</title> のまま止まる）。
 */
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
