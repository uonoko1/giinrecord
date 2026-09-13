import type { LocalMember, LocalRollCall, LocalUnmatchedName, LocalVote, VoteValue } from "@seiji-kiroku/shared";
import { isoDate, SAGA_ASSEMBLY } from "./site.ts";
import { legendOf, UNKNOWN_CELL, UNKNOWN_LEGEND, type VotePdf, type VotePdfMember } from "./votes-pdf.ts";
// 氏名の突き合わせは 11 県で共通（#636）。佐賀の PDF はフルネーム（縦書き）。
import { localNameKey as nameKey, matchBySubsequence as matchName } from "../name-match.ts";

export { nameKey, matchName };

/**
 * 佐賀県議会「議案採決結果一覧表」PDF の行 → LocalRollCall（Issue #768）。
 *
 * - **名寄せ**: PDF の氏名（縦書きを結合）と名簿の氏名を、空白と異体字セレクタを除き
 *   字形違い（髙/高・﨑/崎・𠮷/吉）を寄せた完全一致で。完全一致が無いときだけ部分列一致で
 *   1 人に決まれば寄せる（`matchBySubsequence`。10 県と同じ）。
 * - **id**: `{assemblyId}-{sessionId}-{議決日 yyyymmdd}-{議案番号}`。
 *   **番号が空の行が 11 行ある**（意見書案で番号と件名が 1 アイテムに入る）ので、
 *   **番号が空なら件名から作る**（秋田 #759 と同じ）。
 *   同じ議決日で同じ id の行が複数なら全部に `-1`, `-2` … を足す（10 県と同じ規則）。
 * - **議決日**: **表の見出しの `M月D日採決` と、PDF の表題の和暦の年。**
 *   **1 本の PDF に議決日が 2 つある本がある**（令和5年11月定: 12月20日 と 12月21日）。
 *   **年またぎに注意**——**11月定例会の議決が12月、令和5年11月定は 12月20日/21日**。
 *   **会期の月より 6 か月以上前の月なら翌年**（docs/DATA_CONTRACT.md。宮城・滋賀・青森・秋田と同じ）。
 *
 * ## **氏名の食い違いを片方に決めない**（#711 の `sourceConflict`。**この議会の要点**）
 * **一次資料どうしが 2 人ぶん食い違っている**（#670 / #765 が数え、この PR が 16 本で確かめた）:
 *   - **`猪村利恵子`（利 U+5229）10 会期 / `猪村理恵子`（理 U+7406）3 会期**
 *     （この PR の実測: 読める 16 本のうち `利` 10 本・`理` 3 本・どちらも無い 3 本）
 *   - **`桃崎祐介`（祐 U+7950）14 会期 / `桃崎裕介`（裕 U+88D5）2 会期**
 * **議員一覧ページはどちらも多数側**（`猪村利恵子` / `桃崎祐介`）。
 * **日付では切れない**——**`裕` の 2 本（令和7年4月臨・令和8年4月臨）は `利` と書く 2 本と同じ本で、
 * その前後の定例会が `理` を使う。** **「事務局が直近で改めた」ではない**（#670 の仮説は否定された）。
 *
 * **`localNameKey` はこれを畳まない**（別の漢字であって字形違いではない。`ITAIJI` の docblock）。
 * **`matchBySubsequence` も寄せない**（長さが同じで 1 文字違うので部分列にならない）。
 * **だから `memberId` が空のまま `unmatched.json` に落ち、`buildLocalAssembly` が
 * `reason: "sourceConflict"` を付ける**（#711）。**どちらが正しいかは議会に確かめる。**
 * **少数側に寄せることも、多数側に寄せることもしない**——
 * **1 文字違いは同一人物の根拠にならない**（本番の地方名簿に現職どうしの 1 文字違いが 3 組ある）。
 */

