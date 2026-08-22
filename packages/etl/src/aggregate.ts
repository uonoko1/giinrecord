import type { Member, MemberDetail, MemberSummary, RollCall, RollCallSummary, VoteEntry, VoteValue } from "@seiji-kiroku/shared";
import { toSummary } from "./sources/sangiin-members.ts";

/** 集約結果（純粋関数の出力）。ファイルへの書き出しは dataset.ts が担う。 */
export interface Aggregated {
  /** `members/index.json`。counts を埋めたもの。 */
  index: MemberSummary[];
  /** `members/{id}.json`。名簿の全員分（票のない議員も timeline 空で含む）。 */
  details: MemberDetail[];
  /** `rollcalls/index.json`。日付降順。 */
  rollCalls: RollCallSummary[];
}

/**
 * その採決でその会派の多数票。賛成票>反対票なら賛成、反対票>賛成票なら反対、同数（0対0含む）なら undefined。
 * 公表された会派別集計（事実）から機械的に求めるだけで、会派の「方針」を推定するものではない。
 */
export function groupMajority(rollCall: RollCall, group: string): VoteValue | undefined {
  const g = rollCall.groups.find((x) => x.group === group);
  if (!g || g.yes === g.no) return undefined;
  return g.yes > g.no ? "賛成" : "反対";
}

/**
 * `result` は公表された集計をそのまま文字列にする。可決・否決の判定は投票結果ページに無いので多数決から推論しない。
 * 参院 議案情報の審議結果（原文: 可決・否決・修正議決・同意・是認 など）が突合できていれば「可決（賛成 N・反対 N）」の形で両方出す。
 */
export function summarizeRollCall(rc: RollCall, decision?: string): RollCallSummary {
  const tally = `賛成 ${rc.totals.yes}・反対 ${rc.totals.no}`;
  return {
    id: rc.id, session: rc.session, date: rc.date, title: rc.title,
    totals: rc.totals, result: decision ? `${decision}（${tally}）` : tally, sourceUrl: rc.sourceUrl,
  };
}

/**
 * 名簿と突合済みの採決から、議員ごとの timeline と一覧を組み立てる。
 * - memberId が空（未突合）の票は unmatched.json 側で扱うので timeline には入れない。
 * - 名簿にない memberId は名寄せの不整合なので例外にする（黙って捨てない）。
 * - 並びは日付降順、同日は採決 id 降順で安定させる（差分最小化）。
 */
export function buildDataset(
  members: readonly Member[],
  rollCalls: readonly RollCall[],
  /** 採決 id → 議案情報の審議結果（原文）。無い採決は得票のみの result になる。 */
  decisions: ReadonlyMap<string, string> = new Map(),
): Aggregated {
  const summarize = (rc: RollCall) => summarizeRollCall(rc, decisions.get(rc.id));
  const timelines = new Map<string, VoteEntry[]>(members.map((m) => [m.id, []]));
  for (const rc of rollCalls) {
    for (const v of rc.votes) {
      if (v.memberId === "") continue;
      const timeline = timelines.get(v.memberId);
      if (!timeline) throw new Error(`vote in ${rc.id} refers to unknown memberId ${v.memberId} ("${v.nameText}")`);
      const groupValue = groupMajority(rc, v.group);
      timeline.push({
        kind: "vote", date: rc.date, rollCallId: rc.id, title: rc.title, value: v.value,
        result: summarize(rc).result, ...(groupValue ? { groupValue } : {}), sourceUrl: rc.sourceUrl,
      });
    }
  }
  const details = members.map((m): MemberDetail => ({ ...m, timeline: [...timelines.get(m.id)!].sort(byDateDesc) }));
  const index = members.map((m) => {
    const s = toSummary(m);
    return { ...s, counts: { ...s.counts, rollcalls: timelines.get(m.id)!.length } };
  });
  return { index, details, rollCalls: rollCalls.map(summarize).sort(byDateDesc) };
}

const byDateDesc = (a: { date: string; id?: string; rollCallId?: string }, b: { date: string; id?: string; rollCallId?: string }) =>
  cmp(b.date, a.date) || cmp(b.rollCallId ?? b.id ?? "", a.rollCallId ?? a.id ?? "");
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
