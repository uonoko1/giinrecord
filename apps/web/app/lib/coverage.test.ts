import { describe, expect, it } from "vitest";
import type { Assembly } from "@seiji-kiroku/shared";
import assembliesFixture from "../test-fixtures/assemblies/index.json";
import localMembers from "../test-fixtures/assemblies/members-index.json";
import sessionsFixture from "../test-fixtures/assemblies/sessions.json";
import { dataset } from "../test-fixtures/dataset";
import { buildCoverage, formatLocalSessionRange, formatSessionRange, hasSessionGaps, linkedRecordCounts, rosterlessSessions, rosterScope, sangiinUnlinkedVotes, sessionRange, shugiinBillNameCoverage, shugiinQuestionCoverage, shugiinRosterAsOf, speechCoverage } from "./coverage";
import type { AssemblySession } from "./data-contract";
import type { Dataset, MemberSummary } from "./dataset";

const assemblies = assembliesFixture as Assembly[];
const sessions = new Map<string, AssemblySession[]>([["pref-04", sessionsFixture as AssemblySession[]]]);
const withLocal: Dataset = { ...dataset, assemblies, members: [...dataset.members, ...(localMembers as MemberSummary[])] };

describe("sessionRange / formatSessionRange", () => {
  it("最小と最大に加えて、実際に行のあった回次の数（重複を除く）を持つ", () => {
    expect(sessionRange([221, 200, 210])).toEqual({ from: 200, to: 221, count: 3 });
    expect(sessionRange([221, 221, 220])).toEqual({ from: 220, to: 221, count: 2 });
  });
  it("空なら null、1 つなら from === to", () => {
    expect(sessionRange([])).toBeNull();
    expect(sessionRange([221])).toEqual({ from: 221, to: 221, count: 1 });
  });
  it("歯抜け（範囲のうち 0 件の回次がある）を判定する", () => {
    // 実データの参院: 第200—221回のうち記名投票のある回次は 11
    expect(hasSessionGaps(sessionRange([200, 201, 204, 208, 209, 211, 213, 214, 217, 219, 221]))).toBe(true);
    expect(hasSessionGaps(sessionRange([220, 221]))).toBe(false);
    expect(hasSessionGaps(sessionRange([221]))).toBe(false);
    expect(hasSessionGaps(null)).toBe(false);
  });
  it("表示は「第200—221回」、1 つなら「第221回」、空なら null", () => {
    expect(formatSessionRange({ from: 200, to: 221, count: 11 })).toBe("第200—221回");
    expect(formatSessionRange({ from: 221, to: 221, count: 1 })).toBe("第221回");
    expect(formatSessionRange(null)).toBeNull();
  });

  // #219: 第142〜199回のバックフィル後も、範囲と実回次数の両方を出して連続収録と読ませない。
  // 第160回・第199回のように採決が 1 件も無い回次があるので、遡っても歯抜けは残る。
  it("第142回まで遡っても範囲は最小〜最大、歯抜けは歯抜けのまま出る", () => {
    const backfilled = [142, 143, 145, 150, 170, 180, 190, 200, 201, 221];
    const range = sessionRange(backfilled);
    expect(range).toEqual({ from: 142, to: 221, count: 10 });
    expect(hasSessionGaps(range)).toBe(true);
    expect(formatSessionRange(range)).toBe("第142—221回");
  });
});

