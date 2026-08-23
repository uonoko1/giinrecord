import { parse } from "node-html-parser";
import type { LocalMember } from "@seiji-kiroku/shared";
import { cleanText, resolveTottoriUrl, toIsoDate, TOTTORI_ASSEMBLY, TOTTORI_ROSTER_URL } from "./site.ts";

/**
 * 鳥取県議会 議員名簿（五十音順）（Issue #184）。1 ページに全議員。
 *   各議員: p.CreatedDate（項目の掲載日）→ h2.Title の a（「姓　名（かな）」、href はプロフィール /item/{番号}.htm）→ p.Status の「in」カテゴリのリンク。
 *   カテゴリは 選挙区（「…選挙区」）・委員会（「…委員会」）・会派（それ以外）。会派がちょうど 1 つに決まらなければ例外（推定しない）。
 * id は p_31_item_{番号}（氏名からは作らない）。as-of はページに掲載日が無いので、項目の掲載日のうち最新。
 */
export { TOTTORI_ROSTER_URL };

export interface Roster {
  members: LocalMember[];
  /** 項目の掲載日のうち最新（ISO） */
  asOf: string;
}

const NAME_KANA = /^(.+?)（(.+?)）$/;
const ITEM = /\/item\/(\d+)\.htm$/;

export function parseRoster(html: string): Roster {
  const root = parse(html);
  const contents = root.querySelector("#ContentPane") ?? root;
  const entries: { profileUrl: string; slug: string; name: string; kana: string; categories: string[]; date: string }[] = [];
  for (const h2 of contents.querySelectorAll("h2.Title")) {
    const a = h2.querySelector("a");
    if (!a) continue;
    const profileUrl = resolveTottoriUrl(a.getAttribute("href") ?? "", TOTTORI_ROSTER_URL);
    const m = profileUrl.match(ITEM);
    if (!m) throw new Error(`profile link is not /item/{番号}.htm: ${profileUrl}`);
    const title = cleanText(a.text);
    const nk = title.match(NAME_KANA);
    if (!nk) throw new Error(`${title}: cannot read 氏名（かな）`);
    // 掲載日: 直前の p.CreatedDate
    let date: string | undefined;
    for (let el = h2.previousElementSibling; el; el = el.previousElementSibling) {
      if (el.tagName === "P" && el.classNames.includes("CreatedDate")) { date = toIsoDate(cleanText(el.text)); break; }
      if (el.tagName === "H2") break;
    }
    if (!date) throw new Error(`${title}: 掲載日 (p.CreatedDate) not found`);
    // カテゴリ: 直後の p.Status のリンク
    let categories: string[] | undefined;
    for (let el = h2.nextElementSibling; el; el = el.nextElementSibling) {
      if (el.tagName === "H2") break;
      if (el.tagName === "P" && el.classNames.includes("Status")) { categories = el.querySelectorAll("a").map((x) => cleanText(x.text)); break; }
    }
    if (!categories) throw new Error(`${title}: categories (p.Status) not found`);
    entries.push({ profileUrl, slug: `item_${m[1]}`, name: nk[1], kana: nk[2], categories, date });
  }
  if (entries.length === 0) throw new Error("no members found in roster page");
  const seen = new Set<string>();
  const members: LocalMember[] = [];
  const asOf = entries.map((e) => e.date).sort().at(-1)!;
  for (const e of entries) {
    if (seen.has(e.slug)) throw new Error(`${e.name} (${e.slug}) listed twice`);
    seen.add(e.slug);
    const districts = e.categories.filter((c) => /選挙区$/.test(c));
    const groups = e.categories.filter((c) => !/選挙区$/.test(c) && !/委員会$/.test(c));
    if (districts.length !== 1) throw new Error(`${e.name}: 選挙区 must be exactly one category, got ${JSON.stringify(districts)}`);
    if (groups.length !== 1) throw new Error(`${e.name}: 会派 (a category that is neither 選挙区 nor 委員会) must be exactly one, got ${JSON.stringify(groups)}`);
    members.push({
      id: `p_${TOTTORI_ASSEMBLY.prefCode}_${e.slug}`,
      assemblyId: TOTTORI_ASSEMBLY.id,
      name: e.name,
      kana: e.kana,
      group: groups[0],
      district: districts[0],
      profileUrl: e.profileUrl,
      current: true,
      asOf,
      sourceUrl: TOTTORI_ROSTER_URL,
      counts: { rollcalls: 0 },
    });
  }
  return { members, asOf };
}
