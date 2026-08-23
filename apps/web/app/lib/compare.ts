/**
 * /compare（Issue #104）: 複数議員の記録を同じ採決・議案で横並びにする純粋ロジック。Browser-safe。
 *
 * 行＝案件、列＝議員。参院の個人票（事実）は rollCallId で、衆院の会派の態度（推定）は billId で揃える。
 * 2 人以上に記録のある案件だけを行にする（比べる相手の無い行は作らず、件数だけ `unsharedVotes` に残す）。
 * 一致率・スコア・並べ替えの評価指標はここには無い。並びは日付降順（同日は id 降順）だけ。
 */
import type { MemberDetail, StanceEntry, VoteEntry } from "./data-contract";

export const COMPARE_MAX = 4;
export const COMPARE_STORAGE_KEY = "seiji-kiroku:compare";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** `?m=id1,id2` → 最大 COMPARE_MAX 件の id（重複・空・不正な文字を落とす）。 */
export function parseCompareIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!SAFE_ID.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length === COMPARE_MAX) break;
  }
  return out;
}

export type ToggleResult = { ids: string[]; added: boolean; full?: true };

/** 比較リストの出し入れ。登録済みなら外し、未登録なら末尾に足す。上限なら変えずに `full`。 */
export function toggleCompareId(ids: string[], id: string): ToggleResult {
  if (ids.includes(id)) return { ids: ids.filter((x) => x !== id), added: false };
  if (ids.length >= COMPARE_MAX) return { ids, added: false, full: true };
  return { ids: [...ids, id], added: true };
}

/** 列の議員（見出し用）。 */
export interface CompareColumn {
  id: string;
  name: string;
  house: MemberDetail["house"];
}

export interface FactRow {
  id: string;
  date: string;
  title: string;
  /** 採決の結果（得票を含む原文）。どの列も同じ採決なので行に1つ。 */
  result: string;
  /** 列ごとの票。記録の無い議員は null（「記録なし」）。 */
  cells: (VoteEntry | null)[];
}

export interface EstimatedRow {
  id: string;
  date: string;
  title: string;
  /** 列ごとの会派の態度（推定）。会派がどちらにも載らない・衆院でない議員は null。 */
  cells: (StanceEntry | null)[];
}

export interface CompareRows {
  columns: CompareColumn[];
  /** 事実: 参院の記名投票（rollCallId で揃える）。 */
  facts: FactRow[];
  /** 推定: 衆院の会派の態度（billId で揃える）。 */
  estimated: EstimatedRow[];
  /** 列ごとの、行にならなかった（他の誰にも記録が無い）採決の数。事実を隠さないために件数を残す。 */
  unsharedVotes: number[];
}

function byDateDesc<T extends { date: string; id: string }>(a: T, b: T): number {
  return b.date.localeCompare(a.date) || b.id.localeCompare(a.id);
}

function alignBy<E extends { date: string; title: string }, R extends { id: string; date: string; title: string; cells: (E | null)[] }>(
  members: MemberDetail[],
  pick: (m: MemberDetail) => Map<string, E>,
  make: (id: string, first: E, cells: (E | null)[]) => R,
): { rows: R[]; unshared: number[] } {
  const maps = members.map(pick);
  const rows: R[] = [];
  const unshared = maps.map(() => 0);
  const seen = new Set<string>();
  maps.forEach((map, col) => {
    for (const [id, first] of map) {
      if (seen.has(id)) continue;
      seen.add(id);
      const cells = maps.map((m) => m.get(id) ?? null);
      const holders = cells.filter((c) => c !== null).length;
      if (holders >= 2) rows.push(make(id, first, cells));
      else unshared[col] = (unshared[col] ?? 0) + 1;
    }
  });
  rows.sort(byDateDesc);
  return { rows, unshared };
}

export function alignTimelines(members: MemberDetail[]): CompareRows {
  const columns = members.map((m) => ({ id: m.id, name: m.name, house: m.house }));
  const facts = alignBy(
    members,
    (m) => new Map(m.timeline.filter((e): e is VoteEntry => e.kind === "vote").map((e) => [e.rollCallId, e])),
    (id, first, cells): FactRow => ({ id, date: first.date, title: first.title, result: first.result, cells }),
  );
  const estimated = alignBy(
    members,
    (m) => new Map(m.timeline.filter((e): e is StanceEntry => e.kind === "stance").map((e) => [e.billId, e])),
    (id, first, cells): EstimatedRow => ({ id, date: first.date, title: first.title, cells }),
  );
  return { columns, facts: facts.rows, estimated: estimated.rows, unsharedVotes: facts.unshared };
}

/* ---------- localStorage（議員ページの「比較に追加」、Issue #104）。Cookie は使わない。必ず try/catch。 ---------- */

export function readStoredCompareIds(): string[] {
  try {
    const raw = localStorage.getItem(COMPARE_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parseCompareIds(parsed.filter((x): x is string => typeof x === "string").join(","));
  } catch {
    return [];
  }
}

export function writeStoredCompareIds(ids: string[]): void {
  try {
    if (ids.length === 0) localStorage.removeItem(COMPARE_STORAGE_KEY);
    else localStorage.setItem(COMPARE_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable (private mode etc.) — the in-page state still applies */
  }
}
