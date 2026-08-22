import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Member, RollCall, Speech } from "@seiji-kiroku/shared";
import { buildDataset, groupMajority, summarizeRollCall } from "../src/aggregate.ts";
import { matchVotes } from "../src/match-votes.ts";
import { parseRollCall } from "../src/sources/sangiin-votes.ts";
import { parseMemberList } from "../src/sources/sangiin-members.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.htm`, import.meta.url), "utf-8");
const BASE = "https://www.sangiin.go.jp/japanese/touhyoulist/221";
const ROSTER = "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm";

const member = (id: string, name: string, group = "自民"): Member => ({
  id, name, kana: "", house: "sangiin",
  terms: [{ house: "sangiin", group, district: "東京", from: "", sessionFrom: 221 }],
  sourceUrl: ROSTER,
});

const rollCall = (id: string, date: string, votes: RollCall["votes"], groups: RollCall["groups"] = []): RollCall => ({
  id, session: 221, date, title: `案件 ${id}`,
  totals: { total: votes.length, yes: votes.filter((v) => v.value === "賛成").length, no: votes.filter((v) => v.value === "反対").length },
  groups, votes, sourceUrl: `${BASE}/${id}.htm`,
});

const vote = (memberId: string, value: RollCall["votes"][number]["value"], group = "自由民主党・無所属の会") =>
  ({ memberId, nameText: memberId, group, value });

describe("groupMajority: その採決でその会派の多数票", () => {
  const rc = rollCall("221-0605-v001", "2026-06-05", [], [
    { group: "A", size: 3, yes: 2, no: 1 },
    { group: "B", size: 3, yes: 1, no: 2 },
    { group: "C", size: 2, yes: 1, no: 1 },
    { group: "D", size: 2, yes: 0, no: 0 },
  ]);
  test("賛成票>反対票なら賛成", () => assert.equal(groupMajority(rc, "A"), "賛成"));
  test("反対票>賛成票なら反対", () => assert.equal(groupMajority(rc, "B"), "反対"));
  test("同数なら undefined", () => assert.equal(groupMajority(rc, "C"), undefined));
  test("0対0も同数として undefined", () => assert.equal(groupMajority(rc, "D"), undefined));
  test("会派が集計にない場合は undefined", () => assert.equal(groupMajority(rc, "X"), undefined));
});

describe("summarizeRollCall: rollcalls/index.json の1行", () => {
  test("result は公表された集計をそのまま文字列化し、可否を判定しない", () => {
    const rc = rollCall("221-0605-v001", "2026-06-05", [vote("m_1", "賛成"), vote("m_2", "反対"), vote("m_3", "投票なし")]);
    assert.deepEqual(summarizeRollCall(rc), {
      id: "221-0605-v001", session: 221, date: "2026-06-05", title: "案件 221-0605-v001",
      totals: { total: 3, yes: 1, no: 1 }, result: "賛成 1・反対 1", sourceUrl: `${BASE}/221-0605-v001.htm`,
    });
  });
});

