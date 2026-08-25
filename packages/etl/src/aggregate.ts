import type { Bill, Member, MemberDetail, MemberSpeeches, MemberSummary, MemberTerm, Question, RollCall, RollCallSummary, Speech, SpeechEntry, TimelineEntry, VoteValue } from "@seiji-kiroku/shared";
import { toSummary } from "./sources/sangiin-members.ts";
import { groupAt } from "./group-history.ts";
import { assemblyIdOf } from "./assemblies.ts";
import type { MatchedBill } from "./match-bills.ts";
import type { MatchedAttendance } from "./match-attendance.ts";

/** 集約結果（純粋関数の出力）。ファイルへの書き出しは dataset.ts が担う。 */
export interface Aggregated {
  /** `members/index.json`。counts を埋めたもの。 */
  index: MemberSummary[];
  /** `members/{id}.json`。名簿の全員分（票のない議員も timeline 空で含む）。timeline に speech 行は入らない（#242）。 */
  details: MemberDetail[];
  /**
   * `members/{id}/speeches.json`（#242）。発言のある議員だけ（0 件の議員は行を作らない）。
   * timeline から分けたのはプリレンダーをやめるため（#263 の実測: HTML は元 JSON の 2.15 倍で、
   * timeline に置いたままではファイルを分けても転送量が変わらない）。
   */
  speeches: MemberSpeeches[];
  /** `rollcalls/index.json`。日付降順。 */
  rollCalls: RollCallSummary[];
}

/**
 * 回次 targets の採決・発言を突合するのに取得する名簿の回次。
 * 名簿ページ giin/{N}/giin.htm は第N回終了後のある時点（概ね次の回次の直前）の名簿で、
 * 第N回の会期中に退任した議員（通常選挙・辞職）を含まない（第217回の名簿は令和7年7月31日現在）。
 * 第N回中の議員は「N-1 の名簿 ∪ N の名簿」で覆えるので、各回次の1つ前も取る。
 * 回次は飛び得る（日次の直近 5 回次＋手動で足した第200〜201回など）ので、最小回次だけでなく
 * 連続するブロックごとに「ブロック先頭の1つ前」を足す（第217回の再突合には第216回の名簿が要る。#103 レビュー）。
 */