describe("rosterlessSessions: 名簿の無い回次（#219 / #230）", () => {
  const meta = (sessions: number[], rosterSessions: number[]) => ({
    fetchedAt: "2026-08-24T00:00:00.000Z",
    sessions,
    sources: rosterSessions.map((s) => ({ name: `参議院 議員一覧（第${s}回）`, url: `https://www.sangiin.go.jp/japanese/joho1/kousei/giin/${s}/giin.htm`, fetchedAt: "2026-08-24T00:00:00.000Z" })),
  });

  it("最古の名簿より前の回次を、データ（meta.sources の議員一覧）から数える", () => {
    const r = rosterlessSessions(meta([142, 150, 200, 216, 221], [216, 217, 221]));
    expect(r).toEqual({ earliestRoster: 216, sessions: [142, 150, 200], range: { from: 142, to: 200, count: 3 } });
  });

  it("全回次に名簿があれば空（回次はハードコードしない）", () => {
    expect(rosterlessSessions(meta([220, 221], [219, 220, 221]))?.sessions).toEqual([]);
  });

  it("meta が無い・議員一覧の出典が無いなら null（推定しない）", () => {
    expect(rosterlessSessions(undefined)).toBeNull();
    expect(rosterlessSessions(meta([142], []))).toBeNull();
  });
});

describe("speechCoverage: 発言をどの会議まで取っているか（#242）", () => {
  const at = "2026-08-25T00:00:00.000Z";
  const src = (name: string, url: string) => ({ name, url, fetchedAt: at });
  const API = "https://kokkai.ndl.go.jp/api/speech";
  const metaOf = (sources: { name: string; url: string; fetchedAt: string }[]) => ({ fetchedAt: at, sessions: [221], sources });

  it("nameOfMeeting が付いていなければ委員会も取っている（#242）", () => {
    const m = metaOf([
      src("国会会議録検索システム 検索用API（参議院 本会議・委員会）", `${API}?nameOfHouse=%E5%8F%82%E8%AD%B0%E9%99%A2&sessionFrom=221&sessionTo=221&recordPacking=json`),
      src("国会会議録検索システム 検索用API（衆議院 本会議・委員会）", `${API}?nameOfHouse=%E8%A1%86%E8%AD%B0%E9%99%A2&sessionFrom=221&sessionTo=221&recordPacking=json`),
    ]);
    expect(speechCoverage(m).map((c) => [c.house, c.committees])).toEqual([["sangiin", true], ["shugiin", true]]);
  });

  it("nameOfMeeting=本会議 が付いていれば本会議だけ（#242 以前の出力もそのまま読める）", () => {
    const m = metaOf([src("国会会議録検索システム 検索用API（参議院 本会議）", `${API}?nameOfHouse=%E5%8F%82%E8%AD%B0%E9%99%A2&nameOfMeeting=%E6%9C%AC%E4%BC%9A%E8%AD%B0&sessionFrom=221&sessionTo=221`)]);
    expect(speechCoverage(m).map((c) => [c.house, c.committees])).toEqual([["sangiin", false]]);
  });

  it("委員会の出席者欄（#109）の出典は発言ではないので数えない", () => {
    const m = metaOf([src("国会会議録検索システム 検索用API（参議院 委員会の出席者欄）", `${API}?nameOfHouse=%E5%8F%82%E8%AD%B0%E9%99%A2&speaker=%E4%BC%9A%E8%AD%B0%E9%8C%B2%E6%83%85%E5%A0%B1&any=%E7%99%BA%E8%AD%B0%E8%80%85&sessionFrom=221&sessionTo=221`)]);
    expect(speechCoverage(m)).toEqual([]);
  });

  it("meta が無い・会議録の出典が無ければ空（推定しない）", () => {
    expect(speechCoverage(undefined)).toEqual([]);
    expect(speechCoverage(metaOf([src("参議院 議員一覧（第221回）", "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm")]))).toEqual([]);
  });
});

