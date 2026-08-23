import type { Member, MemberId } from "@seiji-kiroku/shared";
import { indexByName, resolveMember } from "./match-votes.ts";
import type { CommitteeMeeting } from "./sources/kokkai-attendance.ts";

/** 名寄せできなかった出席者欄の氏名表記。`data/unmatched.json` の1行（運用者が確認する）。会議録の出席者欄に会派は無いので group は空。 */
export interface UnmatchedAttendee {
  kind: "attendance";
  nameText: string;
  group: string;
  meetingId: string;
}

/** 名簿に名寄せ済みの「委員会に発議者として出席」1 件（1 人 × 1 会議）。timeline の attendance 行の材料。 */
export interface MatchedAttendance {
  memberId: MemberId;
  /** 出席者欄の氏名の原文（空白と「君」を除いたもの）。 */
  nameText: string;
  /** 会議の回次（timeline の session）。 */
  session: number;
  meetingId: string;
  meeting: string;
  date: string;
  role: "発議者";
  bills: CommitteeMeeting["bills"];
  sourceUrl: string;
}

/**
 * 委員会に出席した発議者（parseAttendancePage の出力）を参院名簿に名寄せする純粋関数（Issue #109）。
 * 正規化・同姓同名の扱いは matchVotes と同じ resolveMember。会議の回次に効いている名簿で突合する。
 * 出席者欄に会派は無いので同姓同名は絞れず unmatched（`kind: "attendance"`、meetingId 付き）に載せる（推定しない）。
 * 出力は Bill.submitters には決して流さない（出席した発議者は発議者全員ではない）。
 */
export function matchAttendance(meetings: readonly CommitteeMeeting[], members: readonly Member[]): { entries: MatchedAttendance[]; unmatched: UnmatchedAttendee[] } {
  const index = indexByName(members.filter((m) => m.house === "sangiin"));
  const entries: MatchedAttendance[] = [];
  const unmatched: UnmatchedAttendee[] = [];
  for (const mt of meetings) {
    for (const a of mt.attendees) {
      const member = resolveMember(index, a.nameText, undefined, mt.session);
      if (member) entries.push({ memberId: member.id, nameText: a.nameText, session: mt.session, meetingId: mt.id, meeting: mt.meeting, date: mt.date, role: a.role, bills: mt.bills, sourceUrl: mt.sourceUrl });
      else unmatched.push({ kind: "attendance", nameText: a.nameText, group: "", meetingId: mt.id });
    }
  }
  return { entries, unmatched };
}
