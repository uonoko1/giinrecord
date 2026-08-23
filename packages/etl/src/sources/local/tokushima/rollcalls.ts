import type { LocalMember, LocalRollCall, LocalUnmatchedName, LocalVote, VoteValue } from "@seiji-kiroku/shared";
import { TOKUSHIMA_ASSEMBLY } from "./site.ts";
import { legendKey, UNKNOWN_CELL, UNKNOWN_LEGEND, type VotePdf } from "./votes-pdf.ts";

/**
 * 徳島の表決 PDF の行 → LocalRollCall（Issue #183）。宮城（miyagi/rollcalls.ts）と同じ方針:
 * - 名寄せ: 氏名の空白（半角・全角）を除いた完全一致だけ。名簿に同じ氏名が 2 人いれば名寄せしない。異体字も寄せない。
 *   一致しなければ memberId は "" で unmatched に載せる。
 * - id: {assemblyId}-{sessionId}-{採決日 yyyymmdd}-{節見出し}-{議案番号（NFKC。「第１号」→「第1号」）}。
 *   同じ採決日・節で同じ番号の行が複数（原案と修正案、監査委員の選任 2 人）なら全部に -1, -2 … を足す。番号欄に数字が無い行（動議「-」）は 無番号{n}。
 * - LocalVote: raw はセルの原文（〇 U+3007 もそのまま）、legend はその節の凡例の意味の原文。mapped は凡例の文面が国会の値に機械的に対応するときだけ（docs/DATA_CONTRACT.md）。
 * - 表決方法・人数の欄は PDF に無いので method / counts は付けない（推定しない）。委員会審査結果は committeeResult に原文で。
 */

/** 凡例の文面 → 国会の値。文面が完全一致するときだけ（「起立（賛成）した者」と書いてあれば賛成、議長・退席・欠席・除斥は票を投じていない）。 */
// ○「委員会審査結果又は議長宣告に起立（賛成）した者」は議案そのものへの賛成ではなく「委員会審査結果／議長宣告」への起立
// （請願が委員会で不採択なら ○ は請願を退けた側）。議案への賛否は凡例から機械的には読めないので ○ と ● には mapped を付けない（推定しない）。
const MAPPED_BY_LEGEND: Record<string, VoteValue> = {
  "議長": "投票なし",
  "退席": "投票なし",
  "欠席": "投票なし",
  "除斥": "投票なし",
};

export function mapLegend(raw: string, legend: Record<string, string>): LocalVote {
  if (raw === UNKNOWN_CELL) return { raw, legend: UNKNOWN_LEGEND };
  const meaning = legend[legendKey(raw)];
  if (!meaning) throw new Error(`cell "${raw}" is not in the legend (${Object.keys(legend).join("")})`);
  const mapped = MAPPED_BY_LEGEND[meaning];
  return mapped ? { raw, legend: meaning, mapped } : { raw, legend: meaning };
}

const nameKey = (s: string) => s.replace(/[\s　]/g, "");

export interface SessionInfo {
  sessionId: string;
  /** 会期ページの h1 の原文（「令和8年6月定例会」） */
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
  const ymd = pdf.date.replace(/-/g, "");
  for (const section of pdf.sections) {
    // 同じ番号の行の数（結合セル）を先に数え、2 つ以上なら -1, -2 … で分ける
    const numberOf = (number: string) => (/\d/.test(number.normalize("NFKC")) ? number.normalize("NFKC").replace(/[\s　]/g, "") : "");
    const dup = new Map<string, number>();
    for (const row of section.rows) dup.set(numberOf(row.number), (dup.get(numberOf(row.number)) ?? 0) + 1);
    const seq = new Map<string, number>();
    for (const row of section.rows) {
      const base = numberOf(row.number);
      const n = (seq.get(base) ?? 0) + 1;
      seq.set(base, n);
      const numberForId = base === "" ? `無番号${n}` : (dup.get(base) ?? 1) > 1 ? `${base}-${n}` : base;
      const id = `${TOKUSHIMA_ASSEMBLY.id}-${session.sessionId}-${ymd}-${section.kind}-${numberForId}`;
      if (rollCalls.some((rc) => rc.id === id)) throw new Error(`duplicate rollCall id ${id}`);
      const votes = row.cells.map((raw, i) => {
        const member = pdf.members[i];
        if (resolved[i] === "") {
          const key = `${member.nameText}\t${member.group}`;
          const u = unmatched.get(key) ?? { nameText: member.nameText, group: member.group, rollCallIds: [] };
          u.rollCallIds.push(id);
          unmatched.set(key, u);
        }
        return { memberId: resolved[i], nameText: member.nameText, group: member.group, value: mapLegend(raw, section.legend) };
      });
      rollCalls.push({
        id,
        assemblyId: TOKUSHIMA_ASSEMBLY.id,
        sessionId: session.sessionId,
        sessionLabel: session.sessionLabel,
        date: pdf.date,
        kind: section.kind,
        number: row.number,
        title: row.title,
        committeeResult: row.committeeResult,
        result: row.result,
        votes,
        page: row.page,
        sourceUrl: session.pdfUrl,
      });
    }
  }
  return { rollCalls, unmatched: [...unmatched.values()] };
}
