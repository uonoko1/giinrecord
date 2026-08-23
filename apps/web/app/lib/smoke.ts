/**
 * Pure checker behind scripts/smoke.ts: given an in-memory listing of build/client
 * (relative path -> file content; non-HTML files may be empty strings) and what data/
 * promised, report every missing page and broken internal link. No I/O here so the
 * rules are unit-testable; scripts/smoke.ts does the filesystem walk.
 */

import { sitemapLocs } from "./sitemap";

/** relative path (posix, no leading slash) -> file content */
export type BuildFiles = Map<string, string>;

export interface ExpectedData {
  /** ids from data/members/index.json, or null when that file is absent */
  memberIds: string[] | null;
  /** entries from data/rollcalls/index.json, or null when that file is absent */
  rollCalls: { session: number; id: string }[] | null;
}

export interface SmokeReport {
  checkedPages: number;
  checkedLinks: number;
  failures: string[];
}

export const REQUIRED_PAGES = ["index.html", "about/index.html", "members/index.html"];

const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Site-relative hrefs (`/...`) in document order, de-duplicated. Skips external, `//host`, mailto, `#`, etc. */
export function extractInternalHrefs(html: string): string[] {
  const seen = new Set<string>();
  for (const m of html.matchAll(HREF_RE)) {
    const href = m[1] ?? m[2] ?? "";
    if (href.startsWith("/") && !href.startsWith("//")) seen.add(href);
  }
  return [...seen];
}

/** `/about/?q#x` -> `about`; `/` -> ``. Result is a build-relative path without leading/trailing slash. */
export function resolveHrefTarget(href: string): string {
  const path = href.split(/[?#]/, 1)[0] ?? "";
  return decodeURIComponent(path).replace(/^\/+/, "").replace(/\/+$/, "");
}

function targetExists(files: BuildFiles, target: string): boolean {
  if (target === "") return files.has("index.html");
  return files.has(target) || files.has(`${target}/index.html`);
}

export function expectedPages(data: ExpectedData): string[] {
  const pages = [...REQUIRED_PAGES];
  for (const id of data.memberIds ?? []) pages.push(`members/${id}/index.html`);
  if (data.rollCalls && data.rollCalls.length > 0) {
    pages.push("rollcalls/index.html");
    for (const r of data.rollCalls) pages.push(`rollcalls/${r.session}/${r.id}/index.html`);
  }
  return pages;
}

export function checkBuild(files: BuildFiles, data: ExpectedData): SmokeReport {
  const failures: string[] = [];
  for (const page of expectedPages(data)) {
    if (!files.has(page)) failures.push(`missing page: ${page}`);
  }

  let checkedPages = 0;
  let checkedLinks = 0;
  for (const [path, content] of files) {
    if (!path.endsWith(".html")) continue;
    checkedPages++;
    for (const href of extractInternalHrefs(content)) {
      checkedLinks++;
      if (!targetExists(files, resolveHrefTarget(href))) failures.push(`broken link in ${path}: ${href}`);
    }
  }
  return { checkedPages, checkedLinks, failures };
}

export interface MemberDataReport {
  checkedFiles: number;
  failures: string[];
}

/** ビルドが /data/members/{id}.json に置くべきファイル（/compare が実行時に fetch する、Issue #104）。 */
export function expectedMemberDataFiles(data: ExpectedData): string[] {
  return (data.memberIds ?? []).map((id) => `data/members/${id}.json`);
}

/**
 * /compare（#104）は議員の JSON をバンドルせず、ビルド時に data/members/*.json を build/client/data/members/ へ
 * コピーしたものを fetch する（scripts/copy-member-data.ts）。index.json の全 id 分が無ければ失敗。
 */
export function checkMemberData(files: BuildFiles, data: ExpectedData): MemberDataReport {
  const expected = expectedMemberDataFiles(data);
  const failures = expected.filter((f) => !files.has(f)).map((f) => `missing data file: ${f}`);
  return { checkedFiles: expected.length, failures };
}

export interface SitemapReport {
  checkedUrls: number;
  failures: string[];
}

/** `https://host/members/m_1` or `/members/m_1` -> `members/m_1` (build-relative target). */
function sitemapLocTarget(loc: string): string {
  const path = /^[a-z][a-z0-9+.-]*:\/\//i.test(loc) ? loc.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "") : loc;
  return resolveHrefTarget(path.startsWith("/") ? path : `/${path}`);
}

/**
 * sitemap.xml must exist, every <loc> must resolve to a built page, and every page
 * data/ promised must be listed (a member page search engines cannot find is a missing fact).
 * <loc> may be absolute (SITE_ORIGIN set) or site-relative (unset).
 */
export function checkSitemap(files: BuildFiles, data: ExpectedData): SitemapReport {
  const xml = files.get("sitemap.xml");
  if (xml === undefined) return { checkedUrls: 0, failures: ["missing file: sitemap.xml"] };
  const failures: string[] = [];
  const listed = new Set<string>();
  const locs = sitemapLocs(xml);
  for (const loc of locs) {
    const target = sitemapLocTarget(loc);
    listed.add(target);
    if (!targetExists(files, target)) failures.push(`sitemap entry has no page: ${loc}`);
  }
  for (const page of expectedPages(data)) {
    const target = page.replace(/\/?index\.html$/, "");
    if (!listed.has(target)) failures.push(`page not in sitemap: /${target}`);
  }
  return { checkedUrls: locs.length, failures };
}

export function formatReport(r: SmokeReport): string {
  const head = `smoke: ${r.checkedPages} HTML pages, ${r.checkedLinks} internal links checked`;
  if (r.failures.length === 0) return `${head} — OK`;
  return [`${head} — ${r.failures.length} failure(s):`, ...r.failures.map((f) => `  - ${f}`)].join("\n");
}
