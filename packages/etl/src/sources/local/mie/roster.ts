import { parse, type HTMLElement } from "node-html-parser";
import type { LocalMember } from "@seiji-kiroku/shared";
import { cleanText, MIE_ASSEMBLY, MIE_ORIGIN, MIE_ROSTER_INDEX_URL, resolveMieUrl, warekiDate } from "./site.ts";

/**
 * 三重県議会 議員名簿（Issue #203）。
 *   選挙区別５０音順（08089011294.htm、1 ページ）: 選挙区・氏名・ふりがな・会派・期数 の表と h2 の「（令和７年１１月１８日現在）」（as-of）。
 *   選挙区別名簿（08096011310.htm）: 15 選挙区ページへのリンク。各選挙区ページに議員ごとの a name（プロフィールの slug）・ふりがな・氏名・所属会派。
 * 2 系統を突合して 1 人分にする（氏名で対応づけ、ふりがな・会派が食い違えば例外）。id は p_24_{a name の slug}（氏名からは作らない）。
 * profileUrl は選挙区ページ＋ #slug。as-of は５０音順ページの掲載日。
 */
export const GOJUON_URL = MIE_ROSTER_INDEX_URL;
export const DISTRICT_INDEX_URL = `${MIE_ORIGIN}/KENGIKAI/08096011310.htm`;

const ASOF = /（(令和|平成)([０-９0-9]+|元)年([０-９0-9]+)月([０-９0-9]+)日現在(?:・欠員([０-９0-9]+)名)?）/;

/** 空白（全角・半角）を除く（選挙区名「いなべ市・ 員弁郡」、氏名「東　　 豊」の揺れを寄せる）。 */
const stripSpaces = (s: string) => s.replace(/[\s　]/g, "");

export interface GojuonRow {
  district: string;
  name: string;
  kana: string;
  group: string;
}
export interface Gojuon {
  asOf: string;
  seats: number;
  rows: GojuonRow[];
}

/** 選挙区別５０音順 → 掲載日・定数・全議員の行。欠員の空行（td の無い tr）は数えない。 */
export function parseGojuon(html: string): Gojuon {
  const root = parse(html);
  const h2 = root.querySelectorAll("h2").map((h) => cleanText(h.text)).find((t) => ASOF.test(t));
  if (!h2) throw new Error("５０音順: h2 with 掲載日（…現在） not found");
  const am = h2.match(ASOF)!;
  const asOf = warekiDate(am[1], am[2], am[3], am[4]);
  const seatsMatch = cleanText(root.text).match(/定数）は、条例で([０-９0-9]+)人/);
  if (!seatsMatch) throw new Error("５０音順: 定数 not found");
  const seats = Number(seatsMatch[1].normalize("NFKC"));
  const table = root.querySelectorAll("table").find((t) => t.querySelectorAll("th").some((th) => cleanText(th.text) === "選挙区"));
  if (!table) throw new Error("５０音順: table with 選挙区 header not found");
  const rows: GojuonRow[] = [];
  let district = "";
  for (const tr of table.querySelectorAll("tr")) {
    const th = tr.querySelector("th");
    const ths = tr.querySelectorAll("th").map((c) => cleanText(c.text));
    if (ths.includes("氏名")) continue; // 見出し行
    if (th) district = stripSpaces(cleanText(th.text));
    const tds = tr.querySelectorAll("td").map((c) => cleanText(c.text));
    if (tds.length === 0) continue; // 欠員の空行
    if (tds.length !== 4) throw new Error(`５０音順: expected 4 cells (氏名・ふりがな・会派・期数), got ${tds.length}: ${tds.join(" | ")}`);
    if (district === "") throw new Error(`５０音順: row "${tds[0]}" has no 選挙区 heading`);
    rows.push({ district, name: tds[0], kana: tds[1], group: tds[2] });
  }
  if (rows.length === 0) throw new Error("５０音順: no members found");
  if (rows.length > seats) throw new Error(`５０音順: ${rows.length} members exceed 定数 ${seats}`);
  return { asOf, seats, rows };
}

