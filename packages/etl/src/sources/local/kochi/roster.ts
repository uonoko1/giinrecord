import { parse } from "node-html-parser";
import type { LocalMember } from "@seiji-kiroku/shared";
import { cleanText, KOCHI_ASSEMBLY, KOCHI_ROSTER_URL, warekiYear } from "./site.ts";

/**
 * 高知県議会 議員名簿（会派別）（Issue #220）。1 ページに全議員。
 *   /member/categories/ の表が会派ごとに
 *     会派の見出し行（th「自由民主党（20人）」＋連絡先）
 *     列見出しの行（議席番号・氏名・常任委員会・選挙区）
 *     議員の行（議席番号・顔写真・氏名＋ふりがな・常任委員会・選挙区）
 *   を繰り返す。議員ごとのプロフィールページは無い（リンクが張られていない）ので profileUrl は名簿ページ自身。
 *   id は議席番号（表の原文）から作る（氏名からは作らない）。欠員の議席は行が無いので飛ぶ。
 *   as-of は表の前の「令和８年７月30日現在」。無ければ例外（取得日で代用しない）。
 */
export { KOCHI_ROSTER_URL };

export interface Roster {
  members: LocalMember[];
  /** 名簿の「令和N年M月D日現在」（ISO） */
  asOf: string;
}

const AS_OF = /(令和|平成)([０-９0-9]+|元)年([０-９0-9]+)月([０-９0-9]+)日現在/;
/** 会派の見出し（「自由民主党（20人）」）。人数は突合に使う */
const GROUP_HEADING = /^(.+?)（([０-９0-9]+)人）$/;
/** 氏名の欄。1 行目が氏名、括弧の行がふりがな（全角・半角どちらの括弧も来る） */
const KANA_LINE = /^[（(](.+?)[）)]$/;

export function parseRoster(html: string): Roster {
  const root = parse(html);
  const asOfMatch = cleanText(root.text).match(AS_OF);
  if (!asOfMatch) throw new Error("名簿の掲載日（令和N年M月D日現在）not found");
  const asOf = `${warekiYear(asOfMatch[1], asOfMatch[2])}-${asOfMatch[3].normalize("NFKC").padStart(2, "0")}-${asOfMatch[4].normalize("NFKC").padStart(2, "0")}`;

  const table = root.querySelectorAll("table").find((t) => GROUP_HEADING.test(cleanText(t.querySelector("th")?.text ?? "")));
  if (!table) throw new Error("議員名簿（会派別）の表 not found");

  const members: LocalMember[] = [];
  const seats = new Set<string>();
  const expected: { group: string; size: number }[] = [];
  let group: string | undefined;
  for (const tr of table.querySelectorAll("tr")) {
    // 会派の見出し行（th）: ここから下の議員の行はこの会派
    const th = tr.querySelectorAll("th");
    if (th.length > 0) {
      const m = cleanText(th[0].text).match(GROUP_HEADING);
      if (!m) continue; // 連絡先だけの見出しなどは会派の切り替えにしない
      group = m[1];
      expected.push({ group, size: Number(m[2].normalize("NFKC")) });
      continue;
    }
    const cells = tr.querySelectorAll("td");
    if (cells.length < 5) continue;
    const seat = cleanText(cells[0].text).normalize("NFKC");
    // 列見出しの行（「議席番号」）は議員の行ではない
    if (!/^\d+$/.test(seat)) continue;
    if (group === undefined) throw new Error(`議席番号 ${seat}: 会派の見出しより前に議員の行が出た`);
    // 氏名の欄は「氏名」と「（ふりがな）」の 2 行（<p> でも <br> でも来る）
    const nameCell = cells[2];
    const lines = nameCell.innerHTML
      .split(/<br\s*\/?>|<\/p>/i)
      .map((s) => cleanText(parse(s).text))
      .filter((s) => s !== "");
    const kanaIdx = lines.findIndex((l) => KANA_LINE.test(l));
    if (kanaIdx < 1) throw new Error(`議席番号 ${seat}: 氏名とふりがなの 2 行が読めない (${JSON.stringify(lines)})`);
    const name = lines.slice(0, kanaIdx).join(" ");
    const kana = cleanText(lines[kanaIdx].match(KANA_LINE)![1]);
    // 選挙区は改行で割られていることがある（「奈半利町・田野町・」「安田町・北川村・」）ので詰める
    const district = cleanText(cells[4].text).replace(/[\s　]+/g, "");
    if (name === "" || kana === "" || district === "") throw new Error(`議席番号 ${seat}: 名簿の行が欠けている ${JSON.stringify({ name, kana, district })}`);
    if (seats.has(seat)) throw new Error(`議席番号 ${seat} が 2 回出た`);
    seats.add(seat);
    members.push({
      id: `p_${KOCHI_ASSEMBLY.prefCode}_${seat}`,
      assemblyId: KOCHI_ASSEMBLY.id,
      name,
      kana,
      group,
      district,
      profileUrl: KOCHI_ROSTER_URL,
      current: true,
      asOf,
      sourceUrl: KOCHI_ROSTER_URL,
      counts: { rollcalls: 0 },
    });
  }
  if (members.length === 0) throw new Error("no members found in roster page");
  // 会派の見出しの「（N人）」と実際の行数が合わなければ例外（読み落としを黙って通さない）
  for (const e of expected) {
    const got = members.filter((m) => m.group === e.group).length;
    if (got !== e.size) throw new Error(`${e.group}: 見出しは ${e.size} 人だが ${got} 行読めた`);
  }
  return { members, asOf };
}
