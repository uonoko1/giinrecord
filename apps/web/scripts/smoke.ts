/**
 * Build smoke test: run after `pnpm build` (cwd: apps/web).
 * Walks build/client, asserts the pages data/ promised exist and every internal
 * href resolves to a file or dir/index.html, and that data/data-archive.zip exists with
 * one entry per data/ file (+ README) within ARCHIVE_MAX_BYTES. Exits non-zero on any failure.
 * Usage: pnpm --filter web smoke   (BUILD_DIR / SEIJI_DATA_DIR override the defaults)
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ARCHIVE_NAME, checkArchive, collectDataFiles } from "../app/lib/archive";
import { defaultDataDir, readRollCallIndex } from "../app/lib/data-files";
import { checkBuild, formatReport, type BuildFiles, type ExpectedData } from "../app/lib/smoke";

async function listBuild(root: string): Promise<BuildFiles> {
  const files: BuildFiles = new Map();
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const abs = path.join(e.parentPath, e.name);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    files.set(rel, rel.endsWith(".html") ? await readFile(abs, "utf8") : "");
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
const report = checkBuild(files, data);

/** Upper bound for the bulk zip. data/ is ~41 MB raw (5 sessions) and deflates to a few MB; raise deliberately when sessions grow. */
const ARCHIVE_MAX_BYTES = Number(process.env.ARCHIVE_MAX_BYTES ?? 50 * 1024 * 1024);
const archivePath = path.join(buildDir, "data", ARCHIVE_NAME);
const archive = files.has(`data/${ARCHIVE_NAME}`) ? await readFile(archivePath) : undefined;
const dataFileCount = (await collectDataFiles(dataDir)).length;
report.failures.push(...checkArchive(archive, { dataFileCount, maxBytes: ARCHIVE_MAX_BYTES }));

console.log(`smoke: build=${buildDir} data=${dataDir} members=${data.memberIds?.length ?? "none"} rollcalls=${data.rollCalls?.length ?? "none"}`);
console.log(`smoke: archive=${archivePath} size=${archive?.length ?? "missing"} dataFiles=${dataFileCount} max=${ARCHIVE_MAX_BYTES}`);
console.log(formatReport(report));
process.exit(report.failures.length === 0 ? 0 : 1);
