/**
 * Pure checker behind scripts/smoke.ts: given an in-memory listing of build/client
 * (relative path -> file content; non-HTML files may be empty strings) and what data/
 * promised, report every missing page and broken internal link. No I/O here so the
 * rules are unit-testable; scripts/smoke.ts does the filesystem walk.
 */

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

export function formatReport(r: SmokeReport): string {
  const head = `smoke: ${r.checkedPages} HTML pages, ${r.checkedLinks} internal links checked`;
  if (r.failures.length === 0) return `${head} — OK`;
  return [`${head} — ${r.failures.length} failure(s):`, ...r.failures.map((f) => `  - ${f}`)].join("\n");
}
