// @vitest-environment node
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { memberPaths, readMemberDetail, readMeta } from "./data-files";

const fixtures = fileURLToPath(new URL("../test-fixtures/data", import.meta.url));
const missing = fileURLToPath(new URL("../test-fixtures/does-not-exist", import.meta.url));

/** data/ に壊れた JSON を置いた一時ディレクトリ（ETL 不具合の再現） */
async function brokenDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "seiji-broken-"));
  await writeFile(path.join(dir, "meta.json"), "{ not json");
  await mkdir(path.join(dir, "members"));
  await writeFile(path.join(dir, "members", "index.json"), "{ not json");
  await writeFile(path.join(dir, "members", "m_000123.json"), "{ not json");
  return dir;
}

describe("memberPaths", () => {
  it("一覧 /members と、members/index.json の全議員 /members/{id} を返す", async () => {
    expect(await memberPaths(fixtures)).toEqual(["/members", "/members/m_000123", "/members/m_000456"]);
  });
  it("data/ が無ければ一覧 /members だけを返して落ちない", async () => {
    expect(await memberPaths(missing)).toEqual(["/members"]);
  });
  it("index.json が壊れていれば黙らずに throw する", async () => {
    await expect(memberPaths(await brokenDataDir())).rejects.toThrow(SyntaxError);
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
  it("壊れた JSON は throw する", async () => {
    await expect(readMemberDetail(await brokenDataDir(), "m_000123")).rejects.toThrow(SyntaxError);
  });
});

describe("readMeta", () => {
  it("meta.json を読む", async () => {
    expect((await readMeta(fixtures))?.fetchedAt).toBe("2025-04-01T03:00:00+09:00");
  });
  it("無ければ null", async () => {
    expect(await readMeta(missing)).toBeNull();
  });
  it("壊れた JSON は throw する", async () => {
    await expect(readMeta(await brokenDataDir())).rejects.toThrow(SyntaxError);
  });
});
