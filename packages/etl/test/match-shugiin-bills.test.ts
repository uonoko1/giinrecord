import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Bill, Member } from "@seiji-kiroku/shared";
import { matchShugiinBills } from "../src/match-shugiin-bills.ts";

const KEIKA = "https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian/keika";
const member = (id: string, name: string, house: Member["house"] = "shugiin", group = "立憲"): Member => ({
  id, name, kana: "", house,
  terms: [{ house, group, district: "東京1区", from: "", sessionFrom: 221 }],
  sourceUrl: "https://www.shugiin.go.jp/internet/itdb_giinprof.nsf/html/profile/top.htm",
});
const bill = (b: Partial<Bill> & { id: string }): Bill => ({
  session: 221, kind: "衆法", number: 1, title: `法案 ${b.id}`, house: "shugiin", sourceUrl: `${KEIKA}/1DE153E.htm`, ...b,
});

describe("matchShugiinBills: 提出者一覧・賛成者の氏名を衆院の名簿に名寄せする（純粋関数）", () => {
  test("衆院の名簿があれば submitters / supporters に memberId が入り、原文の氏名（submitterNames / supporterNames）はそのまま残る", () => {
    const members = [member("s_1", "落合 貴之"), member("s_2", "中野 洋昌"), member("s_3", "赤羽 一嘉")];
    const { bills, unmatched } = matchShugiinBills(
      [bill({ id: "221-衆法-1", submitterNames: ["落合貴之", "中野洋昌"], supporterNames: ["赤羽一嘉"] })],
      members,
    );
    assert.deepEqual(bills[0]?.submitters, ["s_1", "s_2"]);
    assert.deepEqual(bills[0]?.supporters, ["s_3"]);
    assert.deepEqual(bills[0]?.submitterNames, ["落合貴之", "中野洋昌"]);
    assert.deepEqual(bills[0]?.supporterNames, ["赤羽一嘉"]);
    assert.deepEqual(unmatched, []);
  });

  test("名簿に無い氏名は unmatched（kind: bill, billId 付き）に載り、例外にはならない。紐づいた人だけが submitters に入る", () => {
    const members = [member("s_1", "落合 貴之")];
    const { bills, unmatched } = matchShugiinBills([bill({ id: "221-衆法-1", submitterNames: ["落合貴之", "存在しない人"] })], members);
    assert.deepEqual(bills[0]?.submitters, ["s_1"]);
    assert.deepEqual(unmatched, [{ kind: "bill", nameText: "存在しない人", group: "", billId: "221-衆法-1" }]);
  });

  test("参院の名簿（house: sangiin）とは突合しない（衆院の提出者は衆議院議員）", () => {
    const members = [member("m_1", "落合 貴之", "sangiin")];
    const { bills } = matchShugiinBills([bill({ id: "221-衆法-1", submitterNames: ["落合貴之"] })], members);
    assert.equal(bills[0]?.submitters, undefined);
  });

  test("衆院の名簿がまだ無い（衆院議員 0 人）なら名寄せを試みず、unmatched も出さない（氏名は Bill に原文のまま残る）", () => {
    const members = [member("m_1", "落合 貴之", "sangiin")];
    const { bills, unmatched } = matchShugiinBills([bill({ id: "221-衆法-1", submitterNames: ["落合貴之"], supporterNames: ["赤羽一嘉"] })], members);
    assert.deepEqual(bills[0]?.submitterNames, ["落合貴之"]);
    assert.deepEqual(unmatched, []);
  });

  test("同姓同名が複数いる（経過ページに会派が無い）ときは紐づけず unmatched に載せる（推測しない）", () => {
    const members = [member("s_1", "高木 真理"), member("s_2", "高木 真理", "shugiin", "自民")];
    const { bills, unmatched } = matchShugiinBills([bill({ id: "221-衆法-2", submitterNames: ["高木真理"] })], members);
    assert.equal(bills[0]?.submitters, undefined);
    assert.equal(unmatched.length, 1);
  });

  test("提出者一覧の欄が無い議案（閣法）はそのまま通る", () => {
    const members = [member("s_1", "落合 貴之")];
    const input = bill({ id: "221-閣法-3", kind: "閣法", submitterText: "内閣" });
    const { bills, unmatched } = matchShugiinBills([input], members);
    assert.deepEqual(bills, [input]);
    assert.deepEqual(unmatched, []);
  });
});
