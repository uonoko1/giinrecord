import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Bill, Member, RollCall, Speech } from "@seiji-kiroku/shared";
import { buildDataset, groupMajority, summarizeRollCall } from "../src/aggregate.ts";
import { matchVotes } from "../src/match-votes.ts";
import type { MatchedBill } from "../src/match-bills.ts";
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
  const ds = buildDataset(members, rcs, new Map(), speeches);

  test("speech エントリは speechId・会議名・冒頭抜粋・文字数・出典URL を持ち、要約や評価は持たない", () => {
    const m1 = ds.details.find((d) => d.id === "m_1")!;
    assert.deepEqual(m1.timeline.find((e) => e.kind === "speech" && e.speechId === "122115254X01920260605_002"), {
      kind: "speech", date: "2026-06-05", speechId: "122115254X01920260605_002", meeting: "本会議 第1号",
      excerpt: "抜粋 122115254X01920260605_002", chars: 300, sourceUrl: "https://kokkai.ndl.go.jp/txt/122115254X01920260605/2",
    });
  });

  test("vote と speech が混ざっても timeline は日付降順（不変条件）。同日は vote → speech の順", () => {
    const m1 = ds.details.find((d) => d.id === "m_1")!;
    const later = buildDataset(members, rcs, new Map(), [...speeches, speech("122115254X02020260610_009", "m_1", "2026-06-10")]);
    assert.deepEqual(later.details.find((d) => d.id === "m_1")!.timeline.map((e) => [e.kind, e.date]), [["speech", "2026-06-10"], ["speech", "2026-06-10"], ["vote", "2026-06-05"], ["speech", "2026-06-05"]]);
    assert.deepEqual(m1.timeline.map((e) => [e.kind, e.date]), [["speech", "2026-06-10"], ["vote", "2026-06-05"], ["speech", "2026-06-05"]]);
  });

  test("議長・大臣など position 付きの発言も timeline に入り、position を原文のまま載せる（役職としての発言も記録）", () => {
    const m1 = ds.details.find((d) => d.id === "m_1")!;
    assert.deepEqual(m1.timeline.find((e) => e.kind === "speech" && e.speechId === "122115254X02020260610_004"), {
      kind: "speech", date: "2026-06-10", speechId: "122115254X02020260610_004", meeting: "本会議 第1号",
      excerpt: "抜粋 122115254X02020260610_004", chars: 300, position: "議長", sourceUrl: "https://kokkai.ndl.go.jp/txt/122115254X02020260610/4",
    });
  });

  test("position が空文字の発言は position を載せない（キーを作らない）", () => {
    const d = buildDataset(members, [], new Map(), [speech("x_001", "m_1", "2026-06-05", { position: "" })]);
    assert.deepEqual(Object.keys(d.details[0].timeline[0]).includes("position"), false);
    assert.equal(d.index[0].counts.speeches, 1);
  });

  test("衆院本会議の発言は衆院議員（h_）の timeline に入り、counts.speeches に数える（Issue #107）", () => {
    const h = { ...member("h_1", "衆 一郎", "自由民主党・無所属の会"), house: "shugiin" as const, terms: [{ house: "shugiin" as const, group: "自由民主党・無所属の会", district: "東京1", from: "", sessionFrom: 221 }] };
    const d = buildDataset([h], [], new Map(), [speech("122105254X03520260724_002", "h_1", "2026-07-24", { house: "shugiin" })]);
    assert.equal(d.index[0].counts.speeches, 1);
    assert.equal(d.details[0].timeline[0].kind, "speech");
  });

  test("発言の院と議員の院が違えば例外（衆院本会議の発言を参院議員に付けない）", () => {
    assert.throws(() => buildDataset(members, [], new Map(), [speech("122105254X03520260724_002", "m_1", "2026-07-24", { house: "shugiin" })]), /house/);
  });

  test("memberId の無い発言（名簿にいない大臣など）は timeline に入れない", () => {
    assert.ok(ds.details.every((d) => d.timeline.every((e) => e.kind !== "speech" || e.speechId !== "122115254X01920260605_010")));
  });

  test("counts.speeches は timeline の speech 数（position 付きの発言も含める。内訳は持たない）", () => {
    assert.deepEqual(ds.index.map((m) => [m.id, m.counts.speeches]), [["m_1", 2], ["m_2", 0]]);
  });

  test("speeches を省略しても従来どおり（後方互換）", () => {
    assert.deepEqual(buildDataset(members, rcs).index.map((m) => m.counts.speeches), [0, 0]);
  });

  test("名簿にない memberId の発言は例外（名寄せの不整合を黙って捨てない）", () => {
    assert.throws(() => buildDataset(members, [], new Map(), [speech("x_001", "m_9", "2026-06-05")]), /m_9/);
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

const matchedBill = (memberId: string, billId: string, date: string, extra: Partial<MatchedBill> = {}): MatchedBill => ({
  memberId, billId, date, title: `法案 ${billId}`, role: "提出者",
  sourceUrl: `https://www.sangiin.go.jp/japanese/joho1/kousei/gian/221/meisai/m${billId.replace(/\D/g, "")}.htm`, ...extra,
});

describe("buildDataset: bill（提出法案）を timeline に入れる", () => {
  const members = [member("m_1", "一 郎"), member("m_2", "二 郎", "立憲")];
  const rcs = [rollCall("221-0605-v001", "2026-06-05", [vote("m_1", "賛成")])];
  const bills = [
    matchedBill("m_1", "221-参法-16", "2026-06-05", { submitterText: "一郎君 外9名", status: "参議院 環境委員会 未了" }),
    matchedBill("m_1", "221-参法-3", "2026-04-01"),
  ];
  const ds = buildDataset(members, rcs, new Map(), [], bills);

  test("bill エントリは提出日・役割・原文・審議状況・議案ページの URL を持ち、無いキーは省く", () => {
    const m1 = ds.details.find((d) => d.id === "m_1")!;
    assert.deepEqual(m1.timeline.filter((e) => e.kind === "bill"), [
      { kind: "bill", date: "2026-06-05", billId: "221-参法-16", title: "法案 221-参法-16", role: "提出者", submitterText: "一郎君 外9名", status: "参議院 環境委員会 未了",
        sourceUrl: "https://www.sangiin.go.jp/japanese/joho1/kousei/gian/221/meisai/m22116.htm" },
      { kind: "bill", date: "2026-04-01", billId: "221-参法-3", title: "法案 221-参法-3", role: "提出者",
        sourceUrl: "https://www.sangiin.go.jp/japanese/joho1/kousei/gian/221/meisai/m2213.htm" },
    ]);
  });

  test("同日は vote → bill の順、全体は日付降順", () => {
    const m1 = ds.details.find((d) => d.id === "m_1")!;
    assert.deepEqual(m1.timeline.map((e) => `${e.kind}:${e.date}`), ["vote:2026-06-05", "bill:2026-06-05", "bill:2026-04-01"]);
  });

  test("counts.bills は timeline の bill 数", () => {
    assert.deepEqual(ds.index.map((m) => [m.id, m.counts.bills]), [["m_1", 2], ["m_2", 0]]);
  });

  test("名簿にない memberId の bill は例外", () => {
    assert.throws(() => buildDataset(members, [], new Map(), [], [matchedBill("m_9", "221-参法-1", "2026-04-01")]), /m_9/);
  });
});

/* ---------- 衆院 議案（#73）: 提出者・賛成者 = 事実の bill 行、所属会派の態度 = 推定の stance 行 ---------- */

const hMember = (id: string, group: string, sessionFrom = 221): Member => ({
  id, name: id, kana: "", house: "shugiin",
  terms: [{ house: "shugiin", group, district: "東京1区", from: "", sessionFrom }],
  sourceUrl: "https://www.shugiin.go.jp/internet/itdb_annai.nsf/html/statics/syu/1giin.htm",
});
const keika = (id: string) => `https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian/keika/${id}.htm`;
const shugiinBill = (id: string, extra: Partial<Bill> = {}): Bill => ({
  id, session: 221, kind: "衆法", title: `議案 ${id}`, house: "shugiin",
  received: { shugiin: "2026-03-02" }, status: "衆議院で閉会中審査", sourceUrl: keika(id), ...extra,
});

describe("buildDataset: 衆院 Bill から timeline を作る", () => {
  const members = [hMember("h_1", "自由民主党・無所属の会"), hMember("h_2", "日本共産党"), hMember("h_3", "無所属")];
  const bills: Bill[] = [
    shugiinBill("221-衆法-1", { submitters: ["h_1"], supporters: ["h_2"], submitterText: "h_1君外四名", submitterNames: ["h_1"], supporterNames: ["h_2"] }),
    shugiinBill("221-閣法-3", {
      kind: "閣法", received: { shugiin: "2026-02-20", sangiin: "2026-03-13" }, status: "成立",
      shugiinGroupStance: { stanceText: "多数", yes: ["自由民主党・無所属の会"], no: ["日本共産党"] },
    }),
    shugiinBill("221-閣法-4", { kind: "閣法", received: { shugiin: "2026-02-21" }, shugiinGroupStance: { stanceText: "全会一致", yes: ["自由民主党・無所属の会", "日本共産党"], no: [], unanimous: true } }),
    shugiinBill("221-閣法-5", { kind: "閣法", received: undefined, shugiinGroupStance: { stanceText: "多数", yes: ["自由民主党・無所属の会"], no: [] } }),
    shugiinBill("221-閣法-6", { kind: "閣法", received: { shugiin: "2026-02-22" } }),
  ];
  const ds = buildDataset(members, [], new Map(), [], [], bills);
  const of = (id: string) => ds.details.find((d) => d.id === id)!.timeline;

  test("提出者は role 提出者、賛成者は role 賛成者の bill 行（事実）。日付は衆議院の受理日、出典は経過ページ", () => {
    assert.deepEqual(of("h_1").find((e) => e.kind === "bill"), {
      kind: "bill", date: "2026-03-02", billId: "221-衆法-1", title: "議案 221-衆法-1", role: "提出者",
      submitterText: "h_1君外四名", status: "衆議院で閉会中審査", sourceUrl: keika("221-衆法-1"),
    });
    assert.deepEqual(of("h_2").find((e) => e.kind === "bill"), {
      kind: "bill", date: "2026-03-02", billId: "221-衆法-1", title: "議案 221-衆法-1", role: "賛成者",
      submitterText: "h_1君外四名", status: "衆議院で閉会中審査", sourceUrl: keika("221-衆法-1"),
    });
  });

  test("所属会派が賛成会派／反対会派に載る議案は stance 行（estimated: true）。記録するのは会派名であって本人ではない", () => {
    assert.deepEqual(of("h_1").find((e) => e.kind === "stance" && e.billId === "221-閣法-3"), {
      kind: "stance", estimated: true, date: "2026-02-20", billId: "221-閣法-3", title: "議案 221-閣法-3",
      group: "自由民主党・無所属の会", stance: "賛成", stanceText: "多数", status: "成立", sourceUrl: keika("221-閣法-3"),
    });
    assert.deepEqual(of("h_2").find((e) => e.kind === "stance" && e.billId === "221-閣法-3"), {
      kind: "stance", estimated: true, date: "2026-02-20", billId: "221-閣法-3", title: "議案 221-閣法-3",
      group: "日本共産党", stance: "反対", stanceText: "多数", status: "成立", sourceUrl: keika("221-閣法-3"),
    });
  });

  test("会派がどちらにも載らない議案・会派態度の無い議案は stance 行にしない（推論しない）", () => {
    assert.deepEqual(of("h_3").filter((e) => e.kind === "stance"), []);
    assert.ok(of("h_1").every((e) => e.kind !== "stance" || e.billId !== "221-閣法-6"));
  });

  test("衆議院の受理日が無い議案は timeline に置けないので落とす（日付を推定しない）", () => {
    assert.ok(of("h_1").every((e) => e.kind !== "stance" || e.billId !== "221-閣法-5"));
  });

  test("全会一致の stanceText も原文のまま", () => {
    const row = of("h_2").find((e) => e.kind === "stance" && e.billId === "221-閣法-4");
    assert.equal(row?.kind === "stance" && row.stanceText, "全会一致");
  });

  test("timeline は日付降順、同日は vote → bill → stance → speech", () => {
    const d = buildDataset([hMember("h_1", "自由民主党・無所属の会")], [], new Map(),
      [speech("x_001", "h_1", "2026-03-02", { house: "shugiin" })],
      [], [shugiinBill("221-衆法-1", { submitters: ["h_1"] }), shugiinBill("221-閣法-3", { kind: "閣法", shugiinGroupStance: { stanceText: "多数", yes: ["自由民主党・無所属の会"], no: [] } })]);
    assert.deepEqual(d.details[0].timeline.map((e) => e.kind), ["bill", "stance", "speech"]);
  });

  test("counts.bills は bill 行の数（stance は数えない）", () => {
    assert.deepEqual(ds.index.map((m) => [m.id, m.counts.bills]), [["h_1", 1], ["h_2", 1], ["h_3", 0]]);
  });

  test("参院の議員（house: sangiin）には衆院の会派態度を付けない", () => {
    const d = buildDataset([member("m_1", "一 郎", "自由民主党・無所属の会")], [], new Map(), [], [], [bills[1]]);
    assert.deepEqual(d.details[0].timeline, []);
  });

  test("会派は議案の提出回次の名簿で引く（後の回次の名簿しか無ければ推定しない）", () => {
    const d = buildDataset([hMember("h_1", "自由民主党・無所属の会", 222)], [], new Map(), [], [], [bills[1]]);
    assert.deepEqual(d.details[0].timeline, []);
  });

  test("提出者の memberId が名簿に無ければ例外", () => {
    assert.throws(() => buildDataset(members, [], new Map(), [], [], [shugiinBill("221-衆法-9", { submitters: ["h_9"] })]), /h_9/);
  });
});
