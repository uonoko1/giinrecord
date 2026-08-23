/**
 * URL-mode smoke (Issue #85): checks a *served* site (the nginx container behind
 * `docker compose up`) instead of the build directory. Pure functions only — scripts/smoke.ts
 * does the fetching. The expected header values are the ones the production server block
 * has always sent (deploy/nginx/site.conf); packages/etl/test/deploy-docker.test.ts pins the
 * same values against the nginx config, so a drift in either place fails CI.
 */

import { externalResourceUrls } from "./smoke";

export interface ServedResponse {
  status: number;
  /** lower-cased header name -> value */
  headers: Record<string, string>;
  body: string;
}

export interface UrlSmokeTargets {
  /** site-relative page URLs that must return 200 */
  pages: string[];
  /** a path that is not a page; must return 200 through the SPA fallback (null = skip) */
  unknown: string | null;
  /** one hashed asset (null = none built) */
  asset: string | null;
  /** one file under data/ (the archive zip today; null = none built) */
  data: string | null;
}

export const EXPECTED_SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "content-security-policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; connect-src 'self'",
};

export const EXPECTED_CACHE_CONTROL = {
  assets: "public, max-age=31536000, immutable",
  data: "public, max-age=3600",
} as const;

export const UNKNOWN_PATH = "/__smoke-no-such-page__/";

/** `members/m_1/index.html` -> `/members/m_1/`; `index.html` -> `/` */
function pageUrl(file: string): string {
  const dir = file.replace(/index\.html$/, "");
  return `/${dir}`;
}

export function urlSmokeTargets(pageFiles: string[], otherFiles: string[]): UrlSmokeTargets {
  const asset = otherFiles.find((f) => f.startsWith("assets/")) ?? null;
  const data = otherFiles.find((f) => f.startsWith("data/")) ?? null;
  return {
    pages: pageFiles.map(pageUrl),
    unknown: UNKNOWN_PATH,
    asset: asset ? `/${asset}` : null,
    data: data ? `/${data}` : null,
  };
}

export interface ServedReport {
  checked: number;
  failures: string[];
}

function expectHeader(url: string, r: ServedResponse, name: string, expected: string, failures: string[]): void {
  const actual = r.headers[name];
  if (actual === undefined) failures.push(`${url}: header ${name} missing (expected "${expected}")`);
  else if (actual !== expected) failures.push(`${url}: header ${name} = "${actual}" (expected "${expected}")`);
}

function expectSecurityHeaders(url: string, r: ServedResponse, failures: string[]): void {
  for (const [name, value] of Object.entries(EXPECTED_SECURITY_HEADERS)) expectHeader(url, r, name, value, failures);
}

export function checkServed(got: Map<string, ServedResponse>, t: UrlSmokeTargets): ServedReport {
  const failures: string[] = [];
  let checked = 0;
  const take = (url: string): ServedResponse | undefined => {
    checked++;
    const r = got.get(url);
    if (!r) failures.push(`${url}: no response`);
    return r;
  };

  for (const url of t.pages) {
    const r = take(url);
    if (!r) continue;
    if (r.status !== 200) failures.push(`${url}: status ${r.status} (expected 200)`);
    expectSecurityHeaders(url, r, failures);
    // #168: the served HTML must not load anything off-site (Google Fonts etc.)
    for (const u of externalResourceUrls(r.body)) failures.push(`${url}: external resource ${u}`);
  }
  if (t.unknown) {
    const r = take(t.unknown);
    if (r) {
      if (r.status !== 200) failures.push(`${t.unknown}: status ${r.status} (expected 200 via SPA fallback)`);
      expectSecurityHeaders(t.unknown, r, failures);
    }
  }
  if (t.asset) {
    const r = take(t.asset);
    if (r) {
      if (r.status !== 200) failures.push(`${t.asset}: status ${r.status} (expected 200)`);
      // nginx: add_header in a location replaces the server-level set, so /assets/ and /data/ carry
      // only Cache-Control — same as the production block has always done. Not checked here.
      expectHeader(t.asset, r, "cache-control", EXPECTED_CACHE_CONTROL.assets, failures);
    }
  }
  if (t.data) {
    const r = take(t.data);
    if (r) {
      if (r.status !== 200) failures.push(`${t.data}: status ${r.status} (expected 200)`);
      expectHeader(t.data, r, "cache-control", EXPECTED_CACHE_CONTROL.data, failures);
    }
  }
  return { checked, failures };
}
