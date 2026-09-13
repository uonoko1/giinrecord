import type { LocalMember, LocalRollCall, LocalUnmatchedName, LocalVote, VoteValue } from "@seiji-kiroku/shared";
import { AKITA_ASSEMBLY, isoDate } from "./site.ts";
import { legendOf, UNKNOWN_CELL, UNKNOWN_LEGEND, type VotePdf } from "./votes-pdf.ts";
// 氏名の突き合わせは 10 県で共通（#636）。秋田の PDF はフルネーム（縦書き）。
import { localNameKey as nameKey, matchBySubsequence as matchName } from "../name-match.ts";

export { nameKey, matchName };

/**
 * 秋田県議会「各議員の表決状況」PDF の行 → LocalRollCall（Issue #759）。
 *
 * - **名寄せ**: PDF の氏名（縦書きを結合）と名簿の氏名を、空白と異体字セレクタを除き
 *   字形違い（髙/高・﨑/崎・𠮷/吉）を寄せた完全一致で。完全一致が無いときだけ部分列一致で
 *   1 人に決まれば寄せる（`matchBySubsequence`。9 県と同じ）。
 *   **秋田には `高橋` 姓が字形違いで 3 人いる**（`高橋 健` U+9AD8 / `髙橋 豪`・`髙橋武浩` U+9AD9。
 *   #615 が実測）。**`localNameKey` は `髙` と `高` を寄せる**ので、
 *   **3 人が同じ鍵になり、名が違うことで分かれる**（`健` / `豪` / `武浩`）。
 *   **名が同じ 2 人が出たら `matchBySubsequence` が 1 人に決められず `unmatched.json` に落ちる**
 *   （**別人に寄せない**。#569）。
 * - **id**: `{assemblyId}-{sessionId}-{議決日 yyyymmdd}-{議案等番号}`。
 *   **番号が空の行がある**（`NUMBER_CELL` に当たらない行）ので、**番号が空なら件名から作る。**
 *   同じ議決日で同じ id の行が複数なら全部に `-1`, `-2` … を足す（9 県と同じ規則）。
 * - **議決日**: PDF の本文の `M月D日` と、**PDF の見出しの和暦の年**。
 *   **154 / 154 本の本文に `M月D日` があり、和暦の年も見出しにある**（#753）。
 *   **年またぎに注意**——11月・12月定例会の議決が翌年 1 月になることがあるので、
 *   会期の見出しの月より 6 か月以上前の月なら翌年にする（docs/DATA_CONTRACT.md。宮城・滋賀・青森と同じ）。
 *   **秋田の見出しには月が無い形もある**（`平成２９年第２回定例会（１２月２２日）` の括弧が無い本）ので、
 *   **見出しから月が取れないときは、その PDF の中の議決月日の最小の月を会期の月とみなす**（下記）。
 * - **`mapped`**: **凡例の文言が下の表と完全一致するときだけ**（docs/DATA_CONTRACT.md）。
 */

/**
 * 凡例の意味の原文 → 国会の値。
 *
 * **秋田の凡例は 4 通りある**（A 130 / B 10 / C 9 / D 5 本。#753 が数え、この実装が 154 本で確かめた）。
 * **その 4 通りに出る意味の原文は次の 7 つだけ**（実測 2026-09-13）:
 *   `賛成` `反対` `議長` `欠席` `棄権` `除斥` `議場に不在` — **A / B / C はこの中に収まる**
 *
 * ## **凡例 D の `－`＝「棄権又は議場に不在」は `mapped` を付けない**（**この PR の判断**）
 *
 * **`H231004giketu.pdf` `h2306giketu.pdf` `h231101giketu.pdf` `h231129giketu.pdf` `h231202giketu.pdf`
 * の 5 本は、凡例に `「－」：棄権又は議場に不在` と書いてある**（原文）。
 * **1 つの記号に 2 つの意味がある。**
 *
 * **「棄権」と「議場に不在」は別の事実である**——
 * **棄権は「議場に居て、賛否のどちらも示さなかった」、議場に不在は「議場に居なかった」。**
 * **どちらも `投票なし` に落ちるので、`mapped` だけを見るなら同じに見える**が、
 * **`mapped` を付けるのは「凡例の文言が表と完全一致したとき」という規約**（docs/DATA_CONTRACT.md）で、
 * **`棄権又は議場に不在` はこの表に無い。**
 * **だから `mapped` は付かず、`raw`（`－`）と `legend`（`棄権又は議場に不在`）だけが残る。**
 *
 * **滋賀（#741）は凡例そのものが無い PDF を `抽出不能` にした。秋田の D は違う扱いにする**——
 * **凡例が有り、原文がそう書いてあるので、`legend` に原文を入れる。**
 * **`抽出不能` にすると「PDF にそう書いてあった」という事実が消える。**
 * **`棄権` か `議場に不在` のどちらかに決めることもしない**——**それは推定であり、
 * 「議場に居たか居なかったか」を勝手に決めることになる**（#569）。
 *
 * **この 5 本で `－` が本文セルに実際に出るか**——**出ない**（実測 2026-09-13:
 * `－`(U+FF0D) は本文セルに 7 個 / 4 本だけ出るが、**その 4 本は凡例 A である**）。
 * **つまり凡例 D の 5 本では、この判断は今のところ 1 セルも動かさない。**
 * **それでも書いておく**——**将来この 5 本の形の PDF に `－` が出たときに、
 * 黙って `棄権` になったり `抽出不能` になったりしないように。**
 *
 * **`副` `退` `白` は入れない**——**秋田の凡例 4 通りのどれにも無く、本文セルにも 1 つも出ない**
 * （#753 が 154 本で確かめ、この実装も確かめた）。**青森の `副`（凡例にあるが 0 個）とは違う。**
 */
