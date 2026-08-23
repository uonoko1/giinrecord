import type { LocalMember, LocalRollCall, LocalUnmatchedName, LocalVote, VoteValue } from "@seiji-kiroku/shared";
import { MIYAGI_ASSEMBLY } from "./site.ts";
import { UNKNOWN_CELL, UNKNOWN_LEGEND, type VotePdf } from "./votes-pdf.ts";

/**
 * 表決 PDF の行 → LocalRollCall（Issue #157）。
 * - 名寄せ: 氏名の空白（半角・全角）を除いた完全一致だけ。名簿に同じ氏名が 2 人いれば名寄せしない。異体字（髙/高）も寄せない。
 *   一致しなければ memberId は "" で unmatched に載せる（辞職・失職で名簿から消えた人は PDF にだけ出る）。
 * - 日付: 議決月日（M/D）は見出しの和暦年（令和N年）で西暦にする。会期の月より 6 か月以上前の月は翌年（11月定例会の 1月）。
 * - mapped: 凡例の意味から機械的に対応づけられるときだけ（docs/DATA_CONTRACT.md）。
 */

/** 「票を投じていない」と凡例が言う意味 → 投票なし。棄権・白票は国会の値に対応づけない（凡例の区分を保つ）。 */
const NOT_VOTED = new Set(["議長", "欠席", "議場に不在", "除斥", "退席"]);

export function mapLegend(raw: string, legend: string): LocalVote {
  let mapped: VoteValue | undefined;
  if (raw === UNKNOWN_CELL) mapped = undefined;
  else if (legend === "賛成") mapped = "賛成";
  else if (legend === "反対") mapped = "反対";
  else if (NOT_VOTED.has(legend)) mapped = "投票なし";
  return mapped ? { raw, legend, mapped } : { raw, legend };
}

export function toIsoDate(dateText: string, sessionYear: number, sessionMonth: number): string {
  const m = dateText.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) throw new Error(`date "${dateText}" is not M/D`);
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error(`date "${dateText}" out of range`);
  const year = month < sessionMonth - 6 ? sessionYear + 1 : sessionYear;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const nameKey = (s: string) => s.replace(/[\s　]/g, "");

export interface SessionInfo {
  /** 会期 index の見出しの原文（「令和7年11月定例会（第398回）」） */
  sessionLabel: string;
  pdfUrl: string;
}

export function toLocalRollCalls(pdf: VotePdf, roster: readonly LocalMember[], session: SessionInfo): { rollCalls: LocalRollCall[]; unmatched: LocalUnmatchedName[] } {
  const byName = new Map<string, LocalMember[]>();
  for (const m of roster) {
    const key = nameKey(m.name);
    byName.set(key, [...(byName.get(key) ?? []), m]);
  }
  const resolved = pdf.members.map((m) => {
    const hits = byName.get(nameKey(m.nameText)) ?? [];
    return hits.length === 1 ? hits[0].id : "";
  });
  const unmatched = new Map<string, LocalUnmatchedName>();
  const rollCalls: LocalRollCall[] = [];
  const ids = new Set<string>();
  const unnumbered = new Map<string, number>();
  for (const row of pdf.rows) {
    const date = toIsoDate(row.dateText, pdf.sessionYear, pdf.sessionMonth);
    const ymd = date.replace(/-/g, "");
    let numberForId = row.number;
    if (numberForId === "") {
      const key = `${ymd}\t${row.kind}`;
      const n = (unnumbered.get(key) ?? 0) + 1;
      unnumbered.set(key, n);
      numberForId = `無番号${n}`;
    }
    const id = `${MIYAGI_ASSEMBLY.id}-${pdf.sessionId}-${ymd}-${row.kind}-${numberForId}`;
    if (ids.has(id)) throw new Error(`duplicate rollCall id ${id}`);
    ids.add(id);
    const methodLegend = pdf.legend.methods[row.methodText];
    if (!methodLegend) throw new Error(`${id}: 表決方法 "${row.methodText}" is not in the legend`);
    const votes = row.cells.map((raw, i) => {
      const legend = raw === UNKNOWN_CELL ? UNKNOWN_LEGEND : pdf.legend.votes[raw];
      if (!legend) throw new Error(`${id}: cell "${raw}" is not in the legend`);
      const member = pdf.members[i];
      if (resolved[i] === "") {
        const key = `${member.nameText}\t${member.group}`;
        const u = unmatched.get(key) ?? { nameText: member.nameText, group: member.group, rollCallIds: [] };
        u.rollCallIds.push(id);
        unmatched.set(key, u);
      }
      return { memberId: resolved[i], nameText: member.nameText, group: member.group, value: mapLegend(raw, legend) };
    });
    rollCalls.push({
      id,
      assemblyId: MIYAGI_ASSEMBLY.id,
      sessionId: pdf.sessionId,
      sessionLabel: session.sessionLabel,
      date,
      kind: row.kind,
      number: row.number,
      title: row.title,
      method: { raw: row.methodText, legend: methodLegend },
      result: row.result,
      counts: row.counts,
      votes,
      page: row.page,
      sourceUrl: session.pdfUrl,
    });
  }
  return { rollCalls, unmatched: [...unmatched.values()] };
}
