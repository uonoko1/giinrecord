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

/**
 * 議案（衆参の議案情報から）。`data/bills/{session}/{id}.json`（docs/DATA_CONTRACT.md）。
 * 氏名・会派名・議決はすべて議案ページの原文。`shugiinGroupStance` だけが会派単位の記録（推定）で、
 * 個人の賛否を表すものではない。RollCall には入れない。
 */
export interface Bill {
  id: string;          // `{提出回次}-{種別原文}-{番号}`（例 "221-衆法-1"）。番号の無い議案（決算・承諾など）は番号の代わりに経過ページの id
  session: number;     // 提出回次
  kind: BillKind;
  /** 議案情報の種別の原文（例「決算」「ＮＨＫ決算」「承諾」）。kind に対応が無く その他 にしたとき原文を残す。kind と同じなら省略 */
  kindText?: string;
  number?: number;
  title: string;
  /** この議案ページを公開している院（sourceUrl のドメインと一致） */
  house: House;
  submitters?: MemberId[];   // 議員立法の提出者（事実。名簿に名寄せできた人だけ）
  supporters?: MemberId[];   // 議員立法の賛成者（事実。名簿に名寄せできた人だけ）
  submitterText?: string;    // 「議案提出者」欄の原文（例: "落合　貴之君外四名", "内閣", "国土交通委員長"）
  /** 「議案提出者一覧」の氏名（原文から「君」を除いたもの。事実）。欄が無い（閣法・参法）なら省略 */
  submitterNames?: string[];
  /** 「議案提出の賛成者」の氏名（同上）。欄はあるが空なら [] */
  supporterNames?: string[];
  /** 「議案提出会派」（原文の会派名） */
  submitterGroups?: string[];
  /** 議案受理年月日（各院）。ISO */
  received?: { shugiin?: string; sangiin?: string };
  /** 一覧ページの「審議状況」の原文（例「成立」「衆議院で閉会中審査」「本院議了」） */
  status?: string;
  /** 各院の審議結果の原文（可決・否決・修正・承認・閉会中審査 …）と公布日・法律番号 */
  result?: { sangiin?: string; shugiin?: string; promulgated?: string; lawNumber?: string };
  /**
   * 【推定】衆議院審議時の会派態度（経過ページ「衆議院審議時会派態度／賛成会派／反対会派」の原文）。
   * 衆議院は個人別の投票記録を公開していないため、個人の賛否はここから推定するしかない。事実（参院の個人票）とは型で分ける。
   */
  shugiinGroupStance?: ShugiinGroupStance;
  sourceUrl: string;
}

/** 会派単位の態度（推定の材料）。会派名は原文。`unanimous` はページが「全会一致」と書いているときだけ true（反対会派が空でも推論しない）。 */
export interface ShugiinGroupStance {
  /** 「衆議院審議時会派態度」の原文（多数・少数・全会一致） */
  stanceText: string;
  yes: string[];
  no: string[];
  unanimous?: boolean;
}

/** Row of `data/bills/index.json`（議案一覧用）. */
export interface BillSummary {
  id: string;
  session: number;
  kind: BillKind;
  house: House;
  title: string;
  status?: string;
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
