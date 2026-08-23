import type { Bill, Member, MemberDetail, MemberSummary, MemberTerm, RollCall, RollCallSummary, Speech, TimelineEntry, VoteValue } from "@seiji-kiroku/shared";
import { toSummary } from "./sources/sangiin-members.ts";
import { groupAt } from "./group-history.ts";
import type { MatchedBill } from "./match-bills.ts";

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
 * 回次 targets の採決・発言を突合するのに取得する名簿の回次。
 * 名簿ページ giin/{N}/giin.htm は第N回終了後のある時点（概ね次の回次の直前）の名簿で、
 * 第N回の会期中に退任した議員（通常選挙・辞職）を含まない（第217回の名簿は令和7年7月31日現在）。
 * 第N回中の議員は「N-1 の名簿 ∪ N の名簿」で覆えるので、最小回次の1つ前も取る。
 */
export function rosterSessionsFor(targets: readonly number[]): number[] {
  const sorted = [...new Set(targets)].sort((a, b) => a - b);
  return sorted.length ? [sorted[0] - 1, ...sorted] : [];
}

/** 1回次分の名簿（parseMemberList の出力）。 */
export interface Roster { session: number; members: readonly Member[] }

/**
 * 回次ごとの名簿をプロフィールID（Member.id）で1人に統合する。
 * - 氏名・かな・本名・sourceUrl は最新回次の表記（改姓・通称変更は最新に従う。古い表記で突合できるよう名簿の原文は各回次のフィクスチャに残る）。
 * - terms は回次ごとの (会派, 選挙区, 任期満了) を時系列に並べ、隣接する回次で同じなら1つに畳む（sessionFrom〜sessionTo）。新しい順。
 * - current は最新回次の名簿に載っているか。辞職・任期満了・補選で入れ替わった人も Member として残す（票の事実は消えない）。
 * 名簿が0件のときは例外（cli.ts が空の index.json を書かないように）。
 */
export function mergeRosters(rosters: readonly Roster[]): Member[] {
  if (rosters.length === 0) throw new Error("no rosters to merge");
  const ordered = [...rosters].sort((a, b) => a.session - b.session);
  const latest = ordered[ordered.length - 1].session;
  const byId = new Map<string, { member: Member; terms: MemberTerm[] }>();
  let previous: number | undefined;
  for (const { session, members } of ordered) {
    for (const m of members) {
      const entry = byId.get(m.id) ?? { member: m, terms: [] };
      entry.member = m;
      for (const t of m.terms) {
        const last = entry.terms[entry.terms.length - 1];
        // 直前に処理した名簿にも同じ条件で載っていれば同じ term の続き（間の回次を取得していなくても、手元の名簿で連続なら畳む）
        if (last && sameTerm(last, t) && last.sessionTo === previous) last.sessionTo = session;
        else entry.terms.push({ ...t, sessionFrom: session, sessionTo: session });
      }
      byId.set(m.id, entry);
    }
    previous = session;
  }
  return [...byId.values()].map(({ member, terms }) => ({
    ...member,
    terms: [...terms].reverse(),
    current: terms[terms.length - 1].sessionTo === latest,
  }));
}

const sameTerm = (a: MemberTerm, b: MemberTerm) => a.house === b.house && a.group === b.group && a.district === b.district && a.from === b.from && a.to === b.to;

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
 * 名簿と突合済みの採決・発言から、議員ごとの timeline と一覧を組み立てる。
 * - memberId が空（未突合）の票・memberId の無い発言は unmatched.json 側で扱うので timeline には入れない。
 * - 名簿にない memberId は名寄せの不整合なので例外にする（黙って捨てない）。
 * - 並びは日付降順。同日は kind（vote → bill → speech）、次に採決 id / 発言 id の降順で安定させる（差分最小化）。
 * - 議長・大臣など position 付きの発言（議事進行・政府答弁）も事実として timeline に入れ、position を原文のまま載せる。
 *   counts.speeches は役職付きも含めた数（内訳は持たない）。区別は web が position を表示して行う。
 * - 提出法案（matchBills の出力）は提出日の bill 行になり、sourceUrl は議案ページ。counts.bills はその数。
 * - 衆院 議案（shugiinBills、#73）: 名寄せ済みの submitters / supporters は 提出者 / 賛成者 の bill 行（事実）。
 *   shugiinGroupStance の賛成会派／反対会派に、その議員の提出回次の会派（groupAt）が載っていれば stance 行（推定、estimated: true）。
 *   行に記録するのは会派名であって本人の賛否ではない。会派がどちらにも無い・態度が無い・衆院の受理日が無い議案は行にしない（推論しない）。
 *   日付は衆議院の議案受理年月日。counts.bills に stance は数えない。
 */