export function rosterSessionsFor(targets: readonly number[]): number[] {
  const set = new Set(targets);
  const out = new Set<number>();
  for (const s of set) {
    if (!set.has(s - 1)) out.add(s - 1);
    out.add(s);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * 対象外の回次から引き継ぐ timeline の1行（#103）。cli.ts が前回出力の members/{id}.json から、今回取得しない回次（carried）の
 * speech / question / attendance / 参法の bill 行を読み、そのまま timeline に戻す。vote 行は rollcalls/ の再突合、衆院の bill / stance 行は bills/ から作り直すので引き継がない。
 */
export interface CarriedEntry { memberId: string; entry: TimelineEntry }

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
 * 名簿と突合済みの採決・発言から、議員ごとの timeline（`members/{id}.json`）・発言（`members/{id}/speeches.json`）・一覧を組み立てる。
 * - memberId が空（未突合）の票・memberId の無い発言は unmatched.json 側で扱うのでどこにも入れない。
 * - 名簿にない memberId は名寄せの不整合なので例外にする（黙って捨てない）。
 * - 並びは日付降順。同日は kind（vote → bill → stance → question → attendance → speech）、次に採決 id / 発言 id の降順で安定させる（差分最小化）。
 * - 発言（#242）は timeline ではなく speeches（`members/{id}/speeches.json`）に入る。並びは timeline と同じ日付降順。
 *   会議名は会議録の原文（「本会議 第19号」「予算委員会第一分科会 第2号」）なので、本会議と委員会は表示で区別できる。
 *   議長・大臣・委員長など position 付きの発言（議事進行・政府答弁・委員長報告）も事実として入れ、position を原文のまま載せる。
 *   counts.speeches は役職付きも含めた数（内訳は持たない）。区別は web が position と会議名を表示して行う。
 * - 提出法案（matchBills の出力）は提出日の bill 行になり、sourceUrl は議案ページ。counts.bills はその数。
 * - 衆院 議案（shugiinBills、#73）: 名寄せ済みの submitters / supporters は 提出者 / 賛成者 の bill 行（事実）。
 *   shugiinGroupStance の賛成会派／反対会派に、その議員の提出回次の会派（groupAt）が載っていれば stance 行（推定、estimated: true）。
 *   行に記録するのは会派名であって本人の賛否ではない。会派がどちらにも無い・態度が無い・衆院の受理日が無い議案は行にしない（推論しない）。
 *   日付は衆議院の議案受理年月日。counts.bills に stance は数えない。
 * - 質問主意書（matchQuestions の出力、#106）: 名寄せ済みの submitters の question 行（事実）。日付は提出日、sourceUrl は衆院 経過ページ／参院 詳細ページ。
 *   counts.questions はその数。未突合（submitters 無し）の質問は unmatched.json 側で扱うので timeline には入れない。
 * - 委員会出席（matchAttendance の出力、#109）: 会議録の出席者欄の「発議者」を attendance 行（事実、estimated: false）にする。
 *   出席した発議者は発議者全員ではないので bill 行（提出者）にはせず、counts にも数えない。参院の委員会の発議者は参議院議員なので衆院議員に付けば例外。
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
  /** 質問主意書（matchQuestions の出力。submitters は名簿の memberId）。 */
  questions: readonly Question[] = [],
  /** 委員会に発議者として出席した記録（matchAttendance の出力。memberId は参院名簿）。 */
  attendance: readonly MatchedAttendance[] = [],
  /** 対象外の回次から引き継ぐ行（#103）。memberId は名簿に無ければ例外。 */
  carried: readonly CarriedEntry[] = [],
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
        kind: "vote", session: rc.session, date: rc.date, rollCallId: rc.id, title: rc.title, value: v.value,
        result: summarize(rc).result, ...(groupValue ? { groupValue } : {}), sourceUrl: rc.sourceUrl,
      });
    }
  }
  const houseOf = new Map(members.map((m) => [m.id, m.house]));
  // 発言は timeline とは別の入れ物に集める（#242）。timelineOf は「名簿に無い memberId は例外」の検査に使う。
  const speechesOf = new Map<string, SpeechEntry[]>();
  for (const s of speeches) {
    if (!s.memberId) continue;
    timelineOf(s.memberId, `speech ${s.id} ("${s.speakerText}")`);
    // 発言の院と議員の院は一致していなければならない（衆院の発言を同名の参院議員に付けない。Issue #107）。
    if (houseOf.get(s.memberId) !== s.house) throw new Error(`speech ${s.id} ("${s.speakerText}", ${s.house}) refers to member ${s.memberId} of house ${String(houseOf.get(s.memberId))}`);
    const list = speechesOf.get(s.memberId) ?? [];
    list.push({
      kind: "speech", session: s.session, date: s.date, speechId: s.id, meeting: s.meeting, excerpt: s.excerpt, chars: s.chars,
      ...(s.position ? { position: s.position } : {}), sourceUrl: s.sourceUrl,
    });
    speechesOf.set(s.memberId, list);
  }
  for (const b of bills) {
    timelineOf(b.memberId, `bill ${b.billId}`).push({
      kind: "bill", session: sessionOfBillId(b.billId), date: b.date, billId: b.billId, title: b.title, role: b.role,
      ...(b.submitterText ? { submitterText: b.submitterText } : {}), ...(b.status ? { status: b.status } : {}), sourceUrl: b.sourceUrl,
    });
  }
  for (const b of shugiinBills) {
    const date = b.received?.shugiin;
    if (!date) continue;
    const base = { session: b.session, date, billId: b.id, title: b.title, ...(b.status ? { status: b.status } : {}), sourceUrl: b.sourceUrl };
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
  for (const q of questions) {
    for (const memberId of q.submitters ?? []) {
      timelineOf(memberId, `question ${q.id}`).push({
        kind: "question", session: q.session, date: q.date, questionId: q.id, title: q.title,
        ...(q.submitterText ? { submitterText: q.submitterText } : {}), ...(q.status ? { status: q.status } : {}),
        ...(q.answerDate ? { answerDate: q.answerDate } : {}), ...(q.answerUrl ? { answerUrl: q.answerUrl } : {}), sourceUrl: q.sourceUrl,
      });
    }
  }
  for (const a of attendance) {
    const timeline = timelineOf(a.memberId, `attendance ${a.meetingId} ("${a.nameText}")`);
    if (houseOf.get(a.memberId) !== "sangiin") throw new Error(`attendance ${a.meetingId} ("${a.nameText}") refers to member ${a.memberId} of house ${String(houseOf.get(a.memberId))} (参院の委員会の発議者は参議院議員)`);
    timeline.push({ kind: "attendance", estimated: false, session: a.session, date: a.date, meetingId: a.meetingId, meeting: a.meeting, role: a.role, bills: a.bills.map((b) => ({ ...b })), sourceUrl: a.sourceUrl });
  }
  // 対象外の回次から引き継ぐ行（#103）。そのまま入れる（再解釈しない）。名簿に無い memberId は他の行と同じく例外。
  // speech の引き継ぎ行は timeline ではなく speeches に入れる（#242。行き先が変わっても引き継ぎ自体は止めない）。
  for (const c of carried) {
    const timeline = timelineOf(c.memberId, `carried ${c.entry.kind} (session ${c.entry.session})`);
    if (c.entry.kind === "speech") speechesOf.set(c.memberId, [...(speechesOf.get(c.memberId) ?? []), c.entry]);
    else timeline.push(c.entry);
  }
  // assemblyId（#156）は国会の名簿パーサが付けないので集約で補う（toSummary も同じ assemblyIdOf）。index と detail で同じ値（validateDataset が一致を検査する）。
  const details = members.map((m): MemberDetail => ({ ...m, assemblyId: assemblyIdOf(m), timeline: [...timelines.get(m.id)!].sort(byDateDesc) }));
  // 発言のある議員だけ（#242）。並びは timeline と同じ（日付降順 → speechId の降順）。members の順で決定的にする。
  const speechFiles = members
    .filter((m) => (speechesOf.get(m.id)?.length ?? 0) > 0)
    .map((m): MemberSpeeches => ({ id: m.id, speeches: [...speechesOf.get(m.id)!].sort(byDateDesc) }));
  const index = members.map((m) => {
    const s = toSummary(m);
    const timeline = timelines.get(m.id)!;
    const count = (kind: TimelineEntry["kind"]) => timeline.filter((e) => e.kind === kind).length;
    // counts.speeches は speeches.json の行数（timeline には speech 行が無い。#242）。
    // /coverage の linkedRecordCounts がこの値を数えている（#251）ので、speeches.json と一致していなければならない
    // （validateDataset の不変条件）。
    return { ...s, counts: { rollcalls: count("vote"), bills: count("bill"), speeches: speechesOf.get(m.id)?.length ?? 0, questions: count("question") } };
  });
  return { index, details, speeches: speechFiles, rollCalls: rollCalls.map(summarize).sort(byDateDesc) };
}

/** 参法の billId `{回次}-{種別}-{番号}`（docs/DATA_CONTRACT.md）の回次。形が違えば例外（推定しない）。 */
function sessionOfBillId(billId: string): number {
  const m = billId.match(/^(\d+)-/);
  if (!m) throw new Error(`billId without session prefix: ${billId}`);
  return +m[1];
}

type Sortable = { date: string; kind?: TimelineEntry["kind"]; id?: string; rollCallId?: string; speechId?: string; billId?: string; questionId?: string; meetingId?: string };
const KIND_ORDER: Record<TimelineEntry["kind"], number> = { vote: 0, bill: 1, stance: 2, question: 3, attendance: 4, speech: 5 };
const sortKey = (x: Sortable) => x.rollCallId ?? x.speechId ?? x.billId ?? x.questionId ?? x.meetingId ?? x.id ?? "";
const byDateDesc = (a: Sortable, b: Sortable) =>
  cmp(b.date, a.date) || KIND_ORDER[a.kind ?? "vote"] - KIND_ORDER[b.kind ?? "vote"] || cmp(sortKey(b), sortKey(a));
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
