/**
 * 議会（Assembly、#156 / #158）の読み側ヘルパ。ブラウザでも安全（Node API 無し）。
 * - 国会／地方の区別は `assemblyId` の接頭辞（`diet-`）だけで決める。`house` は国会の院の意味のまま触らない。
 * - 個人別表決の公開状況は `app/data/vote-disclosure.json`（#128 の調査表を機械的に起こしたもの）。事実として表示し、評価しない。
 */
import type { Assembly, AssemblyId, LocalVote } from "@seiji-kiroku/shared";
import disclosure from "../data/vote-disclosure.json";
import type { AssemblySession, LocalRollCallSubject, MemberSummary, TimelineEntry } from "./data-contract";

export function isDietAssemblyId(id: string): boolean {
  return id.startsWith("diet-");
}

/** assemblyId が無い（#156 より前の）データは国会議員。`diet-` 以外の assemblyId を持つ人だけが地方議員 */
export function isLocalMember(m: Pick<MemberSummary, "house" | "assemblyId">): boolean {
  return m.assemblyId !== undefined && !isDietAssemblyId(m.assemblyId);
}

export function findAssembly(assemblies: readonly Assembly[], id: string): Assembly | undefined {
  return assemblies.find((a) => a.id === id);
}

/** 地方議会（national 以外）。index が無ければ空 */
export function localAssemblies(assemblies: readonly Assembly[] | undefined): Assembly[] {
  return (assemblies ?? []).filter((a) => a.kind !== "national");
}

/** 議会ページの URL（docs/DATA_CONTRACT.md: `/assemblies/{assemblyId}/`） */
export function assemblyPath(id: AssemblyId | string): string {
  return `/assemblies/${id}`;
}

/* ---------- 公開状況（vote-disclosure.json） ---------- */

/** 調査の 4 値（docs/research/local-assemblies.md）。並びは表示順 */
export const DISCLOSURE_STATUSES = ["公開", "会派別", "総数のみ", "不明"] as const;
export type DisclosureStatus = (typeof DISCLOSURE_STATUSES)[number];

export interface VoteDisclosureRow {
  /** `pref-{2桁}` / `city-{5桁}`。data/ に同じ id の議会があればページへリンクする */
  assemblyId: string;
  kind: "prefectural" | "municipal";
  /** 調査表の表記（「宮城」「岡山市」） */
  label: string;
  status: DisclosureStatus;
  /** 状態の但し書きの原文（「起立採決のみ」「無所属は個人名」） */
  statusNote?: string;
  /** 形式の原文（「PDF」「HTML 表」「—」） */
  format: string;
  /** 確認したページ（調査表の最初の URL） */
  sourceUrl: string;
  /** as-of / 備考の原文 */
  note: string;
}

export interface VoteDisclosure {
  surveyedAt: string;
  source: string;
  issue: number;
  rows: VoteDisclosureRow[];
}

export const VOTE_DISCLOSURE: VoteDisclosure = disclosure as VoteDisclosure;

export function disclosureFor(assemblyId: string): VoteDisclosureRow | undefined {
  return VOTE_DISCLOSURE.rows.find((r) => r.assemblyId === assemblyId);
}

/* ---------- 表決値（LocalVote） ---------- */

export type LocalVoteTone = "yes" | "no" | "none" | "raw";

const MAPPED_TONE = { 賛成: "yes", 反対: "no", 投票なし: "none" } as const;

/** 判の色。凡例から国会の値に対応づけられた（mapped がある）行だけ色を使い、それ以外は中立（raw）。raw の記号から推定しない */
export function localVoteTone(vote: LocalVote): LocalVoteTone {
  return vote.mapped ? MAPPED_TONE[vote.mapped] : "raw";
}

/* ---------- 賛否の対象（voteSubject / committeeReport、#204） ---------- */

/**
 * `rollcalls/index.json` の `voteSubject`（表の節見出しの原文）/ `committeeReport`（委員長報告の原文）を
 * rollCallId で timeline（localVote の行）に写す。一致しない行・localVote 以外の行は触らない。
 */
export function joinVoteSubjects(timeline: TimelineEntry[], index: readonly LocalRollCallSubject[] | null): TimelineEntry[] {
  if (!index || index.length === 0) return timeline;
  const byId = new Map(index.map((r) => [r.id, r]));
  return timeline.map((e) => {
    if (e.kind !== "localVote") return e;
    const rc = byId.get(e.rollCallId);
    if (!rc || (rc.voteSubject === undefined && rc.committeeReport === undefined)) return e;
    return {
      ...e,
      ...(rc.voteSubject !== undefined ? { voteSubject: rc.voteSubject } : {}),
      ...(rc.committeeReport !== undefined ? { committeeReport: rc.committeeReport } : {}),
    };
  });
}

/**
 * 採決行の注記（#204）。鳥取の請願・陳情の ○ は「委員長報告（例：不採択）への賛成」であって
 * 請願・陳情そのものへの賛成ではないので、「賛否の対象：委員長報告（不採択）」を事実として添える。
 * - 「議案に対する賛否」（議案そのものへの賛否＝既定の読み方）は注記しない。
 * - 知らない原文は言い換えずそのまま出す（推定しない）。committeeReport だけの行も落とさない。
 */
export function voteSubjectNote(e: { voteSubject?: string; committeeReport?: string }): string | null {
  const { voteSubject, committeeReport } = e;
  if (voteSubject === "委員長報告に対する賛否") return committeeReport === undefined ? "賛否の対象：委員長報告" : `賛否の対象：委員長報告（${committeeReport}）`;
  const parts = [
    voteSubject !== undefined && voteSubject !== "議案に対する賛否" ? `賛否の対象：${voteSubject}` : null,
    committeeReport !== undefined ? `委員長報告：${committeeReport}` : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" ・ ") : null;
}

/* ---------- 会期一覧（assemblies/{id}/sessions.json、ビルド時にバンドル） ---------- */

const sessionFiles = import.meta.glob<AssemblySession[]>("../../../../data/assemblies/*/sessions.json", { eager: true, import: "default" });

/** 議会 id → 会期一覧。ファイルが無い議会は載らない */
export function bundledSessions(files: Record<string, AssemblySession[]> = sessionFiles): Map<string, AssemblySession[]> {
  const out = new Map<string, AssemblySession[]>();
  for (const [file, sessions] of Object.entries(files)) {
    const id = file.split("/").at(-2);
    if (id) out.set(id, sessions);
  }
  return out;
}
