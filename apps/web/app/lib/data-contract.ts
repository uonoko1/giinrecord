/**
 * Web-side view of docs/DATA_CONTRACT.md.
 * These mirror the types the contract says will be added to `packages/shared`;
 * once they land there (ETL PBI), replace this file with re-exports.
 */
import type { Assembly, AssemblyId, AssemblyKind, DatasetMeta, DietAssemblyId, House, LocalVote, Member, MemberId, RollCall, RollCallSummary, VoteValue } from "@seiji-kiroku/shared";

export type { Assembly, AssemblyId, AssemblyKind, DatasetMeta, DietAssemblyId, LocalVote, RollCall, RollCallSummary, VoteValue };

/** 国会の2議会の id（院 → 議会 id）。ETL の `assemblies.ts` と同じ値（shared は型だけなので定数は両側に持つ）。#156 */
export const DIET_ASSEMBLY_IDS: Readonly<Record<House, DietAssemblyId>> = { sangiin: "diet-sangiin", shugiin: "diet-shugiin" };

/**
 * `assemblies/index.json` が無い古いデータ用の国会の2議会。ETL の `dietAssemblies()` と同じ並び（参議院・衆議院）。
 * sourceUrl は名簿（議員一覧）の入口。
 */
export const DIET_ASSEMBLIES: readonly Assembly[] = [
  { id: "diet-sangiin", kind: "national", name: "参議院", sourceUrl: "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm" },
  { id: "diet-shugiin", kind: "national", name: "衆議院", sourceUrl: "https://www.shugiin.go.jp/internet/itdb_annai.nsf/html/statics/syu/1giin.htm" },
];

export interface MemberSummary {
  id: MemberId;
  name: string;
  kana: string;
  house: House;
  /** 所属議会（#156）。#156 より前のデータには無いので、無ければ house から `diet-{house}`（`memberAssemblyId`） */
  assemblyId?: AssemblyId;
  group: string;
  district: string;
  termEnd?: string;
  /** 最新回次の名簿に載っているか。無い（古いデータ）なら現職として扱う */
  current?: boolean;
  /** questions は #106 以降のデータにだけある（古いデータでは無い） */
  counts: { rollcalls: number; bills: number; speeches: number; questions?: number };
}

/**
 * `members/{id}.json`。**`timeline` に `speech` 行は入らない（#242）**。
 * 発言は `members/{id}/speeches.json`（`MemberSpeeches`）にあり、議員ページは発言タブを開いたときに実行時 fetch する。
 * 件数は `Member.counts.speeches` に残るので、取りに行く前でもタブの件数は出せる。
 */
export interface MemberDetail extends Member {
  timeline: TimelineEntry[];
}

/** `members/{id}/speeches.json`（#242）。その議員の発言だけを日付降順で持つ。無いファイル＝0 件。 */
export interface MemberSpeeches {
  id: string;
  speeches: SpeechEntry[];
}

export type VoteEntry = {
  kind: "vote";
  /** 国会の回次（#103）。回次ごとの折りたたみに使う。古いデータには無い */
  session?: number;
  date: string;
  rollCallId: string;
  title: string;
  value: VoteValue;
  result: string;
  groupValue?: VoteValue;
  sourceUrl: string;
};
export type BillRole = "提出者" | "賛成者";
export type BillEntry = {
  kind: "bill";
  /** 国会の回次（#103）。回次ごとの折りたたみに使う。古いデータには無い */
  session?: number;
  /** 参議院への提出日（議案ページ「提出日」）。 */
  date: string;
  billId: string;
  title: string;
  role: BillRole;
  /** 議案ページ「発議者」欄の原文（例「打越さく良君 外9名」）。外N名の氏名は公表されていない。 */
  submitterText?: string;
  /** 審議状況（議案ページの経過のうち最新のものを「段階名 議決の原文」で）。 */
  status?: string;
  sourceUrl: string;
};
export type SpeechEntry = {
  kind: "speech";
  /** 国会の回次（#103）。回次ごとの折りたたみに使う。古いデータには無い */
  session?: number;
  date: string;
  speechId: string;
  meeting: string;
  excerpt: string;
  chars: number;
  /** 会議録の speakerPosition 原文（例: "議長", "国土交通大臣"）。役職として行った発言。無ければ省略 */
  position?: string;
  sourceUrl: string;
};
/**
 * 【推定】所属会派の態度（衆院のみ）。衆議院は個人の投票記録を公開していないため、議案ページの「賛成会派／反対会派」に
 * その議員の所属会派が載っていることだけを記録する。本人の賛否ではない。`estimated: true` を常に持ち、VoteEntry（事実）とは型で分ける。
 */
export type StanceEntry = {
  kind: "stance";
  /** 国会の回次（#103）。回次ごとの折りたたみに使う。古いデータには無い */
  session?: number;
  estimated: true;
  /** 衆議院の議案受理年月日。 */
  date: string;
  billId: string;
  title: string;
  /** 所属会派（正式名称）。 */
  group: string;
  /** 会派が賛成会派／反対会派のどちらに載っていたか。 */
  stance: "賛成" | "反対";
  /** 「衆議院審議時会派態度」の原文（多数・少数・全会一致）。 */
  stanceText: string;
  status?: string;
  sourceUrl: string;
};
/** 質問主意書の提出（事実。衆参の質問答弁情報から、#106）。date は提出日。 */
export type QuestionEntry = {
  kind: "question";
  /** 国会の回次（#103）。回次ごとの折りたたみに使う。古いデータには無い */
  session?: number;
  date: string;
  questionId: string;
  title: string;
  /** 提出者欄の原文（例「緒方 林太郎君」）。 */
  submitterText?: string;
  /** 衆院「経過状況」の原文（例「答弁受理」）。参院には無い。 */
  status?: string;
  /** 答弁書受領日（ISO）。無ければ省略。 */
  answerDate?: string;
  /** 答弁本文（HTML）の URL。無ければ省略。 */
  answerUrl?: string;
  /** 衆院 経過ページ／参院 詳細ページ。 */
  sourceUrl: string;
};
/**
 * 委員会に発議者として出席した事実（会議録の委員会冒頭「出席者」欄の「発議者」、#109）。
 * 載るのはその日に出席した発議者であり、参法の発議者全員ではない。提出法案（BillEntry）とは別の kind で、`estimated: false`。
 * 「委員会に発議者として出席」と明示し、提出者とは別の表現にする。
 */
