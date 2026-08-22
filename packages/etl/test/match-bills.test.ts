import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Member } from "@seiji-kiroku/shared";
import { matchBills } from "../src/match-bills.ts";
import type { Bill } from "../src/sources/sangiin-bills.ts";

const ROSTER = "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm";
const GIAN = "https://www.sangiin.go.jp/japanese/joho1/kousei/gian/221/meisai";

const member = (id: string, name: string, group = "立憲", legalName?: string): Member => ({
  id, name, ...(legalName ? { legalName } : {}), kana: "", house: "sangiin",
  terms: [{ house: "sangiin", group, district: "東京", from: "", sessionFrom: 221 }],
  sourceUrl: ROSTER,
});

const bill = (b: Partial<Bill> & { id: string }): Bill => ({
  session: 221, kind: "参法", number: 16, title: `法案 ${b.id}`, category: "法律案（参法）",
  sourceUrl: `${GIAN}/m221100221016.htm`, submittedOn: "2026-07-09", proposers: [], plenary: [], ...b,
});

describe("matchBills: 参法の発議者を名簿に名寄せする（純粋関数）", () => {
  const members = [member("m_1", "打越 さく良"), member("m_2", "原田 秀一", "自民"), member("m_3", "高木 真理"), member("m_4", "高木 真理", "自民")];

  test("筆頭発議者は 提出者 として、提出日・原文・審議状況・議案ページの URL とともに紐づく", () => {
    const { entries, unmatched } = matchBills(
      [bill({ id: "221-参法-16", proposerText: "打越さく良君 外9名", proposers: ["打越さく良"], status: "参議院 環境委員会 未了" })],
      members,
    );
    assert.deepEqual(entries, [{
      memberId: "m_1", billId: "221-参法-16", date: "2026-07-09", title: "法案 221-参法-16", role: "提出者",
      submitterText: "打越さく良君 外9名", status: "参議院 環境委員会 未了", sourceUrl: `${GIAN}/m221100221016.htm`,
    }]);
    assert.deepEqual(unmatched, []);
  });

  test("名寄せは matchVotes と同じ正規化（空白・NFKC・異体字）。本名でも突合する", () => {
    const ms = [member("m_9", "髙橋 はるみ", "自民", "髙橋 晴美")];
    const r1 = matchBills([bill({ id: "221-参法-1", proposers: ["高橋はるみ"] })], ms);
    const r2 = matchBills([bill({ id: "221-参法-2", proposers: ["高橋　晴美"] })], ms);
    assert.equal(r1.entries[0]?.memberId, "m_9");
    assert.equal(r2.entries[0]?.memberId, "m_9");
  });

  test("名簿に無い氏名は unmatched（種別 bill）に載り、例外にはならない", () => {
    const { entries, unmatched } = matchBills([bill({ id: "221-参法-3", proposers: ["存在しない人"] })], members);
    assert.deepEqual(entries, []);
    assert.deepEqual(unmatched, [{ nameText: "存在しない人", group: "", billId: "221-参法-3" }]);
  });

  test("同姓同名が複数いて会派で絞れない（議案ページに会派が無い）ときは紐づけず unmatched に載せる（推測しない）", () => {
    const { entries, unmatched } = matchBills([bill({ id: "221-参法-4", proposers: ["高木真理"] })], members);
    assert.deepEqual(entries, []);
    assert.equal(unmatched.length, 1);
  });

  test("参法以外（閣法・衆法）の発議者は参議院の名簿と突合しない（衆議院議員なので unmatched にもしない）", () => {
    const { entries, unmatched } = matchBills(
      [bill({ id: "221-衆法-25", kind: "衆法", category: "法律案（衆法）", proposers: ["西岡義高"] }), bill({ id: "221-閣法-1", kind: "閣法", category: "法律案（内閣提出）" })],
      members,
    );
    assert.deepEqual(entries, []);
    assert.deepEqual(unmatched, []);
  });

  test("参法に提出日が無ければ timeline に置けないので例外（黙って落とさない）", () => {
    assert.throws(() => matchBills([bill({ id: "221-参法-5", submittedOn: undefined, proposers: ["原田秀一"] })], members), /提出日/);
  });

  test("status・proposerText が無ければキーごと省く", () => {
    const { entries } = matchBills([bill({ id: "221-参法-6", proposers: ["原田秀一"] })], members);
    assert.deepEqual(Object.keys(entries[0] ?? {}).sort(), ["billId", "date", "memberId", "role", "sourceUrl", "title"]);
  });
});
