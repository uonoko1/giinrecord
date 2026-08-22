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
  /** 最新回次の名簿に載っているか。無い（古いデータ）なら現職として扱う */
  current?: boolean;
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
export type BillRole = "提出者" | "賛成者";
export type BillEntry = {
  kind: "bill";
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
  date: string;
  speechId: string;
  meeting: string;
  excerpt: string;
  chars: number;
  /** 会議録の speakerPosition 原文（例: "議長", "国土交通大臣"）。役職として行った発言。無ければ省略 */
  position?: string;
  sourceUrl: string;
};
export type TimelineEntry = VoteEntry | BillEntry | SpeechEntry;
