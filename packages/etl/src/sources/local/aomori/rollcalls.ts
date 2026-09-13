import type { LocalMember, LocalRollCall, LocalUnmatchedName, LocalVote, VoteValue } from "@seiji-kiroku/shared";
import { AOMORI_ASSEMBLY, isoDate } from "./site.ts";
import { legendOf, UNKNOWN_CELL, UNKNOWN_LEGEND, type VotePdf } from "./votes-pdf.ts";
// 氏名の突き合わせは 9 県で共通（#636）。青森の PDF はフルネーム（縦書き 1 文字 1 アイテム）。
import { localNameKey as nameKey, matchBySubsequence as matchName } from "../name-match.ts";

export { nameKey, matchName };

/**
 * 青森県議会「議決結果」PDF の行 → LocalRollCall（Issue #750）。
 *
 * - **名寄せ**: PDF の氏名（縦書きを結合）と名簿の氏名を、空白と異体字セレクタを除き
 *   字形違い（髙/高・﨑/崎・𠮷/吉）を寄せた完全一致で。完全一致が無いときだけ部分列一致で
 *   1 人に決まれば寄せる（`matchBySubsequence`。8 県と同じ）。
 * - **`unmatched.json` の理由**（`brokenGlyph` / `sourceConflict`）は `buildLocalAssembly` が付ける。
 *   **青森では `噰引ユキ子`（`櫛` U+6ADB が `噰` U+5670 に化ける。第322〜325回の 4 本）が
 *   `sourceConflict` で捕まる**（#749 の機序 ③）。**`和田寛司`（PDF）も名簿の `和田寬司` と
 *   1 文字違いなので `sourceConflict`**（#529 が見つけた罠。**寛 U+5BDB / 寬 U+5BEC は別字なので
 *   `localNameKey` は畳まない。畳んではいけない**）。
 * - **`噰` を `櫛` に戻さない。`寛` を `寬` に寄せない**（推定であり別人の記録を作る側。#569／#674）。
 * - **id**: `{assemblyId}-{sessionId}-{議決日 yyyymmdd}-{議案等番号}`。
 *   **番号が空の行がある**（`276` は 46 行中 12 行、`287` は 9 行。**番号と件名が 1 アイテムに
 *   繋がっているため**）ので、**番号が空なら件名から作る。**
 *   同じ議決日で同じ id の行が複数なら全部に `-1`, `-2` … を足す（8 県と同じ規則）。
 * - **議決日**: PDF の `6/29` と、**会期の年**（index の見出し。**PDF に年が無い会期が 4 本ある**。#743）。
 *   **年またぎに注意**——11月定例会の議決が翌年 1 月になることがあるので、
 *   会期の月より 6 か月以上前の月なら翌年にする（docs/DATA_CONTRACT.md の規則。宮城・滋賀と同じ）。
 * - **`継続審査` の行は採決にならない**——**記号が 1 つも無いので、`votes-pdf.ts` が行にしない**
 *   （記号の帯から行を作るため）。**「表決しなかった」を「全員が賛成しなかった」と読ませない。**
 *   **56 本中 3 本（`275` `279` `giketsukekka_27.09_283`）にある**（#529 が第275回で 5 行、#743 が 56 本で確認）。
 *   **ここで日付が読めずに落ちる行は、実測では 0 行である**（2,445 行すべてが `M/D`）。
 * - **`mapped`**: **凡例の文言が下の表と完全一致するときだけ**（docs/DATA_CONTRACT.md）。
 */

/**
 * 凡例の意味の原文 → 国会の値。**青森の凡例は 56 本で 1 字も変わらない**（#743 が 13 年ぶんで確認）:
 *   `賛否欄：「○」は賛成、「×」は反対、「議」は議長、「副」は副議長が議長の職務を代理、
 *    「除」は除斥、「欠」は欠席、「退」は退席`
 * **`副` は 56 本に 1 個も出ないが、凡例にあるのでここにも書く**（出たときに `抽出不能` にしない）。
 * **`-`（U+002D）は凡例に無い**ので、ここにも書かない——`抽出不能` のまま `mapped` は付かない（#569）。
 */