describe("shugiinQuestionCoverage: 衆院の質問主意書を取得した回次（#235）", () => {
  // 「取得した回次」と「議員ページに出るか」は別の事実。ここは取得した回次だけを数え、
  // 出るかどうかは linkedRecordCounts が実数で数える（代理値で「第N回のぶんだけ出る」と言わない。#259 レビュー）
  const meta = (fetched: number[], sessions: number[]) => ({
    fetchedAt: "2026-08-24T00:00:00.000Z",
    sessions,
    sources: [
      { name: "衆議院 議員一覧（2026-02-18現在）", url: "https://www.shugiin.go.jp/internet/itdb_annai.nsf/html/statics/syu/1giin.htm", fetchedAt: "2026-08-24T00:00:00.000Z" },
      ...fetched.map((s) => ({ name: `衆議院 質問答弁情報（第${s}回）`, url: `https://www.shugiin.go.jp/internet/itdb_shitsumon.nsf/html/shitsumon/kaiji${s}_l.htm`, fetchedAt: "2026-08-24T00:00:00.000Z" })),
    ],
  });

  it("出典から取得した回次の範囲を数える（meta.sessions からは推論しない）", () => {
    expect(shugiinQuestionCoverage(meta([200, 210, 216], [200, 210, 216, 221]))).toEqual({ fetched: { from: 200, to: 216, count: 3 } });
  });

  it("1 回次だけなら from === to", () => {
    expect(shugiinQuestionCoverage(meta([221], [221]))).toEqual({ fetched: { from: 221, to: 221, count: 1 } });
  });

  it("meta が無い・質問答弁情報の出典が無いなら null（推定しない）", () => {
    expect(shugiinQuestionCoverage(undefined)).toBeNull();
    expect(shugiinQuestionCoverage(meta([], [221]))).toBeNull();
  });
});

describe("linkedRecordCounts: 議員ページに実際に出ている件数（#251）", () => {
  // members/index.json の counts の合計そのもの。取得の有無や名簿の覆う回次から推論しない
  const members = [
    { house: "shugiin" as const, counts: { rollcalls: 0, bills: 3, speeches: 0, questions: 0 } },
    { house: "shugiin" as const, counts: { rollcalls: 0, bills: 2, speeches: 5, questions: 0 } },
    { house: "sangiin" as const, counts: { rollcalls: 10, bills: 1, speeches: 2, questions: 7 } },
  ];

  it("院ごとに counts を合計する", () => {
    expect(linkedRecordCounts(members, "shugiin")).toEqual({ rollcalls: 0, bills: 5, speeches: 5, questions: 0 });
    expect(linkedRecordCounts(members, "sangiin")).toEqual({ rollcalls: 10, bills: 1, speeches: 2, questions: 7 });
  });

  it("questions が無い（古い）データでは 0 として数える", () => {
    expect(linkedRecordCounts([{ house: "shugiin" as const, counts: { rollcalls: 0, bills: 1, speeches: 0 } }], "shugiin")?.questions).toBe(0);
  });

  it("その院の議員が 0 人なら null（無い事実を作らない）", () => {
    expect(linkedRecordCounts([], "shugiin")).toBeNull();
  });
});

describe("rosterScope: 名簿が公開されている範囲の違い（#251）", () => {
  const shugiin = { name: "衆議院 議員一覧（2026-02-18現在）", url: "https://www.shugiin.go.jp/internet/itdb_annai.nsf/html/statics/syu/1giin.htm", fetchedAt: "2026-08-24T00:00:00.000Z" };
  const sangiin = (s: number) => ({ name: `参議院 議員一覧（第${s}回）`, url: `https://www.sangiin.go.jp/japanese/joho1/kousei/giin/${s}/giin.htm`, fetchedAt: "2026-08-24T00:00:00.000Z" });

  it("衆院の 1 時点と、参院の回次ごとの名簿の範囲を両方持つ（参院を「制約なし」と書かないための材料）", () => {
    const scope = rosterScope({ fetchedAt: "2026-08-24T00:00:00.000Z", sessions: [216, 221], sources: [shugiin, sangiin(216), sangiin(221)] });
    expect(scope.shugiin).toEqual({ asOf: "2026-02-18", url: shugiin.url });
    expect(scope.sangiinSessions).toEqual([216, 221]);
    expect(scope.sangiin).toEqual({ from: 216, to: 221, count: 2 });
  });

  it("参院の名簿の出典が無ければ空（推定しない）", () => {
    const scope = rosterScope({ fetchedAt: "2026-08-24T00:00:00.000Z", sessions: [221], sources: [shugiin] });
    expect(scope.sangiinSessions).toEqual([]);
    expect(scope.sangiin).toBeNull();
  });
});

