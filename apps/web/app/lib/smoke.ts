/**
 * Pure checker behind scripts/smoke.ts: given an in-memory listing of build/client
 * (relative path -> file content; non-HTML files may be empty strings) and what data/
 * promised, report every missing page and broken internal link. No I/O here so the
 * rules are unit-testable; scripts/smoke.ts does the filesystem walk.
 */

import type { ZipDistricts } from "@seiji-kiroku/shared";
import { DIET_ASSEMBLIES } from "./data-contract";
import { DISTRICTS_DATA_PATH, zipShardUrl } from "./districts";
import { SITE_NAME } from "./seo";
import { sitemapLocs } from "./sitemap";

/** relative path (posix, no leading slash) -> file content */
export type BuildFiles = Map<string, string>;

export interface ExpectedData {
  /** ids from data/members/index.json, or null when that file is absent */
  memberIds: string[] | null;
  /** 発言のある議員の id（data/members/{id}/speeches.json があるもの。#242）。data/ が無ければ省略／null */
  speechMemberIds?: string[] | null;
  /** entries from data/rollcalls/index.json, or null when that file is absent */
  rollCalls: { session: number; id: string }[] | null;
  /** data/assemblies/index.json の id。ファイルが無ければ省略／null → 国会の2議会（prerender の fallback と同じ、#158） */
  assemblyIds?: string[] | null;
  /** data/districts/by-zip.json から: 上3桁の一覧と、引き比べる見本の1件。ファイルが無ければ省略／null（#112） */
  districts?: { prefixes: string[]; sample: { zip: string; districts: ZipDistricts } } | null;
  /** data/ 直下にある運用ファイル名（OPS_DATA_FILES のうち存在するもの）。data/ が無ければ省略／null（#152） */
  opsFiles?: string[] | null;
}

export interface SmokeReport {
  checkedPages: number;
  checkedLinks: number;
  failures: string[];
}

export const REQUIRED_PAGES = ["index.html", "about/index.html", "coverage/index.html", "terms/index.html", "privacy/index.html", "members/index.html", "assemblies/index.html"];

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
  for (const id of data.assemblyIds ?? DIET_ASSEMBLIES.map((a) => a.id)) pages.push(`assemblies/${id}/index.html`);
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

/**
 * nginx が 404 の本文として返すファイル（deploy/nginx/site.conf の `error_page 404`）。#325
 * React Router がプリレンダー無しのルート用に書き出す SPA shell そのもの。
 */
export const SPA_FALLBACK_FILE = "__spa-fallback.html";

/**
 * Issue #325: この shell は 404 の本文であり、/compare（#104）の本文でもある。
 * HydrateFallback を定義するまで、React Router の既定フォールバックがそのまま出ていた：
 * `<html lang="en">`（日本語サイトなのに en）、`<title>Loading...</title>`（サイト名が無いので
 * 外形監視 deploy/monitor/probe.sh の title 検査も通らない）、そして本番のコンソールに出る
 * `💿 Hey developer` の console.log。ビルド成果物側でそれを固定する。
 */
export function checkSpaFallback(files: BuildFiles): { failures: string[] } {
  const html = files.get(SPA_FALLBACK_FILE);
  if (html === undefined) return { failures: [`missing page: ${SPA_FALLBACK_FILE}`] };
  const failures: string[] = [];
  const lang = html.match(/<html[^>]*\blang="([^"]*)"/)?.[1];
  if (lang !== "ja") failures.push(`${SPA_FALLBACK_FILE}: <html lang="${lang ?? ""}"> (expected lang="ja")`);
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/)?.[1] ?? "";
  if (!title.includes(SITE_NAME)) failures.push(`${SPA_FALLBACK_FILE}: <title>${title}</title> lacks the site name`);
  if (!/<meta[^>]+name="robots"[^>]+content="[^"]*noindex/.test(html)) {
    failures.push(`${SPA_FALLBACK_FILE}: no <meta name="robots" content="noindex">`);
  }
  if (html.includes("Hey developer")) failures.push(`${SPA_FALLBACK_FILE}: React Router の既定フォールバック（Hey developer）が残っている`);
  return { failures };
}

