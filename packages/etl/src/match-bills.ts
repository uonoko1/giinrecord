import type { BillRole, Member, MemberId } from "@seiji-kiroku/shared";
import { indexByName, resolveMember } from "./match-votes.ts";
import type { Bill } from "./sources/sangiin-bills.ts";

/** 名寄せできなかった発議者の氏名表記。`data/unmatched.json` の1行（運用者が確認する）。議案ページに会派は無いので group は空。 */
export interface UnmatchedBillProposer {
  nameText: string;
  group: string;
  billId: string;
}

/** 名簿の1人に紐づいた議員立法の関与（timeline の bill 行の材料。aggregate.ts が TimelineEntry にする）。 */
export interface MatchedBill {
  memberId: MemberId;
  billId: string;
  /** 参議院への提出日（議案ページ「提出日」）。 */
  date: string;
  title: string;
  role: BillRole;
  /** 発議者欄の原文（例「打越さく良君 外9名」）。 */
  submitterText?: string;
  status?: string;
  /** 議案ページ。 */
  sourceUrl: string;
}

/**
 * 参法の発議者を名簿に名寄せする純粋関数（正規化・同姓同名の扱いは matchVotes と同じ resolveMember）。
 * - 対象は種別「法律案（参法）」だけ。閣法に発議者は無く、衆法の発議者は衆議院議員で参院名簿に無いのが正常なので unmatched にもしない。
 * - 議案ページに載る氏名は筆頭発議者だけ（「外N名」の氏名は公表されていない）。載っている人だけを 提出者 にし、人数は submitterText の原文で示す。
 *   賛成者の氏名も公表されていないので、この関数が 賛成者 を作ることはない（型としては残す）。
 * - 議案ページに会派が無いので、同姓同名は絞れず unmatched に載せる（推測しない）。
 * - 提出日の無い参法は timeline に置けないので例外（上流 HTML の変化を黙って飲まない）。
 * 注: #24 で衆法・会派の扱いを広げるときもこの関数は純粋なまま保つ。
 */
export function matchBills(bills: readonly Bill[], members: readonly Member[]): { entries: MatchedBill[]; unmatched: UnmatchedBillProposer[] } {
  const index = indexByName(members);
  const entries: MatchedBill[] = [];
  const unmatched: UnmatchedBillProposer[] = [];
  for (const bill of bills) {
    if (bill.kind !== "参法") continue;
    if (bill.proposers.length === 0) continue;
    if (!bill.submittedOn) throw new Error(`${bill.id}: 提出日がありません (${bill.sourceUrl})`);
    for (const nameText of bill.proposers) {
      const member = resolveMember(index, nameText, undefined);
      if (!member) {
        unmatched.push({ nameText, group: "", billId: bill.id });
        continue;
      }
      entries.push({
        memberId: member.id, billId: bill.id, date: bill.submittedOn, title: bill.title, role: "提出者",
        ...(bill.proposerText ? { submitterText: bill.proposerText } : {}),
        ...(bill.status ? { status: bill.status } : {}),
        sourceUrl: bill.sourceUrl,
      });
    }
  }
  return { entries, unmatched };
}
