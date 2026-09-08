import type { LocalMember, LocalRollCall, LocalUnmatchedName, LocalVote, VoteValue } from "@seiji-kiroku/shared";
import { SHIMANE_ASSEMBLY } from "./site.ts";
import { UNKNOWN_CELL, UNKNOWN_LEGEND, type ResultRow, type VotePdf } from "./votes-pdf.ts";
// 氏名の突き合わせは 7 県で共通（#636）。島根の PDF はフルネームで文字層の欠落が無いので完全一致のみ。
import { localNameKey as nameKey, matchByExact as matchName, type NameMatch } from "../name-match.ts";
// 字形の揺れ（〇 U+3007・✕ U+2715）は凡例を引くときだけ寄せる。raw は原文のまま（#674）。
import { legendKey } from "../glyph-variants.ts";

export type { NameMatch };
export { nameKey, matchName };

/**
 * 島根県議会の表決 PDF の行 → LocalRollCall（Issue #221）。
 * - 名寄せ: PDF の氏名（縦書きを結合したフルネーム）と名簿の氏名を、空白と異体字セレクタを除き
 *   字形違い（德/徳・髙/高 …）を寄せた上での完全一致で。同姓が複数いてもフルネームなので取り違えない。
 *   決まらなければ memberId "" のまま候補を列挙する（選ばない）。
 * - 議決日: 議員別採決結果一覧 PDF には書かれていないので、同じ会期ページの「議決結果一覧」PDF から議案番号ごとに読む。
 *   請願・その他表決は議決結果一覧に載らないので、その会期の最終議決日（議案の議決日のうち最新）を使う。
 * - 付託委員会は捨てずに referredCommittees に原文のまま全部入れる（予算案は 4 常任委員会すべてに付託される）。
 * - counts は PDF の賛成者数・反対者数の公表値（votes から数え直さない）。表決者数・出席者数は公表されていないので付けない。
 * - 請願の賛否は PDF の※注記のとおり「付託先委員会の報告」に対するもの。○ を請願そのものへの賛成と読ませないために
 *   voteSubject / committeeReport に残す（鳥取 #184 と同じ扱い）。
 * - 表決方法（起立・簡易）の欄は PDF に無いので method は付けない（推定しない）。
 */

/** 凡例の意味の原文 → 国会の値。「票を投じていない」と凡例が言う意味は 投票なし。 */
const MAPPED: Record<string, VoteValue> = {
  "賛成": "賛成",
  "反対": "反対",
  "議長": "投票なし",
  "欠席等による不在": "投票なし",
  "議案と一定の利害関係を有する議員": "投票なし",
};

export function mapLegend(raw: string, legend: string): LocalVote {
  const mapped = raw === UNKNOWN_CELL ? undefined : MAPPED[legend];
  return mapped ? { raw, legend, mapped } : { raw, legend };
}

/**
 * セルの原文 → 凡例の意味。字形の揺れ（〇 U+3007 → ○ U+25CB など）は寄せてから引く（#674）。
 * 寄せても凡例に無ければ例外（丸めない・推定しない。#569）。raw は原文のまま呼び出し側に返る。
 */
export function legendOf(raw: string, legend: ReadonlyMap<string, string>, label: string): string {
  if (raw === UNKNOWN_CELL) return UNKNOWN_LEGEND;
  const meaning = legend.get(legendKey(raw));
  if (!meaning) throw new Error(`${label}: cell "${raw}" is not in the legend (${[...legend.keys()].join("")})`);
  return meaning;
}

export interface SessionInfo {
  sessionId: string;
  /** 会期 index のリンク文言（「令和8年6月定例会（第499回）」） */
  sessionLabel: string;
}

export interface PdfSource {
  pdf: VotePdf;
  pdfUrl: string;
}

export interface Dates {
  /** 議決結果一覧 PDF から読んだ議案番号ごとの議決日・議決結果 */
  results: Map<string, ResultRow>;
  /** 議決結果一覧に載らない行（請願・その他表決）に使う、その会期の最終議決日（ISO） */
  lastDate: string;
}

