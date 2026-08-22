import type { Member, MemberId, RollCall } from "@seiji-kiroku/shared";
import { matchesGroup } from "./sources/sangiin-groups.ts";

/** 名寄せできなかった氏名表記。`data/unmatched.json` の1行（運用者が確認する）。 */
export interface Unmatched {
  nameText: string;
  group: string;
  rollCallId: string;
}

/**
 * 氏名で1人に絞れたが、採決ページの会派と名簿の会派が一致しなかった票。
 * 受け入れ基準（氏名＋会派）からの逸脱を運用者に見せるためのもの（Issue #3）。
 * 正当な原因は採決後の会派改称・移籍だが、名簿にいない旧議員が同名の現職に紐づく誤りも同じ形で現れる。
 */
export interface GroupMismatch extends Unmatched {
  memberId: MemberId;
  rosterGroup: string;
}

/**
 * 旧字体・異体字の吸収は最小限（参院名簿と投票ページで実際にぶれうる文字だけ）。
 * 増やすときはテスト（match-votes.test.ts）のテーブルに1行足す。
 */
const VARIANTS: Readonly<Record<string, string>> = {
  髙: "高", 﨑: "崎", 德: "徳", 濵: "浜", 邊: "辺", 邉: "辺",
};

/** 突合キー: 空白（全角含む）を除き、NFKC 正規化し、異体字を最小限吸収する。 */
export function normalizeName(s: string): string {
  return s.normalize("NFKC").replace(/[\s　]+/g, "").replace(/[髙﨑德濵邊邉]/g, (c) => VARIANTS[c] ?? c);
}

/**
 * 投票の氏名表記を Member に突合して memberId を埋める純粋関数。
 * 1. 正規化氏名（通称 name / 本名 legalName のどちらか）が一致する候補を集める
 * 2. 候補が複数なら、採決ページの会派と名簿の会派（略称）で絞る（同姓同名の分離）
 * 3. 1人に絞れなければ memberId は "" のまま unmatched に載せる（例外にしない）
 * 候補が1人のときは会派が食い違っても採用するが、groupMismatch に載せて可視化する:
 * 名簿は現在の会派しか持たず、採決後に会派が改称・移籍すると同一人物でも会派表記が食い違うため
 * （第221回: れいわ新選組 → いのちの党）。名簿にいない旧議員が同名の現職に紐づく誤りも
 * ここに現れるので、運用者は groupMismatch を確認する。
 * 同じ memberId が1採決内に2回出るのはデータ異常なので例外。
 */
export function matchVotes(
  rollCall: RollCall,
  members: readonly Member[],
): { rollCall: RollCall; unmatched: Unmatched[]; groupMismatch: GroupMismatch[] } {
  const byName = indexByName(members);
  const unmatched: Unmatched[] = [];
  const groupMismatch: GroupMismatch[] = [];
  const seen = new Map<MemberId, string>();

  const votes = rollCall.votes.map((vote) => {
    const member = resolveMember(byName, vote.nameText, vote.group);
    if (!member) {
      unmatched.push({ nameText: vote.nameText, group: vote.group, rollCallId: rollCall.id });
      return { ...vote, memberId: "" };
    }
    const prev = seen.get(member.id);
    if (prev !== undefined) throw new Error(`duplicate memberId ${member.id} in ${rollCall.id}: "${prev}" and "${vote.nameText}"`);
    seen.set(member.id, vote.nameText);
    if (!inGroup(member, vote.group)) {
      groupMismatch.push({
        nameText: vote.nameText, group: vote.group, rollCallId: rollCall.id,
        memberId: member.id, rosterGroup: member.terms.map((t) => t.group).join("/"),
      });
    }
    return { ...vote, memberId: member.id };
  });
  return { rollCall: { ...rollCall, votes }, unmatched, groupMismatch };
}

/**
 * 氏名表記と会派から名簿の1人を決める（matchVotes と matchSpeeches で共通）。
 * 1. 正規化氏名（通称 name / 本名 legalName）が一致する候補を集める
 * 2. 候補が複数なら会派で絞る（同姓同名の分離）。会派が無ければ絞れない
 * 3. 1人に絞れなければ undefined
 */
export function resolveMember(index: NameIndex, nameText: string, group: string | undefined): Member | undefined {
  return resolve(index.get(normalizeName(nameText)) ?? [], group ?? "");
}

export type NameIndex = Map<string, Member[]>;

export function indexByName(members: readonly Member[]): NameIndex {
  const map = new Map<string, Member[]>();
  for (const m of members) {
    const keys = new Set([m.name, m.legalName].filter((n): n is string => !!n).map(normalizeName));
    for (const key of keys) map.set(key, [...(map.get(key) ?? []), m]);
  }
  return map;
}

function resolve(candidates: Member[], voteGroup: string): Member | undefined {
  if (candidates.length === 1) return candidates[0];
  const byGroup = candidates.filter((m) => inGroup(m, voteGroup));
  return byGroup.length === 1 ? byGroup[0] : undefined;
}

function inGroup(member: Member, voteGroup: string): boolean {
  return member.terms.some((t) => matchesGroup(t.group, voteGroup));
}
