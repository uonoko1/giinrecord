/**
 * Web-side view of docs/DATA_CONTRACT.md.
 * These mirror the types the contract says will be added to `packages/shared`;
 * once they land there (ETL PBI), replace this file with re-exports.
 */
import type { DatasetMeta, House, Member, MemberId, RollCall, RollCallSummary, VoteValue } from "@seiji-kiroku/shared";

export type { DatasetMeta, RollCall, RollCallSummary, VoteValue };

export interface MemberSummary {
  id: MemberId;
  name: string;
  kana: string;
  house: House;
  group: string;
  district: string;
  termEnd?: string;
  counts: { rollcalls: number; bills: number; speeches: number };
}

export interface MemberDetail extends Member {
  timeline: TimelineEntry[];
}

export type VoteEntry = {
  kind: "vote";
  date: string;
  rollCallId: string;
  title: string;
  value: VoteValue;
  result: string;
  groupValue?: VoteValue;
  sourceUrl: string;
};
export type BillEntry = {
  kind: "bill";
  date: string;
  billId: string;
  title: string;
  role: "提出者" | "賛成者";
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
  sourceUrl: string;
};
export type TimelineEntry = VoteEntry | BillEntry | SpeechEntry;
