import type { House, Member, MemberId } from "@seiji-kiroku/shared";
import { indexByName, resolveMember, type NameIndex } from "./match-votes.ts";
import type { CommitteeRoster } from "./sources/kokkai-committee.ts";

/** 名寄せできなかった出席委員欄の氏名表記。会議録の出席委員欄に会派は無いので group は空。 */
export interface UnmatchedCommitteeMember {
  kind: "committee";
  nameText: string;
  group: string;
  meetingId: string;
}

/**
 * 名簿に名寄せ済みの「委員会に◯◯として出席」1 行（1 人 × 1 回次 × 1 委員会 × 1 役職。Issue #244）。
 *
 * **在任期間ではありません。** 会議録の出席委員欄に在任期間は書かれていないので（欠席した日は載らず、
 * 就任日・退任日も書かれていない）、ここに持つのは**出席した会議の事実**だけです:
 * `meetings`（出席した回数）・`firstDate` / `lastDate`（出席した最初の日 / 最新の日）。
 * 「firstDate から lastDate までずっとその役職だった」とは**言えません**（PO の判断、#244）。
 */
export interface MatchedCommitteeRole {
  memberId: MemberId;
  /** 出席委員欄の氏名の原文（空白と「君」を除いたもの）。 */
  nameText: string;
  session: number;
  house: House;
  /** 委員会等の名前の原文（会議名から号を落としたもの。例「内閣委員会」「憲法審査会」）。 */
  committee: string;
  /** 出席委員欄の役職の原文（「委員長」「理事」「委員」「幹事」「会長」「委員長代理理事」など）。 */
  role: string;
  /** その回次・その委員会・その役職で出席した会議の回数。 */
  meetings: number;
  /** 出席した最初の会議の日付（ISO）。**就任日ではありません。** */
  firstDate: string;
  /** 出席した最新の会議の日付（ISO）。**退任日ではありません。** */
  lastDate: string;
  /** firstDate の会議録情報の speechID。 */
  firstMeetingId: string;
  /** lastDate の会議録情報の speechID。 */
  lastMeetingId: string;
  /** firstDate の会議録（冒頭情報）の URL。一次資料。 */
  sourceUrl: string;
}

/**
 * 出席委員名簿（parseCommitteeRosterPage の出力）を衆参の名簿に名寄せする純粋関数（Issue #244）。
 * 正規化・同姓同名・在職の確認は matchVotes と同じ `resolveMember`。
 * - 名簿は**会議の院のもの**だけを使う（衆院の委員会に参院議員を紐づけない）。
 * - `resolveMember` には会議の `{ session, date }` を渡す（#230。渡さないと在職を確認できず候補ゼロになる）。
 * - 会議録に会派は書かれていないので、**同姓同名は絞れず unmatched** に載せる（推測で紐づけない）。
 *   これは `match-shugiin-bills.ts` / `match-attendance.ts` と同じ条件。
 * - 同じ回次・同じ委員会・同じ役職の複数回の出席は 1 行にまとめる（回数と最初 / 最新の出席日を持つ）。
 *   役職が変われば（委員 から 理事）別の行にする。役職の変化は事実なので丸めない。
 */
export function matchCommitteeRoles(
  rosters: readonly CommitteeRoster[],
  members: readonly Member[],
): { entries: MatchedCommitteeRole[]; unmatched: UnmatchedCommitteeMember[] } {
  const index: Partial<Record<House, NameIndex>> = {};
  const indexFor = (house: House): NameIndex => (index[house] ??= indexByName(members.filter((m) => m.house === house)));
  const byKey = new Map<string, MatchedCommitteeRole>();
  const unmatched: UnmatchedCommitteeMember[] = [];

  for (const roster of rosters) {
    const committee = committeeName(roster.meeting);
    for (const rm of roster.members) {
      const member = resolveMember(indexFor(roster.house), rm.nameText, undefined, { session: roster.session, date: roster.date });
      if (!member) {
        unmatched.push({ kind: "committee", nameText: rm.nameText, group: "", meetingId: roster.id });
        continue;
      }
      const key = `${member.id} ${roster.session} ${committee} ${rm.role}`;
      const prev = byKey.get(key);
      if (prev === undefined) {
        byKey.set(key, {
          memberId: member.id, nameText: rm.nameText, session: roster.session, house: roster.house,
          committee, role: rm.role, meetings: 1,
          firstDate: roster.date, lastDate: roster.date,
          firstMeetingId: roster.id, lastMeetingId: roster.id,
          sourceUrl: roster.sourceUrl,
        });
        continue;
      }
      prev.meetings += 1;
      // 会議録の取得順が日付順とは限らないので日付で比べる（同日なら speechID で安定させる）。
      if (isBefore(roster, prev.firstDate, prev.firstMeetingId)) {
        prev.firstDate = roster.date;
        prev.firstMeetingId = roster.id;
        prev.sourceUrl = roster.sourceUrl;
        prev.nameText = rm.nameText;
      }
      if (isAfter(roster, prev.lastDate, prev.lastMeetingId)) {
        prev.lastDate = roster.date;
        prev.lastMeetingId = roster.id;
      }
    }
  }

  // 並びは memberId → 回次 → 委員会名 → 役職。取得順（API のページ順）に依存させないため。
  //
  // **`localeCompare` を使わない。** 文字列の比較は必ずコードポイント順（`cmp`）で行う。
  // `localeCompare` は実行環境のロケール（ICU）で結果が変わり、日本語の委員会名では
  // 実際に順序が入れ替わる: `ja-JP` では読み順（憲法 < 内閣 < 予算）、`en-US` では
  // コードポイント順（予算 < 内閣 < 憲法）になる。手元と CI で並びが変わり、
  // 本番でも実行環境しだいで議員ページの表示順が変わる（2026-08-25 に CI で実際に検出）。
  const entries = [...byKey.values()].sort((a, b) =>
    cmp(a.memberId, b.memberId) || a.session - b.session || cmp(a.committee, b.committee) || cmp(a.role, b.role));
  return { entries, unmatched };
}

/**
 * 会議名から委員会等の名前を取り出す（「内閣委員会 第25号」から「内閣委員会」、
 * 「厚生労働委員会 閉会後第4号」から「厚生労働委員会」）。号が付かない会議名はそのまま。
 * `parseCommitteeRosterPage` が `nameOfMeeting` と `issue` を半角空白で繋いだものが入る。
 */
export function committeeName(meeting: string): string {
  const i = meeting.indexOf(" ");
  return (i < 0 ? meeting : meeting.slice(0, i)).trim();
}

/** 文字列の比較（コードポイント順）。ロケールに依存しないよう `localeCompare` は使わない（`aggregate.ts` と同じ流儀）。 */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isBefore = (r: CommitteeRoster, date: string, id: string): boolean => r.date < date || (r.date === date && r.id < id);
const isAfter = (r: CommitteeRoster, date: string, id: string): boolean => r.date > date || (r.date === date && r.id > id);
