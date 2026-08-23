/**
 * Browser check (Issue #194): the URL-mode smoke only looks at status codes and headers, so a CSP that
 * blocks the inline <script> tags React Router emits (hydration context, themeInit) went unnoticed and
 * production shipped with no working client-side JS. This script opens a few served pages in headless
 * Chromium and fails on anything the header checks cannot see:
 *   - any console error or uncaught page error
 *   - any `securitypolicyviolation` event (CSP)
 *   - the members search really filters (typing reduces the number of rows -> hydration happened)
 * Usage: pnpm --filter web browser-check -- --url http://127.0.0.1:8081
 * Requires a Chromium for Playwright: `pnpm --filter web exec playwright install --with-deps chromium` (CI: docker-web job).
 * PO: run the same command against https://gikailog.jp once the VPS has picked up the new site.conf.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type ConsoleMessage, type Page } from "playwright";
import { defaultDataDir } from "../app/lib/data-files";

const urlFlag = process.argv.indexOf("--url");
const baseUrl = urlFlag >= 0 ? process.argv[urlFlag + 1] : undefined;
if (!baseUrl) {
  console.error("browser-check: --url <origin> is required, e.g. --url http://127.0.0.1:8081");
  process.exit(2);
}
const origin = baseUrl.replace(/\/$/, "");

/** one member page to open: the first id of data/members/index.json (null when no data is built) */
async function firstMemberId(): Promise<string | null> {
  try {
    const index = JSON.parse(await readFile(path.join(defaultDataDir(), "members", "index.json"), "utf8")) as { id: string }[];
    return index[0]?.id ?? null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return null;
  }
}

interface PageResult {
  url: string;
  consoleErrors: string[];
  pageErrors: string[];
  cspViolations: string[];
}

/** Installed before any script of the page runs, so violations from the inline <script> tags are caught too. */
const CSP_LISTENER = `
  window.__cspViolations = [];
  document.addEventListener("securitypolicyviolation", (e) => {
    window.__cspViolations.push(e.violatedDirective + " blocked " + (e.blockedURI || "inline") + " at " + e.sourceFile + ":" + e.lineNumber);
  });
`;

async function visit(page: Page, url: string, run?: (page: Page) => Promise<void>): Promise<PageResult> {
  const r: PageResult = { url, consoleErrors: [], pageErrors: [], cspViolations: [] };
  const onConsole = (m: ConsoleMessage) => {
    if (m.type() === "error") r.consoleErrors.push(m.text());
  };
  const onPageError = (e: Error) => r.pageErrors.push(e.message);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  try {
    const res = await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    if (!res || res.status() !== 200) r.pageErrors.push(`status ${res?.status() ?? "none"} (expected 200)`);
    if (run) await run(page);
  } catch (err) {
    r.pageErrors.push(err instanceof Error ? err.message : String(err));
  } finally {
    // read even when goto/run threw: the violations are the diagnosis
    r.cspViolations = await page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []).catch(() => []);
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
  }
  return r;
}

/** The members search narrows the list only after hydration: rows before typing must be > rows after. */
async function membersSearchFilters(page: Page): Promise<void> {
  const rows = () => page.locator("li.members-item").count();
  const before = await rows();
  if (before === 0) throw new Error("members: no rows rendered (li.members-item)");
  await page.locator("input[type=search].members-input").fill("ふじかわ");
  await page
    .waitForFunction((n) => document.querySelectorAll("li.members-item").length < n, before, { timeout: 5_000 })
    .catch(() => undefined);
  const after = await rows();
  if (!(after < before)) throw new Error(`members search did not filter: ${before} rows before typing, ${after} after (hydration blocked?)`);
  console.log(`browser-check: members search ${before} -> ${after} rows`);
}

const memberId = await firstMemberId();
const targets: { url: string; run?: (page: Page) => Promise<void> }[] = [
  { url: `${origin}/` },
  { url: `${origin}/members/`, run: membersSearchFilters },
  { url: `${origin}/rollcalls/` },
  ...(memberId ? [{ url: `${origin}/members/${memberId}/` }] : []),
];

const browser = await chromium.launch();
const failures: string[] = [];
try {
  const context = await browser.newContext();
  await context.addInitScript(CSP_LISTENER);
  const page = await context.newPage();
  for (const t of targets) {
    const r = await visit(page, t.url, t.run);
    for (const e of r.cspViolations) failures.push(`${r.url}: CSP violation: ${e}`);
    for (const e of r.consoleErrors) failures.push(`${r.url}: console error: ${e}`);
    for (const e of r.pageErrors) failures.push(`${r.url}: ${e}`);
    console.log(`browser-check: ${r.url} csp=${r.cspViolations.length} console=${r.consoleErrors.length} errors=${r.pageErrors.length}`);
  }
} finally {
  await browser.close();
}
if (failures.length > 0) {
  console.error(`browser-check: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`browser-check: ok (${targets.length} pages)`);
