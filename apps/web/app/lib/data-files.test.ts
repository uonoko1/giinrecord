// @vitest-environment node
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assemblyPaths, memberPaths, readAssemblies, readAssemblySessions, readLocalRollCallIndex, readMemberDetail, readMeta, readRollCall, readShugiinBillNameStats, rollCallPaths } from "./data-files";

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

describe("readShugiinBillNameStats（#251）", () => {
  /** bills/{回次}/{id}.json と members/index.json を置いた一時ディレクトリ */
  async function billsDataDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "seiji-bills-"));
    await mkdir(path.join(dir, "members"));
    await writeFile(
      path.join(dir, "members", "index.json"),
      JSON.stringify([
        { id: "h_1", name: "中島 克仁", kana: "なかじま かつひと", house: "shugiin", group: "立憲", district: "山梨1", counts: { rollcalls: 0, bills: 1, speeches: 0 } },
        { id: "h_2", name: "阿部 知子", kana: "あべ ともこ", house: "shugiin", group: "立憲", district: "神奈川12", counts: { rollcalls: 0, bills: 1, speeches: 0 } },
        // 参院議員は衆院の名簿に数えない
        { id: "m_1", name: "東 徹", kana: "あずま とおる", house: "sangiin", group: "維新", district: "大阪", counts: { rollcalls: 0, bills: 0, speeches: 0 } },
      ]),
    );
    await mkdir(path.join(dir, "bills", "221"), { recursive: true });
    await mkdir(path.join(dir, "bills", "217"), { recursive: true });
    await writeFile(
      path.join(dir, "bills", "221", "221-衆法-1.json"),
      JSON.stringify({ id: "221-衆法-1", house: "shugiin", session: 221, title: "法案", submitterNames: ["中島克仁"], submitters: ["h_1"], supporterNames: ["阿部知子", "東徹君"], supporters: ["h_2"] }),
    );
    // 名簿の回次より前: 氏名だけあって紐づかない
    await writeFile(
      path.join(dir, "bills", "217", "217-衆法-1.json"),
      JSON.stringify({ id: "217-衆法-1", house: "shugiin", session: 217, title: "古い法案", submitterNames: ["中島克仁", "退任 太郎"], supporterNames: ["別人 花子"] }),
    );
    // 参院の議案は数えない
    await writeFile(path.join(dir, "bills", "217", "217-参法-1.json"), JSON.stringify({ id: "217-参法-1", house: "sangiin", session: 217, title: "参法", submitterNames: ["東徹"] }));
    return dir;
  }

  it("衆院の議案の氏名の延べ数と、紐づいた memberId の延べ数を数える（参院の議案は数えない）", async () => {
    const stats = await readShugiinBillNameStats(await billsDataDir());
    expect(stats?.names).toBe(6); // 221: 3、217: 3
    expect(stats?.linked).toBe(2); // 221 の submitters 1 + supporters 1
  });

  it("回次ごとに、異なり氏名の数と現在の名簿にある数を数える（氏名は空白を除いて突合）", async () => {
    const stats = await readShugiinBillNameStats(await billsDataDir());
    expect(stats?.sessions).toEqual([
      // 「退任 太郎」「別人 花子」は名簿に無い
      { session: 217, names: 3, inRoster: 1 },
      // 「東徹君」は「君」が残っているので名簿の氏名と一致しない（docs/research/shugiin-roster.md の注）
      { session: 221, names: 3, inRoster: 2 },
    ]);
  });

  it("衆院の名簿の人数と、名簿のなかで氏名が重複する人数を数える", async () => {
    const stats = await readShugiinBillNameStats(await billsDataDir());
    expect(stats?.rosterMembers).toBe(2); // 参院議員は数えない
    expect(stats?.rosterDuplicateNames).toBe(0);
  });

  it("bills/ が無ければ null（無い事実を作らない）", async () => {
    expect(await readShugiinBillNameStats(missing)).toBeNull();
  });
});
