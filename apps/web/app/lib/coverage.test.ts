import { describe, expect, it } from "vitest";
import type { Assembly } from "@seiji-kiroku/shared";
import assembliesFixture from "../test-fixtures/assemblies/index.json";
import localMembers from "../test-fixtures/assemblies/members-index.json";
import sessionsFixture from "../test-fixtures/assemblies/sessions.json";
import { dataset } from "../test-fixtures/dataset";
import { buildCoverage, formatLocalSessionRange, formatSessionRange, sessionRange } from "./coverage";
import type { AssemblySession } from "./data-contract";
import type { Dataset, MemberSummary } from "./dataset";

const assemblies = assembliesFixture as Assembly[];
const sessions = new Map<string, AssemblySession[]>([["pref-04", sessionsFixture as AssemblySession[]]]);
const withLocal: Dataset = { ...dataset, assemblies, members: [...dataset.members, ...(localMembers as MemberSummary[])] };

describe("sessionRange / formatSessionRange", () => {
  it("最小と最大を取る（順不同でよい）", () => {
    expect(sessionRange([221, 200, 210])).toEqual({ from: 200, to: 221 });
  });
  it("空なら null、1 つなら from === to", () => {
    expect(sessionRange([])).toBeNull();
    expect(sessionRange([221])).toEqual({ from: 221, to: 221 });
  });
  it("表示は「第200—221回」、1 つなら「第221回」、空なら null", () => {
    expect(formatSessionRange({ from: 200, to: 221 })).toBe("第200—221回");
    expect(formatSessionRange({ from: 221, to: 221 })).toBe("第221回");
    expect(formatSessionRange(null)).toBeNull();
  });
});

describe("buildCoverage: 国会", () => {
  it("meta.sessions の範囲をそのまま数える", () => {
    expect(buildCoverage(withLocal, sessions).metaSessions).toEqual({ from: 220, to: 221 });
  });

  it("参議院は rollcalls/index.json の件数と回次の範囲を持ち、個人票あり", () => {
    const sangiin = buildCoverage(withLocal, sessions).diet.find((d) => d.assemblyId === "diet-sangiin")!;
    expect(sangiin.name).toBe("参議院");
    expect(sangiin.house).toBe("sangiin");
    expect(sangiin.individualVotes).toBe(true);
    expect(sangiin.rollcalls).toBe(dataset.rollcalls.length);
    expect(sangiin.rollcallSessions).toEqual({ from: 220, to: 221 });
    expect(sangiin.members).toBe(3);
    expect(sangiin.sourceUrl).toBe(assemblies[0]!.sourceUrl);
  });

  it("衆議院は個人票が無いので採決 0 件・回次の範囲なし（参院の件数を流用しない）", () => {
    const shugiin = buildCoverage(withLocal, sessions).diet.find((d) => d.assemblyId === "diet-shugiin")!;
    expect(shugiin.individualVotes).toBe(false);
    expect(shugiin.rollcalls).toBe(0);
    expect(shugiin.rollcallSessions).toBeNull();
  });

  it("assemblyId の無い（#156 より前の）議員は house から国会の議会に数える", () => {
    const diet = buildCoverage({ ...dataset, assemblies }, new Map()).diet;
    expect(diet.find((d) => d.assemblyId === "diet-sangiin")!.members).toBe(3);
    expect(diet.find((d) => d.assemblyId === "diet-shugiin")!.members).toBe(0);
  });
});

describe("buildCoverage: 地方議会", () => {
  it("会期一覧から採決数・会期数・最新/最古の会期・取得元を数える", () => {
    const miyagi = buildCoverage(withLocal, sessions).local.find((l) => l.assemblyId === "pref-04")!;
    expect(miyagi.name).toBe("宮城県議会");
    expect(miyagi.kind).toBe("prefectural");
    expect(miyagi.members).toBe(3);
    expect(miyagi.sessions).toBe(2);
    expect(miyagi.rollcalls).toBe(5); // 3 + 2
    expect(miyagi.sessionRange!.newest.id).toBe("399");
    expect(miyagi.sessionRange!.oldest.id).toBe("398");
    expect(miyagi.sources.map((s) => s.sourceUrl)).toEqual((sessionsFixture as AssemblySession[]).map((s) => s.sourceUrl));
  });

  it("会期一覧が無い議会は 0 件で載る（落とさない）", () => {
    const miyagi = buildCoverage(withLocal, new Map()).local.find((l) => l.assemblyId === "pref-04")!;
    expect(miyagi.rollcalls).toBe(0);
    expect(miyagi.sessions).toBe(0);
    expect(miyagi.sessionRange).toBeNull();
    expect(formatLocalSessionRange(miyagi)).toBeNull();
  });

  it("会期の表示は原文のまま「古い 〜 新しい」、1 会期なら 1 つだけ", () => {
    const miyagi = buildCoverage(withLocal, sessions).local.find((l) => l.assemblyId === "pref-04")!;
    expect(formatLocalSessionRange(miyagi)).toBe("第398回（令和7年11月定例会） 〜 第399回（令和8年2月定例会）");
    const one = new Map<string, AssemblySession[]>([["pref-04", [(sessionsFixture as AssemblySession[])[0]!]]]);
    expect(formatLocalSessionRange(buildCoverage(withLocal, one).local[0]!)).toBe("第399回（令和8年2月定例会）");
  });
});

describe("buildCoverage: 合計", () => {
  it("国会・地方それぞれの採決数と議員数、議会数を数える", () => {
    const { totals } = buildCoverage(withLocal, sessions);
    expect(totals.dietRollcalls).toBe(dataset.rollcalls.length);
    expect(totals.dietMembers).toBe(3);
    expect(totals.localRollcalls).toBe(5);
    expect(totals.localMembers).toBe(3);
    expect(totals.assemblies).toBe(3);
  });

  it("assemblies/index.json が無い古いデータでは国会の 2 議会だけ", () => {
    const c = buildCoverage({ ...dataset, assemblies: undefined }, new Map());
    expect(c.diet.map((d) => d.assemblyId)).toEqual(["diet-sangiin", "diet-shugiin"]);
    expect(c.local).toEqual([]);
    expect(c.totals.assemblies).toBe(2);
  });

  it("データが空でも落ちない", () => {
    const c = buildCoverage({ meta: undefined, members: [], rollcalls: [] }, new Map());
    expect(c.metaSessions).toBeNull();
    expect(c.totals.dietRollcalls).toBe(0);
    expect(c.diet.every((d) => d.members === 0)).toBe(true);
  });
});
