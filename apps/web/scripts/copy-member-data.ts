/**
 * Post-build step (Issue #104, runs after `react-router build`, cwd: apps/web):
 * copies data/members/*.json to build/client/data/members/ so /compare can fetch
 * /data/members/{id}.json at runtime (nginx serves /data/ with a 1h cache, same as the archive).
 * 772 member files are too much to bundle into one chunk, and the page is query-driven
 * (not prerendered), so the JSON stays as plain static files. Nothing to copy → no-op.
 *
 * Also copies the operational files at the top of data/ (Issue #152: meta.json, unmatched*.json,
 * group-mismatch.json — OPS_DATA_FILES, whichever exist) to build/client/data/ so the external monitor
 * (deploy/monitor/probe.sh) can read /data/meta.json's fetchedAt for its freshness check.
 * Usage: tsx scripts/copy-member-data.ts   (BUILD_DIR / SEIJI_DATA_DIR override the defaults)
 */
import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { defaultDataDir } from "../app/lib/data-files";
import { OPS_DATA_FILES } from "../app/lib/smoke";

const buildDir = process.env.BUILD_DIR ?? path.resolve(process.cwd(), "build/client");
const dataDir = defaultDataDir();
const src = path.join(dataDir, "members");
const dst = path.join(buildDir, "data", "members");

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

let names: string[] = [];
try {
  names = (await readdir(src)).filter((f) => f.endsWith(".json") && f !== "index.json").sort();
} catch (err) {
  if (!isEnoent(err)) throw err;
}
await mkdir(dst, { recursive: true });
for (const name of names) await copyFile(path.join(src, name), path.join(dst, name));
console.log(`member data: ${names.length} files -> ${dst}`);

const opsDst = path.join(buildDir, "data");
const copied: string[] = [];
for (const name of OPS_DATA_FILES) {
  try {
    await copyFile(path.join(dataDir, name), path.join(opsDst, name));
    copied.push(name);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}
console.log(`ops data: ${copied.length} files (${copied.join(", ") || "none"}) -> ${opsDst}`);