const MAPPED: Record<string, VoteValue> = {
  "賛成": "賛成",
  "反対": "反対",
  "議長": "投票なし",
  "欠席": "投票なし",
  "棄権": "投票なし",
  "除斥": "投票なし",
  "議場に不在": "投票なし",
};

export function mapLegend(raw: string, legend: string): LocalVote {
  const mapped = raw === UNKNOWN_CELL || legend === UNKNOWN_LEGEND ? undefined : MAPPED[legend];
  return mapped ? { raw, legend, mapped } : { raw, legend };
}

export interface SessionInfo {
  sessionId: string;
  /** 会期の見出しの原文（「平成２９年第２回定例会（１２月２２日）」） */
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
 * PDF の議決日（月・日）と会期の年から ISO 日付。
 * **会期の月より 6 か月以上前の月は翌年**（11月・12月定例会の 1月議決。docs/DATA_CONTRACT.md）。
 */
export function resolveDate(session: { year: number; month: number }, month: number, day: number): string {
  const year = session.month - month >= 6 ? session.year + 1 : session.year;
  return isoDate(year, month, day);
}

/** 議決月日の欄の原文（「12月22日」。**全角もある**）→ 月・日。読めなければ undefined（推定しない）。 */
export function parseDateText(text: string): { month: number; day: number } | undefined {
  const m = text.normalize("NFKC").replace(/[\s　]/g, "").match(/^(\d{1,2})月(\d{1,2})日$/);
  if (!m) return undefined;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return { month, day };
}

/**
 * **この PDF の会期の年と月**（`sessionId` と年またぎの判定に使う）。
 *
 * **年は PDF の見出しの和暦から**（`平成２９年第２回定例会（１２月２２日）`。154 / 154 本にある。#753）。
 * **見出しに年が無ければ例外**——**日付の無い記録を出さない**（この ETL の原則）。
 *
 * **月は「この PDF の議決月日のうち、いちばん小さい月」ではなく「いちばん大きい月」を採る**——
 * **年またぎの判定に使うので、会期が始まった月を知りたいのではなく、
 * 「この PDF の議決が会期の後半か」を知りたい。**
 * **秋田の 1 本の PDF は 1 本会議日ぶん**（#615 / #753）なので、**月はふつう 1 つだけである**
 * （実測: 154 本中 152 本が 1 つの月、2 本が 2 つの月）。
 * **2 つある本では大きいほうを採る**——**11月と12月が混ざる形で、年またぎではない。**
 *
 * **見出しの `（１２月２２日）` は使わない**——**無い本がある**
 * （`平成２３年６月定例会` / `平成２４年第２回定例会（９月議会）`。実測）。
 */
export function sessionOf(pdf: VotePdf, pdfUrl: string): { year: number; month: number } {
  if (pdf.year === undefined) throw new Error(`${pdfUrl}: 見出しから和暦の年が読めない（${JSON.stringify(pdf.headingText)}）`);
  const months = pdf.rows.map((r) => parseDateText(r.dateText)?.month).filter((m): m is number => m !== undefined);
  if (months.length === 0) throw new Error(`${pdfUrl}: 議決月日が 1 行も読めない`);
  return { year: pdf.year, month: Math.max(...months) };
}

/** id に使えない文字（区切りと空白）を落とす。原文は `number` / `title` に残る。 */
const idPart = (s: string): string => s.replace(/[\s　/\\]/g, "");

export interface Converted {
  rollCalls: LocalRollCall[];
  unmatched: LocalUnmatchedName[];
  /** **字が落ちたまま名簿に寄った氏名**（`meta.lossyNameMatches`。青森 #749 の機序 ②） */
  lossy: { nameText: string; memberId: string; rosterName: string; rollCalls: number }[];
  /**
   * **議決日が読めなくて採決にしなかった行**の数。
   * **実測では 154 本 3,985 行すべてが `M月D日` で、0 である**（2026-09-13）。
   * **ここは「議決月日の欄が別の形になった会期」が出たときに気づくための数である。**
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
      // **議決日が読めない行は採決にしない**（**日付の無い記録を出さない**）
      const md = parseDateText(row.dateText);
      if (!md) { skippedRows++; continue; }
      const date = resolveDate(session, md.month, md.day);
      // **番号が空の行は件名で代える。どちらも空なら例外**（名の無い採決は出さない）
      const key = row.number !== "" ? row.number : row.title;
      if (key === "") throw new Error(`${pdfUrl}: page ${row.page}: 議案等番号も件名も空の行がある`);
      const base = `${AKITA_ASSEMBLY.id}-${session.sessionId}-${date.replace(/-/g, "")}-${idPart(key)}`;
      baseIds.set(base, (baseIds.get(base) ?? 0) + 1);
      const votes: LocalRollCall["votes"] = row.cells.map((raw, i) => {
        const legend = legendOf(raw, pdf.legend.votes);
        const member = pdf.members[i];
        return { memberId: resolved[i].memberId, nameText: member.nameText, group: member.group, value: mapLegend(raw, legend) };
      });
      rollCalls.push({
        id: base,
        assemblyId: AKITA_ASSEMBLY.id,
        sessionId: session.sessionId,
        sessionLabel: session.sessionLabel,
        date,
        // **秋田の PDF に議案種別の欄は無い**（番号の欄に `議案第184号` `認定第1号` `請願第2号` と
        // 種別が混ざる）。**それを種別に起こすのは推定である**ので、
        // **この議会が公表している単位（「議案等」。列見出しが `議案等番号`）をそのまま書く**
        kind: "議案等",
        number: row.number,
        title: row.title,
        result: row.result,
        // **表決方法の欄がある**（`起立` / `簡易` / `投票`。凡例に意味が書いてある）。
        // **「簡易だから個人票が無い」と決め打ちしない**——**秋田は簡易でも全員ぶんの記号が入る**
        // （#615 が令和8年7月3日版の 13 行で実測）。
        // **`legend` には凡例の原文を入れる**（`簡易表決（異議の有無を諮る）`）。
        // **凡例に無ければ原文のまま**（推定しない）
        ...(row.method !== "" ? { method: { raw: row.method, legend: pdf.legend.methods[row.method] ?? row.method } } : {}),
        ...(row.counts ? { counts: { yes: row.counts.yes, no: row.counts.no, voting: row.counts.voting } } : {}),
        votes,
        page: row.page,
        sourceUrl: pdfUrl,
      });
    }
    // **字が落ちたまま寄った氏名**を数える（青森 #749 の機序 ②。`meta.lossyNameMatches`）
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
  // 同じ議決日で同じ id の行が複数なら、出た順に全部へ -1, -2 … を足す（9 県と同じ規則）
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
  // **`reason` はここでは付けない**——`buildLocalAssembly` が 10 県すべてを通る 1 か所で付ける
  // （県ごとに書くと足し忘れが黙って落ちる。#680 の判断）。ここは候補だけ写す。
  const unmatchedList = [...unmatched.values()].map((u) => {
    const match = matchOf.get(`${u.nameText}\t${u.group}`);
    return { ...u, ...(match && match.candidates.length > 0 ? { candidates: match.candidates } : {}) };
  });
  return { rollCalls, unmatched: unmatchedList, lossy: [...lossy.values()], skippedRows };
}
