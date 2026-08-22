/**
 * Shared data model for 政治記録.
 * Every record carries `sourceUrl` — the primary source it was transcribed from.
 * The site renders facts only; nothing here encodes an evaluation.
 */

export type House = "sangiin" | "shugiin";

/** Stable internal id. Never derived from name (names change). */
export type MemberId = string; // e.g. "m_000123"

export interface Member {
  id: MemberId;
  name: string;        // 公式表記（例: "藤川 政人"）。通称使用者は通称（投票ページの表記と一致）
  legalName?: string;  // 通称使用者の本名（名簿の "[本名]" 行）。通称と同じなら省略
  kana: string;        // ふりがな
  house: House;
  /** Membership periods; a member can move between groups/houses. */
  terms: MemberTerm[];
  /** 最新回次の名簿に載っているか（辞職・任期満了で名簿から消えた人は false）。回次をまたいで統合したときに付く。 */
  current?: boolean;
  sourceUrl: string;   // 衆参の議員一覧・プロフィール
}

/** Lightweight row for `data/members/index.json` (search / list). See docs/DATA_CONTRACT.md. */
export interface MemberSummary {
  id: MemberId;
  name: string;
  kana: string;
  house: House;
  group: string;       // 名簿上の会派表記（参院は略称）
  district: string;
  termEnd?: string;    // ISO date
  /** 最新回次の名簿に載っているか。false は元職（辞職・任期満了）。事実であって評価ではない。 */
  current: boolean;
  counts: { rollcalls: number; bills: number; speeches: number };
}

export interface MemberTerm {
  house: House;
  group: string;       // 会派（例: "自由民主党・無所属の会"）
  district: string;    // 選挙区（例: "愛知", "比例"）
  from: string;        // ISO date
  to?: string;         // ISO date, undefined = current
  sessionFrom: number; // 国会回次
  sessionTo?: number;
}

export type BillKind = "閣法" | "衆法" | "参法" | "予算" | "条約" | "承認" | "決議" | "その他";

export interface Bill {
  id: string;          // e.g. "221-衆法-1"
  session: number;
  kind: BillKind;
  number?: number;
  title: string;
  submitters?: MemberId[];   // 議員立法の提出者（事実）
  supporters?: MemberId[];   // 議員立法の賛成者（事実）
  submitterText?: string;    // 名寄せ前の原文（例: "落合 貴之君外四名"）
  result?: { sangiin?: string; shugiin?: string; promulgated?: string; lawNumber?: string };
  sourceUrl: string;
}

export type VoteValue = "賛成" | "反対" | "投票なし";

/** One roll-call vote in the House of Councillors plenary. */
export interface RollCall {
  id: string;          // e.g. "221-0724-v001"
  session: number;
  date: string;        // ISO date
  title: string;       // 案件名（原文）
  billId?: string;
  totals: { total: number; yes: number; no: number };
  /** Per-group tallies as published (事実). */
  groups: { group: string; size: number; yes: number; no: number }[];
  /** Per-member votes (事実). */
  votes: { memberId: MemberId; nameText: string; group: string; value: VoteValue }[];
  sourceUrl: string;
}

export interface Speech {
  id: string;          // NDL speechID
  memberId?: MemberId;
  speakerText: string;
  group?: string;
  position?: string;
  house: House;
  meeting: string;     // 会議名
  date: string;
  excerpt: string;     // 冒頭の抜粋（要約はしない）
  chars: number;
  sourceUrl: string;   // 会議録の該当発言URL
}

export interface DatasetMeta {
  fetchedAt: string;   // ISO datetime
  sources: { name: string; url: string; fetchedAt: string }[];
  sessions: number[];
}

/** `data/members/{id}.json`: the member plus every record of theirs, newest first (docs/DATA_CONTRACT.md). */
export interface MemberDetail extends Member {
  timeline: TimelineEntry[];
}

export type VoteEntry = {
  kind: "vote";
  date: string;
  rollCallId: string;
  title: string;
  value: VoteValue;
  /** 公表された集計をそのまま文字列にしたもの（例: "賛成 150・反対 90"）。可否の判定・評価はしない。 */
  result: string;
  /** その採決でその会派の多数票（賛成票>反対票なら賛成、同数なら undefined）。 */
  groupValue?: VoteValue;
  sourceUrl: string;
};
/** 議員立法でのその人の立場（議案ページの原文に基づく事実）。参法の「発議者」は 提出者。 */
export type BillRole = "提出者" | "賛成者";
export type BillEntry = {
  kind: "bill";
  /** 参議院への提出日（議案ページ「提出日」）。 */
  date: string;
  billId: string;
  title: string;
  role: BillRole;
  /** 議案ページ「発議者」欄の原文（例「打越さく良君 外9名」）。外N名の氏名は公表されていないので、人数の事実だけをここで示す。 */
  submitterText?: string;
  /** 審議状況（議案ページの経過のうち最新のものを「段階名 議決の原文」で）。 */
  status?: string;
  sourceUrl: string;
};
export type SpeechEntry = {
  kind: "speech";
  date: string;
  speechId: string;
  meeting: string;
  excerpt: string;
  chars: number;
  /** 会議録の speakerPosition をそのまま（例: "議長", "国土交通大臣", "財政金融委員長"）。議員としてではなく役職として行った発言の事実。無ければ省略 */
  position?: string;
  sourceUrl: string;
};
export type TimelineEntry = VoteEntry | BillEntry | SpeechEntry;

/** Row of `data/rollcalls/index.json` (採決一覧用). */
export interface RollCallSummary {
  id: string;
  session: number;
  date: string;
  title: string;
  totals: { total: number; yes: number; no: number };
  result: string;
  sourceUrl: string;
}
