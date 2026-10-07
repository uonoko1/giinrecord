import type { Bill, Member, MemberId } from "@seiji-kiroku/shared";
import { indexByName, resolveMember } from "./match-votes.ts";

/** 名寄せできなかった衆院 議案の提出者・賛成者の氏名表記。`data/unmatched.json` の1行（運用者が確認する）。経過ページに個人の会派は無いので group は空。 */
export interface UnmatchedShugiinBillName {
  kind: "bill";
  nameText: string;
  group: string;
  billId: string;
}

/**
 * 衆院 経過ページの「議案提出者一覧」「議案提出の賛成者」の氏名を衆院の名簿に名寄せする純粋関数（Issue #72）。
 * - 正規化・同姓同名の扱いは matchVotes と同じ resolveMember。経過ページに個人の会派は無いので、同姓同名は絞れず unmatched に載せる（推測しない）。
 * - 原文の氏名（submitterNames / supporterNames）は名寄せの成否に関係なく Bill に残る。submitters / supporters は紐づいた人だけ。
 * - 衆院の名簿がまだ無い（house: "shugiin" の Member が 0 人）なら名寄せを試みず、unmatched も出さない。
 *   全氏名（第221回で約2,000件）を unmatched に流すと運用者の確認表が埋まり、名簿 PBI が入れば解消するものなので、氏名は Bill 側の事実として残すにとどめる。
 * - 参院の名簿（house: "sangiin"）とは突合しない（衆院の提出者は衆議院議員）。
 * - 名簿が覆う回次（衆院議員の term の sessionFrom..sessionTo）に提出された議案だけ名寄せする。
 *   衆院は「現在」の名簿しか無い（Issue #71）ので、過去回次の議案（継続審議で一覧に載る分を含む）の氏名は、今の名簿に無いのが正常でも
 *   無いのが誤りでも区別できない。名簿の無い回次と同じ扱い（紐づけず、unmatched にも出さず、氏名だけ残す）にして推測も確認表の汚染も避ける。
 * - **名寄せを走らせた回次では、`submitters` / `supporters` は名寄せの結果そのものになる**（#1236）。
 *   入力の `Bill` が前回出力（`data/bills/`）由来の古い ID を持っていても**残さない。**
 *   **氏名が事実で ID は派生**なので、派生を入力より長生きさせない。
 *   食い違いを数えるのは `unattestedBillMatches`（母数つき）。
 */
export function matchShugiinBills(bills: readonly Bill[], members: readonly Member[]): { bills: Bill[]; unmatched: UnmatchedShugiinBillName[] } {
  const shugiin = members.filter((m) => m.house === "shugiin");
  if (shugiin.length === 0) return { bills: [...bills], unmatched: [] };
  const covered = rosterCoveredSessions(shugiin);
  const index = indexByName(shugiin);
  const unmatched: UnmatchedShugiinBillName[] = [];
  const resolve = (bill: Bill, names: readonly string[] | undefined): MemberId[] | undefined => {
    if (!names) return undefined;
    const billId = bill.id;
    const ids: MemberId[] = [];
    for (const nameText of names) {
      const member = resolveMember(index, nameText, undefined, { session: bill.session, date: bill.received?.shugiin });
      if (member) ids.push(member.id);
      else unmatched.push({ kind: "bill", nameText, group: "", billId });
    }
    return ids.length ? ids : undefined;
  };
  const out = bills.map((bill) => {
    // 名簿が覆わない回次は名寄せを走らせない（上の注記）。**前回出力から来た ID はここでは落とさない**
    // ——名簿が覆っていた頃の名寄せの結果で、その回次の唯一の記録である（#1236）。
    if (!covered.has(bill.session)) return { ...bill };
    // **名寄せを走らせた回次では、`submitters` / `supporters` は名寄せの結果そのものにする**（#1236）。
    // `{ ...bill, ...(submitters ? { submitters } : {}) }` だと**名寄せが 1 件も当たらなかったとき
    // 前回出力（carried）の古い ID が残り、`submitterNames` と食い違う。**
    // **氏名は一次資料から毎回取り直す事実、ID はそこから導く派生**なので、
    // **派生を入力より長生きさせない**（`Bill.submitters` の型定義は「名簿に名寄せできた人だけ」）。
    const { submitters: _carriedSubmitters, supporters: _carriedSupporters, ...rest } = bill;
    const submitters = resolve(bill, bill.submitterNames);
    const supporters = resolve(bill, bill.supporterNames);
    return { ...rest, ...(submitters ? { submitters } : {}), ...(supporters ? { supporters } : {}) };
  });
  return { bills: out, unmatched };
}

