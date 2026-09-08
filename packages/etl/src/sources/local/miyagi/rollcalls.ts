import type { LocalMember, LocalRollCall, LocalUnmatchedName, LocalVote, VoteValue } from "@seiji-kiroku/shared";
import { MIYAGI_ASSEMBLY } from "./site.ts";
import { UNKNOWN_CELL, UNKNOWN_LEGEND, type VotePdf } from "./votes-pdf.ts";
// 氏名の突き合わせは 7 県で共通（#636）。宮城の PDF はフルネーム。名簿の「髙橋 伸二」は字形違いを寄せて初めて PDF の「高橋 伸二」と一致する。
import { localNameKey as nameKey, matchBySubsequence as matchName } from "../name-match.ts";
// 字形の揺れ（〇 U+3007・✕ U+2715）は凡例を引くときだけ寄せる。raw は原文のまま（#674）。
import { legendKey } from "../glyph-variants.ts";

export { nameKey, matchName };

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

/**
 * セルの原文 → 凡例の意味。字形の揺れ（〇 U+3007 → ○ U+25CB、✕ U+2715 → × U+00D7）は寄せてから引く（#674）。
 * 寄せても凡例に無ければ例外（丸めない・推定しない。#569）。raw は原文のまま呼び出し側に残る。
 */
export function legendOf(raw: string, votes: Record<string, string>, label: string): string {
  if (raw === UNKNOWN_CELL) return UNKNOWN_LEGEND;
  const meaning = votes[legendKey(raw)];
  if (!meaning) throw new Error(`${label}: cell "${raw}" is not in the legend (${Object.keys(votes).join("")})`);
  return meaning;
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


export interface SessionInfo {
  /** 会期 index の見出しの原文（「令和7年11月定例会（第398回）」） */
  sessionLabel: string;
  pdfUrl: string;
}

/**
 * 表決 PDF の見出し（「第398回宮城県議会（令和7年11月定例会）」）を、
 * 会期 index の見出し（「令和7年11月定例会（第398回）」）と突き合わせる（#695）。
 *
 * index.ts は通算回次（pdf.sessionId）だけを見ていた。回次は宮城県議会の通算なので一意で、
 * これだけでも別の会期の PDF はほぼ弾ける。ただし **議決日は PDF 側の 年月（sessionYear / sessionMonth）から作る**
 * （toIsoDate。議決月日の欄は「12/17」と月日しか無い）ので、回次が合っていても年月が食い違えば
 * 日付だけが別の会期のものになる。回次と年月は同じ見出しの中の別々の語なので、両方を照合する。
 *
 * 何と何を照合するか: **見出しの「第N回」と「令和N年M月定例会」の両方**。数字の全角・半角は NFKC で寄せる。
 */
const PDF_LABEL = /^第(\d+)回宮城県議会[（(](.+?)[）)]$/;
const INDEX_LABEL = /^(.+?(?:定例会|臨時会))[（(]第(\d+)回[）)]$/;

export function checkPdfSession(pdfLabel: string, sessionLabel: string, pdfUrl: string): void {
  const t = pdfLabel.normalize("NFKC").replace(/[\s　]/g, "").match(PDF_LABEL);
  if (!t) throw new Error(`${pdfUrl}: PDF says "${pdfLabel}", which is not 第N回宮城県議会（…）`);
  const l = sessionLabel.normalize("NFKC").replace(/[\s　]/g, "").match(INDEX_LABEL);
  if (!l) throw new Error(`${pdfUrl}: session index says "${sessionLabel}", which is not 令和N年M月定例会（第N回）`);
  if (t[1] !== l[2]) throw new Error(`${pdfUrl}: PDF says 第${t[1]}回, session index says 第${l[2]}回`);
  if (t[2] !== l[1]) throw new Error(`${pdfUrl}: PDF says ${t[2]}, session index says ${l[1]}`);
}

export function toLocalRollCalls(pdf: VotePdf, roster: readonly LocalMember[], session: SessionInfo): { rollCalls: LocalRollCall[]; unmatched: LocalUnmatchedName[] } {
  checkPdfSession(pdf.sessionLabel, session.sessionLabel, session.pdfUrl);
  const resolved = pdf.members.map((m) => matchName(m.nameText, roster).memberId);
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
      const legend = legendOf(raw, pdf.legend.votes, id);
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
