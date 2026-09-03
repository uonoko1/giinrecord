/**
 * /coverage（#218）の集計。データ（`data/` の index.json 群）だけから件数と範囲を数える純関数。
 * 数値はここで数え、ページ側にも定数にも書かない（データが増えたら再ビルドで追随する）。
 * ブラウザでも動く（Node API は使わない）。
 */
import type { Assembly, BillSummary, DatasetMeta, House } from "@seiji-kiroku/shared";
import { isDietAssemblyId } from "./assemblies";
import { DIET_ASSEMBLIES, type AssemblySession } from "./data-contract";
import type { Dataset } from "./dataset";
import { memberAssemblyId } from "./member-search";

/**
 * 回次の範囲。`from`—`to` は最小と最大で、`count` は実際に行のあった回次の数（重複を除く）。
 * `to - from + 1 > count` なら歯抜け（その範囲のうち 0 件の回次がある）。連続収録と読ませないために両方持つ。
 */
export interface SessionRange {
  from: number;
  to: number;
  /** 実際に行のあった回次の数（重複を除く） */
  count: number;
}

export function sessionRange(sessions: readonly number[]): SessionRange | null {
  if (sessions.length === 0) return null;
  const unique = new Set(sessions);
  return { from: Math.min(...sessions), to: Math.max(...sessions), count: unique.size };
}

/** 範囲のうち行が 1 件も無い回次があるか（第200—221回のうち記名投票のある回次は 11、など） */
export function hasSessionGaps(range: SessionRange | null): boolean {
  return range !== null && range.to - range.from + 1 > range.count;
}

/** [200, 221] → "第200—221回"、1 つなら "第221回"。空なら null */
export function formatSessionRange(range: SessionRange | null): string | null {
  if (!range) return null;
  return range.from === range.to ? `第${range.from}回` : `第${range.from}—${range.to}回`;
}

/**
 * 回次ごとの参院名簿が公開されていない回次（#219 / #230）。
 * 参院サイトの回次別名簿は最古の 1 回次分より前が 404 で、その回次の票は名簿に突合できない
 * （＝議員ページに紐づかない）。どの回次かは `meta.sources` の「参議院 議員一覧（第N回）」から数える。
 * 回次の数値はハードコードしない（データが増えたら再ビルドで追随する）。
 */
export interface RosterlessSessions {
  /** 手元にある最古の名簿の回次 */
  earliestRoster: number;
  /** 名簿より前の回次（昇順）。`meta.sessions` のうち earliestRoster 未満のもの */
  sessions: number[];
  /** その範囲。1 件も無ければ null */
  range: SessionRange | null;
}

