import { parse, type HTMLElement } from "node-html-parser";
import type { LocalMember } from "@seiji-kiroku/shared";
import { cleanText, resolveShimaneUrl, SHIMANE_ASSEMBLY, SHIMANE_ROSTER_URL, warekiYear } from "./site.ts";

/**
 * 島根県議会 議員名簿（選挙区別）（Issue #221）。
 *   /gikai/gaido/meibo/tiku.html          選挙区の表（12 選挙区へのリンク）。Assembly.sourceUrl。
 *   /gikai/gaido/meibo/{選挙区}.html      その選挙区の議員（写真つき）。議員 1 人ぶんが 1 セル
 *                                         （td / th。1 人区は表が無く div のまま）で、
 *                                         ふりがな・氏名（プロフィールへのリンク）・所属会派が <p> と <br> で並ぶ。
 * 「議員名別名簿」「会派別名簿」は PDF だが、選挙区・ふりがな・会派が 1 つのページで揃うのはこの選挙区別ページなので
 * こちらを名簿にする（PDF の役職つきレイアウトを推定で読まない）。
 *
 * 議員 id は プロフィールページ（/gikai/gaido/meibo/simeibetu/{slug}.html）の slug から `p_32_{slug}`（氏名からは作らない）。
 * 掲載日（asOf）は選挙区ページの「（令和5年5月17日現在）」（caption か本文の <p>）のうち最新。
 * 1 つも見つからなければ例外（取得日で代用しない）。
 */
export { SHIMANE_ROSTER_URL };

/** 選挙区ページ（tiku.html の表の並び順）。取得順を固定し、ページが増減したら気づけるようにする。 */
export const DISTRICT_PAGES = [
  { district: "松江", slug: "matsue", path: "/gikai/gaido/meibo/matsue.html" },
  { district: "浜田", slug: "hamada", path: "/gikai/gaido/meibo/hamada.html" },
  { district: "出雲", slug: "izumo", path: "/gikai/gaido/meibo/izumo.html" },
  { district: "益田", slug: "masuda", path: "/gikai/gaido/meibo/masuda.html" },
  { district: "大田", slug: "ooda", path: "/gikai/gaido/meibo/ooda.html" },
  { district: "安来", slug: "yasugi", path: "/gikai/gaido/meibo/yasugi.html" },
  { district: "江津", slug: "goutu", path: "/gikai/gaido/meibo/goutu.html" },
  { district: "雲南・飯石", slug: "unnan", path: "/gikai/gaido/meibo/unnan.html" },
  { district: "仁多", slug: "nita", path: "/gikai/gaido/meibo/nita.html" },
  { district: "邑智", slug: "outi", path: "/gikai/gaido/meibo/outi.html" },
  { district: "鹿足", slug: "kanoashi", path: "/gikai/gaido/meibo/kanoashi.html" },
  { district: "隠岐", slug: "oki", path: "/gikai/gaido/meibo/oki.html" },
] as const;

export interface DistrictLink {
  district: string;
  url: string;
}

const PROFILE = /\/gikai\/gaido\/meibo\/simeibetu\/([\w-]+)\.html$/;
const AS_OF = /[（(](令和|平成)(\d+|元)年(\d{1,2})月(\d{1,2})日現在[）)]/;
/** ふりがな（ひらがなと長音・空白だけ）。氏名・会派と見分けるために使う。 */
const KANA = /^[ぁ-ゖー\s]+$/;
/** ページの見出し（1 人区は表が無く、見出しもセルの中に入ってしまう）。会派として読まないために落とす。 */
const HEADING = /選挙区島根県議会議員（写真）一覧/;

/** 選挙区 index（tiku.html）→ 選挙区名とページ URL。表の並び順。 */
export function parseDistrictIndex(html: string, baseUrl: string): DistrictLink[] {
  const root = parse(html);
  const contents = root.querySelector("#page-content");
  if (!contents) throw new Error(`${baseUrl}: #page-content not found`);
  const table = contents.querySelectorAll("table").find((t) => cleanText(t.querySelector("caption")?.text ?? "") === "選挙区");
  if (!table) throw new Error(`${baseUrl}: 選挙区 table not found`);
  const districts: DistrictLink[] = [];
  for (const a of table.querySelectorAll("a")) {
    const district = cleanText(a.text);
    if (district === "") continue;
    const url = resolveShimaneUrl(a.getAttribute("href") ?? "", baseUrl);
    if (districts.some((d) => d.url === url)) throw new Error(`${baseUrl}: duplicate district page ${url}`);
    districts.push({ district, url });
  }
  if (districts.length === 0) throw new Error(`${baseUrl}: no district pages found`);
  return districts;
}

export interface DistrictPage {
  members: LocalMember[];
  /** そのページの「（令和N年M月D日現在）」（ISO）。1 人区のページには無いこともある */
  asOf: string | undefined;
}

