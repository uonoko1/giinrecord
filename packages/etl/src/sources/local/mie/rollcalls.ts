import type { LocalMember, LocalRollCall, LocalUnmatchedName, LocalVote, VoteValue } from "@seiji-kiroku/shared";
import { MIE_ASSEMBLY } from "./site.ts";
import { UNKNOWN_CELL, UNKNOWN_LEGEND, type VotePdf } from "./votes-pdf.ts";
// 氏名の突き合わせは 7 県で共通（#636）。三重の PDF はフルネーム。実データで異体字セレクタ付きの「辻󠄀内」が出る。
import { localNameKey as nameKey, matchBySubsequence as matchName } from "../name-match.ts";
// 字形の揺れ（〇 U+3007・✕ U+2715）は凡例を引くときだけ寄せる。raw は原文のまま（#674）。
import { legendKey } from "../glyph-variants.ts";

export { nameKey, matchName };

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


export interface SessionInfo {
  sessionId: string;
  /** 会期 index の h2 の原文（「令和８年定例会」） */
  sessionLabel: string;
  pdfUrl: string;
}

/**
 * PDF の表題の会期名（「令和８年定例会（１月）」の「令和８年定例会」）を、会期 index の h2 と突き合わせる（#695）。
 *
 * 三重は通年議会で 1 年 1 会期、賛否 PDF は月ごとに 1 本。会期 index の h2 の下に月別のリンクが並ぶだけなので、
 * 別の年の PDF がその一覧に混ざっても、会期名（令和8年定例会）は index 側の文言がそのまま付く。
 * 中身は令和7年の票、会期名は令和8年——**利用者からは検出できない**（#569）。
 *
 * 何と何を照合するか: **表題の会期名（年 + 定例会/臨時会）**。表題には月も入っている（「（１月）」）が、
 * 月は index.ts がリンク文言（「令和８年１月」）と突き合わせる（月別 PDF なのでリンクにしか無い情報）。
 * ここは会期そのものの取り違えを見る。数字の全角・半角は PDF と h2 で揺れるので NFKC で寄せる。
 *
 * 注: index.ts にも同じ突合がある（#203 から。年・月・会期名の 3 つ）。ここに置くのは
 * **toLocalRollCalls を index.ts を通さず呼んでも通り抜けられないようにする**ため（高知・奈良・鳥取と同じ形）。
 */
export function checkPdfSession(pdfSessionName: string, sessionLabel: string, pdfUrl: string): void {
  const a = pdfSessionName.normalize("NFKC").replace(/[\s　]/g, "");
  const b = sessionLabel.normalize("NFKC").replace(/[\s　]/g, "");
  if (a !== b) throw new Error(`${pdfUrl}: PDF says ${pdfSessionName}, session index says ${sessionLabel}`);
}

export function toLocalRollCalls(pdf: VotePdf, roster: readonly LocalMember[], session: SessionInfo): { rollCalls: LocalRollCall[]; unmatched: LocalUnmatchedName[] } {
  checkPdfSession(pdf.sessionName, session.sessionLabel, session.pdfUrl);
  const resolved = pdf.members.map((m) => matchName(m.nameText, roster).memberId);
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
      const legend = legendOf(raw, pdf.legend, id);
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
