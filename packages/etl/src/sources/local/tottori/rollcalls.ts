import type { LocalMember, LocalRollCall, LocalUnmatchedName, LocalVote, VoteValue } from "@seiji-kiroku/shared";
import { TOTTORI_ASSEMBLY } from "./site.ts";
import { UNKNOWN_CELL, UNKNOWN_LEGEND, type VotePdf, type VotePdfRow } from "./votes-pdf.ts";

/**
 * 鳥取県議会の表決 PDF の行 → LocalRollCall（Issue #184）。
 * - 名寄せ: PDF の氏名は「○○議員」（姓だけ。同姓は「浜田一議員」のように名の 1 文字付き）。名簿の氏名（空白を除く）が
 *   「議員」を除いた文字列で始まる議員がちょうど 1 人のときだけ寄せる。0 人・2 人以上は memberId "" で unmatched に載せ、候補を全員列挙する（選ばない）。
 * - 同じ会期の複数の PDF（全体版・部分集合版・同じファイルの複製）に同じ議案が出たら、内容（票・人数・結果・方法・委員長報告・件名）が
 *   一致することを確かめて 1 件にする。食い違えば例外（どちらが正しいか推定しない）。sourceUrl は最初に出た PDF。
 * - id は {assemblyId}-{sessionId}-{議決日 yyyymmdd}-{種別}-{番号}。議決日は PDF の見出し。
 * - mapped: 凡例の文言が下の表にあるときだけ（docs/DATA_CONTRACT.md）。表決方法の凡例は PDF に無いので legend は原文と同じ。
 */

/** 凡例の意味の原文 → 国会の値。「票を投じていない」と凡例が言う意味は 投票なし。棄権は対応づけない。 */
const MAPPED: Record<string, VoteValue> = {
  "賛成": "賛成",
  "反対": "反対",
  "議長": "投票なし",
  "副議長が議長の職務を代理": "投票なし",
  "除斥": "投票なし",
  "欠席": "投票なし",
  "議場に不在であり、表決しなかった議員": "投票なし",
};

export function mapLegend(raw: string, legend: string): LocalVote {
  const mapped = raw === UNKNOWN_CELL ? undefined : MAPPED[legend];
  return mapped ? { raw, legend, mapped } : { raw, legend };
}

const nameKey = (s: string) => s.replace(/[\s　]/g, "");

export interface NameMatch {
  memberId: string;
  candidates: { id: string; name: string }[];
}

/** PDF の「○○議員」→ 名簿。氏名（空白除く）が「議員」を除いた文字列で始まる議員がちょうど 1 人なら memberId、それ以外は ""（候補は全部返す）。 */
export function matchName(nameText: string, roster: readonly LocalMember[]): NameMatch {
  const key = nameKey(nameText).replace(/議員$/, "");
  if (key === "") return { memberId: "", candidates: [] };
  const candidates = roster.filter((m) => nameKey(m.name).startsWith(key)).map((m) => ({ id: m.id, name: m.name }));
  return { memberId: candidates.length === 1 ? candidates[0].id : "", candidates };
}

export interface SessionInfo {
  sessionId: string;
  /** 会期 index のラベル（「令和8年6月定例会」）。PDF の見出しと一致しなければ例外 */
  sessionLabel: string;
}

export interface PdfSource {
  pdf: VotePdf;
  pdfUrl: string;
}

type Vote = LocalRollCall["votes"][number];

function rowFingerprint(row: VotePdfRow, votes: Vote[]): string {
  const cells = votes.map((v) => `${v.nameText}=${v.value.raw}`).sort();
  return JSON.stringify([row.kind, row.number, row.counts, row.methodText, row.result, row.committeeReport ?? null, cells]);
}

