import type { Member, Speech } from "@seiji-kiroku/shared";
import { indexByName, resolveMember } from "./match-votes.ts";

/** 名寄せできなかった発言者表記。`data/unmatched.json` の1行（運用者が確認する）。 */
export interface UnmatchedSpeech {
  nameText: string;
  group: string;
  speechId: string;
  /**
   * その発言の回次（Issue 370）。`/coverage` が「紐づけられなかった発言が第N回に何件あるか」を
   * 数えて出すために要る。**speechId から復元しない**——ここには発言そのものの回次
   * （会議録 API のレコードの値）が既にあるので、それをそのまま持つ。
   */
  session: number;
}

/**
 * 発言者名（speaker）＋会派（speakerGroup）で Speech を名簿に突合し memberId を埋める純粋関数。
 * 正規化・同姓同名・在職の確認は matchVotes と同じ（resolveMember）。同姓同名はその回次に効いている名簿の会派（groupAt）で分ける（Issue #24）。
 * - 回次と日付は**発言ごとの `session` / `date`**（会議録 API のレコードの値。事実）を使う（#230）。
 *   呼び出し側が渡す回次を受け取っていたが、それは取得時に指定した回次であって発言そのものの回次とは別の値になりうるので、
 *   在職の確認には使わない（引き継ぎ行の再突合でも発言の回次が要る）。
 * - 議長・大臣など position がある発言も、名簿にいれば memberId を入れ、position はそのまま保持する。
 * - 名簿は**両院ぶんを渡す**（`speechRosters`。Issue #313）。会議録は会議の院で分かれるが、発言者はその院の議員とは限らない
 *   （大臣・副大臣としての答弁、連合審査会など）。院で名簿を分けると、他院の議員の発言が丸ごと落ちる。
 * - position があって名簿にいない発言者（他院議員の大臣・政府参考人など）は名簿に無いのが正常なので unmatched にしない。
 * - position が無く名簿にもいない発言者は unmatched に載せる（表記ゆれ・名簿の欠落を運用者に見せる）。
 */
/**
 * 発言の突合に渡す名簿（Issue #313）。**両院ぶんを 1 つに並べる。**
 *
 * 会議録は会議の院（`nameOfHouse`）で分かれるが、**発言者はその院の議員とは限らない**。
 * 参議院の会議には衆院議員が大臣・副大臣として答弁に立ち、連合審査会にも出る（逆も同じ）。
 * 参院の会議録を参院名簿だけに突合していたため、そこに出た衆院議員の発言が全部落ちていた
 * （`data/unmatched.json` の 692 行はすべて参議院の会議録。うち第221回の 391 行・37 名分がこれで紐づく）。
 *
 * **名簿を足しても在職の確認も同姓同名の扱いも緩まない**。どちらも resolveMember がそのまま効く:
 * - 在職（#230）: 衆院名簿は「現在」の 1 回次分しか無い（#71）ので、それが覆わない回次（第217・219回）の
 *   発言は `tenureVerified` の (a) も (b) も成り立たず候補が残らない。unmatched に残る（推測で紐づけない）。
 * - 同姓同名: 両院の名簿には同じ氏名の議員が実在する。会派（groupAt）で 1 人に絞れなければ紐づけない。
 */
export function speechRosters(sangiin: readonly Member[], shugiin: readonly Member[]): Member[] {
  return [...sangiin, ...shugiin];
}

export function matchSpeeches(speeches: readonly Speech[], members: readonly Member[]): { speeches: Speech[]; unmatched: UnmatchedSpeech[] } {
  const index = indexByName(members);
  const unmatched: UnmatchedSpeech[] = [];
  const out = speeches.map((s) => {
    const member = resolveMember(index, s.speakerText, s.group, { session: s.session, date: s.date });
    if (member) return { ...s, memberId: member.id };
    if (!s.position) unmatched.push({ nameText: s.speakerText, group: s.group ?? "", speechId: s.id, session: s.session });
    return { ...s };
  });
  return { speeches: out, unmatched };
}
