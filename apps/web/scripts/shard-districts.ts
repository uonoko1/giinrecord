/**
 * Post-build step (Issue #112, runs after `react-router build`, cwd: apps/web):
 * splits data/districts/by-zip.json (~10 MB, 120k zips) into build/client/data/districts/zip/{first3}.json
 * (at most 1,000 small files) and copies data/districts/meta.json next to them, so the Home 郵便番号 input
 * can fetch just the shard for the typed zip (nginx serves /data/ with a 1h cache, same as /data/members/).
 * No data/districts/ → no-op (the widget then reports 「該当する郵便番号が見つかりません」).
 * Usage: tsx scripts/shard-districts.ts   (BUILD_DIR / SEIJI_DATA_DIR override the defaults)
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ZipDistricts } from "@seiji-kiroku/shared";
import { defaultDataDir } from "../app/lib/data-files";
import { DISTRICTS_DATA_PATH, shardByZip } from "../app/lib/districts";

const buildDir = process.env.BUILD_DIR ?? path.resolve(process.cwd(), "build/client");
const src = path.join(defaultDataDir(), "districts");
const dst = path.join(buildDir, ...DISTRICTS_DATA_PATH.split("/"));

let byZip: Record<string, ZipDistricts> | null = null;
try {
  byZip = JSON.parse(await readFile(path.join(src, "by-zip.json"), "utf8")) as Record<string, ZipDistricts>;
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

if (byZip === null) {
  console.log("districts: data/districts/by-zip.json absent, nothing to shard");
} else {
  const shards = shardByZip(byZip);
  await mkdir(path.join(dst, "zip"), { recursive: true });
  for (const [prefix, shard] of shards) await writeFile(path.join(dst, "zip", `${prefix}.json`), JSON.stringify(shard));
  await copyFile(path.join(src, "meta.json"), path.join(dst, "meta.json"));
  console.log(`districts: ${Object.keys(byZip).length} zips -> ${shards.size} shards in ${dst}/zip + meta.json`);
}