export function toLocalRollCalls(sources: readonly PdfSource[], roster: readonly LocalMember[], session: SessionInfo): { rollCalls: LocalRollCall[]; unmatched: LocalUnmatchedName[] } {
  const byId = new Map<string, { rc: LocalRollCall; fingerprint: string }>();
  const unmatched = new Map<string, LocalUnmatchedName>();
  const order: string[] = [];
  for (const { pdf, pdfUrl } of sources) {
    if (pdf.sessionLabel !== session.sessionLabel) throw new Error(`${pdfUrl}: PDF says ${pdf.sessionLabel}, session index says ${session.sessionLabel}`);
    const resolved = pdf.members.map((m) => matchName(m.nameText, roster));
    const ymd = pdf.date.replace(/-/g, "");
    for (const row of pdf.rows) {
      if (/[\s/\\]/.test(row.kind + row.number)) throw new Error(`${pdfUrl}: kind/number "${row.kind} ${row.number}" cannot be used in an id`);
      const id = `${TOTTORI_ASSEMBLY.id}-${session.sessionId}-${ymd}-${row.kind}-${row.number}`;
      const votes: Vote[] = row.cells.map((raw, i) => {
        const legend = raw === UNKNOWN_CELL ? UNKNOWN_LEGEND : pdf.legend.votes[raw];
        if (!legend) throw new Error(`${id}: cell "${raw}" is not in the legend`);
        const member = pdf.members[i];
        return { memberId: resolved[i].memberId, nameText: member.nameText, group: member.group, value: mapLegend(raw, legend) };
      });
      const fingerprint = rowFingerprint(row, votes);
      const existing = byId.get(id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error(`${id}: content differs between PDFs (${existing.rc.sourceUrl} vs ${pdfUrl})`);
        if (existing.rc.date !== pdf.date) throw new Error(`${id}: date differs between PDFs`);
        if (row.title !== "" && existing.rc.title !== "" && row.title !== existing.rc.title) throw new Error(`${id}: title differs between PDFs ("${existing.rc.title}" vs "${row.title}")`);
        if (row.voteSubject !== undefined && existing.rc.voteSubject !== undefined && row.voteSubject !== existing.rc.voteSubject) throw new Error(`${id}: 賛否の対象 differs between PDFs`);
        if (existing.rc.title === "" && row.title !== "") existing.rc.title = row.title;
        if (existing.rc.voteSubject === undefined && row.voteSubject !== undefined) existing.rc.voteSubject = row.voteSubject;
        continue;
      }
      for (let i = 0; i < votes.length; i++) {
        if (votes[i].memberId !== "") continue;
        const key = `${votes[i].nameText}\t${votes[i].group}`;
        const u = unmatched.get(key) ?? { nameText: votes[i].nameText, group: votes[i].group, rollCallIds: [], ...(resolved[i].candidates.length ? { candidates: resolved[i].candidates } : {}) };
        u.rollCallIds.push(id);
        unmatched.set(key, u);
      }
      const rc: LocalRollCall = {
        id,
        assemblyId: TOTTORI_ASSEMBLY.id,
        sessionId: session.sessionId,
        sessionLabel: session.sessionLabel,
        date: pdf.date,
        kind: row.kind,
        number: row.number,
        title: row.title,
        method: { raw: row.methodText, legend: row.methodText },
        result: row.result,
        counts: { voting: row.counts.voting, yes: row.counts.yes, no: row.counts.no },
        ...(row.voteSubject !== undefined ? { voteSubject: row.voteSubject } : {}),
        ...(row.committeeReport !== undefined ? { committeeReport: row.committeeReport } : {}),
        votes,
        page: row.page,
        sourceUrl: pdfUrl,
      };
      byId.set(id, { rc, fingerprint });
      order.push(id);
    }
  }
  const rollCalls = order.map((id) => byId.get(id)!.rc);
  for (const rc of rollCalls) if (rc.title === "") throw new Error(`${rc.id}: title is empty in every PDF`);
  return { rollCalls, unmatched: [...unmatched.values()] };
}