const MAPPED: Record<string, VoteValue> = {
  "賛成": "賛成",
  "反対": "反対",
  "議長": "投票なし",
  "副議長が議長の職務を代理": "投票なし",
  "除斥": "投票なし",
  "欠席": "投票なし",
  "退席": "投票なし",
};

export function mapLegend(raw: string, legend: string): LocalVote {
  const mapped = raw === UNKNOWN_CELL || legend === UNKNOWN_LEGEND ? undefined : MAPPED[legend];
  return mapped ? { raw, legend, mapped } : { raw, legend };
}

export interface SessionInfo {
  sessionId: string;
  /** index の見出しの原文（「令和8年6月第326回定例会」） */
  sessionLabel: string;
  /** 会期の西暦（年またぎの判定に使う。**PDF に年が無い会期があるので index から来る**） */
  year: number;
  /** 会期の月（年またぎの判定に使う） */
  month: number;
}

export interface PdfSource {
  pdf: VotePdf;
  pdfUrl: string;
}

/**
 * PDF の議決日（月・日）と会期の年から ISO 日付。
 * **会期の月より 6 か月以上前の月は翌年**（11月定例会の 1月議決。docs/DATA_CONTRACT.md）。
 */
export function resolveDate(session: { year: number; month: number }, month: number, day: number): string {
  const year = session.month - month >= 6 ? session.year + 1 : session.year;
  return isoDate(year, month, day);
}

/** 議決月日の欄の原文（「6/29」）→ 月・日。読めなければ undefined（`継続審査` など。推定しない）。 */
export function parseDateText(text: string): { month: number; day: number } | undefined {
  const m = text.normalize("NFKC").replace(/[\s　]/g, "").match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return undefined;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return { month, day };
}

/** id に使えない文字（区切りと空白）を落とす。原文は `number` / `title` に残る。 */
const idPart = (s: string): string => s.replace(/[\s　/\\]/g, "");

export interface Converted {
  rollCalls: LocalRollCall[];
  unmatched: LocalUnmatchedName[];
  /** **字が落ちたまま名簿に寄った氏名**（`meta.lossyNameMatches`。#749 の機序 ②） */
  lossy: { nameText: string; memberId: string; rosterName: string; rollCalls: number }[];
  /**
   * **議決日が読めなくて採決にしなかった行**の数。
   * **実測では 56 本 2,445 行すべてが `M/D` で、0 である**（2026-09-13）。
   * **`継続審査` の行はここに来ない**——**記号が 1 つも無いので、そもそも `rows` にならない**
   * （`votes-pdf.ts` は記号の帯から行を作る）。**「表決しなかった」を「全員が賛成しなかった」と
   * 読ませない**という目的は、そちらで満たされている。
   * **ここは「議決日の欄が別の形になった会期」が出たときに気づくための数である。**
   */
  skippedRows: number;
}