export function buildDataset(
  members: readonly Member[],
  rollCalls: readonly RollCall[],
  /** 採決 id → 議案情報の審議結果（原文）。無い採決は得票のみの result になる。 */
  decisions: ReadonlyMap<string, string> = new Map(),
  speeches: readonly Speech[] = [],
  /** 名簿に名寄せ済みの議員立法の関与（参法の発議者）。 */
  bills: readonly MatchedBill[] = [],
  /** 衆院 議案情報（matchShugiinBills の出力。submitters / supporters は衆院名簿の memberId）。 */
  shugiinBills: readonly Bill[] = [],
): Aggregated {
  const summarize = (rc: RollCall) => summarizeRollCall(rc, decisions.get(rc.id));
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
        result: summarize(rc).result, ...(groupValue ? { groupValue } : {}), sourceUrl: rc.sourceUrl,
      });
    }
  }
  const houseOf = new Map(members.map((m) => [m.id, m.house]));
  for (const s of speeches) {
    if (!s.memberId) continue;
    const timeline = timelineOf(s.memberId, `speech ${s.id} ("${s.speakerText}")`);
    // 発言の院と議員の院は一致していなければならない（衆院本会議の発言を同名の参院議員に付けない。Issue #107）。
    if (houseOf.get(s.memberId) !== s.house) throw new Error(`speech ${s.id} ("${s.speakerText}", ${s.house}) refers to member ${s.memberId} of house ${String(houseOf.get(s.memberId))}`);
    timeline.push({
      kind: "speech", date: s.date, speechId: s.id, meeting: s.meeting, excerpt: s.excerpt, chars: s.chars,
      ...(s.position ? { position: s.position } : {}), sourceUrl: s.sourceUrl,
    });
  }
  for (const b of bills) {
    timelineOf(b.memberId, `bill ${b.billId}`).push({
      kind: "bill", date: b.date, billId: b.billId, title: b.title, role: b.role,
      ...(b.submitterText ? { submitterText: b.submitterText } : {}), ...(b.status ? { status: b.status } : {}), sourceUrl: b.sourceUrl,
    });
  }
  for (const b of shugiinBills) {
    const date = b.received?.shugiin;
    if (!date) continue;
    const base = { date, billId: b.id, title: b.title, ...(b.status ? { status: b.status } : {}), sourceUrl: b.sourceUrl };
    const roles = [["提出者", b.submitters], ["賛成者", b.supporters]] as const;
    for (const [role, ids] of roles) {
      for (const memberId of ids ?? []) {
        timelineOf(memberId, `shugiin bill ${b.id} ${role}`).push({
          kind: "bill", ...base, role, ...(b.submitterText ? { submitterText: b.submitterText } : {}),
        });
      }
    }
    const stance = b.shugiinGroupStance;
    if (!stance) continue;
    for (const m of members) {
      if (m.house !== "shugiin") continue;
      const group = groupAt(m, b.session)?.group;
      if (!group) continue;
      const side = stance.yes.includes(group) ? "賛成" : stance.no.includes(group) ? "反対" : undefined;
      if (!side) continue;
      timelines.get(m.id)!.push({ kind: "stance", estimated: true, ...base, group, stance: side, stanceText: stance.stanceText });
    }
  }
  const details = members.map((m): MemberDetail => ({ ...m, timeline: [...timelines.get(m.id)!].sort(byDateDesc) }));
  const index = members.map((m) => {
    const s = toSummary(m);
    const timeline = timelines.get(m.id)!;
    const count = (kind: TimelineEntry["kind"]) => timeline.filter((e) => e.kind === kind).length;
    return { ...s, counts: { rollcalls: count("vote"), bills: count("bill"), speeches: count("speech") } };
  });
  return { index, details, rollCalls: rollCalls.map(summarize).sort(byDateDesc) };
}

type Sortable = { date: string; kind?: TimelineEntry["kind"]; id?: string; rollCallId?: string; speechId?: string; billId?: string };
const KIND_ORDER: Record<TimelineEntry["kind"], number> = { vote: 0, bill: 1, stance: 2, speech: 3 };
const sortKey = (x: Sortable) => x.rollCallId ?? x.speechId ?? x.billId ?? x.id ?? "";
const byDateDesc = (a: Sortable, b: Sortable) =>
  cmp(b.date, a.date) || KIND_ORDER[a.kind ?? "vote"] - KIND_ORDER[b.kind ?? "vote"] || cmp(sortKey(b), sortKey(a));
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
