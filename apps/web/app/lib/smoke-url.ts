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
  /**
   * Real routes that are deliberately NOT pre-rendered (/compare, #104): no HTML file exists for them,
   * so they are served from the SPA shell and must still return 200. Kept apart from `unknown`,
   * which must return 404 (#325) — the two used to be the same case.
   */
  spa: string[];
  /** a path that is not a route at all; must return 404 (#325; it used to be 200 via the SPA fallback) */
  unknown: string | null;
  /**
   * Issue #746: paths that exist as files in the build but must NOT be reachable as their own 200 URL
   * (`internal` in deploy/nginx/site.conf) — the pre-rendered not-found page and every spelling that
   * `try_files $uri $uri/index.html` can resolve to it. **They must return 404.**
   *
   * **This list used to be missing, and `pages` silently contained `/__not-found/`**: because the build
   * really does write `__not-found/index.html`, the generic "every index.html must be 200" rule
   * *asserted the bug*. Production served `/__not-found/` with 200 and the body
   * 「ページが見つかりません」, and this smoke test called that a pass (measured 2026-09-13).
   */
  internal: string[];
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
  // #482: 使っていないと数えた 17 個のブラウザ機能を空 allowlist で閉じる
  "permissions-policy":
    "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), usb=(), xr-spatial-tracking=()",
};

export const EXPECTED_CACHE_CONTROL = {
  assets: "public, max-age=31536000, immutable",
  data: "public, max-age=3600",
} as const;

export const UNKNOWN_PATH = "/__smoke-no-such-page__/";

/**
 * #104: /compare is query-driven and not pre-rendered. #325 made unknown paths 404, so this is exactly the
 * route a careless `=404` breaks; the smoke test fetches it on every run.
 */
export const SPA_ONLY_PATHS = ["/compare?m=m_1,m_2"];

/**
 * Issue #610 / #746: the pre-rendered not-found page. The build writes it, so it turns up in the
 * `index.html` sweep — but nginx marks it `internal`, so **every spelling must answer 404.**
 * All three are listed because `try_files $uri $uri/index.html` resolves the first two to the third.
 */
export const INTERNAL_ONLY_PATHS = ["/__not-found", "/__not-found/", "/__not-found/index.html"];

/** build-relative files that must be dropped from the "every page is 200" sweep (they are `internal`) */
const INTERNAL_PAGE_FILES = new Set(["__not-found/index.html"]);

/** `members/m_1/index.html` -> `/members/m_1/`; `index.html` -> `/` */
function pageUrl(file: string): string {
  const dir = file.replace(/index\.html$/, "");
  return `/${dir}`;
}

export function urlSmokeTargets(pageFiles: string[], otherFiles: string[]): UrlSmokeTargets {
  const asset = otherFiles.find((f) => f.startsWith("assets/")) ?? null;
  const data = otherFiles.find((f) => f.startsWith("data/")) ?? null;
  return {
    // #746: `internal` なファイルを「200 であるべきページ」から外す。**外し忘れると穴を固定してしまう**
    // ——`__not-found/index.html` はビルドが実際に書き出すので、この掃き出しに混ざっていた。
    pages: pageFiles.filter((f) => !INTERNAL_PAGE_FILES.has(f)).map(pageUrl),
    spa: [...SPA_ONLY_PATHS],
    unknown: UNKNOWN_PATH,
    internal: [...INTERNAL_ONLY_PATHS],
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
  // #104: not pre-rendered but a real route — 200 from the SPA shell. Checked before `unknown` because
  // this is the regression a `try_files … =404` introduces.
  for (const url of t.spa ?? []) {
    const r = take(url);
    if (!r) continue;
    if (r.status !== 200) failures.push(`${url}: status ${r.status} (expected 200)`);
    expectSecurityHeaders(url, r, failures);
  }
  // #746: the not-found page must not be reachable as its own 200 URL, in ANY spelling.
  // `internal` in nginx only rejects *external* requests; `try_files $uri $uri/index.html` resolves
  // /__not-found internally and used to answer 200 with the 「ページが見つかりません」 body — the same
  // text served at a second, indexable URL, which is exactly what #325 set out to prevent.
  for (const url of t.internal ?? []) {
    const r = take(url);
    if (!r) continue;
    if (r.status !== 404) failures.push(`${url}: status ${r.status} (expected 404 — internal, #746)`);
    expectSecurityHeaders(url, r, failures);
  }
  // #325: an unknown path must be 404, not 200 — a 200 makes search engines index a page that does not exist.
  if (t.unknown) {
    const r = take(t.unknown);
    if (r) {
      if (r.status !== 404) failures.push(`${t.unknown}: status ${r.status} (expected 404)`);
      expectSecurityHeaders(t.unknown, r, failures);
    }
  }
  if (t.asset) {
    const r = take(t.asset);
    if (r) {
      if (r.status !== 200) failures.push(`${t.asset}: status ${r.status} (expected 200)`);
      // #482: ここは以前「location の add_header が server 階層を置き換えるので Cache-Control しか
      // 付かない。仕様なので見ない」としていたが、**それは仕様ではなく穴だった**——本番の
      // /assets/*.js には CSP も nosniff も出ていなかった。site.conf 側で location ごとに
      // ヘッダを複製して直したので、ここでも**必ず確かめる**（実機での確認は deploy/test/nginx-headers.test.sh）。
      expectSecurityHeaders(t.asset, r, failures);
      expectHeader(t.asset, r, "cache-control", EXPECTED_CACHE_CONTROL.assets, failures);
    }
  }
  if (t.data) {
    const r = take(t.data);
    if (r) {
      if (r.status !== 200) failures.push(`${t.data}: status ${r.status} (expected 200)`);
      expectSecurityHeaders(t.data, r, failures);  // #482: /assets/ と同じ理由
      expectHeader(t.data, r, "cache-control", EXPECTED_CACHE_CONTROL.data, failures);
    }
  }
  return { checked, failures };
}
