import type { Member, MemberTerm } from "@seiji-kiroku/shared";

/**
 * 採決（発言）の回次に「効いている」名簿の term を返す純粋関数（Issue #24）。
 *
 * 参院の議員一覧は会期後のスナップショット（Sprint 3 の発見。第217回の名簿は選挙後の 2025-07-31 時点）なので、
 * 第 N 回の採決に最も近い事実は第 N 回の名簿。会期中に辞職・任期満了した議員は第 N 回の名簿に無いので、
 * その場合は第 N-1 回（手元にある中で最も新しい過去の回次）の名簿を使う。
 * 後の回次の名簿しか無い（名簿に載る前の採決）なら undefined。会派移動の時期を推定することはしない。
 *
 * `sessionTo` が無い term（parseMemberList 直後、未統合）は sessionFrom の1回次分として扱う。
 * 日付ではなく回次で引く: 名簿に日付が無く、回次→会期の対応表を持ち込むと推定が混じるため。
 */
export function groupAt(member: Member, session: number): MemberTerm | undefined {
  let best: MemberTerm | undefined;
  for (const t of member.terms) {
    const to = t.sessionTo ?? t.sessionFrom;
    if (t.sessionFrom <= session && session <= to) return t;
    if (to < session && (best === undefined || to > (best.sessionTo ?? best.sessionFrom))) best = t;
  }
  return best;
}
