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
 * 2. 採決の時点の在職を名簿から確認できない候補を落とす（#230。`tenureVerified`）
 * 3. 残りが複数なら、採決ページの会派と「採決の回次に効いている名簿の会派」（groupAt）で絞る（同姓同名の分離）
 * 4. 1人に絞れなければ memberId は "" のまま unmatched に載せる（例外にしない）
 * 在職を確認できて候補が1人のときは会派が食い違っても採用するが、どの回次の名簿の会派とも一致しなければ groupMismatch に載せる:
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
    const member = resolveMember(byName, vote.nameText, vote.group, { session: rollCall.session, date: rollCall.date });
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
 * 記録がいつのものかを表す文脈（#230）。在職の確認にはこの両方を使う。
 * `session` は記録の回次、`date` は記録の日付（ISO。採決日・議案提出日・会議の日）。
 * `date` が無い記録は名簿の覆う回次だけで確認する（任期満了日と比べようがないため）。
 */
export interface RecordAt {
  session: number;
  /** ISO date。無ければ (b) の確認（任期満了日との比較）は行わない */
  date?: string;
}

/**
 * その記録の時点で在職していたことを**名簿（一次資料）から確認できる**か（#230）。
 *
 * 名簿には任期満了日（`to`）はあるが在職開始日にあたる項目が無いので、「その回次に在職していた」ことは
 * 次のどちらかでしか確認できない。どちらでもなければ、氏名が一致しても在職は未確認であり、紐づけない（推定しない）。
 *
 * (a) **名簿がその回次を覆っている**: `sessionFrom <= session <= sessionTo`。
 *     その回次の議員一覧に載っている＝その回次の議員であることが一次資料に書いてある。
 * (b) **より前の回次の名簿に載っていて、任期満了日が記録の日付以後**: `sessionTo < session` かつ `to >= date`。
 *     参院の議員一覧は会期後のスナップショットなので、会期中に辞職・任期満了した議員は次の回次の一覧に載らない
 *     （groupAt の注記と同じ事情）。前の回次の一覧に載っている＝その時点までに既に議員であり、
 *     任期満了日がまだ来ていない＝その日にも任期中である。どちらも名簿に書いてある事実。
 *
 * (b) が「前の回次の名簿」を要求するのが要点。任期満了日だけを見ると、2028年に任期が切れる現職が
 * 1998年の票に「任期満了日 >= 1998年」で通ってしまう。初当選より前かどうかは名簿から分からない。
 */
export function tenureVerified(member: Member, at: RecordAt): boolean {
  return rosterCovers(member, at) || tenureCarriedOver(member, at);
}

/** (a) その回次の議員一覧に載っている（名簿の直接の記載）。 */
function rosterCovers(member: Member, at: RecordAt): boolean {
  return member.terms.some((t) => t.sessionFrom <= at.session && at.session <= (t.sessionTo ?? t.sessionFrom));
}

/** (b) より前の回次の名簿に載っていて、任期満了日が記録の日付以後（名簿の記載からの推論）。 */
function tenureCarriedOver(member: Member, at: RecordAt): boolean {
  return member.terms.some((t) => {
    const to = t.sessionTo ?? t.sessionFrom;
    return to < at.session && at.date !== undefined && !!t.to && t.to >= at.date;
  });
}

/**
 * 氏名表記と会派から名簿の1人を決める（matchVotes / matchSpeeches / matchBills で共通）。
 * 1. 正規化氏名（通称 name / 本名 legalName）が一致する候補を集める
 * 2. **その記録の時点の在職を名簿から確認できない候補を落とす**（#230。`tenureVerified`）。
 *    `at` を渡さない呼び出しは「いつの記録か」が分からず在職を確認しようがないので、候補は残らない
 * 3. 残りが複数なら会派で絞る（同姓同名の分離）。その回次に効いている名簿の会派（groupAt）だけを見る。会派が無ければ絞れない
 * 4. 1人に絞れなければ undefined
 *
 * 2 で落ちた候補は会派が一致していても採らない（#230）。同姓同名の別人に記録が付くのを避けるため、
 * 在職未確認の候補は「候補ですらない」ものとして扱う。落ちた氏名は呼び出し側が unmatched に載せる（記録は失わない）。
 */
export function resolveMember(index: NameIndex, nameText: string, group: string | undefined, at?: RecordAt): Member | undefined {
  const named = index.get(normalizeName(nameText)) ?? [];
  const candidates = at === undefined ? [] : named.filter((m) => tenureVerified(m, at));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0 || at === undefined) return undefined;
  const voteGroup = group ?? "";
  const byGroup = candidates.filter((m) => inGroupAt(m, voteGroup, at.session));
  if (byGroup.length === 1) return byGroup[0];
  // #320: ここまでで絞れないのは、会派まで同じ候補が複数あるとき。院を移った議員は、移る前の名簿の行が
  // (b) で残るので（参院の `to` は選挙で決まる任期満了日で、途中で辞職しても消えない）、同一人物の
  // 2 行が会派も同じまま並ぶ。(a) は「その回次の議員一覧に載っている」という**直接の記載**、
  // (b) は「前の回次に載っていて任期が残る」という**推論**なので、(a) の行を採る。
  //
  // 会派で絞ったあとに置くのが要点。先に (a) で絞ると、**会派が違う別人**（(a) で立つ）が
  // 正しい候補（(b) で立つ）を押しのける。会派は名簿に書いてある事実で、(a)/(b) の別より強い手がかり。
  const tied = byGroup.length > 1 ? byGroup : candidates;
  const direct = tied.filter((m) => rosterCovers(m, at));
  return direct.length === 1 ? direct[0] : undefined;
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