export interface DistrictLink {
  district: string;
  url: string;
}

/** 選挙区別名簿 → 選挙区ページへのリンク（「津市選挙区」→ 津市）。 */
export function parseDistrictIndex(html: string, baseUrl: string): DistrictLink[] {
  const root = parse(html);
  const table = root.querySelectorAll("table").find((t) => t.querySelectorAll("th").some((th) => cleanText(th.text) === "選挙区名"));
  if (!table) throw new Error("選挙区別名簿: table with 選挙区名 header not found");
  const out: DistrictLink[] = [];
  for (const a of table.querySelectorAll("a")) {
    const text = cleanText(a.text);
    if (!text.endsWith("選挙区")) throw new Error(`選挙区別名簿: link "${text}" does not end with 選挙区`);
    const district = stripSpaces(text.slice(0, -"選挙区".length));
    if (out.some((l) => l.district === district)) throw new Error(`選挙区別名簿: duplicate 選挙区 ${district}`);
    out.push({ district, url: resolveMieUrl(a.getAttribute("href") ?? "", baseUrl) });
  }
  if (out.length === 0) throw new Error("選挙区別名簿: no 選挙区 links found");
  return out;
}

export interface DistrictMember {
  slug: string;
  name: string;
  kana: string;
  group: string;
  /** 選挙区ページ ＋ #slug（プロフィールの位置） */
  anchorUrl: string;
}
export interface DistrictPage {
  district: string;
  seats: number;
  vacancies: number;
  /** 選挙区ページの h1 の掲載日 */
  asOf: string;
  members: DistrictMember[];
}

const H1 = /^(.+?)（定数\s*([0-9０-９]+)）/;
const SLUG = /^[A-Za-z0-9_-]+$/;

/** 議員のプロフィール表（table-c）1 つ → ラベル（ふりがな・氏名・所属会派）と値。a name（slug）は表の中か、表を包む td の直下にある。 */
function memberTable(table: HTMLElement, baseUrl: string): DistrictMember {
  const findAnchor = (el: HTMLElement | null) => el?.querySelectorAll("a").map((a) => a.getAttribute("name") ?? "").find((n) => n !== "");
  const anchor = findAnchor(table) ?? findAnchor(table.closest("td") as HTMLElement | null);
  if (!anchor || !SLUG.test(anchor)) throw new Error(`選挙区ページ: member table without a name anchor (${baseUrl})`);
  const fields = new Map<string, string>();
  for (const tr of table.querySelectorAll("tr")) {
    const tds = tr.querySelectorAll("td");
    if (tds.length < 2) continue;
    const label = cleanText(tds[0].text);
    if (label === "") continue;
    // 値はラベルの右の最初の空でないセル（行末に空セルが余分に付くページがある）
    const value = tds.slice(1).map((c) => cleanText(c.text)).find((v) => v !== "") ?? "";
    if (value !== "" && !fields.has(label)) fields.set(label, value);
  }
  const name = fields.get("氏名");
  const kana = fields.get("ふりがな");
  const group = fields.get("所属会派");
  if (!name || !kana || !group) throw new Error(`選挙区ページ ${baseUrl}#${anchor}: 氏名/ふりがな/所属会派 missing (${[...fields.keys()].join(" ")})`);
  return { slug: anchor, name, kana, group, anchorUrl: `${baseUrl}#${anchor}` };
}

