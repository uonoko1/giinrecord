import type { LocalMember, LocalRollCall, LocalUnmatchedName, LocalVote, VoteValue } from "@seiji-kiroku/shared";
import { NARA_ASSEMBLY } from "./site.ts";
import { UNKNOWN_CELL, UNKNOWN_LEGEND, type VotePdf } from "./votes-pdf.ts";

/**
 * 奈良県議会の表決 PDF の行 → LocalRollCall（Issue #202）。
 * - 名寄せ: PDF の氏名（縦書きを結合）と名簿の氏名を、空白と異体字セレクタを除き字形違い（髙/高・﨑/崎・𠮷/吉）を寄せた上での完全一致で。
 *   完全一致が無いときだけ、部分列一致（名簿の氏名に PDF の氏名が順序どおり含まれる）で 1 人に決まれば寄せる（一部の字が
 *   文字層に落ちて欠ける列がある。「芦髙清友」の外字「芦」（6月定例会分）、「西川均」の「均」（両方））。
 *   2 人以上なら候補を列挙して memberId "" のまま（選ばない）。
 * - id は {assemblyId}-{sessionId}-{議決日 yyyymmdd}-{種別}-{議案等番号}。同じ議決日・種別で同じ番号の行が複数なら全部に -1, -2 … を足す（徳島と同じ）。
 * - 表決方法・人数の欄は PDF に無いので method / counts は書かない（推定しない）。
 * - mapped: 凡例の文言が下の表と完全一致するときだけ（docs/DATA_CONTRACT.md）。棄権（「退」表決を棄権）は対応づけない。
 */

/** 凡例の意味の原文 → 国会の値。「票を投じていない」と凡例が言う意味は 投票なし。 */
const MAPPED: Record<string, VoteValue> = {
  "賛成": "賛成",
  "反対（起立採決において、起立しなかった議員）": "反対",
  "議長": "投票なし",
  "副議長が議長職務を代行した場合": "投票なし",
  "除斥": "投票なし",
  "欠席": "投票なし",
  "不在（除斥、欠席及び表決を棄権した場合を除く）": "投票なし",
};

export function mapLegend(raw: string, legend: string): LocalVote {
  const mapped = raw === UNKNOWN_CELL ? undefined : MAPPED[legend];
  return mapped ? { raw, legend, mapped } : { raw, legend };
}

/** 字形違い（異体字）を寄せる。人名用の別字（澤/沢 など）は寄せない。 */
const ITAIJI: Record<string, string> = { "髙": "高", "﨑": "崎", "𠮷": "吉" };

