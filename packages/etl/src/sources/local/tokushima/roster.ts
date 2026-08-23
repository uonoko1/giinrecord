import { parse, type HTMLElement } from "node-html-parser";
import type { LocalMember } from "@seiji-kiroku/shared";
import { cleanText, resolveTokushimaUrl, TOKUSHIMA_ASSEMBLY, TOKUSHIMA_ORIGIN } from "./site.ts";

/**
 * 徳島県議会 議員紹介（Issue #183）。2 ページを合わせて 1 人分にする。
 *   会派別（h3「会派名（N人）」→ 役職ごとのリンク）・選挙区別（h3「選挙区（N人）」→「氏名（ふりがな）」＋「所属会派：…」）。
 *   各リンクの href がプロフィールページ（/gikai/giin/{slug}/）で、その slug を id の元にする（氏名からは作らない）。
 *   2 ページで人や所属会派が食い違えば例外。ページに掲載日は無いので as-of は呼び出し側（取得日）が渡す。
 */
export const ROSTER_URLS = {
  kaihabetu: `${TOKUSHIMA_ORIGIN}/gikai/giin/kaihabetu/`,
  senkyoku: `${TOKUSHIMA_ORIGIN}/gikai/giin/senkyoku/`,
} as const;

export interface RosterPages {
  kaihabetu: string;
  senkyoku: string;
}

export interface Roster {
  members: LocalMember[];
  /** 会派別ページの「※定数38名」 */
  seats: number;
  /** as-of（取得日。ページに掲載日が無い） */
  asOf: string;
}

interface Link {
  slug: string;
  profileUrl: string;
  text: string;
  /** リンク直後の ul（選挙区別の「所属会派：」「当選回数：」） */
  details: string[];
}

const SLUG = /\/gikai\/giin\/([A-Za-z0-9_-]+)\/$/;

function memberLinks(el: HTMLElement, baseUrl: string): Link[] {
  return el.querySelectorAll("a").flatMap((a) => {
    const href = a.getAttribute("href") ?? "";
    // 会派ホームページ（外部サイト）や「会派別 議員紹介はこちら」などの案内リンクは議員ではない（取得もしない）
    if (!SLUG.test(href.trim())) return [];
    const profileUrl = resolveTokushimaUrl(href, baseUrl);
    const m = profileUrl.match(SLUG)!;
    const details = a.nextElementSibling?.tagName === "UL" ? a.nextElementSibling.querySelectorAll("li").map((li) => cleanText(li.text)) : [];
    return [{ slug: m[1], profileUrl, text: cleanText(a.text), details }];
  });
}

/** h3 ごとに、次の h3 までの block 内のリンクを集める。 */
function sections(html: string, baseUrl: string): { heading: string; links: Link[] }[] {
  const root = parse(html);
  const out: { heading: string; links: Link[] }[] = [];
  for (const h of root.querySelectorAll("h3")) {
    const section = { heading: cleanText(h.text), links: [] as Link[] };
    // h3 は <div class="block"><div class="heading"><h3> の中。次の block 群を h3 を含む block まで読む
    let block = h.closest(".block");
    for (block = block?.nextElementSibling ?? null; block && !block.querySelector("h3"); block = block.nextElementSibling) {
      section.links.push(...memberLinks(block, baseUrl));
    }
    out.push(section);
  }
  return out;
}

const GROUP_HEADING = /^(.+?)（(\d+)人）$/;
const DISTRICT_HEADING = /^(.+?)\s*選挙区（(\d+)人）$/;
const KANA_TEXT = /^(.+?)\s*[（(](.+?)[）)]$/;

export function parseRoster(pages: RosterPages, opts: { asOf: string }): Roster {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.asOf)) throw new Error(`asOf must be ISO date: ${opts.asOf}`);
  const seatsMatch = pages.kaihabetu.match(/※定数(\d+)名/);
  if (!seatsMatch) throw new Error("会派別: 定数 not found");
  const seats = Number(seatsMatch[1]);

  // 会派別: 「会派名（N人）」の見出し。N は実際のリンク数と一致しなければならない（原文の整合）
  const byId = new Map<string, { slug: string; profileUrl: string; name: string; group: string }>();
  for (const s of sections(pages.kaihabetu, ROSTER_URLS.kaihabetu)) {
    const m = s.heading.match(GROUP_HEADING);
    if (!m) continue;
    if (s.links.length !== Number(m[2])) throw new Error(`${s.heading}: ${s.links.length} members listed`);
    for (const l of s.links) {
      if (byId.has(l.slug)) throw new Error(`${l.text} (${l.slug}) listed twice in 会派別`);
      byId.set(l.slug, { slug: l.slug, profileUrl: l.profileUrl, name: l.text, group: m[1] });
    }
  }
  if (byId.size === 0) throw new Error("会派別: no members found");

  // 選挙区別: 「選挙区（N人）」の見出し、「氏名（ふりがな）」、「所属会派：…」
  const district = new Map<string, { district: string; kana: string; group: string }>();
  for (const s of sections(pages.senkyoku, ROSTER_URLS.senkyoku)) {
    const m = s.heading.match(DISTRICT_HEADING);
    if (!m) continue;
    if (s.links.length !== Number(m[2])) throw new Error(`${s.heading}: ${s.links.length} members listed`);
    for (const l of s.links) {
      const k = l.text.match(KANA_TEXT);
      if (!k) throw new Error(`選挙区別: cannot read 氏名（ふりがな） from "${l.text}"`);
      const g = l.details.find((d) => d.startsWith("所属会派："));
      if (!g) throw new Error(`選挙区別: 所属会派 not found for ${l.text}`);
      if (district.has(l.slug)) throw new Error(`${l.text} (${l.slug}) listed twice in 選挙区別`);
      district.set(l.slug, { district: `${m[1]}選挙区`, kana: cleanText(k[2]), group: g.slice("所属会派：".length).trim() });
    }
  }

  // 2 ページの突合: 1 人でも欠ければ・会派が食い違えば例外（どちらを正とするか推定しない）
  for (const [slug, m] of byId) {
    const d = district.get(slug);
    if (!d) throw new Error(`${m.name} (${slug}) is in 会派別 but not in 選挙区別`);
    if (d.group !== m.group) throw new Error(`${m.name} (${slug}): 所属会派 "${d.group}" in 選挙区別 but "${m.group}" in 会派別`);
  }
  for (const slug of district.keys()) if (!byId.has(slug)) throw new Error(`${slug} is in 選挙区別 but not in 会派別`);
  if (byId.size > seats) throw new Error(`${byId.size} members exceed 定数 ${seats}`);

  const members: LocalMember[] = [...byId.values()].map((m) => ({
    id: `p_${TOKUSHIMA_ASSEMBLY.prefCode}_${m.slug}`,
    assemblyId: TOKUSHIMA_ASSEMBLY.id,
    name: m.name,
    kana: district.get(m.slug)!.kana,
    group: m.group,
    district: district.get(m.slug)!.district,
    profileUrl: m.profileUrl,
    current: true,
    asOf: opts.asOf,
    sourceUrl: ROSTER_URLS.kaihabetu,
    counts: { rollcalls: 0 },
  }));
  return { members, seats, asOf: opts.asOf };
}
