// @vitest-environment node
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prerenderPaths } from "./prerender";

const fixtures = fileURLToPath(new URL("../test-fixtures/data", import.meta.url));
const missing = fileURLToPath(new URL("../test-fixtures/does-not-exist", import.meta.url));

describe("prerenderPaths", () => {
  it("静的ページ・全議員・全採決を列挙する", async () => {
    const paths = await prerenderPaths(fixtures);
    expect(paths.slice(0, 2)).toEqual(["/", "/about"]);
    expect(paths).toContain("/members/m_000123");
    expect(paths).toContain("/rollcalls");
    expect(paths).toContain("/rollcalls/221");
    expect(paths).toContain("/rollcalls/221/221-0724-v007");
    expect(new Set(paths).size).toBe(paths.length);
  });
  it("data/ が無ければ静的ページだけ返して落ちない", async () => {
    expect(await prerenderPaths(missing)).toEqual(["/", "/about"]);
  });
});
