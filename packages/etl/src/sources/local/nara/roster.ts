import { parse } from "node-html-parser";
import type { LocalMember } from "@seiji-kiroku/shared";
import { cleanText, NARA_ASSEMBLY, NARA_ROSTER_URL, resolveNaraUrl, warekiYear } from "./site.ts";

/**
 * 奈良県議会 議員名簿（五十音順）（Issue #202）。1 ページに全議員。
 *   table.datatable（caption「議員名簿（五十音順）（任期：…）」）の行: [行見出し（あ行…、rowspan）] 議員名（リンク）・ふりがな・選挙区・当選回数・所属会派。
 *   リンク先がプロフィールページ（/n161/{番号}.html）で、その番号を id の元にする（氏名からは作らない）。
 *   as-of は表の直後の「（令和8年4月24日現在）」。無ければ例外（取得日で代用しない）。
 */
export { NARA_ROSTER_URL };

export interface Roster {
  members: LocalMember[];
  /** 名簿の「（令和N年M月D日現在）」（ISO） */
  asOf: string;
}

const PROFILE = /\/n161\/(\d+)\.html$/;
const HEADER = ["議員名", "ふりがな", "選挙区", "当選回数", "所属会派"];
const AS_OF = /（(令和|平成)(\d+|元)年(\d{1,2})月(\d{1,2})日現在）/;

export function parseRoster(html: string): Roster {
  const root = parse(html);
  const contents = root.querySelector("#tmp_contents") ?? root;
  const table = contents.querySelectorAll("table").find((t) => cleanText(t.querySelector("caption")?.text ?? "").startsWith("議員名簿（五十音順）"));
  if (!table) throw new Error("議員名簿（五十音順） table not found");
  const rows = table.querySelectorAll("tr");
  const header = rows[0]?.querySelectorAll("th").map((th) => cleanText(th.text)).filter((t) => t !== "");
  if (!header || HEADER.some((h, i) => header[i] !== h)) throw new Error(`roster table header is not ${HEADER.join("/")}: ${JSON.stringify(header)}`);
  const seen = new Set<string>();
  const members: LocalMember[] = [];
  // as-of: 表の直後の「（令和N年M月D日現在）」（ページ全体から探す。table の外にある）
  const asOfMatch = cleanText(contents.text).match(AS_OF);
  if (!asOfMatch) throw new Error("名簿の掲載日（（令和N年M月D日現在））not found");
  const asOf = `${warekiYear(asOfMatch[1], asOfMatch[2])}-${asOfMatch[3].padStart(2, "0")}-${asOfMatch[4].padStart(2, "0")}`;
  for (const tr of rows.slice(1)) {
    const cells = tr.querySelectorAll("td");
    if (cells.length !== 5) throw new Error(`roster row has ${cells.length} cells (expected 5): ${cleanText(tr.text)}`);
    const a = cells[0].querySelector("a");
    if (!a) throw new Error(`roster row has no profile link: ${cleanText(tr.text)}`);
    const profileUrl = resolveNaraUrl(a.getAttribute("href") ?? "", NARA_ROSTER_URL);
    const m = profileUrl.match(PROFILE);
    if (!m) throw new Error(`profile link is not /n161/{番号}.html: ${profileUrl}`);
    const name = cleanText(a.text);
    const kana = cleanText(cells[1].text);
    // 選挙区は改行で割られている（「奈良市・」「山辺郡」）ので詰める
    const district = cleanText(cells[2].text).replace(/\s+/g, "");
    const times = cleanText(cells[3].text);
    const group = cleanText(cells[4].text);
    if (name === "" || kana === "" || district === "" || group === "") throw new Error(`roster row incomplete: ${JSON.stringify({ name, kana, district, group })}`);
    if (!/^\d+回$/.test(times.normalize("NFKC"))) throw new Error(`${name}: 当選回数 "${times}" is not N回`);
    if (seen.has(m[1])) throw new Error(`${name} (${m[1]}) listed twice`);
    seen.add(m[1]);
    members.push({
      id: `p_${NARA_ASSEMBLY.prefCode}_${m[1]}`,
      assemblyId: NARA_ASSEMBLY.id,
      name,
      kana,
      group,
      district,
      profileUrl,
      current: true,
      asOf,
      sourceUrl: NARA_ROSTER_URL,
      counts: { rollcalls: 0 },
    });
  }
  if (members.length === 0) throw new Error("no members found in roster page");
  return { members, asOf };
}
