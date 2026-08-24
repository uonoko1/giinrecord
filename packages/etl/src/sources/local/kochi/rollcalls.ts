import type { LocalMember, LocalRollCall, LocalUnmatchedName, LocalVote, VoteValue } from "@seiji-kiroku/shared";
import { isoDate, KOCHI_ASSEMBLY } from "./site.ts";
import { UNKNOWN_CELL, UNKNOWN_LEGEND, type VotePdf } from "./votes-pdf.ts";

/**
 * 高知県議会の表決 PDF の行 → LocalRollCall（Issue #220）。
 * - 名寄せ: PDF の氏名（縦書きを結合）と名簿の氏名を、空白と異体字セレクタを除き字形違い（髙/高・﨑/崎・𠮷/吉）を
 *   寄せた上での完全一致で。完全一致が無いときだけ、部分列一致（名簿の氏名に PDF の氏名が順序どおり含まれる）で
 *   1 人に決まれば寄せる。2 人以上なら候補を列挙して memberId "" のまま（選ばない）。
 * - id は {assemblyId}-{sessionId}-{議決日 yyyymmdd}-{種別}-{番号}。同じ議決日・種別で同じ番号の行が複数なら
 *   全部に -1, -2 … を足す（徳島・奈良と同じ）。
 * - 議決年月日の「〃」は「上の行と同じ」という意味なので、日付（ISO）は上の行から継ぐ。
 *   セルの原文は VotePdfRow.dateText に「〃」のまま残っている（原文は捨てない）。
 * - 表決方法・人数の欄は LocalRollCall には無いので method は書かない（推定しない）。
 * - mapped: 凡例の文言が下の表と完全一致するときだけ（docs/DATA_CONTRACT.md）。
 */

/** 凡例の意味の原文 → 国会の値。「票を投じていない」と凡例が言う意味は 投票なし。 */
const MAPPED: Record<string, VoteValue> = {
  "賛成": "賛成",
  "反対": "反対",
  "議長": "投票なし",
  "副議長が議長の職務を代理": "投票なし",
  "欠席": "投票なし",
  "除斥": "投票なし",
  "議場に不在であった議員": "投票なし",
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
 * PDF の氏名 → 名簿。完全一致（nameKey）が 1 人ならその人。0 人なら「名簿の氏名に PDF の氏名が順序どおり
 * 部分列として含まれる」議員が 1 人に決まるときだけ寄せる（文字層に落ちる字があるため）。
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
  /** 会期 index のリンク文言（「令和８年６月定例会」）。PDF の表題と一致しなければ例外 */
  sessionLabel: string;
}

export interface PdfSource {
  pdf: VotePdf;
  pdfUrl: string;
}

/** 議決年月日の原文（「R8.7.10」）→ ISO。「〃」は上の行から継ぐので呼ぶ側で解決する。 */
const DATE = /^R([0-9]+)\.([0-9]+)\.([0-9]+)$/;
const DITTO = /^[〃″”]$/;

export function parseDateText(text: string): string | undefined {
  const m = text.normalize("NFKC").replace(/[\s　]/g, "").match(DATE);
  if (!m) return undefined;
  // R = 令和
  return isoDate(2018 + Number(m[1]), Number(m[2]), Number(m[3]));
}

export function toLocalRollCalls(sources: readonly PdfSource[], roster: readonly LocalMember[], session: SessionInfo): { rollCalls: LocalRollCall[]; unmatched: LocalUnmatchedName[] } {
  const rollCalls: LocalRollCall[] = [];
  const baseIds = new Map<string, number>();
  for (const { pdf, pdfUrl } of sources) {
    if (pdf.sessionLabel !== session.sessionLabel) throw new Error(`${pdfUrl}: PDF says ${pdf.sessionLabel}, session index says ${session.sessionLabel}`);
    const resolved = pdf.members.map((m) => matchName(m.nameText, roster));
    let date: string | undefined;
    for (const row of pdf.rows) {
      // 「〃」は上の行と同じ日。最初の行が「〃」なら継ぐ先が無いので例外
      if (DITTO.test(row.dateText)) {
        if (!date) throw new Error(`${pdfUrl}: ${row.number}: 議決年月日が「${row.dateText}」だが上の行が無い`);
      } else {
        const parsed = parseDateText(row.dateText);
        if (!parsed) throw new Error(`${pdfUrl}: ${row.number}: 議決年月日 "${row.dateText}" が読めない`);
        date = parsed;
      }
      if (/[\s/\\]/.test(row.kind + row.number)) throw new Error(`${pdfUrl}: kind/number "${row.kind} ${row.number}" cannot be used in an id`);
      const base = `${KOCHI_ASSEMBLY.id}-${session.sessionId}-${date.replace(/-/g, "")}-${row.kind}-${row.number}`;
      baseIds.set(base, (baseIds.get(base) ?? 0) + 1);
      const votes: LocalRollCall["votes"] = row.cells.map((raw, i) => {
        const legend = raw === UNKNOWN_CELL ? UNKNOWN_LEGEND : pdf.legend.votes[raw];
        if (!legend) throw new Error(`${base}: cell "${raw}" is not in the legend`);
        const member = pdf.members[i];
        return { memberId: resolved[i].memberId, nameText: member.nameText, group: member.group, value: mapLegend(raw, legend) };
      });
      rollCalls.push({
        id: base,
        assemblyId: KOCHI_ASSEMBLY.id,
        sessionId: session.sessionId,
        sessionLabel: session.sessionLabel,
        date,
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
  // 同じ議決日・種別で同じ番号の行が複数なら、出た順に全部へ -1, -2 … を足す（徳島・奈良と同じ規則）
  const seen = new Map<string, number>();
  for (const rc of rollCalls) {
    if ((baseIds.get(rc.id) ?? 0) <= 1) continue;
    const n = (seen.get(rc.id) ?? 0) + 1;
    seen.set(rc.id, n);
    rc.id = `${rc.id}-${n}`;
  }
  // 名簿に寄せられなかった氏名: rollCalls の memberId 空の票から（候補は matchName の結果を写す）
  const unmatched = new Map<string, LocalUnmatchedName>();
  for (const rc of rollCalls) {
    for (const v of rc.votes) {
      if (v.memberId !== "") continue;
      const key = `${v.nameText}\t${v.group}`;
      const u = unmatched.get(key) ?? { nameText: v.nameText, group: v.group, rollCallIds: [] };
      if (!u.rollCallIds.includes(rc.id)) u.rollCallIds.push(rc.id);
      unmatched.set(key, u);
    }
  }
  // 候補を付ける（同姓が 2 人以上など、選べなかったとき）
  const candidateByName = new Map<string, { id: string; name: string }[]>();
  for (const { pdf } of sources) {
    for (const m of pdf.members) {
      const match = matchName(m.nameText, roster);
      if (match.memberId === "" && match.candidates.length > 0) candidateByName.set(`${m.nameText}\t${m.group}`, match.candidates);
    }
  }
  const unmatchedList = [...unmatched.values()].map((u) => {
    const c = candidateByName.get(`${u.nameText}\t${u.group}`);
    return c ? { ...u, candidates: c } : u;
  });
  return { rollCalls, unmatched: unmatchedList };
}