export type AttendanceEntry = {
  kind: "attendance";
  /** 国会の回次（#103）。回次ごとの折りたたみに使う。古いデータには無い */
  session?: number;
  estimated: false;
  date: string;
  /** 会議録情報の speechID。 */
  meetingId: string;
  /** 会議名＋号（例「農林水産委員会 第14号」）。 */
  meeting: string;
  role: "発議者";
  /** その日の案件にあった参法（複数ならどの参法の発議者として出席したかは会議録からは分からない）。 */
  bills: { billId: string; title: string }[];
  /** 会議録の冒頭情報の URL。 */
  sourceUrl: string;
};
/**
 * 地方議会の表決の行（事実、#158。docs/DATA_CONTRACT.md「地方議会の Web 表示が読む形」）。国会の VoteEntry とは kind で分ける。
 * `vote` は凡例付きの原文（LocalVote）。`sessionLabel`・`method`・`result` は議会の公表の原文。sourceUrl は表決結果の PDF／HTML。
 */
export type LocalVoteEntry = {
  kind: "localVote";
  date: string;
  rollCallId: string;
  title: string;
  vote: LocalVote;
  /** 会期の原文（例「第399回（令和8年2月定例会）」） */
  sessionLabel: string;
  /** 表決方法の原文（例「起立」「簡易」）。無ければ省略 */
  method?: string;
  /** 議決結果の原文（例「可決」）。無ければ省略 */
  result?: string;
  /**
   * 賛否の対象の原文（表の節見出し。鳥取「議案に対する賛否」「委員長報告に対する賛否」。#204）。
   * members/{id}.json には無く、ビルド時に `assemblies/{assemblyId}/rollcalls/index.json` から rollCallId で結合する（joinVoteSubjects）。
   * 請願・陳情の ○ が「委員長報告（例：不採択）への賛成」である議会で、○ を採択への賛成と読ませないために表示する
   */
  voteSubject?: string;
  /** 委員長報告の原文（請願・陳情の行。鳥取「不採択」「研究留保」…）。voteSubject と同じくビルド時に結合。無ければ省略 */
  committeeReport?: string;
  sourceUrl: string;
};
/**
 * 委員会等に委員長・理事・委員などとして出席した事実（会議録の冒頭「出席委員」「出席者」欄、#244）。
 *
 * **在任期間ではない。** 会議録に書かれているのは「その日、この役職で出席した」だけで、就任日・退任日は無く、
 * 欠席した日は載らない。したがって firstDate から lastDate の間ずっとその役職だったとは言えない。
 * 画面は「出席 N 回」「最初の出席 …」「最新の出席 …」のように**出席の事実**として出し、
 * 範囲を意味する表記（「〜」「期間」「在任」）は使わない（PO の判断、#244）。
 */
export type CommitteeRoleEntry = {
  kind: "committeeRole";
  /** 国会の回次（#103）。回次ごとの折りたたみに使う。 */
  session: number;
  estimated: false;
  /** timeline の並びに使う日付＝出席した最初の会議の日（firstDate と同じ値）。就任日ではない。 */
  date: string;
  /** 委員会等の名前の原文（例「内閣委員会」「憲法審査会」）。 */
  committee: string;
  /** 出席委員欄の役職の原文（例「委員長」「理事」「委員」「幹事」「会長」）。丸めない。 */
  role: string;
  /** その回次・その委員会・その役職で出席した会議の回数。 */
  meetings: number;
  /** 出席した最初の会議の日付。**就任日ではない。** */
  firstDate: string;
  /** 出席した最新の会議の日付。**退任日ではない。** */
  lastDate: string;
  /** firstDate の会議録情報の speechID。 */
  meetingId: string;
  /** firstDate の会議録の冒頭情報の URL。 */
  sourceUrl: string;
};
export type TimelineEntry = VoteEntry | BillEntry | SpeechEntry | StanceEntry | QuestionEntry | AttendanceEntry | CommitteeRoleEntry | LocalVoteEntry;

/** `assemblies/{assemblyId}/rollcalls/index.json`（LocalRollCallSummary[]）の1行のうち Web が読む項目（#204） */
export interface LocalRollCallSubject {
  id: string;
  /** 賛否の対象の原文。無ければ省略 */
  voteSubject?: string;
  /** 委員長報告の原文。無ければ省略 */
  committeeReport?: string;
}

/** `assemblies/{assemblyId}/sessions.json` の1行（地方議会の会期。新しい順）。#158 */
export interface AssemblySession {
  id: string;
  /** 会期の原文（例「第399回（令和8年2月定例会）」） */
  label: string;
  /** その会期の最終議決日（ISO） */
  date: string;
  rollcalls: number;
  sourceUrl: string;
  fetchedAt: string;
}
