import type { Member, MemberId, RollCall } from "@seiji-kiroku/shared";
import { groupAt } from "./group-history.ts";
import { matchesGroup } from "./sources/sangiin-groups.ts";

/** 名寄せできなかった氏名表記。`data/unmatched.json` の1行（運用者が確認する）。 */
export interface Unmatched {
  nameText: string;
  group: string;
  rollCallId: string;
}

/**
 * 氏名で1人に絞れたが、採決ページの会派がその議員のどの回次の名簿の会派とも一致しなかった票。
 * `data/group-mismatch.json` の1行（Issue #24。docs/DATA_CONTRACT.md）。
 * 正当な原因は名簿に現れない会派改称・移籍だが、名簿にいない旧議員が同名の現職に紐づく誤りも同じ形で現れる。
 * 観測された差異をそのまま記録するだけで、会派移動を推定するものではない。
 */
export interface GroupMismatch {
  memberId: MemberId;
  nameText: string;
  /** 投票結果ページの会派（原文）。 */
  voteGroup: string;
  /** 採決の回次に効いている名簿の会派（groupAt）。効いている名簿が無ければ手元の全会派を "/" で連結。 */
  rosterGroup: string;
  rollCallId: string;
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
 * 投票の氏名表記を Member に突合して memberId を埋める純粋関数（Issue #3, #24）。
 * 1. 正規化氏名（通称 name / 本名 legalName のどちらか）が一致する候補を集める
 * 2. 候補が複数なら、採決ページの会派と「採決の回次に効いている名簿の会派」（groupAt）で絞る（同姓同名の分離）
 * 3. 1人に絞れなければ memberId は "" のまま unmatched に載せる（例外にしない）
 * 候補が1人のときは会派が食い違っても採用するが、どの回次の名簿の会派とも一致しなければ groupMismatch に載せる:
 * 名簿は会期後のスナップショットで、採決後に会派が改称・移籍すると同一人物でも会派表記が食い違うため
 * （第221回: れいわ新選組 → いのちの党。第220回の名簿が「れ新」なら一致扱い）。名簿にいない旧議員が
 * 同名の現職に紐づく誤りもここに現れるので、運用者は data/group-mismatch.json を確認する。
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
    const member = resolveMember(byName, vote.nameText, vote.group, rollCall.session);
    if (!member) {
      unmatched.push({ nameText: vote.nameText, group: vote.group, rollCallId: rollCall.id });
      return { ...vote, memberId: "" };
    }
    const prev = seen.get(member.id);
    if (prev !== undefined) throw new Error(`duplicate memberId ${member.id} in ${rollCall.id}: "${prev}" and "${vote.nameText}"`);
    seen.set(member.id, vote.nameText);
    if (!inAnyTerm(member, vote.group)) {
      groupMismatch.push({
        memberId: member.id, nameText: vote.nameText, voteGroup: vote.group,
        rosterGroup: groupAt(member, rollCall.session)?.group ?? [...new Set(member.terms.map((t) => t.group))].join("/"),
        rollCallId: rollCall.id,
      });
    }
    return { ...vote, memberId: member.id };
  });
  return { rollCall: { ...rollCall, votes }, unmatched, groupMismatch };
}

/**
 * 氏名表記と会派から名簿の1人を決める（matchVotes / matchSpeeches / matchBills で共通）。
 * 1. 正規化氏名（通称 name / 本名 legalName）が一致する候補を集める
 * 2. 候補が複数なら会派で絞る（同姓同名の分離）。session があればその回次に効いている名簿の会派（groupAt）だけを見る。
 *    session が無ければ（議案ページなど回次の文脈が無い呼び出し）どの回次の会派でも可。会派が無ければ絞れない
 * 3. 1人に絞れなければ undefined
 */
export function resolveMember(index: NameIndex, nameText: string, group: string | undefined, session?: number): Member | undefined {
  const candidates = index.get(normalizeName(nameText)) ?? [];
  if (candidates.length === 1) return candidates[0];
  const voteGroup = group ?? "";
  const byGroup = candidates.filter((m) => (session === undefined ? inAnyTerm(m, voteGroup) : inGroupAt(m, voteGroup, session)));
  return byGroup.length === 1 ? byGroup[0] : undefined;
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

/** 採決の回次に効いている名簿の会派が voteGroup と同じ会派か。効いている名簿が無ければ false（推定しない）。 */
function inGroupAt(member: Member, voteGroup: string, session: number): boolean {
  const term = groupAt(member, session);
  return term !== undefined && matchesGroup(term.group, voteGroup);
}

/** いずれかの回次の名簿の会派が voteGroup と同じ会派か。 */
function inAnyTerm(member: Member, voteGroup: string): boolean {
  return member.terms.some((t) => matchesGroup(t.group, voteGroup));
}
