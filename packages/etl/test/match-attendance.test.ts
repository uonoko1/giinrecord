import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Member } from "@seiji-kiroku/shared";
import { matchAttendance } from "../src/match-attendance.ts";
import { parseAttendancePage, type CommitteeMeeting } from "../src/sources/kokkai-attendance.ts";
import { parseMemberList } from "../src/sources/sangiin-members.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");
const ROSTER = "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm";

const member = (id: string, name: string, group: string, session = 221): Member => ({
  id, name, kana: "", house: "sangiin",
  terms: [{ house: "sangiin", group, district: "", from: "", sessionFrom: session }],
  sourceUrl: ROSTER,
});

const meeting = (attendees: string[], extra: Partial<CommitteeMeeting> = {}): CommitteeMeeting => ({
  id: "122115007X01420260709_000", session: 221, meeting: "農林水産委員会 第14号", date: "2026-07-09",
  attendees: attendees.map((nameText) => ({ role: "発議者", nameText })),
  bills: [{ billId: "221-参法-11", title: "法律案" }],
  sourceUrl: "https://kokkai.ndl.go.jp/txt/122115007X01420260709/0",
  ...extra,
});

describe("matchAttendance: 委員会に出席した発議者を参院名簿に名寄せする（Issue #109）", () => {
  test("氏名（空白・異体字を吸収）で紐づき、1 人 1 会議につき 1 行になる", () => {
    const { entries, unmatched } = matchAttendance([meeting(["舟山康江", "髙橋光男"])], [member("m_1", "舟山 康江", "国民"), member("m_2", "高橋 光男", "公明")]);
    assert.deepEqual(entries, [
      { memberId: "m_1", nameText: "舟山康江", session: 221, meetingId: "122115007X01420260709_000", meeting: "農林水産委員会 第14号", date: "2026-07-09", role: "発議者",
        bills: [{ billId: "221-参法-11", title: "法律案" }], sourceUrl: "https://kokkai.ndl.go.jp/txt/122115007X01420260709/0" },
      { memberId: "m_2", nameText: "髙橋光男", session: 221, meetingId: "122115007X01420260709_000", meeting: "農林水産委員会 第14号", date: "2026-07-09", role: "発議者",
        bills: [{ billId: "221-参法-11", title: "法律案" }], sourceUrl: "https://kokkai.ndl.go.jp/txt/122115007X01420260709/0" },
    ]);
    assert.deepEqual(unmatched, []);
  });

  test("名簿に無い氏名は unmatched（kind: attendance、meetingId 付き）に載り、entries には入らない", () => {
    const { entries, unmatched } = matchAttendance([meeting(["誰か"])], [member("m_1", "舟山 康江", "国民")]);
    assert.deepEqual(entries, []);
    assert.deepEqual(unmatched, [{ kind: "attendance", nameText: "誰か", group: "", meetingId: "122115007X01420260709_000" }]);
  });

  test("同姓同名は会議録に会派が無いので絞れず unmatched（推定しない）", () => {
    const { entries, unmatched } = matchAttendance([meeting(["山田太郎"])], [member("m_1", "山田 太郎", "自民"), member("m_2", "山田 太郎", "立憲")]);
    assert.deepEqual(entries, []);
    assert.equal(unmatched.length, 1);
  });

  test("実データ: 第221回の名簿と 農林水産委員会 第14号（発議者 5 名）・第16号（2 名）が全員紐づく", () => {
    const members = parseMemberList(fixture("sangiin-giin-221.htm"), ROSTER, 221);
    const page = parseAttendancePage(JSON.parse(fixture("kokkai-attendance-221.json")), 221);
    const { entries, unmatched } = matchAttendance(page.meetings, members);
    assert.deepEqual(unmatched, []);
    assert.equal(entries.filter((e) => e.meetingId === "122115007X01420260709_000").length, 5);
    assert.equal(entries.filter((e) => e.meetingId === "122115007X01620260716_000").length, 2);
  });
});
