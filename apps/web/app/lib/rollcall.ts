/**
 * Pure helpers for the roll-call pages. Ordering only — nothing here judges a vote.
 */
import type { RollCall } from "./data-contract";

type Group = RollCall["groups"][number];
type Vote = RollCall["votes"][number];

/** 会派は人数の多い順。同数は公表された順を保つ（Array.prototype.sort は安定）。 */
export function groupsBySize(groups: readonly Group[]): Group[] {
  return [...groups].sort((a, b) => b.size - a.size);
}

/** 会派名 → その会派の票（原文順）。 */
export function votesByGroup(votes: readonly Vote[]): Map<string, Vote[]> {
  const map = new Map<string, Vote[]>();
  for (const v of votes) {
    const list = map.get(v.group);
    if (list) list.push(v);
    else map.set(v.group, [v]);
  }
  return map;
}

/** 日付降順。同日は元の順（index.json は id 昇順で同日採決が並ぶ）。 */
export function sortByDateDesc<T extends { date: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.date.localeCompare(a.date));
}

/** 登場する回次を重複なく新しい順に。 */
export function sessionsDesc(rows: readonly { session: number }[]): number[] {
  return [...new Set(rows.map((r) => r.session))].sort((a, b) => b - a);
}

/** 2026-07-24 → 2026.07.24（文字列操作のみ。タイムゾーン変換はしない） */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : iso;
}

/** 2026-08-22T06:00:00+09:00 → 2026.08.22 06:00（文字列のまま。タイムゾーン変換はしない） */
export function formatDateTime(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}.${m[2]}.${m[3]} ${m[4]}:${m[5]}` : formatDate(iso);
}
