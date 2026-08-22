/**
 * Build smoke test: run after `pnpm build` (cwd: apps/web).
 * Walks build/client, asserts the pages data/ promised exist and every internal
 * href resolves to a file or dir/index.html, that sitemap.xml lists exactly the built pages,
 * and that data/data-archive.zip exists with one entry per data/ file (+ README) within
 * ARCHIVE_MAX_BYTES. Exits non-zero on any failure.
 * Usage: pnpm --filter web smoke   (BUILD_DIR / SEIJI_DATA_DIR override the defaults)
 *
 * URL mode (Issue #85): `pnpm --filter web smoke -- --url http://127.0.0.1:8080` additionally fetches
 * every built page, one asset, one data file and an unknown path from that origin and checks status,
 * SPA fallback, security headers and Cache-Control (app/lib/smoke-url.ts). The file checks above still run first.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ARCHIVE_NAME, checkArchive, collectDataFiles } from "../app/lib/archive";
import { defaultDataDir, readRollCallIndex } from "../app/lib/data-files";
import { checkBuild, checkSitemap, formatReport, type BuildFiles, type ExpectedData } from "../app/lib/smoke";
import { checkServed, urlSmokeTargets, type ServedResponse } from "../app/lib/smoke-url";

async function listBuild(root: string): Promise<BuildFiles> {
  const files: BuildFiles = new Map();
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const abs = path.join(e.parentPath, e.name);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    files.set(rel, rel.endsWith(".html") || rel === "sitemap.xml" ? await readFile(abs, "utf8") : "");
  }
  return files;
}

async function readExpected(dataDir: string): Promise<ExpectedData> {
  let memberIds: string[] | null = null;
  try {
    const index = JSON.parse(await readFile(path.join(dataDir, "members", "index.json"), "utf8")) as { id: string }[];
    memberIds = index.map((m) => m.id);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  let rollCalls: ExpectedData["rollCalls"] = null;
  const rc = await readRollCallIndex(dataDir);
  if (rc.length > 0) rollCalls = rc.map((r) => ({ session: r.session, id: r.id }));
  return { memberIds, rollCalls };
}

const buildDir = process.env.BUILD_DIR ?? path.resolve(process.cwd(), "build/client");
const dataDir = defaultDataDir();
const files = await listBuild(buildDir);
const data = await readExpected(dataDir);
const pages = checkBuild(files, data);
const sitemap = checkSitemap(files, data);

/** Upper bound for the bulk zip. data/ is ~41 MB raw (5 sessions) and deflates to a few MB; raise deliberately when sessions grow. */
const ARCHIVE_MAX_BYTES = Number(process.env.ARCHIVE_MAX_BYTES ?? 50 * 1024 * 1024);
const archivePath = path.join(buildDir, "data", ARCHIVE_NAME);
const archive = files.has(`data/${ARCHIVE_NAME}`) ? await readFile(archivePath) : undefined;
const dataFileCount = (await collectDataFiles(dataDir)).length;
const archiveFailures = checkArchive(archive, { dataFileCount, maxBytes: ARCHIVE_MAX_BYTES });

const urlFlag = process.argv.indexOf("--url");
const baseUrl = urlFlag >= 0 ? process.argv[urlFlag + 1] : undefined;
if (urlFlag >= 0 && !baseUrl) {
  console.error("smoke: --url requires an origin, e.g. --url http://127.0.0.1:8080");
  process.exit(2);
}

async function fetchAll(origin: string, urls: string[]): Promise<Map<string, ServedResponse>> {
  const got = new Map<string, ServedResponse>();
  for (const url of urls) {
    try {
      const r = await fetch(new URL(url, origin), { redirect: "manual" });
      const headers: Record<string, string> = {};
      r.headers.forEach((v, k) => (headers[k] = v));
      await r.body?.cancel(); // headers + status are what we check; do not download the 5 MB archive
      got.set(url, { status: r.status, headers, body: "" });
    } catch {
      // left out of the map → reported as "no response"
    }
  }
  return got;
}

let servedFailures: string[] = [];
if (baseUrl) {
  const all = [...files.keys()];
  const targets = urlSmokeTargets(
    all.filter((f) => f.endsWith("index.html")),
    all.filter((f) => !f.endsWith(".html")),
  );
  const urls = [...targets.pages, targets.unknown, targets.asset, targets.data].filter((u): u is string => u !== null);
  const served = checkServed(await fetchAll(baseUrl, urls), targets);
  servedFailures = served.failures;
  console.log(`smoke: url=${baseUrl} ${served.checked} urls fetched`);
}

const report = { ...pages, failures: [...pages.failures, ...sitemap.failures, ...archiveFailures, ...servedFailures] };
console.log(`smoke: build=${buildDir} data=${dataDir} members=${data.memberIds?.length ?? "none"} rollcalls=${data.rollCalls?.length ?? "none"}`);
console.log(`smoke: sitemap.xml ${sitemap.checkedUrls} urls checked`);
console.log(`smoke: archive=${archivePath} size=${archive?.length ?? "missing"} dataFiles=${dataFileCount} max=${ARCHIVE_MAX_BYTES}`);
console.log(formatReport(report));
process.exit(report.failures.length === 0 ? 0 : 1);