/** 議員 1 人ぶんの範囲: 表のセル（td / th）。表が無いページ（1 人区）は #page-content 全体を 1 人ぶんとみなす。 */
function memberCells(contents: HTMLElement): HTMLElement[] {
  const cells = contents.querySelectorAll("td, th").filter((c) => c.querySelector("a[href*='/simeibetu/']"));
  if (cells.length > 0) return cells;
  return contents.querySelector("a[href*='/simeibetu/']") ? [contents] : [];
}

/**
 * 選挙区ページ → その選挙区の議員。
 * セルの中の「プロフィールへのリンク」が氏名。ふりがな・会派は同じセルの中の行（<p> / <br> で区切られる）から、
 * ひらがなだけの行＝ふりがな、氏名でもふりがなでもない残りの行＝会派（原文のまま）として読む。
 * どちらも 1 つに決まらなければ例外（推定しない）。
 */
export function parseDistrictPage(html: string, baseUrl: string, district: string): DistrictPage {
  const root = parse(html);
  const contents = root.querySelector("#page-content");
  if (!contents) throw new Error(`${baseUrl}: #page-content not found`);
  const asOfMatch = cleanText(contents.text).match(AS_OF);
  const asOf = asOfMatch ? `${warekiYear(asOfMatch[1], asOfMatch[2])}-${asOfMatch[3].padStart(2, "0")}-${asOfMatch[4].padStart(2, "0")}` : undefined;
  const members: LocalMember[] = [];
  for (const cell of memberCells(contents)) {
    const a = cell.querySelector("a[href*='/simeibetu/']");
    if (!a) continue;
    const profileUrl = resolveShimaneUrl(a.getAttribute("href") ?? "", baseUrl);
    const m = profileUrl.match(PROFILE);
    if (!m) throw new Error(`${baseUrl}: profile link is not /gikai/gaido/meibo/simeibetu/{slug}.html: ${profileUrl}`);
    const name = cleanText(a.text);
    if (name === "") throw new Error(`${baseUrl}: profile link ${profileUrl} has no name`);
    // セルの中の行（<br> と段落の境目だけで割る。ふりがなが <span> ごとに改行されている人（角智子）を割らないよう、
    // ソースの改行は行の区切りにしない）。氏名・見出し・掲載日の行は落として、ふりがな・会派を選ぶ
    const lines = cell.innerHTML
      .replace(/[\r\n]+/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|td|th|h\d|li|tr)>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .split("\n")
      .map((l) => cleanText(l))
      .filter((l) => l !== "" && l !== name && !AS_OF.test(l) && !HEADING.test(l));
    const kana = lines.filter((l) => KANA.test(l)).map((l) => l.replace(/\s/g, ""));
    const groups = lines.filter((l) => !KANA.test(l));
    if (kana.length !== 1) throw new Error(`${baseUrl} ${name}: expected 1 ふりがな line, got ${JSON.stringify(kana)}`);
    if (groups.length !== 1) throw new Error(`${baseUrl} ${name}: expected 1 所属会派 line, got ${JSON.stringify(groups)}`);
    members.push({
      id: `p_${SHIMANE_ASSEMBLY.prefCode}_${m[1]}`,
      assemblyId: SHIMANE_ASSEMBLY.id,
      name,
      kana: kana[0],
      group: groups[0],
      district,
      profileUrl,
      current: true,
      // asOf は名簿全体で決めるので、ここでは仮に自分のページの掲載日（無ければ空）を入れて parseRoster が上書きする
      asOf: asOf ?? "",
      sourceUrl: baseUrl,
      counts: { rollcalls: 0 },
    });
  }
  if (members.length === 0) throw new Error(`${baseUrl}: no members found`);
  return { members, asOf };
}

export interface Roster {
  members: LocalMember[];
  /** 名簿の掲載日（選挙区ページの「（令和N年M月D日現在）」のうち最新。ISO） */
  asOf: string;
}

/** 12 の選挙区ページ → 名簿。id が重複すれば例外。掲載日はページの掲載日のうち最新（1 つも無ければ例外）。 */
export function parseRoster(pages: readonly { district: string; url: string; html: string }[]): Roster {
  const members: LocalMember[] = [];
  const seen = new Map<string, string>();
  const asOfs: string[] = [];
  for (const p of pages) {
    const page = parseDistrictPage(p.html, p.url, p.district);
    if (page.asOf) asOfs.push(page.asOf);
    for (const m of page.members) {
      const before = seen.get(m.id);
      if (before) throw new Error(`${m.name} (${m.id}) listed twice: ${before} and ${p.url}`);
      seen.set(m.id, p.url);
      members.push(m);
    }
  }
  if (members.length === 0) throw new Error("no members found in the district pages");
  if (asOfs.length === 0) throw new Error("名簿の掲載日（（令和N年M月D日現在））not found on any district page");
  const asOf = asOfs.reduce((a, b) => (a > b ? a : b));
  for (const m of members) m.asOf = asOf;
  return { members, asOf };
}