describe("shugiinRosterAsOf: 衆院の名簿は 1 時点しか無い（#251）", () => {
  const source = { name: "衆議院 議員一覧（2026-02-18現在）", url: "https://www.shugiin.go.jp/internet/itdb_annai.nsf/html/statics/syu/1giin.htm", fetchedAt: "2026-08-24T00:00:00.000Z" };
  const sangiin = { name: "参議院 議員一覧（第221回）", url: "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm", fetchedAt: "2026-08-24T00:00:00.000Z" };

  it("出典の名前から時点と URL を取る（時点の表記は原文のまま）", () => {
    expect(shugiinRosterAsOf({ fetchedAt: "2026-08-24T00:00:00.000Z", sessions: [221], sources: [sangiin, source] })).toEqual({ asOf: "2026-02-18", url: source.url });
  });

  it("参院の回次ごとの名簿（第N回）は拾わない", () => {
    expect(shugiinRosterAsOf({ fetchedAt: "2026-08-24T00:00:00.000Z", sessions: [221], sources: [sangiin] })).toBeNull();
  });

  it("meta が無ければ null（推定しない）", () => {
    expect(shugiinRosterAsOf(undefined)).toBeNull();
  });
});

describe("shugiinBillNameCoverage: 議案の氏名の紐づき（#251）", () => {
  const stats = {
    names: 36493,
    linked: 1353,
    sessions: [
      { session: 216, names: 296, inRoster: 145 },
      { session: 217, names: 334, inRoster: 165 },
      { session: 221, names: 271, inRoster: 270 },
    ],
    rosterMembers: 465,
    rosterDuplicateNames: 0,
  };

  it("紐づいていない延べ数（names - linked）を出す", () => {
    expect(shugiinBillNameCoverage(stats)?.unlinked).toBe(35140);
  });

  it("異なり氏名がいちばん多い回次を選ぶ（回次は定数で書かない）", () => {
    expect(shugiinBillNameCoverage(stats)?.largest).toEqual({ session: 217, names: 334, inRoster: 165 });
  });

  it("異なり氏名の数が同じなら新しい回次を選ぶ", () => {
    const tied = { ...stats, sessions: [{ session: 210, names: 300, inRoster: 20 }, { session: 219, names: 300, inRoster: 30 }] };
    expect(shugiinBillNameCoverage(tied)?.largest?.session).toBe(219);
  });

  it("氏名が 1 件も無い・stats が無いなら null（無い事実を作らない）", () => {
    expect(shugiinBillNameCoverage({ names: 0, linked: 0, sessions: [], rosterMembers: 465, rosterDuplicateNames: 0 })).toBeNull();
    expect(shugiinBillNameCoverage(null)).toBeNull();
  });
});

