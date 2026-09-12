import { parse } from "node-html-parser";
import type { LocalMember } from "@seiji-kiroku/shared";
import { cleanText, resolveShigaUrl, SHIGA_ASSEMBLY, SHIGA_ROSTER_URL } from "./site.ts";

/**
 * 滋賀県議会 議員名簿（五十音順）（Issue #741）。1 ページに全議員（Shift_JIS）。
 *   /g07_giinlistP.asp の表が議員ごとに 2 行（写真の td は rowspan=2）:
 *     1 行目 td: `<a href='g07_giinlistS.asp?SrchID=197'>辻　正隆</a>　(つじ　まさたか)<br />　期数：　3期<br />
 *                　所属会派：　自由民主党滋賀県議会議員団<br />　選挙区：　近江八幡市`
 *     2 行目 td: 住所・電話番号（読まない）
 *   議員 id は `p_25_{SrchID}`（プロフィールページの番号。**氏名からは作らない**）。
 *
 * **名簿ページに掲載日が無い**（「令和N年M月D日現在」も「更新日」も 1 つも無い。実測 #741）ので、
 * `asOf` は**取得日（JST）**にする。**徳島（#183）と同じ扱い**で、そちらも名簿に掲載日が無い
 * （docs/DATA_CONTRACT.md）。取得日を使うのはページに日付が「無い」ときだけで、
 * **あるのに読めなかったときに代用してはいけない。**
 */
export { SHIGA_ROSTER_URL };

export interface Roster {
  members: LocalMember[];
  /** as-of（取得日。ページに掲載日が無い） */
  asOf: string;
}

/** 議員の行（1 人ぶんの td の中身）。`<br>` で区切られた項目を読む */
const PROFILE_HREF = /^g07_giinlistS\.asp\?SrchID=(\d+)$/;
const KANA = /^[（(](.+?)[）)]$/;
const FIELD = /^(期数|所属会派|選挙区)：\s*(.*)$/;

export function parseRoster(html: string, opts: { asOf: string }): Roster {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.asOf)) throw new Error(`asOf must be ISO date: ${opts.asOf}`);
  const root = parse(html);
  const members: LocalMember[] = [];
  const ids = new Set<string>();
  for (const td of root.querySelectorAll("td")) {
    const a = td.querySelector("a");
    if (!a) continue;
    const m = (a.getAttribute("href") ?? "").trim().match(PROFILE_HREF);
    if (!m) continue;
    const srchId = m[1];
    // <br> で割った各行。1 行目は「氏名（リンク） （ふりがな）」、以降は「項目：値」
    const lines = td.innerHTML
      .split(/<br\s*\/?>/i)
      .map((s) => cleanText(parse(s).text))
      .filter((s) => s !== "");
    if (lines.length === 0) throw new Error(`SrchID ${srchId}: 議員の行が空`);
    const name = cleanText(a.text);
    // 氏名の後ろに「（ふりがな）」が続く
    const kanaText = cleanText(lines[0].slice(lines[0].indexOf(name) + name.length));
    const kanaMatch = kanaText.match(KANA);
    if (!kanaMatch) throw new Error(`SrchID ${srchId} (${name}): ふりがな（かな）が読めない: ${JSON.stringify(lines[0])}`);
    const fields = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const f = line.match(FIELD);
      if (f) fields.set(f[1], cleanText(f[2]));
    }
    const group = fields.get("所属会派") ?? "";
    const district = fields.get("選挙区") ?? "";
    if (name === "" || group === "" || district === "") throw new Error(`SrchID ${srchId}: 名簿の行が欠けている ${JSON.stringify({ name, group, district })}`);
    const id = `p_${SHIGA_ASSEMBLY.prefCode}_${srchId}`;
    if (ids.has(id)) throw new Error(`SrchID ${srchId} が 2 回出た`);
    ids.add(id);
    members.push({
      id,
      assemblyId: SHIGA_ASSEMBLY.id,
      name,
      kana: cleanText(kanaMatch[1]),
      group,
      district,
      profileUrl: resolveShigaUrl(a.getAttribute("href")!, SHIGA_ROSTER_URL),
      current: true,
      asOf: opts.asOf,
      sourceUrl: SHIGA_ROSTER_URL,
      counts: { rollcalls: 0 },
    });
  }
  if (members.length === 0) throw new Error("no members found in roster page");
  return { members, asOf: opts.asOf };
}