/** 請願の賛否の対象（PDF の※注記の言い換えではなく、注記が言っていることをそのまま短く書いたもの）。 */
const PETITION_SUBJECT = "付託先委員会の報告に対する賛否";

export function toLocalRollCalls(
  sources: readonly PdfSource[],
  roster: readonly LocalMember[],
  session: SessionInfo,
  dates: Dates,
): { rollCalls: LocalRollCall[]; unmatched: LocalUnmatchedName[] } {
  const rollCalls: LocalRollCall[] = [];
  const unmatched = new Map<string, LocalUnmatchedName>();
  const baseIds = new Map<string, number>();
  const candidateByName = new Map<string, { id: string; name: string }[]>();
  // 議決結果一覧の議案番号を全角・半角を寄せた形（NFKC）で引けるようにする
  const resultsByNumber = new Map([...dates.results].map(([number, row]) => [number.normalize("NFKC"), row] as const));
  for (const { pdf, pdfUrl } of sources) {
    const resolved = pdf.members.map((m) => matchName(m, roster));
    pdf.members.forEach((m, i) => {
      if (resolved[i].memberId === "" && resolved[i].candidates.length > 0) candidateByName.set(m, resolved[i].candidates);
    });
    for (const row of pdf.rows) {
      // 議決日: 議案は議決結果一覧から、載らない行（請願・その他表決）は会期の最終議決日。
      // 番号の突き合わせは全角・半角を寄せて（NFKC）行う。同じ会期でも 2 本の PDF で
      // 数字の全角・半角が違うことがある（令和8年2月は議員別が「承認第１号」、議決結果一覧が「承認第1号」）。
      const hit = resultsByNumber.get(row.number.normalize("NFKC"));
      if (hit && hit.result !== row.result) {
        throw new Error(`${row.number}: 議決結果 differs: 議員別採決結果一覧 "${row.result}" vs 議決結果一覧 "${hit.result}"`);
      }
      const date = hit?.date ?? dates.lastDate;
      const ymd = date.replace(/-/g, "");
      if (/[\s/\\]/.test(row.kind + row.number)) throw new Error(`${pdfUrl}: kind/number "${row.kind} ${row.number}" cannot be used in an id`);
      const base = `${SHIMANE_ASSEMBLY.id}-${session.sessionId}-${ymd}-${row.kind}-${row.number}`;
      baseIds.set(base, (baseIds.get(base) ?? 0) + 1);
      const votes: LocalRollCall["votes"] = row.cells.map((raw, i) => {
        const legend = legendOf(raw, pdf.legend, base);
        const name = pdf.members[i];
        const member = roster.find((m) => m.id === resolved[i].memberId);
        return { memberId: resolved[i].memberId, nameText: name, group: member?.group ?? "", value: mapLegend(raw, legend) };
      });
      // 請願は「付託先委員会の報告」に対する賛否（PDF の※注記）。委員長報告の内容は採決結果の原文と同じ
      const isPetition = row.kind === "請願";
      rollCalls.push({
        id: base,
        assemblyId: SHIMANE_ASSEMBLY.id,
        sessionId: session.sessionId,
        sessionLabel: session.sessionLabel,
        date,
        kind: row.kind,
        number: row.number,
        title: row.title,
        referredCommittees: row.referredCommittees,
        result: row.result,
        counts: { yes: row.counts.yes, no: row.counts.no },
        ...(isPetition ? { voteSubject: PETITION_SUBJECT, committeeReport: row.result } : {}),
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
  // 名簿に寄せられなかった氏名: memberId 空の票から
  for (const rc of rollCalls) {
    for (const v of rc.votes) {
      if (v.memberId !== "") continue;
      const key = `${v.nameText}\t${v.group}`;
      const u = unmatched.get(key) ?? { nameText: v.nameText, group: v.group, rollCallIds: [] };
      if (!u.rollCallIds.includes(rc.id)) u.rollCallIds.push(rc.id);
      unmatched.set(key, u);
    }
  }
  const unmatchedList = [...unmatched.values()].map((u) => {
    const c = candidateByName.get(u.nameText);
    return c ? { ...u, candidates: c } : u;
  });
  return { rollCalls, unmatched: unmatchedList };
}
