/**
 * Post-build step (Issue #104, runs after `react-router build`, cwd: apps/web):
 * copies data/members/*.json to build/client/data/members/ so /compare can fetch
 * /data/members/{id}.json at runtime (nginx serves /data/ with a 1h cache, same as the archive).
 * Also copies data/members/{id}/speeches.json (Issue #242) so the member page can fetch the speech tab
 * at runtime. Speeches are deliberately NOT prerendered: `ssr: false` bakes the whole timeline into the
 * HTML (2.15x the source JSON, measured in #263), so splitting the file only helps if the page fetches it.
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
/** `members/{id}/speeches.json`（#242）。ディレクトリを持つ議員だけ（発言 0 件の議員のファイルは無い） */
let speechDirs: string[] = [];
try {
  const entries = await readdir(src, { withFileTypes: true });
  names = entries.filter((e) => e.isFile() && e.name.endsWith(".json") && e.name !== "index.json").map((e) => e.name).sort();
  speechDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
} catch (err) {
  if (!isEnoent(err)) throw err;
}
await mkdir(dst, { recursive: true });
for (const name of names) await copyFile(path.join(src, name), path.join(dst, name));
let speechFiles = 0;
for (const id of speechDirs) {
  try {
    await mkdir(path.join(dst, id), { recursive: true });
    await copyFile(path.join(src, id, "speeches.json"), path.join(dst, id, "speeches.json"));
    speechFiles++;
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}
console.log(`member data: ${names.length} files + ${speechFiles} speeches.json -> ${dst}`);

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
