import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Bill, Member, Question, RollCall, Speech, TimelineEntry } from "@seiji-kiroku/shared";
import { buildDataset, type CarriedEntry } from "../src/aggregate.ts";
import type { MatchedBill } from "../src/match-bills.ts";
import type { MatchedAttendance } from "../src/match-attendance.ts";

// Issue #103: timeline の全行が回次（session）を持つ。Web の議員ページが回次ごとに折りたたみ、
// cli.ts が対象外の回次の行を members/{id}.json から引き継ぐ（carried）ときの鍵にもなる。

const ROSTER = "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm";
const member = (id: string, name: string, house: Member["house"] = "sangiin"): Member => ({
  id, name, kana: "", house, terms: [{ house, group: "自由民主党・無所属の会", district: "東京", from: "", sessionFrom: 200, sessionTo: 221 }], sourceUrl: ROSTER,
});
const rollCall = (id: string, session: number, date: string, memberId: string): RollCall => ({
  id, session, date, title: `案件 ${id}`, totals: { total: 1, yes: 1, no: 0 },
  groups: [{ group: "自由民主党・無所属の会", size: 1, yes: 1, no: 0 }],
  votes: [{ memberId, nameText: memberId, group: "自由民主党・無所属の会", value: "賛成" }],
  sourceUrl: `https://www.sangiin.go.jp/japanese/touhyoulist/${session}/${id}.htm`,
});
const speech = (id: string, session: number, memberId: string, date: string): Speech => ({
  id, session, memberId, speakerText: memberId, house: "sangiin", meeting: "本会議 第1号", date, excerpt: "抜粋", chars: 10,
  sourceUrl: `https://kokkai.ndl.go.jp/txt/${id.split("_")[0]}/1`,
});

describe("buildDataset: timeline の各行に session が付く", () => {
  const members = [member("m_1", "一 郎"), member("h_1", "衆 一郎", "shugiin")];
  const bill: MatchedBill = { memberId: "m_1", billId: "200-参法-3", date: "2019-11-01", title: "参法", role: "提出者", sourceUrl: "https://www.sangiin.go.jp/japanese/joho1/kousei/gian/200/meisai/m200050200003.htm" };
  const shugiinBill: Bill = {
    id: "216-衆法-1", session: 216, kind: "衆法", house: "shugiin", title: "衆法", sourceUrl: "https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian/keika/1DE1E6A.htm",
    received: { shugiin: "2024-12-01" }, submitters: ["h_1"], shugiinGroupStance: { yes: ["自由民主党・無所属の会"], no: [], stanceText: "多数" },
  };
  const question: Question = { id: "210-sangiin-1", session: 210, number: 1, house: "sangiin", title: "質問", date: "2022-10-10", submitterText: "一 郎君", submitterNames: ["一 郎"], submitters: ["m_1"], sourceUrl: "https://www.sangiin.go.jp/japanese/joho1/kousei/syuisyo/210/meisai/m210001.htm" };
  const attendance: MatchedAttendance = { memberId: "m_1", nameText: "一郎", session: 205, meetingId: "120515007X00120210301_000", meeting: "委員会 第1号", date: "2021-03-01", role: "発議者", bills: [], sourceUrl: "https://kokkai.ndl.go.jp/txt/120515007X00120210301/0" };
  const ds = buildDataset(members, [rollCall("200-1204-v001", 200, "2019-12-04", "m_1")], new Map(), [speech("120115254X00120191204_001", 201, "m_1", "2019-12-04")], [bill], [shugiinBill], [question], [attendance]);
  const m1 = ds.details.find((d) => d.id === "m_1")!;
  const h1 = ds.details.find((d) => d.id === "h_1")!;

  test("vote は採決の回次、bill（参法）は billId の回次、question は質問の回次、attendance は会議の回次。speech は speeches.json 側で会議録の回次（#242）", () => {
    assert.deepEqual(m1.timeline.map((e) => [e.kind, e.session]), [["question", 210], ["attendance", 205], ["vote", 200], ["bill", 200]]);
    assert.deepEqual(ds.speeches.find((x) => x.id === "m_1")!.speeches.map((e) => [e.kind, e.session]), [["speech", 201]]);
  });
  test("衆院の bill 行・stance 行は議案の提出回次", () => {
    assert.deepEqual(h1.timeline.map((e) => [e.kind, e.session]), [["bill", 216], ["stance", 216]]);
  });
});

describe("buildDataset: carried（対象外の回次の行を members/{id}.json から引き継ぐ）", () => {
  const members = [member("m_1", "一 郎")];
  const old: TimelineEntry = { kind: "speech", session: 203, date: "2020-11-01", speechId: "120315254X00120201101_001", meeting: "本会議 第1号", excerpt: "古い抜粋", chars: 5, sourceUrl: "https://kokkai.ndl.go.jp/txt/120315254X00120201101/1" };
  const carried: CarriedEntry[] = [{ memberId: "m_1", entry: old }];

  test("引き継いだ speech 行はそのまま speeches.json に入り、counts に数える（#242: 行き先が変わっても引き継ぎは止めない）", () => {
    const ds = buildDataset(members, [rollCall("221-0605-v001", 221, "2026-06-05", "m_1")], new Map(), [], [], [], [], [], carried);
    const m1 = ds.details[0];
    assert.deepEqual(m1.timeline.map((e) => [e.kind, e.session, e.date]), [["vote", 221, "2026-06-05"]]);
    assert.deepEqual(ds.speeches[0].speeches, [old]);
    assert.equal(ds.index[0].counts.speeches, 1);
  });
  test("名簿にない memberId の引き継ぎ行は例外（黙って捨てない。cli が先に除いて警告する）", () => {
    assert.throws(() => buildDataset(members, [], new Map(), [], [], [], [], [], [{ memberId: "m_9", entry: old }]), /m_9/);
  });
});
