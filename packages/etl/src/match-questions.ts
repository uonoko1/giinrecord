import type { Member, MemberId, Question } from "@seiji-kiroku/shared";
import { indexByName, resolveMember } from "./match-votes.ts";
import { rosterCoveredSessions } from "./match-shugiin-bills.ts";

/** 名寄せできなかった質問主意書の提出者の氏名表記。`data/unmatched.json` の1行（運用者が確認する）。group は衆院 経過ページの会派名（参院は空）。 */
export interface UnmatchedQuestionSubmitter {
  kind: "question";
  nameText: string;
  group: string;
  questionId: string;
}

/**
 * 質問主意書の提出者を名簿に名寄せする純粋関数（Issue #106）。正規化・同姓同名の扱いは matchVotes と同じ resolveMember。
 * - 参院の質問は参院名簿（回次ごと）に、その回次に効いている名簿で突合する（辞職した旧議員も紐づく）。詳細ページに会派は無いので同姓同名は絞れず unmatched。
 * - 衆院の質問は衆院名簿に。経過ページの「会派名」で同姓同名を絞る。衆院名簿は「現在」の1回次分しか無い（#71）ので、
 *   名簿が覆う回次の質問だけ名寄せし、過去回次は紐づけず unmatched にも出さない（matchShugiinBills と同じ扱い。推測も確認表の汚染も避ける）。
 * - 衆院の名簿が無ければ（house: shugiin が0人）衆院の質問は名寄せを試みない。
 * - 原文の氏名（submitterNames）は成否に関係なく Question に残る。submitters は紐づいた人だけ。
 */
export function matchQuestions(questions: readonly Question[], members: readonly Member[]): { questions: Question[]; unmatched: UnmatchedQuestionSubmitter[] } {
  const byHouse = { sangiin: members.filter((m) => m.house === "sangiin"), shugiin: members.filter((m) => m.house === "shugiin") };
  const index = { sangiin: indexByName(byHouse.sangiin), shugiin: indexByName(byHouse.shugiin) };
  const shugiinCovered = rosterCoveredSessions(byHouse.shugiin);
  const unmatched: UnmatchedQuestionSubmitter[] = [];
  const out = questions.map((q) => {
    if (byHouse[q.house].length === 0) return { ...q };
    if (q.house === "shugiin" && !shugiinCovered.has(q.session)) return { ...q };
    const ids: MemberId[] = [];
    for (const nameText of q.submitterNames) {
      const member = resolveMember(index[q.house], nameText, q.group, q.session);
      if (member) ids.push(member.id);
      else unmatched.push({ kind: "question", nameText, group: q.group ?? "", questionId: q.id });
    }
    return ids.length ? { ...q, submitters: ids } : { ...q };
  });
  return { questions: out, unmatched };
}