/** `meta.sources` の「参議院 議員一覧（第N回）」から最古の名簿回次を取り、それより前の回次を数える。出典が無ければ null（推定しない）。 */
export function rosterlessSessions(meta: DatasetMeta | undefined): RosterlessSessions | null {
  const rosters = (meta?.sources ?? [])
    .map((s) => /^参議院 議員一覧（第(\d+)回）$/.exec(s.name)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  if (rosters.length === 0) return null;
  const earliestRoster = Math.min(...rosters);
  const sessions = [...new Set(meta?.sessions ?? [])].filter((s) => s < earliestRoster).sort((a, b) => a - b);
  return { earliestRoster, sessions, range: sessionRange(sessions) };
}

/**
 * 衆院の質問主意書が「取得した回次」（#235）。回次は `meta.sources` の出典名から数える。
 * 議員ページに出るかどうかはここでは判断しない（取得と紐づきは別の事実で、紐づきは
 * `linkedRecordCounts` が members/index.json の counts から実数で数える）。
 */
export interface ShugiinQuestionCoverage {
  /** 質問答弁情報を取得した回次の範囲。1 件も無ければ null */
  fetched: SessionRange | null;
}

/** `meta.sources` の「衆議院 質問答弁情報（第N回）」から数える。出典が無ければ null（推定しない）。 */
export function shugiinQuestionCoverage(meta: DatasetMeta | undefined): ShugiinQuestionCoverage | null {
  const fetched = (meta?.sources ?? [])
    .map((s) => /^衆議院 質問答弁情報（第(\d+)回）$/.exec(s.name)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  if (fetched.length === 0) return null;
  return { fetched: sessionRange(fetched) };
}

/**
 * 発言の収録範囲（#242）。国会会議録検索システムの出典（`meta.sources`）から、
 * **どの会議を取っているか**（本会議だけか、委員会も含むか）を院ごとに読む。
 *
 * 推定しない: 出典 URL の `nameOfMeeting` パラメータを見て、
 * 付いていなければ「本会議と委員会」、`本会議` が付いていれば「本会議のみ」と読むだけ。
 * 出典が無ければ null（無い事実を作らない）。
 *
 * 「どの回次まで遡っているか」はここでは扱わない。名簿の覆う範囲で決まる別の事実で、
 * 上の `rosterScope` / `RosterlessSection` / `ShugiinRosterSection` が既に書いている。
 */
export interface SpeechCoverage {
  house: House;
  /** 委員会（分科会・審査会・連合審査会・公聴会・調査会を含む）も取っているか */
  committees: boolean;
  url: string;
}

/** `meta.sources` の「国会会議録検索システム 検索用API（{院} …）」から、院ごとに会議の範囲を読む。 */
export function speechCoverage(meta: DatasetMeta | undefined): SpeechCoverage[] {
  const out: SpeechCoverage[] = [];
  for (const s of meta?.sources ?? []) {
    const houseName = /^国会会議録検索システム 検索用API（(参議院|衆議院) [^）]*）$/.exec(s.name)?.[1];
    if (!houseName) continue;
    // 会議録の出典は「委員会の出席者欄」（#109）にもあるので、URL で発言 API のものだけを採る
    let url: URL;
    try { url = new URL(s.url); } catch { continue; }
    if (!url.pathname.endsWith("/api/speech")) continue;
    if (url.searchParams.get("speaker") === "会議録情報") continue; // #109 の出席者欄
    const house: House = houseName === "参議院" ? "sangiin" : "shugiin";
    if (out.some((x) => x.house === house)) continue;
    // nameOfMeeting が付いていなければ全会議（本会議＋委員会）。付いていればその会議だけ
    out.push({ house, committees: url.searchParams.get("nameOfMeeting") === null, url: s.url });
  }
  return out;
}

/**
 * その院の議員ページに実際に出ている記録の件数（#251）。`members/index.json` の counts の合計で、
 * 「議員ページに出る」ことそのものの実数。取得の有無や名簿の覆う回次からの推論ではないので、
 * ETL の突合条件が変わっても、データを数え直せばそのまま追随する。
 */
export interface LinkedRecordCounts {
  rollcalls: number;
  bills: number;
  speeches: number;
  questions: number;
}

/** 院ごとに members/index.json の counts を合計する。その院の議員が 0 人なら null（無い事実を作らない）。 */
export function linkedRecordCounts(members: readonly { house: House; counts: { rollcalls: number; bills: number; speeches: number; questions?: number } }[], house: House): LinkedRecordCounts | null {
  const rows = members.filter((m) => m.house === house);
  if (rows.length === 0) return null;
  const sum = (pick: (c: (typeof rows)[number]["counts"]) => number | undefined) => rows.reduce((t, m) => t + (pick(m.counts) ?? 0), 0);
  return { rollcalls: sum((c) => c.rollcalls), bills: sum((c) => c.bills), speeches: sum((c) => c.speeches), questions: sum((c) => c.questions) };
}

/**
 * 参院の票が議員に紐づいているかを回次ごとに数えた結果（#274）。数えるのは Node 側
 * （`data-files.ts` の `readSangiinVoteLinkStats`）で、ここは形と表示の判断だけ。
 */
export interface SangiinVoteLinkStats {
  /** 票の延べ数 */
  votes: number;
  /** そのうち議員に紐づいた数（`memberId` のある票） */
  linked: number;
  /** 回次ごとの、票の延べ数と紐づいた数 */
  sessions: { session: number; votes: number; linked: number }[];
}

/**
 * 最古の名簿より前の回次にある票のうち、議員ページに出ていない数（#274）。
 *
 * 名簿の無い回次でも票がすべて紐づかないわけではない。`tenureVerified` の規則(b)
 * （より前の回次の名簿に載っていて、任期満了日が採決の日以後）で紐づく票があるので、
 * 「名簿より前＝出ない」とは書かず、**紐づいた数と紐づかなかった数を分けて数える**。
 * `unlinkedRange` は紐づかない票が実際にある回次だけの範囲で、票が全部紐づいた回次は入れない。
 */
export interface SangiinUnlinkedVotes {
  /** 名簿より前の回次にある票の延べ数 */
  votes: number;
  /** そのうち議員に紐づいた数 */
  linked: number;
  /** そのうち議員に紐づいていない数（votes - linked） */
  unlinked: number;
  /** 名簿より前で票のある回次の範囲 */
  range: SessionRange;
  /** 紐づかない票が実際にある回次の範囲。1 回次も無ければ null */
  unlinkedRange: SessionRange | null;
}

/** 数えた結果と `rosterlessSessions` から、名簿より前の回次の票を数える。材料が欠ければ null（推定しない）。 */
export function sangiinUnlinkedVotes(stats: SangiinVoteLinkStats | null | undefined, rosterless: RosterlessSessions | null | undefined): SangiinUnlinkedVotes | null {
  if (!stats || !rosterless) return null;
  const before = stats.sessions.filter((s) => s.session < rosterless.earliestRoster);
  const range = sessionRange(before.map((s) => s.session));
  if (!range) return null;
  const votes = before.reduce((t, s) => t + s.votes, 0);
  const linked = before.reduce((t, s) => t + s.linked, 0);
  return {
    votes,
    linked,
    unlinked: votes - linked,
    range,
    unlinkedRange: sessionRange(before.filter((s) => s.votes > s.linked).map((s) => s.session)),
  };
}

/**
 * 両院の名簿が公開されている範囲の違い（#251）。衆院は「現在」の 1 時点だけ、参院は回次ごとだが最古の 1 回次より前は無い。
 * どちらも「名簿のある範囲の外は紐づかない」という同じ制約下にあり、違うのは名簿が覆う範囲だけなので、
 * 参院を「制約が無い」と書かないための材料としてこの 2 つを並べて持つ（すぐ上の節 RosterlessSection と矛盾させない）。
 */
export interface RosterScope {
  /** 衆院の名簿の時点（出典名の原文）と URL。出典が無ければ null */
  shugiin: { asOf: string; url: string } | null;
  /** 参院の回次ごとの名簿がある回次（昇順）。1 件も無ければ空 */
  sangiinSessions: number[];
  /** 参院の名簿がある回次の範囲。1 件も無ければ null */
  sangiin: SessionRange | null;
}

/** `meta.sources` の議員一覧の出典から、両院の名簿の範囲を取る。推定はしない。 */
export function rosterScope(meta: DatasetMeta | undefined): RosterScope {
  const sangiinSessions = [
    ...new Set(
      (meta?.sources ?? [])
        .map((s) => /^参議院 議員一覧（第(\d+)回）$/.exec(s.name)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number),
    ),
  ].sort((a, b) => a - b);
  return { shugiin: shugiinRosterAsOf(meta), sangiinSessions, sangiin: sessionRange(sangiinSessions) };
}

/**
 * 衆院の議員一覧の出典（`meta.sources` の「衆議院 議員一覧（{時点}現在）」）。参院が回次ごと（「第N回」）なのに対し、
 * 衆院は時点が 1 つしか無いことが、出典の名前にそのまま出ている。時点の表記は出典の原文のまま返す（推定しない）。
 */
export function shugiinRosterAsOf(meta: DatasetMeta | undefined): { asOf: string; url: string } | null {
  for (const s of meta?.sources ?? []) {
    const asOf = /^衆議院 議員一覧（(.+)現在）$/.exec(s.name)?.[1];
    if (asOf !== undefined) return { asOf, url: s.url };
  }
  return null;
}

/**
 * 衆院の名簿が「現在」の 1 枚しかないこと（#71 / #245）の、データ上のあらわれ（#251）。
 * `data/bills/{回次}/{id}.json` の提出者・賛成者の氏名（`submitterNames` / `supporterNames`）と、
 * 名寄せできた memberId（`submitters` / `supporters`）を数えた結果を、そのまま持つ。
 * 数えるのは Node 側（`data-files.ts` の `readShugiinBillNameStats`）で、ここは形と表示の判断だけ。
 */
export interface ShugiinBillNameStats {
  /** 衆院の議案に載る提出者・賛成者の氏名の延べ数 */
  names: number;
  /** そのうち名簿の議員に紐づいた数（`submitters` / `supporters` の memberId の延べ数） */
  linked: number;
  /** 回次ごとの、その回次の議案に載る異なり氏名の数と、そのうち現在の名簿にある数 */
  sessions: { session: number; names: number; inRoster: number }[];
  /** 現在の名簿の衆院議員の数 */
  rosterMembers: number;
  /** 名簿の中で正規化後の氏名が重複する人数（0 なら完全同名は名簿に無い） */
  rosterDuplicateNames: number;
}

/**
 * `data/unmatched.json`（議員に紐づけられなかった発言）を数えた結果（Issue 370）。
 *
 * 議案は「第N回では X 人のうち名簿にあるのは Y 人」と数を出しているのに、発言は
 * 「議員ページには出ません」と書くだけで**件数が無かった**。同じ性質の欠落なので同じ形で出す。
 *
 * 落ちている理由は**衆院の名簿が「現在」の1時点しかない**こと（Issue 251 / 316）で、
 * 氏名だけを手がかりに紐づけることはしない（同姓同名かつ同一会派の組が実在する。Issue 369）。
 */
export interface UnmatchedSpeechStats {
  /** 紐づけられなかった発言の件数 */
  speeches: number;
  /** その発言をした異なり人数（氏名の異なり） */
  speakers: number;
  /** 回次ごとの件数。多い順 */
  sessions: { session: number; speeches: number }[];
}

/**
 * 数えた結果を表示用にまとめる。1 件も無ければ null（無い事実を作らない）。
 * 割合は出さない（実数だけ）。
 */
export function unmatchedSpeechCoverage(stats: UnmatchedSpeechStats | null | undefined): UnmatchedSpeechStats | null {
  if (!stats || stats.speeches === 0) return null;
  return stats;
}

/** 衆院の議案の氏名のうち、名簿に紐づいていない延べ数。 */
export interface ShugiinBillNameCoverage extends ShugiinBillNameStats {
  /** names - linked */
  unlinked: number;
  /**
   * 「現在の名簿に居るのは何人か」を示す回次。異なり氏名がいちばん多い回次を選ぶ（同数なら新しい回次）。
   * 回次を定数で書かず、データがいちばん厚い回次をデータから選ぶ。
   */
  largest: { session: number; names: number; inRoster: number } | null;
}

/**
 * 数えた結果を表示用にまとめる。氏名が 1 件も無ければ null（無い事実を作らない）。
 * 割合はここでは出さない（`inRoster` と `names` の実数だけを渡し、画面も実数で書く）。
 */
export function shugiinBillNameCoverage(stats: ShugiinBillNameStats | null | undefined): ShugiinBillNameCoverage | null {
  if (!stats || stats.names === 0) return null;
  const largest = stats.sessions.reduce<ShugiinBillNameStats["sessions"][number] | null>(
    (best, s) => (best === null || s.names > best.names || (s.names === best.names && s.session > best.session) ? s : best),
    null,
  );
  return { ...stats, unlinked: stats.names - stats.linked, largest };
}

/** 国会の 1 院（参議院・衆議院）の収録範囲 */
export interface DietCoverage {
  assemblyId: string;
  house: House;
  name: string;
  /** 議員一覧（公式）。assemblies/index.json の sourceUrl */
  sourceUrl: string;
  /** members/index.json のその議会の行数 */
  members: number;
  /** 個人別の記名投票の件数（rollcalls/index.json。衆議院は 0 = 一次資料に個人票が無い） */
  rollcalls: number;
  /** 記名投票のある回次の範囲。1 件も無ければ null */
  rollcallSessions: SessionRange | null;
  /** 個人別の投票記録が一次資料にあるか（参議院のみ true） */
  individualVotes: boolean;
  /** その院の議案（bills/index.json）の件数。衆院の会派態度（推定）の裏づけになる資料 */
  bills: number;
  /** 議案のある回次の範囲。1 件も無ければ null */
  billSessions: SessionRange | null;
}

/** 地方議会 1 つの収録範囲（sessions.json から数える） */
export interface LocalCoverage {
  assemblyId: string;
  name: string;
  kind: Assembly["kind"];
  /** 議員名簿（公式） */
  sourceUrl: string;
  members: number;
  /** sessions.json の rollcalls の合計 */
  rollcalls: number;
  /** 会期数 */
  sessions: number;
  /** 会期の原文（新しい順の先頭＝最新、末尾＝最古）。会期が無ければ null */
  sessionRange: { newest: AssemblySession; oldest: AssemblySession } | null;
  /** 会期ごとの取得元（一次資料）。新しい順 */
  sources: AssemblySession[];
}

export interface Coverage {
  /** meta.sessions の範囲（ETL が対象にした回次）。meta が無ければ null */
  metaSessions: SessionRange | null;
  diet: DietCoverage[];
  local: LocalCoverage[];
  totals: {
    /** 国会の記名投票の件数（rollcalls/index.json の全行） */
    dietRollcalls: number;
    dietMembers: number;
    /** 議案（bills/index.json）の件数 */
    bills: number;
    localRollcalls: number;
    localMembers: number;
    assemblies: number;
  };
}

/** 参議院だけが個人別の投票記録を公表している（衆議院は起立採決で個人票が一次資料に無い）。#218 */
const HOUSE_OF: Record<string, House> = { "diet-sangiin": "sangiin", "diet-shugiin": "shugiin" };

/**
 * データセットから収録範囲を数える。
 * - 国会: 議員数は members/index.json の assemblyId 別の行数、採決は rollcalls/index.json（参議院の本会議記名投票）
 * - 地方: 議員数は同じく members/index.json、採決と会期は assemblies/{id}/sessions.json
 * どの数もデータの行を数えた結果で、推定や定数は使わない。
 */
/**
 * Issue 408: `bills` は `Dataset` に入っていない（60KB あり、使うのはこの画面だけ）。
 * **必須の引数**で受け取るので、渡し忘れは**コンパイルエラー**になる
 * （optional にすると `?? []` で静かに 0 件になる。レビュー指摘）。
 */
export function buildCoverage(data: Dataset, sessionsByAssembly: ReadonlyMap<string, AssemblySession[]>, bills: readonly BillSummary[]): Coverage {
  const assemblies: readonly Assembly[] = data.assemblies ?? DIET_ASSEMBLIES;
  const memberCount = new Map<string, number>();
  for (const m of data.members) {
    const id = memberAssemblyId(m);
    memberCount.set(id, (memberCount.get(id) ?? 0) + 1);
  }

  const rollcallSessions = sessionRange(data.rollcalls.map((r) => r.session));
  const diet: DietCoverage[] = assemblies
    .filter((a) => isDietAssemblyId(a.id))
    .map((a) => {
      // rollcalls/index.json は参議院の本会議投票結果（個人別）。衆議院の個人票は一次資料に無い
      const individualVotes = a.id === "diet-sangiin";
      const house = HOUSE_OF[a.id] ?? "sangiin";
      const houseBills = bills.filter((b) => b.house === house);
      return {
        assemblyId: a.id,
        house,
        name: a.name,
        sourceUrl: a.sourceUrl,
        members: memberCount.get(a.id) ?? 0,
        rollcalls: individualVotes ? data.rollcalls.length : 0,
        rollcallSessions: individualVotes ? rollcallSessions : null,
        individualVotes,
        bills: houseBills.length,
        billSessions: sessionRange(houseBills.map((b) => b.session)),
      };
    });

  const local: LocalCoverage[] = assemblies
    .filter((a) => !isDietAssemblyId(a.id))
    .map((a) => {
      // sessions.json は新しい順（DATA_CONTRACT の不変条件）。念のため date 降順で並べ直す
      const sessions = [...(sessionsByAssembly.get(a.id) ?? [])].sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
      const newest = sessions[0];
      const oldest = sessions.at(-1);
      return {
        assemblyId: a.id,
        name: a.name,
        kind: a.kind,
        sourceUrl: a.sourceUrl,
        members: memberCount.get(a.id) ?? 0,
        rollcalls: sessions.reduce((sum, s) => sum + s.rollcalls, 0),
        sessions: sessions.length,
        sessionRange: newest && oldest ? { newest, oldest } : null,
        sources: sessions,
      };
    });

  return {
    metaSessions: sessionRange(data.meta?.sessions ?? []),
    diet,
    local,
    totals: {
      dietRollcalls: diet.reduce((sum, d) => sum + d.rollcalls, 0),
      dietMembers: diet.reduce((sum, d) => sum + d.members, 0),
      bills: bills.length,
      localRollcalls: local.reduce((sum, l) => sum + l.rollcalls, 0),
      localMembers: local.reduce((sum, l) => sum + l.members, 0),
      assemblies: assemblies.length,
    },
  };
}

/** 会期の範囲の表示（原文のまま）。1 会期なら 1 つだけ、0 会期なら null */
export function formatLocalSessionRange(c: LocalCoverage): string | null {
  if (!c.sessionRange) return null;
  const { newest, oldest } = c.sessionRange;
  return newest.id === oldest.id ? newest.label : `${oldest.label} 〜 ${newest.label}`;
}
