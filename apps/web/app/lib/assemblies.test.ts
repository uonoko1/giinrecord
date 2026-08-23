import { describe, expect, it } from "vitest";
import type { Assembly } from "@seiji-kiroku/shared";
import disclosure from "../data/vote-disclosure.json";
import assembliesFixture from "../test-fixtures/assemblies/index.json";
import localMember from "../test-fixtures/assemblies/member-local.json";
import type { MemberDetail } from "./data-contract";
import { DISCLOSURE_STATUSES, disclosureFor, findAssembly, isDietAssemblyId, isLocalMember, localAssemblies, localVoteTone, VOTE_DISCLOSURE, type VoteDisclosureRow } from "./assemblies";

const assemblies = assembliesFixture as Assembly[];

describe("isDietAssemblyId / isLocalMember", () => {
  it("diet- で始まる id は国会、それ以外は地方", () => {
    expect(isDietAssemblyId("diet-sangiin")).toBe(true);
    expect(isDietAssemblyId("diet-shugiin")).toBe(true);
    expect(isDietAssemblyId("pref-04")).toBe(false);
    expect(isDietAssemblyId("city-33100")).toBe(false);
  });
  it("assemblyId が無い（古いデータ）議員は国会議員", () => {
    expect(isLocalMember({ house: "sangiin" })).toBe(false);
    expect(isLocalMember({ house: "sangiin", assemblyId: "diet-sangiin" })).toBe(false);
    expect(isLocalMember(localMember as MemberDetail)).toBe(true);
  });
});

describe("findAssembly / localAssemblies", () => {
  it("id で議会を引く。無ければ undefined", () => {
    expect(findAssembly(assemblies, "pref-04")?.name).toBe("宮城県議会");
    expect(findAssembly(assemblies, "pref-99")).toBeUndefined();
  });
  it("localAssemblies は national 以外だけ", () => {
    expect(localAssemblies(assemblies).map((a) => a.id)).toEqual(["pref-04"]);
    expect(localAssemblies(undefined)).toEqual([]);
  });
});

describe("vote-disclosure.json（#128 の調査表から機械的に起こした公開状況）", () => {
  const rows = VOTE_DISCLOSURE.rows;
  it("47 都道府県 + 20 政令市 = 67 行、調査日と出典を持つ", () => {
    expect(rows).toHaveLength(67);
    expect(rows.filter((r) => r.kind === "prefectural")).toHaveLength(47);
    expect(rows.filter((r) => r.kind === "municipal")).toHaveLength(20);
    expect(VOTE_DISCLOSURE.surveyedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(VOTE_DISCLOSURE.source).toBe("docs/research/local-assemblies.md");
    expect(disclosure.rows).toHaveLength(67);
  });
  it("集計は調査の要約と一致する（都道府県 12/14/14/7、政令市 6/12/2/0）", () => {
    const count = (kind: VoteDisclosureRow["kind"], status: VoteDisclosureRow["status"]) => rows.filter((r) => r.kind === kind && r.status === status).length;
    expect(DISCLOSURE_STATUSES.map((s) => count("prefectural", s))).toEqual([12, 14, 14, 7]);
    expect(DISCLOSURE_STATUSES.map((s) => count("municipal", s))).toEqual([6, 12, 2, 0]);
  });
  it("全行が https の出典 URL と一意の assemblyId を持ち、status は4値", () => {
    expect(new Set(rows.map((r) => r.assemblyId)).size).toBe(67);
    for (const r of rows) {
      expect(r.sourceUrl).toMatch(/^https:\/\//);
      expect(DISCLOSURE_STATUSES).toContain(r.status);
      expect(r.assemblyId).toMatch(/^(pref-\d{2}|city-\d{5})$/);
      expect(r.label.length).toBeGreaterThan(0);
    }
  });
  it("宮城は 公開・PDF、岡山市は 公開（起立採決のみ）", () => {
    expect(disclosureFor("pref-04")).toMatchObject({ label: "宮城", status: "公開", format: "PDF（index は HTML）" });
    expect(disclosureFor("city-33100")).toMatchObject({ label: "岡山市", status: "公開", statusNote: "起立採決のみ" });
    expect(disclosureFor("diet-sangiin")).toBeUndefined();
  });
});

describe("localVoteTone: 判の色は mapped がある値だけ。それ以外は中立", () => {
  it("mapped 賛成→yes、反対→no、投票なし→none", () => {
    expect(localVoteTone({ raw: "○", legend: "賛成", mapped: "賛成" })).toBe("yes");
    expect(localVoteTone({ raw: "×", legend: "反対", mapped: "反対" })).toBe("no");
    expect(localVoteTone({ raw: "欠", legend: "欠席", mapped: "投票なし" })).toBe("none");
  });
  it("mapped が無ければ raw が ○ でも中立（推定しない）", () => {
    expect(localVoteTone({ raw: "○", legend: "賛成" })).toBe("raw");
    expect(localVoteTone({ raw: "棄", legend: "棄権" })).toBe("raw");
  });
});
