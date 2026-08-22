import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Member, RollCall } from "@seiji-kiroku/shared";
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

  test("議案情報の審議結果があれば「可決（賛成 1・反対 1）」の形で原文と得票を両方出す", () => {
    const rc = rollCall("221-0605-v001", "2026-06-05", [vote("m_1", "賛成"), vote("m_2", "反対")]);
    assert.equal(summarizeRollCall(rc, "可決").result, "可決（賛成 1・反対 1）");
    assert.equal(summarizeRollCall(rc, "同意").result, "同意（賛成 1・反対 1）");
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

  test("審議結果の突合結果を渡すと、紐づいた採決だけ result に可決等が付き、timeline にも同じ result が入る", () => {
    const withResults = buildDataset(members, rcs, new Map([["221-0605-v001", "可決"]]));
    assert.deepEqual(withResults.rollCalls.map((r) => r.result), ["賛成 1・反対 0", "可決（賛成 1・反対 1）"]);
    const m1 = withResults.details.find((d) => d.id === "m_1")!;
    assert.deepEqual(m1.timeline.map((e) => (e.kind === "vote" ? e.result : "")), ["賛成 1・反対 0", "可決（賛成 1・反対 1）"]);
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