/** 氏名の突合キー: 空白・異体字セレクタ（U+FE00–FE0F, U+E0100–E01EF）を除き、字形違いを寄せる。 */
export const nameKey = (s: string): string =>
  [...s.replace(/[\s　]/g, "").replace(/[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu, "")].map((c) => ITAIJI[c] ?? c).join("");

export interface NameMatch {
  memberId: string;
  candidates: { id: string; name: string }[];
}

/** a の文字が順序どおり b に現れるか（部分列）。 */
const isSubsequence = (a: string, b: string): boolean => {
  let i = 0;
  for (const c of b) if (i < a.length && c === a[i]) i++;
  return i === a.length;
};

/**
 * PDF の氏名 → 名簿。完全一致（nameKey）が 1 人ならその人。0 人なら「名簿の氏名に PDF の氏名が順序どおり部分列として
 * 含まれる」議員が 1 人に決まるときだけ寄せる（文字層に落ちる字（外字「芦」・「均」）が先頭にも末尾にも出るため）。
 * どちらも 2 人以上なら memberId "" で候補を全部返す（選ばない）。
 */
export function matchName(nameText: string, roster: readonly LocalMember[]): NameMatch {
  const key = nameKey(nameText);
  if (key === "") return { memberId: "", candidates: [] };
  const exact = roster.filter((m) => nameKey(m.name) === key);
  if (exact.length > 0) {
    const candidates = exact.map((m) => ({ id: m.id, name: m.name }));
    return { memberId: exact.length === 1 ? exact[0].id : "", candidates };
  }
  if ([...key].length < 2) return { memberId: "", candidates: [] };
  const partial = roster.filter((m) => isSubsequence(key, nameKey(m.name)));
  const candidates = partial.map((m) => ({ id: m.id, name: m.name }));
  return { memberId: partial.length === 1 ? partial[0].id : "", candidates };
}

export interface SessionInfo {
  sessionId: string;
  /** 会期 index のリンク文言（「令和8年6月定例会」）。PDF の見出しと一致しなければ例外 */
  sessionLabel: string;
}

export interface PdfSource {
  pdf: VotePdf;
  pdfUrl: string;
}

export function toLocalRollCalls(sources: readonly PdfSource[], roster: readonly LocalMember[], session: SessionInfo): { rollCalls: LocalRollCall[]; unmatched: LocalUnmatchedName[] } {
  const rollCalls: LocalRollCall[] = [];
  const unmatched = new Map<string, LocalUnmatchedName>();
  const baseIds = new Map<string, number>();
  for (const { pdf, pdfUrl } of sources) {
    if (pdf.sessionLabel !== session.sessionLabel) throw new Error(`${pdfUrl}: PDF says ${pdf.sessionLabel}, session index says ${session.sessionLabel}`);
    const resolved = pdf.members.map((m) => matchName(m.nameText, roster));
    const ymd = pdf.date.replace(/-/g, "");
    for (const row of pdf.rows) {
      if (/[\s/\\]/.test(row.kind + row.number)) throw new Error(`${pdfUrl}: kind/number "${row.kind} ${row.number}" cannot be used in an id`);
      const base = `${NARA_ASSEMBLY.id}-${session.sessionId}-${ymd}-${row.kind}-${row.number}`;
      baseIds.set(base, (baseIds.get(base) ?? 0) + 1);
      const votes: LocalRollCall["votes"] = row.cells.map((raw, i) => {
        const legend = raw === UNKNOWN_CELL ? UNKNOWN_LEGEND : pdf.legend.votes[raw];
        if (!legend) throw new Error(`${base}: cell "${raw}" is not in the legend`);
        const member = pdf.members[i];
        return { memberId: resolved[i].memberId, nameText: member.nameText, group: member.group, value: mapLegend(raw, legend) };
      });
      rollCalls.push({
        id: base,
        assemblyId: NARA_ASSEMBLY.id,
        sessionId: session.sessionId,
        sessionLabel: session.sessionLabel,
        date: pdf.date,
        kind: row.kind,
        number: row.number,
        title: row.title,
        result: row.result,
        votes,
        page: row.page,
        sourceUrl: pdfUrl,
      });
    }
  }
  // 同じ議決日・種別で同じ番号の行が複数なら、出た順に全部へ -1, -2 … を足す（徳島と同じ規則）。id が確定してから unmatched を集める
  const seen = new Map<string, number>();
  for (const rc of rollCalls) {
    if ((baseIds.get(rc.id) ?? 0) <= 1) continue;
    const n = (seen.get(rc.id) ?? 0) + 1;
    seen.set(rc.id, n);
    rc.id = `${rc.id}-${n}`;
  }
  // 名簿に寄せられなかった氏名: rollCalls の memberId 空の票から（候補は matchName の結果を写す）
  for (const rc of rollCalls) {
    for (const v of rc.votes) {
      if (v.memberId !== "") continue;
      const key = `${v.nameText}\t${v.group}`;
      const u = unmatched.get(key) ?? { nameText: v.nameText, group: v.group, rollCallIds: [] };
      if (!u.rollCallIds.includes(rc.id)) u.rollCallIds.push(rc.id);
      unmatched.set(key, u);
    }
  }
  // 候補を付ける（同名 2 人以上・末尾一致 2 人以上）
  const candidateByName = new Map<string, { id: string; name: string }[]>();
  for (const { pdf } of sources) {
    pdf.members.forEach((m) => {
      const match = matchName(m.nameText, roster);
      if (match.memberId === "" && match.candidates.length > 0) candidateByName.set(`${m.nameText}\t${m.group}`, match.candidates);
    });
  }
  const unmatchedList = [...unmatched.values()].map((u) => {
    const c = candidateByName.get(`${u.nameText}\t${u.group}`);
    return c ? { ...u, candidates: c } : u;
  });
  return { rollCalls, unmatched: unmatchedList };
}