export interface MemberDataReport {
  checkedFiles: number;
  failures: string[];
}

/**
 * ビルドが /data/members/ に置くべきファイル。
 * - `{id}.json`: /compare が実行時に fetch する（#104）
 * - `{id}/speeches.json`: 議員ページの発言タブが実行時に fetch する（#242）。発言のある議員のぶんだけ
 */
export function expectedMemberDataFiles(data: ExpectedData): string[] {
  return [
    ...(data.memberIds ?? []).map((id) => `data/members/${id}.json`),
    ...(data.speechMemberIds ?? []).map((id) => `data/members/${id}/speeches.json`),
  ];
}

/**
 * /compare（#104）は議員の JSON をバンドルせず、ビルド時に data/members/*.json を build/client/data/members/ へ
 * コピーしたものを fetch する（scripts/copy-member-data.ts）。index.json の全 id 分が無ければ失敗。
 * 議員ページの発言タブ（#242）も同じ経路で `{id}/speeches.json` を fetch するので、そちらも欠けていれば失敗。
 * ここが抜けると「発言タブを開いても 404 で空」という、ビルドは通るのに画面だけ壊れる形になる。
 */
export function checkMemberData(files: BuildFiles, data: ExpectedData): MemberDataReport {
  const expected = expectedMemberDataFiles(data);
  const failures = expected.filter((f) => !files.has(f)).map((f) => `missing data file: ${f}`);
  return { checkedFiles: expected.length, failures };
}

/**
 * Home の郵便番号入力（#112）は data/districts/by-zip.json をバンドルせず、ビルドが上3桁ごとに切り出した
 * build/client/data/districts/zip/{上3桁}.json と meta.json を fetch する（scripts/shard-districts.ts）。
 * by-zip.json にある上3桁の分だけ分割ファイルが要り、見本の郵便番号を分割ファイルから引いた値は by-zip.json と一致しなければならない。
 * 分割ファイルの中身（files の値）は JSON 文字列で渡す。
 */
export function checkDistrictData(files: BuildFiles, data: ExpectedData): MemberDataReport {
  const d = data.districts;
  if (!d) return { checkedFiles: 0, failures: [] };
  const metaFile = `${DISTRICTS_DATA_PATH}/meta.json`;
  const expected = [metaFile, ...d.prefixes.map((p) => `${DISTRICTS_DATA_PATH}/zip/${p}.json`)];
  const failures = expected.filter((f) => !files.has(f)).map((f) => `missing data file: ${f}`);
  const shardFile = zipShardUrl(d.sample.zip).slice(1);
  const shardText = files.get(shardFile);
  if (shardText !== undefined) {
    let found: ZipDistricts | undefined;
    try {
      found = (JSON.parse(shardText) as Record<string, ZipDistricts>)[d.sample.zip];
    } catch {
      failures.push(`invalid JSON: ${shardFile}`);
    }
    if (found === undefined) failures.push(`zip ${d.sample.zip} not in ${shardFile}`);
    else if (JSON.stringify(found) !== JSON.stringify(d.sample.districts)) failures.push(`zip ${d.sample.zip} in ${shardFile} differs from by-zip.json`);
  }
  return { checkedFiles: expected.length, failures };
}

/**
 * data/ 直下の運用ファイル（#152）。ビルドが build/client/data/ へそのままコピーし（scripts/copy-member-data.ts）、
 * nginx が /data/ で配信する。meta.json は外部監視（deploy/monitor/probe.sh）が鮮度チェックに読む。
 * 順序は固定（コピーとログが決定的になるように）。
 */
export const OPS_DATA_FILES = ["meta.json", "unmatched.json", "unmatched-bills.json", "unmatched-groups.json", "group-mismatch.json"];

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * data/ にある運用ファイルはすべて build/client/data/ に要る。meta.json は JSON として読めて、
 * 最上位に ISO 日時の fetchedAt を持たなければならない（probe.sh が最初の "fetchedAt" を ETL の実行時刻として読む）。
 * meta.json の中身（files の値）は JSON 文字列で渡す。
 */
