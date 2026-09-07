// @vitest-environment node
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildPrerenderPaths, NOT_FOUND_PRERENDER_PATH, prerenderPaths } from "./prerender";

const fixtures = fileURLToPath(new URL("../test-fixtures/data", import.meta.url));
const missing = fileURLToPath(new URL("../test-fixtures/does-not-exist", import.meta.url));

describe("prerenderPaths", () => {
  it("静的ページ・全議員・全採決を列挙する", async () => {
    const paths = await prerenderPaths(fixtures);
    expect(paths.slice(0, 5)).toEqual(["/", "/about", "/coverage", "/terms", "/privacy"]);
    expect(paths).toContain("/members/m_000123");
    expect(paths).toContain("/rollcalls");
    expect(paths).toContain("/rollcalls/221");
    expect(paths).toContain("/rollcalls/221/221-0724-v007");
    expect(paths).toContain("/assemblies");
    expect(paths).toContain("/assemblies/diet-sangiin");
    expect(new Set(paths).size).toBe(paths.length);
  });
  it("data/ が無ければ静的ページだけ返して落ちない", async () => {
    // /members は #7 以降、データが無くても常に生成する（空の一覧を表示）
    // /assemblies と国会の2議会は #158 以降、assemblies/index.json が無くても生成する（ページ側の fallback と同じ）
    expect(await prerenderPaths(missing)).toEqual(["/", "/about", "/coverage", "/terms", "/privacy", "/members", "/assemblies", "/assemblies/diet-sangiin", "/assemblies/diet-shugiin"]);
  });

  // #610: sitemap.ts / robots.ts はこの関数（prerenderPaths）をそのまま使う。not-found（noindex）が
  // ここに混ざると sitemap に載ってしまい、#325 の「存在しない URL を検索結果に出さない」を破る。
  it("NOT_FOUND_PRERENDER_PATH は含まない（sitemap に出さないため）", async () => {
    expect(await prerenderPaths(fixtures)).not.toContain(NOT_FOUND_PRERENDER_PATH);
    expect(await prerenderPaths(missing)).not.toContain(NOT_FOUND_PRERENDER_PATH);
  });
});

describe("buildPrerenderPaths — react-router.config.ts が実際に prerender する一覧（#610）", () => {
  // 値そのものを固定する（#504「名前を固定した は 値を固定した ではない」）。
  // deploy/nginx/site.conf の error_page は `/__not-found/index.html` を直接パスとして参照するので、
  // ここが別の文字列に変わると nginx 側と食い違い、404 の本文が壊れる。
  it("実際のパスは /__not-found（routes.ts の catch-all にマッチし、他の実在ルートと衝突しない）", () => {
    expect(NOT_FOUND_PRERENDER_PATH).toBe("/__not-found");
  });

  it("prerenderPaths に加えて NOT_FOUND_PRERENDER_PATH を足す", async () => {
    const paths = await buildPrerenderPaths(fixtures);
    expect(paths).toContain("/__not-found");
    expect(paths.filter((p) => p === NOT_FOUND_PRERENDER_PATH)).toHaveLength(1);
    // 中身は prerenderPaths と同じ（末尾に 1 件足すだけ）
    expect(paths.slice(0, -1)).toEqual(await prerenderPaths(fixtures));
  });
});