export function toLocalRollCalls(sources: readonly PdfSource[], roster: readonly LocalMember[], session: SessionInfo): Converted {
  const rollCalls: LocalRollCall[] = [];
  const baseIds = new Map<string, number>();
  const matchOf = new Map<string, ReturnType<typeof matchName>>();
  const lossy = new Map<string, { nameText: string; memberId: string; rosterName: string; rollCalls: number }>();
  let skippedRows = 0;
  for (const { pdf, pdfUrl } of sources) {
    const resolved = pdf.members.map((m) => {
      const hit = matchName(m.nameText, roster);
      matchOf.set(`${m.nameText}\t${m.group}`, hit);
      return hit;
    });
    for (const row of pdf.rows) {
      // **議決日が読めない行は採決にしない**（`継続審査`。**表決していない**）。
      // **日付の無い記録を出さない**（#529 の観察を 56 本で確かめたうえでの判断）
      const md = parseDateText(row.dateText);
      if (!md) { skippedRows++; continue; }
      const date = resolveDate(session, md.month, md.day);
      // **番号が空の行がある**（番号と件名が 1 アイテムに繋がる本。docblock）ので件名で代える。
      // **どちらも空なら例外**（名の無い採決は出さない）
      const key = row.number !== "" ? row.number : row.title;
      if (key === "") throw new Error(`${pdfUrl}: page ${row.page}: 議案等番号も件名も空の行がある`);
      const base = `${AOMORI_ASSEMBLY.id}-${session.sessionId}-${date.replace(/-/g, "")}-${idPart(key)}`;
      baseIds.set(base, (baseIds.get(base) ?? 0) + 1);
      const votes: LocalRollCall["votes"] = row.cells.map((raw, i) => {
        const legend = legendOf(raw, pdf.legend.votes);
        const member = pdf.members[i];
        return { memberId: resolved[i].memberId, nameText: member.nameText, group: member.group, value: mapLegend(raw, legend) };
      });
      rollCalls.push({
        id: base,
        assemblyId: AOMORI_ASSEMBLY.id,
        sessionId: session.sessionId,
        sessionLabel: session.sessionLabel,
        date,
        // **青森の PDF に議案種別の欄は無い。推定しない**ので、この議会が公表している単位
        // （「議案等」）をそのまま書く。件名の中に「意見書（案）」「請願書」などは出るが、
        // **それを種別に起こすのは推定である**
        kind: "議案等",
        number: row.number,
        title: row.title,
        result: row.result,
        // **表決方法の欄がある**（56 本の実測で `起立` 2,333 / `簡易` 111 / `記名投票` 1 の 3 通り）。
        // **原文のまま。PDF に表決方法の凡例は無い**ので `legend` も原文を入れる（鳥取と同じ扱い）。
        // **「簡易だから個人票が無い」と決め打ちしない**——**青森は簡易でも全員ぶんの記号が入る**
        // （#529 が第326回の 5 行で実測し、#743 が 46 本に `簡易` があることを確かめた）。
        // **島根は簡易に個人票が無いので別扱いにしている**が、**青森で同じことをすると
        // 実在する 111 行の個人票を捨てることになる。**
        ...(row.method !== "" ? { method: { raw: row.method, legend: row.method } } : {}),
        ...(row.counts ? { counts: { yes: row.counts.yes, no: row.counts.no, voting: row.counts.voting } } : {}),
        votes,
        page: row.page,
        sourceUrl: pdfUrl,
      });
    }
    // **字が落ちたまま寄った氏名**を数える（#749 の機序 ②。`meta.lossyNameMatches`）
    for (let i = 0; i < pdf.members.length; i++) {
      const hit = resolved[i];
      if (hit.memberId === "") continue;
      const m = roster.find((r) => r.id === hit.memberId);
      if (!m || nameKey(pdf.members[i].nameText) === nameKey(m.name)) continue;
      const k = `${pdf.members[i].nameText}\t${hit.memberId}`;
      const cur = lossy.get(k) ?? { nameText: pdf.members[i].nameText, memberId: hit.memberId, rosterName: m.name, rollCalls: 0 };
      cur.rollCalls += pdf.rows.length;
      lossy.set(k, cur);
    }
  }
  // 同じ議決日で同じ id の行が複数なら、出た順に全部へ -1, -2 … を足す（8 県と同じ規則）
  const seen = new Map<string, number>();
  for (const rc of rollCalls) {
    if ((baseIds.get(rc.id) ?? 0) <= 1) continue;
    const n = (seen.get(rc.id) ?? 0) + 1;
    seen.set(rc.id, n);
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
  // **`reason` はここでは付けない**——`buildLocalAssembly` が 9 県すべてを通る 1 か所で付ける
  // （県ごとに書くと足し忘れが黙って落ちる。#680 の判断）。ここは候補だけ写す。
  const unmatchedList = [...unmatched.values()].map((u) => {
    const match = matchOf.get(`${u.nameText}\t${u.group}`);
    return { ...u, ...(match && match.candidates.length > 0 ? { candidates: match.candidates } : {}) };
  });
  return { rollCalls, unmatched: unmatchedList, lossy: [...lossy.values()], skippedRows };
}
