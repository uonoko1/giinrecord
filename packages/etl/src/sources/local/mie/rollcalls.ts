import type { LocalMember, LocalRollCall, LocalUnmatchedName, LocalVote, VoteValue } from "@seiji-kiroku/shared";
import { MIE_ASSEMBLY } from "./site.ts";
import { UNKNOWN_CELL, UNKNOWN_LEGEND, type VotePdf } from "./votes-pdf.ts";

/**
 * 表決 PDF の行 → LocalRollCall（Issue #203）。
 * - 名寄せ: 氏名の空白（半角・全角）と異体字セレクタ（PDF の「辻󠄀」は IVS 付き、名簿は無し）を除いた完全一致だけ。
 *   字そのもの（髙/高）は寄せない。名簿に同じ氏名が 2 人いれば名寄せしない。
 *   一致しなければ memberId は "" で unmatched に載せる（辞職・失職で名簿から消えた人は PDF にだけ出る）。
 * - 日付: 議決月日（M/D）の月は PDF の表題の月と一致しなければ失敗（月ごとの PDF なので年またぎは無い）。年は表題の和暦年。
 * - mapped: 凡例の意味から機械的に対応づけられるときだけ（docs/DATA_CONTRACT.md）。表決方法の欄は無いので method は書かない。
 */

/** 「票を投じていない」と凡例が言う意味 → 投票なし（三重の凡例は 議長・除斥・不在・欠席）。 */
const NOT_VOTED = new Set(["議長", "除斥", "不在", "欠席"]);

export function mapLegend(raw: string, legend: string): LocalVote {
  let mapped: VoteValue | undefined;
  if (raw === UNKNOWN_CELL) mapped = undefined;
  else if (legend === "賛成") mapped = "賛成";
  else if (legend === "反対") mapped = "反対";
  else if (NOT_VOTED.has(legend)) mapped = "投票なし";
  return mapped ? { raw, legend, mapped } : { raw, legend };
}

/** 氏名の突合キー: 空白と異体字セレクタを除く。 */
export const nameKey = (s: string): string => s.replace(/[\s　]/g, "").replace(/[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu, "");

export interface SessionInfo {
  sessionId: string;
  /** 会期 index の h2 の原文（「令和８年定例会」） */
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
  for (const row of pdf.rows) {
    const dm = row.dateText.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (!dm) throw new Error(`議決月日 "${row.dateText}" is not M/D`);
    const month = Number(dm[1]);
    const day = Number(dm[2]);
    if (month !== pdf.month) throw new Error(`${row.kind}${row.number}: 議決月日 "${row.dateText}" is not in month ${pdf.month} of the PDF title`);
    if (day < 1 || day > 31) throw new Error(`議決月日 "${row.dateText}" out of range`);
    const date = `${pdf.year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const id = `${MIE_ASSEMBLY.id}-${session.sessionId}-${date.replace(/-/g, "")}-${row.kind}-${row.number.normalize("NFKC")}`;
    if (ids.has(id)) throw new Error(`duplicate rollCall id ${id}`);
    ids.add(id);
    const votes = row.cells.map((raw, i) => {
      const legend = raw === UNKNOWN_CELL ? UNKNOWN_LEGEND : pdf.legend[raw];
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
      assemblyId: MIE_ASSEMBLY.id,
      sessionId: session.sessionId,
      sessionLabel: session.sessionLabel,
      date,
      kind: row.kind,
      number: row.number,
      title: row.title,
      result: row.result,
      counts: row.counts,
      votes,
      page: row.page,
      sourceUrl: session.pdfUrl,
    });
  }
  return { rollCalls, unmatched: [...unmatched.values()] };
}