/** 選挙区ページ → h1（選挙区・定数・掲載日・欠員）と議員のプロフィール（a name の slug つき）。 */
export function parseDistrictPage(html: string, baseUrl: string): DistrictPage {
  const root = parse(html);
  const h1 = cleanText(root.querySelector("h1")?.text ?? "");
  const m = h1.match(H1);
  const am = h1.match(ASOF);
  if (!m || !am) throw new Error(`選挙区ページ ${baseUrl}: h1 "${h1}" is not {選挙区}（定数 N）…（…現在）`);
  const members = root.querySelectorAll("table.table-c").map((t) => memberTable(t, baseUrl));
  if (members.length === 0) throw new Error(`選挙区ページ ${baseUrl}: no member tables found`);
  const seats = Number(m[2].normalize("NFKC"));
  const vacancies = am[5] ? Number(am[5].normalize("NFKC")) : 0;
  if (members.length !== seats - vacancies) throw new Error(`選挙区ページ ${baseUrl}: ${members.length} members but 定数 ${seats} − 欠員 ${vacancies}`);
  const slugs = new Set(members.map((mm) => mm.slug));
  if (slugs.size !== members.length) throw new Error(`選挙区ページ ${baseUrl}: duplicate slug`);
  return { district: stripSpaces(m[1]), seats, vacancies, asOf: warekiDate(am[1], am[2], am[3], am[4]), members };
}

export interface Roster {
  members: LocalMember[];
  seats: number;
  /** ５０音順ページの掲載日（as-of） */
  asOf: string;
}

/** 氏名の突合キー: 空白と異体字セレクタ（辻󠄀 の IVS）を除く。字そのもの（髙/高）は寄せない。 */
const nameMatchKey = (s: string) => stripSpaces(s).replace(/[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu, "");

/**
 * ５０音順（正）と選挙区ページ（slug・プロフィール）を突合して LocalMember にする。
 * 1 人でも欠ければ・ふりがな・会派が食い違えば例外（どちらを正とするか推定しない）。
 */
export function buildRoster(gojuon: Gojuon, links: readonly DistrictLink[], pages: readonly DistrictPage[]): Roster {
  if (links.length !== pages.length) throw new Error(`selected ${pages.length} pages for ${links.length} links`);
  const byDistrict = new Map<string, DistrictPage>();
  for (let i = 0; i < links.length; i++) {
    if (pages[i].district !== links[i].district) throw new Error(`選挙区ページ: h1 says ${pages[i].district} but the index links it as ${links[i].district}`);
    if (byDistrict.has(pages[i].district)) throw new Error(`選挙区 ${pages[i].district} appears twice`);
    byDistrict.set(pages[i].district, pages[i]);
  }
  const totalSeats = pages.reduce((n, p) => n + p.seats, 0);
  if (totalSeats !== gojuon.seats) throw new Error(`選挙区ページの定数の合計 ${totalSeats} !== ５０音順の定数 ${gojuon.seats}`);
  const used = new Set<string>();
  const members: LocalMember[] = gojuon.rows.map((row) => {
    const page = byDistrict.get(row.district);
    if (!page) throw new Error(`${row.name}: 選挙区 ${row.district} の選挙区ページが無い`);
    const hits = page.members.filter((m) => nameMatchKey(m.name) === nameMatchKey(row.name));
    if (hits.length !== 1) throw new Error(`${row.name}（${row.district}）: 選挙区ページで ${hits.length} 人`);
    const hit = hits[0];
    if (stripSpaces(hit.kana) !== stripSpaces(row.kana)) throw new Error(`${row.name}: ふりがな "${hit.kana}" (選挙区ページ) !== "${row.kana}" (５０音順)`);
    if (hit.group !== row.group) throw new Error(`${row.name}: 所属会派 "${hit.group}" (選挙区ページ) !== "${row.group}" (５０音順)`);
    if (used.has(hit.slug)) throw new Error(`${row.name}: slug ${hit.slug} used twice`);
    used.add(hit.slug);
    return {
      id: `p_${MIE_ASSEMBLY.prefCode}_${hit.slug}`,
      assemblyId: MIE_ASSEMBLY.id,
      name: row.name,
      kana: row.kana,
      group: row.group,
      district: row.district,
      profileUrl: hit.anchorUrl,
      current: true,
      asOf: gojuon.asOf,
      sourceUrl: GOJUON_URL,
      counts: { rollcalls: 0 },
    };
  });
  for (const page of pages) {
    for (const m of page.members) if (!used.has(m.slug)) throw new Error(`${m.name} (${m.slug}) is on the ${page.district} page but not in ５０音順`);
  }
  return { members, seats: gojuon.seats, asOf: gojuon.asOf };
}
