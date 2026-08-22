import type { Bill, Member, MemberId } from "@seiji-kiroku/shared";
import { indexByName, resolveMember } from "./match-votes.ts";

/** 名寄せできなかった衆院 議案の提出者・賛成者の氏名表記。`data/unmatched.json` の1行（運用者が確認する）。経過ページに個人の会派は無いので group は空。 */
export interface UnmatchedShugiinBillName {
  kind: "bill";
  nameText: string;
  group: string;
  billId: string;
}

/**
 * 衆院 経過ページの「議案提出者一覧」「議案提出の賛成者」の氏名を衆院の名簿に名寄せする純粋関数（Issue #72）。
 * - 正規化・同姓同名の扱いは matchVotes と同じ resolveMember。経過ページに個人の会派は無いので、同姓同名は絞れず unmatched に載せる（推測しない）。
 * - 原文の氏名（submitterNames / supporterNames）は名寄せの成否に関係なく Bill に残る。submitters / supporters は紐づいた人だけ。
 * - 衆院の名簿がまだ無い（house: "shugiin" の Member が 0 人）なら名寄せを試みず、unmatched も出さない。
 *   全氏名（第221回で約2,000件）を unmatched に流すと運用者の確認表が埋まり、名簿 PBI が入れば解消するものなので、氏名は Bill 側の事実として残すにとどめる。
 * - 参院の名簿（house: "sangiin"）とは突合しない（衆院の提出者は衆議院議員）。
 */
export function matchShugiinBills(bills: readonly Bill[], members: readonly Member[]): { bills: Bill[]; unmatched: UnmatchedShugiinBillName[] } {
  const shugiin = members.filter((m) => m.house === "shugiin");
  if (shugiin.length === 0) return { bills: [...bills], unmatched: [] };
  const index = indexByName(shugiin);
  const unmatched: UnmatchedShugiinBillName[] = [];
  const resolve = (billId: string, names: readonly string[] | undefined): MemberId[] | undefined => {
    if (!names) return undefined;
    const ids: MemberId[] = [];
    for (const nameText of names) {
      const member = resolveMember(index, nameText, undefined);
      if (member) ids.push(member.id);
      else unmatched.push({ kind: "bill", nameText, group: "", billId });
    }
    return ids.length ? ids : undefined;
  };
  const out = bills.map((bill) => {
    const submitters = resolve(bill.id, bill.submitterNames);
    const supporters = resolve(bill.id, bill.supporterNames);
    return { ...bill, ...(submitters ? { submitters } : {}), ...(supporters ? { supporters } : {}) };
  });
  return { bills: out, unmatched };
}
