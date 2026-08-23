/**
 * Post-build step (Issue #104, runs after `react-router build`, cwd: apps/web):
 * copies data/members/*.json to build/client/data/members/ so /compare can fetch
 * /data/members/{id}.json at runtime (nginx serves /data/ with a 1h cache, same as the archive).
 * 772 member files are too much to bundle into one chunk, and the page is query-driven
 * (not prerendered), so the JSON stays as plain static files. Nothing to copy → no-op.
 * Usage: tsx scripts/copy-member-data.ts   (BUILD_DIR / SEIJI_DATA_DIR override the defaults)
 */
import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { defaultDataDir } from "../app/lib/data-files";

const buildDir = process.env.BUILD_DIR ?? path.resolve(process.cwd(), "build/client");
const src = path.join(defaultDataDir(), "members");
const dst = path.join(buildDir, "data", "members");

let names: string[] = [];
try {
  names = (await readdir(src)).filter((f) => f.endsWith(".json") && f !== "index.json");
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}
await mkdir(dst, { recursive: true });
for (const name of names) await copyFile(path.join(src, name), path.join(dst, name));
console.log(`member data: ${names.length} files -> ${dst}`);
