import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { memberPaths, readMemberDetail, readMeta } from "./data-files";

const fixtures = fileURLToPath(new URL("../test-fixtures/data", import.meta.url));
const missing = fileURLToPath(new URL("../test-fixtures/does-not-exist", import.meta.url));

describe("memberPaths", () => {
  it("members/index.json の全議員を /members/{id} にする", async () => {
    expect(await memberPaths(fixtures)).toEqual(["/members/m_000123", "/members/m_000456"]);
  });
  it("data/ が無ければ空配列を返して落ちない", async () => {
    expect(await memberPaths(missing)).toEqual([]);
  });
});

describe("readMemberDetail", () => {
  it("members/{id}.json を読む", async () => {
    const detail = await readMemberDetail(fixtures, "m_000123");
    expect(detail?.name).toBe("藤川 政人");
    expect(detail?.timeline).toHaveLength(4);
  });
  it("無い id は null", async () => {
    expect(await readMemberDetail(fixtures, "m_999999")).toBeNull();
  });
  it("パス区切りを含む id は読まない", async () => {
    expect(await readMemberDetail(fixtures, "../meta")).toBeNull();
  });
});

describe("readMeta", () => {
  it("meta.json を読む", async () => {
    expect((await readMeta(fixtures))?.fetchedAt).toBe("2025-04-01T03:00:00+09:00");
  });
  it("無ければ null", async () => {
    expect(await readMeta(missing)).toBeNull();
  });
});