export function checkOpsData(files: BuildFiles, data: ExpectedData): MemberDataReport {
  const expected = (data.opsFiles ?? []).map((name) => `data/${name}`);
  const failures = expected.filter((f) => !files.has(f)).map((f) => `missing data file: ${f}`);
  const metaFile = "data/meta.json";
  const metaText = expected.includes(metaFile) ? files.get(metaFile) : undefined;
  if (metaText !== undefined) {
    let fetchedAt: unknown;
    let parsed = true;
    try {
      fetchedAt = (JSON.parse(metaText) as { fetchedAt?: unknown }).fetchedAt;
    } catch {
      parsed = false;
      failures.push(`invalid JSON: ${metaFile}`);
    }
    if (parsed && (typeof fetchedAt !== "string" || !ISO_DATETIME_RE.test(fetchedAt))) failures.push(`${metaFile}: fetchedAt missing or not an ISO datetime`);
  }
  return { checkedFiles: expected.length, failures };
}

/**
 * ロゴ・ファビコン・manifest・OGP 画像（#129）。SVG/manifest は public/ から、PNG/ICO はビルドが
 * brand/*.svg からラスタライズする（scripts/brand-assets.ts）。root.tsx と seoMeta が参照する名前と一致させる。
 */
export const REQUIRED_BRAND_ASSETS = ["favicon.svg", "favicon.ico", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "site.webmanifest", "og-image.png", "logo.svg"];

export function checkBrandAssets(files: BuildFiles): MemberDataReport {
  const failures = REQUIRED_BRAND_ASSETS.filter((f) => !files.has(f)).map((f) => `missing brand asset: ${f}`);
  return { checkedFiles: REQUIRED_BRAND_ASSETS.length, failures };
}

/** root.tsx が link する自サイト配信フォントの CSS（#168） */
export const FONTS_CSS = "fonts/fonts.css";

const RESOURCE_TAG_RE = /<(?:link|script|img|iframe|source|video|audio|object|embed)\b[^>]*?\b(?:href|src|data)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)/g;

const isExternal = (u: string) => /^(?:https?:)?\/\//i.test(u);

/**
 * Resource URLs a browser would *fetch* while rendering (link / script / img / iframe …) that point off-site.
 * Plain <a href> to the source documents (sourceUrl) are links the visitor chooses to follow and are not listed.
 */
export function externalResourceUrls(html: string, siteOrigin = process.env.SITE_ORIGIN ?? ""): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(RESOURCE_TAG_RE)) {
    const tag = m[0];
    // <link rel="canonical"|"alternate"> は取得されない（検索エンジン向けの自己参照）。
    if (/^<link\b/i.test(tag) && /\brel\s*=\s*["'](?:canonical|alternate)["']/i.test(tag)) continue;
    const u = m[1] ?? m[2] ?? "";
    if (!isExternal(u)) continue;
    // 自サイトの絶対 URL（SITE_ORIGIN）は外部ではない。
    if (siteOrigin && (u === siteOrigin || u.startsWith(siteOrigin.replace(/\/$/, "") + "/"))) continue;
    out.push(u);
  }
  return out;
}

function cssUrls(css: string): string[] {
  return [...css.matchAll(CSS_URL_RE)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

/**
 * Issue #168（第三者送信ゼロ）: every built page loads resources only from this site, fonts/fonts.css
 * exists, references no external URL, and every woff2 it names is in the build.
 */
export function checkNoExternalResources(files: BuildFiles): MemberDataReport {
  const failures: string[] = [];
  let checkedFiles = 0;
  for (const [rel, html] of files) {
    if (!rel.endsWith(".html")) continue;
    checkedFiles++;
    for (const u of externalResourceUrls(html)) failures.push(`${rel}: external resource ${u}`);
  }
  const css = files.get(FONTS_CSS);
  if (css === undefined) failures.push(`missing ${FONTS_CSS} (self-hosted fonts, #168)`);
  else {
    checkedFiles++;
    for (const u of cssUrls(css)) {
      if (isExternal(u)) failures.push(`${FONTS_CSS}: external resource ${u}`);
      else if (!files.has(`fonts/${u}`)) failures.push(`${FONTS_CSS}: missing fonts/${u}`);
    }
  }
  return { checkedFiles, failures };
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