/**
 * 凡例の意味の原文 → 国会の値。
 *
 * **佐賀の凡例に出る語は 6 つだけ**（この PR が 16 本で数えた）:
 *   `賛成` `反対` `退席` `欠席` `議長` `除席` `地方自治法第117条による除斥`
 *
 * ## **`除席` と `除斥` を同じにしない**
 * **令和5年5月臨（前半）は `除：地方自治法第117条による除斥`、
 * 令和6年4月臨・令和7年4月臨・令和8年4月臨は `除：除席`**（実測。#689 / #765 も同じ）。
 * **字が違う。どちらも原文。丸めない。**
 * **`除斥` は地方自治法第117条の用語で「利害関係があるので議事に加われない」、
 * `除席` はその語としては条文に無い。** **どちらも「表決に加わっていない」＝ `投票なし` に落ちるが、
 * `legend` には原文をそのまま残す**ので、後から区別できる。
 *
 * ## **`退席` は `投票なし`**
 * **「議場から出た」であって「反対」ではない。** **賛否のどちらにも寄せない。**
 *
 * ## **`議長` は `投票なし`**（10 県と同じ）
 * **ただし「議長は採決に加わらない」と決め打ちしていない**——**この PR の実測で、
 * 令和5年11月定の再議の 1 行だけ `議` が 1 つも無く、37 人全員が `○`/`×` を出している**
 * （議決者数 37・賛成18・反対19）。**記号をそのまま読むので、その行は 37 人ぶんの票になる。**
 */
const MAPPED: Record<string, VoteValue> = {
  "賛成": "賛成",
  "反対": "反対",
  "議長": "投票なし",
  "欠席": "投票なし",
  "退席": "投票なし",
  "除席": "投票なし",
  "地方自治法第117条による除斥": "投票なし",
};

export function mapLegend(raw: string, legend: string): LocalVote {
  const mapped = raw === UNKNOWN_CELL || legend === UNKNOWN_LEGEND ? undefined : MAPPED[legend];
  return mapped ? { raw, legend, mapped } : { raw, legend };
}

export interface SessionInfo {
  sessionId: string;
  /** 会期の名前の原文（`令和8年6月定例会`） */
  sessionLabel: string;
  /** 会期の西暦（年またぎの判定に使う） */
  year: number;
  /** 会期の月（年またぎの判定に使う） */
  month: number;
}

export interface PdfSource {
  pdf: VotePdf;
  pdfUrl: string;
}

/**
 * 議決日（PDF の表の見出しの月日）と会期の年から ISO 日付。
 * **会期の月より 6 か月以上前の月は翌年**（11月定例会の 1月議決。docs/DATA_CONTRACT.md）。
 */
export function resolveDate(session: { year: number; month: number }, month: number, day: number): string {
  const year = session.month - month >= 6 ? session.year + 1 : session.year;
  return isoDate(year, month, day);
}

/** id に使えない文字（区切りと空白）を落とす。原文は `number` / `title` に残る。 */
const idPart = (s: string): string => s.replace(/[\s　/\\]/g, "");

export interface Converted {
  rollCalls: LocalRollCall[];
  unmatched: LocalUnmatchedName[];
  /** **字が落ちたまま名簿に寄った氏名**（`meta.lossyNameMatches`。青森 #749 の機序 ②） */
  lossy: { nameText: string; memberId: string; rosterName: string; rollCalls: number }[];
}