describe("buildCoverage: 国会", () => {
  it("meta.sessions の範囲と回次数をそのまま数える", () => {
    expect(buildCoverage(withLocal, sessions).metaSessions).toEqual({ from: 220, to: 221, count: 2 });
  });

  it("参議院は rollcalls/index.json の件数と回次の範囲を持ち、個人票あり", () => {
    const sangiin = buildCoverage(withLocal, sessions).diet.find((d) => d.assemblyId === "diet-sangiin")!;
    expect(sangiin.name).toBe("参議院");
    expect(sangiin.house).toBe("sangiin");
    expect(sangiin.individualVotes).toBe(true);
    expect(sangiin.rollcalls).toBe(dataset.rollcalls.length);
    expect(sangiin.rollcallSessions).toEqual({ from: 220, to: 221, count: 2 });
    expect(sangiin.members).toBe(3);
    expect(sangiin.sourceUrl).toBe(assemblies[0]!.sourceUrl);
  });

  it("衆議院は個人票が無いので採決 0 件・回次の範囲なし（参院の件数を流用しない）", () => {
    const shugiin = buildCoverage(withLocal, sessions).diet.find((d) => d.assemblyId === "diet-shugiin")!;
    expect(shugiin.individualVotes).toBe(false);
    expect(shugiin.rollcalls).toBe(0);
    expect(shugiin.rollcallSessions).toBeNull();
  });

  it("議案（bills/index.json）は house ごとに数える。衆院は個人票が無くても議案の収録範囲を持つ", () => {
    const diet = buildCoverage(withLocal, sessions).diet;
    const shugiin = diet.find((d) => d.assemblyId === "diet-shugiin")!;
    expect(shugiin.bills).toBe(3);
    expect(shugiin.billSessions).toEqual({ from: 219, to: 221, count: 2 }); // 220 は議案が無い＝歯抜け
    expect(hasSessionGaps(shugiin.billSessions)).toBe(true);
    // 参院の議案は fixture に無い（実データも bills/index.json は全て shugiin）
    const sangiin = diet.find((d) => d.assemblyId === "diet-sangiin")!;
    expect(sangiin.bills).toBe(0);
    expect(sangiin.billSessions).toBeNull();
  });

  it("bills/index.json が無い古いデータでは議案 0 件（落ちない）", () => {
    const diet = buildCoverage({ ...withLocal, bills: undefined }, sessions).diet;
    expect(diet.every((d) => d.bills === 0 && d.billSessions === null)).toBe(true);
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
    expect(totals.bills).toBe(3);
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

describe("sangiinUnlinkedVotes: 名簿より前の回次で議員に紐づいていない票（#274）", () => {
  const rosterless = { earliestRoster: 216, sessions: [200, 201, 204], range: { from: 200, to: 204, count: 3 } };
  const stats = {
    votes: 100,
    linked: 60,
    sessions: [
      { session: 200, votes: 30, linked: 10 },
      { session: 201, votes: 20, linked: 20 }, // 名簿より前でも全部紐づいている回次がある
      { session: 204, votes: 10, linked: 0 },
      { session: 221, votes: 40, linked: 30 }, // 名簿のある回次は数えない
    ],
  };

  it("名簿より前の回次の票だけを数え、そのうち紐づいていない数を出す", () => {
    const r = sangiinUnlinkedVotes(stats, rosterless);
    expect(r).toEqual({ votes: 60, linked: 30, unlinked: 30, range: { from: 200, to: 204, count: 3 }, unlinkedRange: { from: 200, to: 204, count: 2 } });
  });

  it("紐づいていない票のある回次だけを unlinkedRange に入れる（全部紐づいた回次は入れない）", () => {
    // 第201回は 20 票すべて紐づいているので、紐づかない回次の範囲には入らない
    expect(sangiinUnlinkedVotes(stats, rosterless)?.unlinkedRange).toEqual({ from: 200, to: 204, count: 2 });
  });

  it("紐づいていない票が 1 件も無ければ unlinkedRange は null（無い事実を作らない）", () => {
    const all = { votes: 30, linked: 30, sessions: [{ session: 200, votes: 30, linked: 30 }] };
    expect(sangiinUnlinkedVotes(all, rosterless)).toEqual({ votes: 30, linked: 30, unlinked: 0, range: { from: 200, to: 200, count: 1 }, unlinkedRange: null });
  });

  it("名簿より前の回次に票が 1 件も無ければ null", () => {
    expect(sangiinUnlinkedVotes({ votes: 40, linked: 30, sessions: [{ session: 221, votes: 40, linked: 30 }] }, rosterless)).toBeNull();
  });

  it("数えた結果が無い・名簿の出典が無いなら null（推定しない）", () => {
    expect(sangiinUnlinkedVotes(null, rosterless)).toBeNull();
    expect(sangiinUnlinkedVotes(stats, null)).toBeNull();
  });
});