describe("buildDataset: members/{id}.json・members/index.json・rollcalls/index.json", () => {
  const members = [member("m_1", "一 郎"), member("m_2", "二 郎", "立憲"), member("m_3", "三 郎")];
  const rcs = [
    rollCall("221-0605-v001", "2026-06-05", [vote("m_1", "賛成"), vote("m_2", "反対", "立憲民主・無所属")],
      [{ group: "自由民主党・無所属の会", size: 1, yes: 1, no: 0 }, { group: "立憲民主・無所属", size: 1, yes: 0, no: 1 }]),
    rollCall("221-0724-v001", "2026-07-24", [vote("m_1", "投票なし"), vote("", "賛成")],
      [{ group: "自由民主党・無所属の会", size: 2, yes: 1, no: 0 }]),
  ];
  const ds = buildDataset(members, rcs);

  test("全議員分の MemberDetail を作り、票のない議員は timeline が空", () => {
    assert.deepEqual(ds.details.map((d) => d.id), ["m_1", "m_2", "m_3"]);
    assert.deepEqual(ds.details[2].timeline, []);
  });

  test("timeline は日付降順で、vote エントリに採決の事実と会派の多数票を持つ", () => {
    const m1 = ds.details.find((d) => d.id === "m_1")!;
    assert.deepEqual(m1.timeline, [
      { kind: "vote", date: "2026-07-24", rollCallId: "221-0724-v001", title: "案件 221-0724-v001", value: "投票なし", result: "賛成 1・反対 0", groupValue: "賛成", sourceUrl: `${BASE}/221-0724-v001.htm` },
      { kind: "vote", date: "2026-06-05", rollCallId: "221-0605-v001", title: "案件 221-0605-v001", value: "賛成", result: "賛成 1・反対 1", groupValue: "賛成", sourceUrl: `${BASE}/221-0605-v001.htm` },
    ]);
  });

  test("同日の採決は採決 id の降順（安定）", () => {
    const same = buildDataset([member("m_1", "一 郎")], [
      rollCall("221-0605-v001", "2026-06-05", [vote("m_1", "賛成")]),
      rollCall("221-0605-v002", "2026-06-05", [vote("m_1", "反対")]),
    ]);
    assert.deepEqual(same.details[0].timeline.map((e) => (e.kind === "vote" ? e.rollCallId : "")), ["221-0605-v002", "221-0605-v001"]);
  });

  test("会派が賛否同数なら groupValue キー自体を持たない（JSON に null を出さない）", () => {
    const tie = buildDataset([member("m_1", "一 郎")], [
      rollCall("221-0605-v001", "2026-06-05", [vote("m_1", "賛成")], [{ group: "自由民主党・無所属の会", size: 2, yes: 1, no: 1 }]),
    ]);
    assert.equal("groupValue" in tie.details[0].timeline[0], false);
  });

  test("memberId が空（未突合）の票はどの timeline にも入らない", () => {
    assert.ok(ds.details.every((d) => d.timeline.every((e) => e.kind === "vote" && e.rollCallId !== "")));
    assert.equal(ds.details.flatMap((d) => d.timeline).length, 3);
  });

  test("members/index.json の counts.rollcalls は timeline の vote 数", () => {
    assert.deepEqual(ds.index.map((m) => [m.id, m.counts.rollcalls]), [["m_1", 2], ["m_2", 1], ["m_3", 0]]);
    assert.deepEqual(ds.index[0].counts, { rollcalls: 2, bills: 0, speeches: 0 });
  });

  test("rollcalls/index.json は日付降順の RollCallSummary[]", () => {
    assert.deepEqual(ds.rollCalls.map((r) => r.id), ["221-0724-v001", "221-0605-v001"]);
  });

  test("採決が 0 件でも全議員の detail と空の index を返す", () => {
    const empty = buildDataset(members, []);
    assert.equal(empty.details.length, 3);
    assert.deepEqual(empty.rollCalls, []);
  });

  test("名簿にない memberId の票が来たら例外（名寄せの不整合を黙って捨てない）", () => {
    assert.throws(() => buildDataset([member("m_1", "一 郎")], [rollCall("221-0605-v001", "2026-06-05", [vote("m_9", "賛成")])]), /m_9/);
  });
});

const speech = (id: string, memberId: string | undefined, date: string, extra: Partial<Speech> = {}): Speech => ({
  id, ...(memberId ? { memberId } : {}), speakerText: memberId ?? "?", house: "sangiin", meeting: "本会議 第1号", date,
  excerpt: `抜粋 ${id}`, chars: 300, sourceUrl: `https://kokkai.ndl.go.jp/txt/${id.split("_")[0]}/${Number(id.split("_")[1])}`, ...extra,
});

