import type { Member, Speech } from "@seiji-kiroku/shared";
import { indexByName, resolveMember } from "./match-votes.ts";

/** 名寄せできなかった発言者表記。`data/unmatched.json` の1行（運用者が確認する）。 */
export interface UnmatchedSpeech {
  nameText: string;
  group: string;
  speechId: string;
}

/**
 * 発言者名（speaker）＋会派（speakerGroup）で Speech を名簿に突合し memberId を埋める純粋関数。
 * 正規化・同姓同名の扱いは matchVotes と同じ（resolveMember）。session を渡すと同姓同名はその回次に効いている名簿の会派（groupAt）で分ける（Issue #24）。
 * - 議長・大臣など position がある発言も、名簿にいれば memberId を入れ、position はそのまま保持する。
 * - position があって名簿にいない発言者（衆院議員の大臣・政府参考人など）は参院名簿に無いのが正常なので unmatched にしない。
 * - position が無く名簿にもいない発言者は unmatched に載せる（表記ゆれ・名簿の欠落を運用者に見せる）。
 */
export function matchSpeeches(speeches: readonly Speech[], members: readonly Member[], session?: number): { speeches: Speech[]; unmatched: UnmatchedSpeech[] } {
  const index = indexByName(members);
  const unmatched: UnmatchedSpeech[] = [];
  const out = speeches.map((s) => {
    const member = resolveMember(index, s.speakerText, s.group, session);
    if (member) return { ...s, memberId: member.id };
    if (!s.position) unmatched.push({ nameText: s.speakerText, group: s.group ?? "", speechId: s.id });
    return { ...s };
  });
  return { speeches: out, unmatched };
}
