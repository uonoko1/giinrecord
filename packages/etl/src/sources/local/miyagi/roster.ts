import { parse, type HTMLElement } from "node-html-parser";
import type { LocalMember } from "@seiji-kiroku/shared";
import { cleanText, MIYAGI_ASSEMBLY, MIYAGI_ORIGIN, parsePostedDate, resolveMiyagiUrl } from "./site.ts";

/**
 * 宮城県議会 議員名簿（Issue #157）。3 ページを合わせて 1 人分にする。
 *   会派別（会派の正式名称）・選挙区別（選挙区）・五十音順（ふりがな）。各ページの a 要素の href がプロフィールページで、
 *   その slug（例 meibo_yuzuki）を id の元にする（氏名からは作らない）。3 ページで人が食い違えば例外。
 */
export const ROSTER_URLS = {
  kaiha: `${MIYAGI_ORIGIN}/site/kengikai/18meibo-kaiha.html`,
  kubetu: `${MIYAGI_ORIGIN}/site/kengikai/18meibo-kubetu.html`,
  gojuuon: `${MIYAGI_ORIGIN}/site/kengikai/18meibo-gojuuon.html`,
} as const;

export interface RosterPages {
  kaiha: string;
  kubetu: string;
  gojuuon: string;
}

export interface Roster {
  members: LocalMember[];
  /** 選挙区別ページの「欠員N名」の合計 */
  vacancies: number;
  /** 3 ページの掲載日のうち最新（ISO） */
  asOf: string;
}

interface Link {
  slug: string;
  profileUrl: string;
  text: string;
}

const SLUG = /\/site\/kengikai\/([A-Za-z0-9_-]+)\.html$/;

function memberLinks(el: HTMLElement, baseUrl: string): Link[] {
  return el.querySelectorAll("a").map((a) => {
    const profileUrl = resolveMiyagiUrl(a.getAttribute("href") ?? "", baseUrl);
    const m = profileUrl.match(SLUG);
    if (!m) throw new Error(`profile link not under /site/kengikai/: ${profileUrl}`);
    return { slug: m[1], profileUrl, text: cleanText(a.text) };
  });
}

/** 見出し（h2/h3）ごとに、次の見出しまでの p 要素内のリンクを集める。 */
function sections(html: string, headingTag: "h2" | "h3", baseUrl: string): { heading: string; links: Link[]; texts: string[] }[] {
  const root = parse(html);
  const contents = root.querySelector("#tmp_contents") ?? root;
  const out: { heading: string; links: Link[]; texts: string[] }[] = [];
  for (const h of contents.querySelectorAll(headingTag)) {
    const section = { heading: cleanText(h.text), links: [] as Link[], texts: [] as string[] };
    for (let el = h.nextElementSibling; el && el.tagName !== headingTag.toUpperCase(); el = el.nextElementSibling) {
      if (el.tagName !== "P") continue;
      section.links.push(...memberLinks(el, baseUrl));
      section.texts.push(cleanText(el.text));
    }
    out.push(section);
  }
  return out;
}

const GROUP_HEADING = /^(.+?)（(\d+)名）$/;
const DISTRICT_HEADING = /^(.+?)（定数：(\d+)名）$/;
const KANA_TEXT = /^(.+?)\s*（(.+?)）$/;

export function parseRoster(pages: RosterPages): Roster {
  // 会派別: 「会派名（N名）」の見出し。N は実際のリンク数と一致しなければならない（原文の整合）。
  const byId = new Map<string, { slug: string; profileUrl: string; name: string; group: string }>();
  for (const s of sections(pages.kaiha, "h2", ROSTER_URLS.kaiha)) {
    const m = s.heading.match(GROUP_HEADING);
    if (!m) continue;
    if (s.links.length !== Number(m[2])) throw new Error(`${s.heading}: ${s.links.length} members listed`);
    for (const l of s.links) {
      if (byId.has(l.slug)) throw new Error(`${l.text} (${l.slug}) listed twice in 会派別`);
      byId.set(l.slug, { slug: l.slug, profileUrl: l.profileUrl, name: l.text, group: m[1] });
    }
  }
  if (byId.size === 0) throw new Error("会派別: no members found");

  // 選挙区別: 「選挙区（定数：N名）」の見出し。「欠員N名」は p の原文から。
  const district = new Map<string, string>();
  let vacancies = 0;
  const seatErrors: string[] = [];
  for (const s of sections(pages.kubetu, "h3", ROSTER_URLS.kubetu)) {
    const m = s.heading.match(DISTRICT_HEADING);
    if (!m) continue;
    for (const l of s.links) {
      if (district.has(l.slug)) throw new Error(`${l.text} (${l.slug}) listed twice in 選挙区別`);
      district.set(l.slug, m[1]);
    }
    for (const t of s.texts) {
      const v = t.match(/^欠員(\d+)名$/);
      if (v) vacancies += Number(v[1]);
    }
    if (s.links.length + s.texts.reduce((n, t) => n + Number(t.match(/^欠員(\d+)名$/)?.[1] ?? 0), 0) !== Number(m[2])) {
      seatErrors.push(`${s.heading}: ${s.links.length} members + vacancies do not add up to 定数`);
    }
  }

  // 五十音順: 「氏名（ふりがな）」
  const kana = new Map<string, string>();
  for (const s of sections(pages.gojuuon, "h2", ROSTER_URLS.gojuuon)) for (const l of s.links) {
    const m = l.text.match(KANA_TEXT);
    if (!m) throw new Error(`五十音順: cannot read 氏名（ふりがな） from "${l.text}"`);
    if (kana.has(l.slug)) throw new Error(`${l.text} (${l.slug}) listed twice in 五十音順`);
    kana.set(l.slug, m[2]);
  }

  // 3 ページの突合: 1 人でも欠ければ例外（どのページを正とするか推定しない）
  const missing = (label: string, ids: Map<string, unknown>) => {
    for (const [slug, m] of byId) if (!ids.has(slug)) throw new Error(`${m.name} (${slug}) is in 会派別 but not in ${label}`);
    for (const slug of ids.keys()) if (!byId.has(slug)) throw new Error(`${slug} is in ${label} but not in 会派別`);
  };
  missing("選挙区別", district);
  missing("五十音順", kana);
  if (seatErrors.length) throw new Error(seatErrors.join("; "));

  const asOf = [pages.kaiha, pages.kubetu, pages.gojuuon].map(parsePostedDate).sort().at(-1)!;
  const members: LocalMember[] = [...byId.values()].map((m) => ({
    id: `p_${MIYAGI_ASSEMBLY.prefCode}_${m.slug}`,
    assemblyId: MIYAGI_ASSEMBLY.id,
    name: m.name,
    kana: kana.get(m.slug)!,
    group: m.group,
    district: district.get(m.slug)!,
    profileUrl: m.profileUrl,
    current: true,
    asOf,
    sourceUrl: ROSTER_URLS.kaiha,
    counts: { rollcalls: 0 },
  }));
  return { members, vacancies, asOf };
}
