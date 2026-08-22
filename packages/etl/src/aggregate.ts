import type { Member, MemberDetail, MemberSummary, RollCall, RollCallSummary, Speech, TimelineEntry, VoteValue } from "@seiji-kiroku/shared";
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

/** `result` は公表された集計をそのまま文字列にする。可決・否決の判定は出典に無いので行わない。 */
export function summarizeRollCall(rc: RollCall): RollCallSummary {
  return {
    id: rc.id, session: rc.session, date: rc.date, title: rc.title,
    totals: rc.totals, result: `賛成 ${rc.totals.yes}・反対 ${rc.totals.no}`, sourceUrl: rc.sourceUrl,
  };
}

/**
 * 名簿と突合済みの採決・発言から、議員ごとの timeline と一覧を組み立てる。
 * - memberId が空（未突合）の票・memberId の無い発言は unmatched.json 側で扱うので timeline には入れない。
 * - 名簿にない memberId は名寄せの不整合なので例外にする（黙って捨てない）。
 * - 並びは日付降順。同日は kind（vote → bill → speech）、次に採決 id / 発言 id の降順で安定させる（差分最小化）。
 * - 議長・大臣など position 付きの発言（議事進行・政府答弁）は timeline に入れず counts.speeches にも数えない。
 *   TimelineEntry（shared 契約）に position が無く、議員としての討論と区別なく「本会議発言 N」と出てしまうため。
 *   契約に position が入ったら、この除外をやめて position を載せる。除外数は cli が表示する。
 */
export function buildDataset(members: readonly Member[], rollCalls: readonly RollCall[], speeches: readonly Speech[] = []): Aggregated {
  const timelines = new Map<string, TimelineEntry[]>(members.map((m) => [m.id, []]));
  const timelineOf = (memberId: string, what: string): TimelineEntry[] => {
    const timeline = timelines.get(memberId);
    if (!timeline) throw new Error(`${what} refers to unknown memberId ${memberId}`);
    return timeline;
  };
  for (const rc of rollCalls) {
    for (const v of rc.votes) {
      if (v.memberId === "") continue;
      const groupValue = groupMajority(rc, v.group);
      timelineOf(v.memberId, `vote in ${rc.id} ("${v.nameText}")`).push({
        kind: "vote", date: rc.date, rollCallId: rc.id, title: rc.title, value: v.value,
        result: summarizeRollCall(rc).result, ...(groupValue ? { groupValue } : {}), sourceUrl: rc.sourceUrl,
      });
    }
  }
  for (const s of speeches) {
    if (!s.memberId || s.position) continue;
    timelineOf(s.memberId, `speech ${s.id} ("${s.speakerText}")`).push({
      kind: "speech", date: s.date, speechId: s.id, meeting: s.meeting, excerpt: s.excerpt, chars: s.chars, sourceUrl: s.sourceUrl,
    });
  }
  const details = members.map((m): MemberDetail => ({ ...m, timeline: [...timelines.get(m.id)!].sort(byDateDesc) }));
  const index = members.map((m) => {
    const s = toSummary(m);
    const timeline = timelines.get(m.id)!;
    const count = (kind: TimelineEntry["kind"]) => timeline.filter((e) => e.kind === kind).length;
    return { ...s, counts: { ...s.counts, rollcalls: count("vote"), speeches: count("speech") } };
  });
  return { index, details, rollCalls: rollCalls.map(summarizeRollCall).sort(byDateDesc) };
}

type Sortable = { date: string; kind?: TimelineEntry["kind"]; id?: string; rollCallId?: string; speechId?: string };
const KIND_ORDER: Record<TimelineEntry["kind"], number> = { vote: 0, bill: 1, speech: 2 };
const sortKey = (x: Sortable) => x.rollCallId ?? x.speechId ?? x.id ?? "";
const byDateDesc = (a: Sortable, b: Sortable) =>
  cmp(b.date, a.date) || KIND_ORDER[a.kind ?? "vote"] - KIND_ORDER[b.kind ?? "vote"] || cmp(sortKey(b), sortKey(a));
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