export function toLocalRollCalls(sources: readonly PdfSource[], roster: readonly LocalMember[], session: SessionInfo): Converted {
  const rollCalls: LocalRollCall[] = [];
  const baseIds = new Map<string, number>();
  const matchOf = new Map<string, ReturnType<typeof matchName>>();
  const lossy = new Map<string, { nameText: string; memberId: string; rosterName: string; rollCalls: number }>();
  /** 氏名 → 名寄せの結果（同じ氏名を 2 回引かない） */
  const resolve = (m: VotePdfMember) => {
    const key = `${m.nameText}\t${m.group}`;
    const hit = matchOf.get(key) ?? matchName(m.nameText, roster);
    matchOf.set(key, hit);
    return hit;
  };
  for (const { pdf, pdfUrl } of sources) {
    for (const [i, row] of pdf.rows.entries()) {
      const date = resolveDate(session, row.month, row.day);
      // **番号が空の行は件名で代える。どちらも空なら例外**（名の無い採決は出さない）
      const key = row.number !== "" ? row.number : row.title;
      if (key === "") throw new Error(`${pdfUrl}: page ${row.page}: 議案番号も件名も空の行がある`);
      const base = `${SAGA_ASSEMBLY.id}-${session.sessionId}-${date.replace(/-/g, "")}-${idPart(key)}`;
      baseIds.set(base, (baseIds.get(base) ?? 0) + 1);
      // **議員の並びは表ごとに違う**（`rowMembers[i]`。`pdf.members` を使わない）
      const members = pdf.rowMembers[i];
      const votes: LocalRollCall["votes"] = row.cells.map((raw, k) => {
        const legend = legendOf(raw, pdf.legend.votes);
        const member = members[k];
        return { memberId: resolve(member).memberId, nameText: member.nameText, group: member.group, value: mapLegend(raw, legend) };
      });
      rollCalls.push({
        id: base,
        assemblyId: SAGA_ASSEMBLY.id,
        sessionId: session.sessionId,
        sessionLabel: session.sessionLabel,
        date,
        // **佐賀の PDF に議案種別の欄は無い**（番号の欄に `甲第36号議案` `乙第46号議案` `議第３号議案`
        // `意第５号意見書案` `請第１号請願` と種別が混ざる）。**それを種別に起こすのは推定である**ので、
        // **この議会が公表している単位（列見出しが `議案番号`）をそのまま書く**
        kind: "議案",
        number: row.number,
        title: row.title,
        result: row.result,
        // **表決方法の欄は無い**（宮城・秋田にはある）。**`method` を書かない**（無いものを作らない）
        // **集計欄が読めない行では `counts` を書かない**（-1 のような値を作らない。#569）。
        // **実測 2026-09-13: 505 行すべてで 賛成・反対・議決者数・出席者数が読める**
        ...(countsOf(row.counts) ?? {}),
        votes,
        page: row.page,
        sourceUrl: pdfUrl,
      });
    }
    // **字が落ちたまま寄った氏名**を数える（青森 #749 の機序 ②。`meta.lossyNameMatches`）
    const seen = new Set<string>();
    for (const [i, row] of pdf.rows.entries()) {
      for (const m of pdf.rowMembers[i]) {
        if (seen.has(m.nameText)) continue;
        seen.add(m.nameText);
        const hit = resolve(m);
        if (hit.memberId === "") continue;
        const r = roster.find((x) => x.id === hit.memberId);
        if (!r || nameKey(m.nameText) === nameKey(r.name)) continue;
        const k = `${m.nameText}\t${hit.memberId}`;
        const cur = lossy.get(k) ?? { nameText: m.nameText, memberId: hit.memberId, rosterName: r.name, rollCalls: 0 };
        cur.rollCalls += pdf.rows.length;
        lossy.set(k, cur);
      }
      void row;
    }
  }
  // 同じ議決日で同じ id の行が複数なら、出た順に全部へ -1, -2 … を足す（10 県と同じ規則）
  const seenId = new Map<string, number>();
  for (const rc of rollCalls) {
    if ((baseIds.get(rc.id) ?? 0) <= 1) continue;
    const n = (seenId.get(rc.id) ?? 0) + 1;
    seenId.set(rc.id, n);
    rc.id = `${rc.id}-${n}`;
  }
  // 名簿に寄せられなかった氏名
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
  // **`reason` はここでは付けない**——`buildLocalAssembly` が 11 県すべてを通る 1 か所で付ける
  // （県ごとに書くと足し忘れが黙って落ちる。#680 の判断）。ここは候補だけ写す。
  const unmatchedList = [...unmatched.values()].map((u) => {
    const match = matchOf.get(`${u.nameText}\t${u.group}`);
    return { ...u, ...(match && match.candidates.length > 0 ? { candidates: match.candidates } : {}) };
  });
  return { rollCalls, unmatched: unmatchedList, lossy: [...lossy.values()] };
}

/** 集計欄の原文（`37` `0`。**全角もありうる**）→ 数。読めなければ undefined（推定しない）。 */
export function numberOf(text: string): number | undefined {
  if (text.replace(/[\s　]/g, "") === "") return undefined;
  const n = Number(text.normalize("NFKC").replace(/[\s　]/g, ""));
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * 集計欄 → `LocalRollCall.counts`。**賛成と反対の両方が読めたときだけ**返す
 * （型が `yes` / `no` を必須にしているので、片方だけでは書けない）。
 * **`present` / `voting` は読めたぶんだけ足す。**
 */
export function countsOf(c: { present: string; voting: string; yes: string; no: string }): { counts: NonNullable<LocalRollCall["counts"]> } | undefined {
  const yes = numberOf(c.yes);
  const no = numberOf(c.no);
  if (yes === undefined || no === undefined) return undefined;
  const present = numberOf(c.present);
  const voting = numberOf(c.voting);
  return { counts: { yes, no, ...(present !== undefined ? { present } : {}), ...(voting !== undefined ? { voting } : {}) } };
}
