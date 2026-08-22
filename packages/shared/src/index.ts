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
  name: string;        // 公式表記（例: "藤川 政人"）
  kana: string;        // ふりがな
  house: House;
  /** Membership periods; a member can move between groups/houses. */
  terms: MemberTerm[];
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
