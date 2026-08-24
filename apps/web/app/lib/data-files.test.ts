// @vitest-environment node
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assemblyPaths, memberPaths, readAssemblies, readAssemblySessions, readLocalRollCallIndex, readMemberDetail, readMeta, readRollCall, rollCallPaths } from "./data-files";

const fixtures = fileURLToPath(new URL("../test-fixtures/data", import.meta.url));
const missing = fileURLToPath(new URL("../test-fixtures/does-not-exist", import.meta.url));
const assemblyFixtures = fileURLToPath(new URL("../test-fixtures/assemblies/data", import.meta.url));

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

describe("rollCallPaths", () => {
  it("一覧・回次別一覧・全採決ページを列挙する", async () => {
    expect(await rollCallPaths(fixtures)).toEqual([
      "/rollcalls",
      "/rollcalls/220",
      "/rollcalls/221",
      "/rollcalls/220/220-0124-v001",
      "/rollcalls/221/221-0323-v001",
      "/rollcalls/221/221-0724-v006",
      "/rollcalls/221/221-0724-v007",
    ]);
  });
  it("data/ が無ければ空配列を返して落ちない", async () => {
    expect(await rollCallPaths(missing)).toEqual([]);
  });
  it("index.json が壊れていれば黙らずに throw する", async () => {
    const dir = await brokenDataDir();
    await mkdir(path.join(dir, "rollcalls"));
    await writeFile(path.join(dir, "rollcalls", "index.json"), "{ not json");
    await expect(rollCallPaths(dir)).rejects.toThrow(SyntaxError);
  });
});

describe("readRollCall", () => {
  it("rollcalls/{session}/{id}.json を読む", async () => {
    const rc = await readRollCall(fixtures, "221", "221-0724-v007");
    expect(rc?.title).toMatch(/特別区の設置/);
    expect(rc?.votes).toHaveLength(10);
  });
  it("無い id は null", async () => {
    expect(await readRollCall(fixtures, "221", "221-9999-v999")).toBeNull();
  });
  it("パス区切りを含む session / id は読まない", async () => {
    expect(await readRollCall(fixtures, "../members", "index")).toBeNull();
    expect(await readRollCall(fixtures, "221", "../index")).toBeNull();
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

describe("readAssemblies / assemblyPaths（#158）", () => {
  it("assemblies/index.json を読む", async () => {
    const list = await readAssemblies(assemblyFixtures);
    expect(list?.map((a) => a.id)).toEqual(["diet-sangiin", "diet-shugiin", "pref-04"]);
  });
  it("assemblies/index.json が無ければ null", async () => {
    expect(await readAssemblies(missing)).toBeNull();
  });
  it("一覧 /assemblies と index.json の全議会 /assemblies/{id} を返す", async () => {
    expect(await assemblyPaths(assemblyFixtures)).toEqual(["/assemblies", "/assemblies/diet-sangiin", "/assemblies/diet-shugiin", "/assemblies/pref-04"]);
  });
  it("index.json が無い（#156 より前の）データでは国会の2議会を返す（ページ側の fallback と同じ）", async () => {
    expect(await assemblyPaths(missing)).toEqual(["/assemblies", "/assemblies/diet-sangiin", "/assemblies/diet-shugiin"]);
  });
  it("index.json が壊れていれば黙らずに throw する", async () => {
    const dir = await brokenDataDir();
    await mkdir(path.join(dir, "assemblies"));
    await writeFile(path.join(dir, "assemblies", "index.json"), "{ not json");
    await expect(assemblyPaths(dir)).rejects.toThrow(SyntaxError);
  });
});

describe("readAssemblySessions（#158）", () => {
  it("assemblies/{id}/sessions.json を読む", async () => {
    const sessions = await readAssemblySessions(assemblyFixtures, "pref-04");
    expect(sessions?.map((s) => s.id)).toEqual(["399", "398"]);
  });
  it("無い議会・パス区切りを含む id は null", async () => {
    expect(await readAssemblySessions(assemblyFixtures, "pref-99")).toBeNull();
    expect(await readAssemblySessions(assemblyFixtures, "../index")).toBeNull();
  });
});

describe("readLocalRollCallIndex（#204）", () => {
  it("assemblies/{id}/rollcalls/index.json を読み、voteSubject / committeeReport の原文をそのまま返す", async () => {
    const index = await readLocalRollCallIndex(assemblyFixtures, "pref-31");
    expect(index).toHaveLength(3);
    const chinjo = index?.find((r) => r.id === "pref-31-2026-06-20260629-陳情-8年-11");
    expect(chinjo?.voteSubject).toBe("委員長報告に対する賛否");
    expect(chinjo?.committeeReport).toBe("不採択");
    const giin = index?.find((r) => r.id === "pref-31-2026-06-20260629-知事提案-第10号");
    expect(giin?.voteSubject).toBe("議案に対する賛否");
    expect(giin?.committeeReport).toBeUndefined();
  });
  it("無い議会（宮城には rollcalls/index.json が無い）・パス区切りを含む id は null", async () => {
    expect(await readLocalRollCallIndex(assemblyFixtures, "pref-04")).toBeNull();
    expect(await readLocalRollCallIndex(assemblyFixtures, "pref-99")).toBeNull();
    expect(await readLocalRollCallIndex(assemblyFixtures, "../pref-31")).toBeNull();
  });
});