describe("buildDataset: speech を timeline に入れる", () => {
  const members = [member("m_1", "一 郎"), member("m_2", "二 郎", "立憲")];
  const rcs = [rollCall("221-0605-v001", "2026-06-05", [vote("m_1", "賛成")])];
  const speeches = [
    speech("122115254X01920260605_002", "m_1", "2026-06-05"),
    speech("122115254X02020260610_004", "m_1", "2026-06-10", { position: "議長" }),
    speech("122115254X01920260605_010", undefined, "2026-06-05", { position: "内閣総理大臣" }),
  ];
  const ds = buildDataset(members, rcs, speeches);

  test("speech エントリは speechId・会議名・冒頭抜粋・文字数・出典URL を持ち、要約や評価は持たない", () => {
    const m1 = ds.details.find((d) => d.id === "m_1")!;
    assert.deepEqual(m1.timeline.find((e) => e.kind === "speech" && e.speechId === "122115254X01920260605_002"), {
      kind: "speech", date: "2026-06-05", speechId: "122115254X01920260605_002", meeting: "本会議 第1号",
      excerpt: "抜粋 122115254X01920260605_002", chars: 300, sourceUrl: "https://kokkai.ndl.go.jp/txt/122115254X01920260605/2",
    });
  });

  test("vote と speech が混ざっても timeline は日付降順（不変条件）。同日は vote → speech の順", () => {
    const m1 = ds.details.find((d) => d.id === "m_1")!;
    const later = buildDataset(members, rcs, [...speeches, speech("122115254X02020260610_009", "m_1", "2026-06-10")]);
    assert.deepEqual(later.details.find((d) => d.id === "m_1")!.timeline.map((e) => [e.kind, e.date]), [["speech", "2026-06-10"], ["vote", "2026-06-05"], ["speech", "2026-06-05"]]);
    assert.deepEqual(m1.timeline.map((e) => [e.kind, e.date]), [["vote", "2026-06-05"], ["speech", "2026-06-05"]]);
  });

  test("議長・大臣など position 付きの発言は、TimelineEntry に position が無い間は timeline に入れない（議員としての発言と区別できない数値を出さない）", () => {
    const m1 = ds.details.find((d) => d.id === "m_1")!;
    assert.equal(m1.timeline.some((e) => e.kind === "speech" && e.speechId === "122115254X02020260610_004"), false);
    assert.equal(buildDataset(members, [], [speech("x_001", "m_1", "2026-06-05", { position: "" })]).index[0].counts.speeches, 1);
  });

  test("memberId の無い発言（名簿にいない大臣など）は timeline に入れない", () => {
    assert.ok(ds.details.every((d) => d.timeline.every((e) => e.kind !== "speech" || e.speechId !== "122115254X01920260605_010")));
  });

  test("counts.speeches は timeline の speech 数（position 付きの発言は含まない）", () => {
    assert.deepEqual(ds.index.map((m) => [m.id, m.counts.speeches]), [["m_1", 1], ["m_2", 0]]);
  });

  test("speeches を省略しても従来どおり（後方互換）", () => {
    assert.deepEqual(buildDataset(members, rcs).index.map((m) => m.counts.speeches), [0, 0]);
  });

  test("名簿にない memberId の発言は例外（名寄せの不整合を黙って捨てない）", () => {
    assert.throws(() => buildDataset(members, [], [speech("x_001", "m_9", "2026-06-05")]), /m_9/);
  });
});

describe("実データ: 第221回", () => {
  const members = parseMemberList(fixture("sangiin-giin-221"), ROSTER, 221);
  const rcs = ["221-0605-v001", "221-0724-v001"].map((id) => matchVotes(parseRollCall(fixture(id), `${BASE}/${id}.htm`, 221), members).rollCall);
  const ds = buildDataset(members, rcs);

  test("全議員の counts.rollcalls の合計 === 全採決の votes 数", () => {
    const sum = ds.index.reduce((a, m) => a + m.counts.rollcalls, 0);
    assert.equal(sum, rcs.reduce((a, r) => a + r.votes.length, 0));
  });

  test("各 vote エントリの groupValue は、その採決でその会派の賛成票>反対票なら賛成", () => {
    for (const d of ds.details) for (const e of d.timeline) {
      if (e.kind !== "vote") continue;
      const rc = rcs.find((r) => r.id === e.rollCallId)!;
      const g = rc.groups.find((g) => g.group === rc.votes.find((v) => v.memberId === d.id)!.group)!;
      assert.equal(e.groupValue, g.yes > g.no ? "賛成" : g.yes < g.no ? "反対" : undefined);
    }
  });
});