/** `submitters` / `supporters` の ID のうち、同じ個票の氏名から名簿で引けないもの（#1236 の計器の 1 行）。 */
export interface UnattestedBillMatch {
  billId: string;
  field: "submitters" | "supporters";
  /** その欄に対応する氏名（`submitterNames` / `supporterNames`）の件数 */
  names: number;
  /** その欄に入っている ID の件数 */
  ids: number;
  /** 氏名から名簿で引けた ID の種類数 */
  attested: number;
  /** 氏名から引けない ID */
  unattested: MemberId[];
}

/**
 * **`submitterNames` と `submitters` の対応を数える計器**（#1236。受け入れ条件 1・3）。
 *
 * **なぜ件数の比較ではないか**: 名寄せは一部だけ当たるのが正常なので（同姓同名・敬称付き・名簿に無い人）、
 * **件数が一致しないこと自体は不整合ではない。** `data/bills/` の実測で
 * **`supporters` は 2 件が件数不一致だが、どちらも正常な部分一致**だった
 * （`221-衆法-26` が 153 名 → 152 件、`221-衆法-27` が 59 名 → 58 件。後者は原文が `東徹君`）。
 * **件数で測ると実データに偽陽性が 2 件出る。**
 *
 * **測るのは「その ID を、同じ個票の氏名から名簿で引けるか」である。**
 * 引けない ID は **carried から取り残された名寄せの結果**で、
 * **その議員の個人ページに「提出者として記録されていない議案」を出す。**
 *
 * **母数（`checked`）を返すのが要点**（#1056）。
 * **「不整合 0 件」は「母数が 0」でも成り立つ**ので、母数を見ずに緑と言えないようにする。
 * **名簿が覆わない回次の欄は名寄せを走らせていない**＝判定できないので、
 * `checked` には数えず `skippedUncovered` で別に言う（「0 件」と「数えていない」を混ぜない）。
 */
export function unattestedBillMatches(
  bills: readonly Bill[],
  members: readonly Member[],
): { checked: number; skippedUncovered: number; rows: UnattestedBillMatch[] } {
  const shugiin = members.filter((m) => m.house === "shugiin");
  const covered = rosterCoveredSessions(shugiin);
  const index = indexByName(shugiin);
  const rows: UnattestedBillMatch[] = [];
  let checked = 0;
  let skippedUncovered = 0;
  const FIELDS = [
    ["submitters", "submitterNames"],
    ["supporters", "supporterNames"],
  ] as const;
  for (const bill of bills) {
    for (const [idsKey, namesKey] of FIELDS) {
      const ids = bill[idsKey];
      if (!ids?.length) continue;
      // 衆院の名簿が 0 人のときは covered が空集合になるので、ここで全部 skipped に落ちる（名寄せを走らせていない）。
      if (!covered.has(bill.session)) {
        skippedUncovered++;
        continue;
      }
      checked++;
      const names = bill[namesKey] ?? [];
      const attested = new Set<MemberId>();
      for (const nameText of names) {
        const member = resolveMember(index, nameText, undefined, { session: bill.session, date: bill.received?.shugiin });
        if (member) attested.add(member.id);
      }
      const unattested = ids.filter((id) => !attested.has(id));
      if (unattested.length) rows.push({ billId: bill.id, field: idsKey, names: names.length, ids: ids.length, attested: attested.size, unattested });
    }
  }
  return { checked, skippedUncovered, rows };
}

/** 名簿（term の sessionFrom..sessionTo）が覆う回次の集合。sessionTo が無い term は sessionFrom の1回次分（groupAt と同じ扱い）。 */
export function rosterCoveredSessions(members: readonly Member[]): Set<number> {
  const out = new Set<number>();
  for (const m of members) {
    for (const t of m.terms) {
      for (let s = t.sessionFrom; s <= (t.sessionTo ?? t.sessionFrom); s++) out.add(s);
    }
  }
  return out;
}
