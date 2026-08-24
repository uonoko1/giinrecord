/**
 * /coverage（#218）の集計。データ（`data/` の index.json 群）だけから件数と範囲を数える純関数。
 * 数値はここで数え、ページ側にも定数にも書かない（データが増えたら再ビルドで追随する）。
 * ブラウザでも動く（Node API は使わない）。
 */
import type { Assembly, House } from "@seiji-kiroku/shared";
import { isDietAssemblyId } from "./assemblies";
import { DIET_ASSEMBLIES, type AssemblySession } from "./data-contract";
import type { Dataset } from "./dataset";
import { memberAssemblyId } from "./member-search";

/** 回次の範囲（meta.sessions と rollcalls の session から数える）。データが空なら null */
export interface SessionRange {
  from: number;
  to: number;
}

export function sessionRange(sessions: readonly number[]): SessionRange | null {
  if (sessions.length === 0) return null;
  return { from: Math.min(...sessions), to: Math.max(...sessions) };
}

/** [200, 221] → "第200—221回"、1 つなら "第221回"。空なら null */
export function formatSessionRange(range: SessionRange | null): string | null {
  if (!range) return null;
  return range.from === range.to ? `第${range.from}回` : `第${range.from}—${range.to}回`;
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
export function buildCoverage(data: Dataset, sessionsByAssembly: ReadonlyMap<string, AssemblySession[]>): Coverage {
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
      return {
        assemblyId: a.id,
        house: HOUSE_OF[a.id] ?? "sangiin",
        name: a.name,
        sourceUrl: a.sourceUrl,
        members: memberCount.get(a.id) ?? 0,
        rollcalls: individualVotes ? data.rollcalls.length : 0,
        rollcallSessions: individualVotes ? rollcallSessions : null,
        individualVotes,
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
