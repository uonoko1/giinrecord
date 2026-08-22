/**
 * Post-build step (runs after `react-router build`, cwd: apps/web):
 * writes build/client/data/data-archive.zip — all of data/ (incl. LICENSE) plus README.txt.
 * Deterministic: same data/ → same bytes (app/lib/archive.ts).
 * Usage: tsx scripts/build-archive.ts   (BUILD_DIR / SEIJI_DATA_DIR override the defaults)
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ARCHIVE_NAME, buildDataArchive } from "../app/lib/archive";
import { defaultDataDir } from "../app/lib/data-files";

const buildDir = process.env.BUILD_DIR ?? path.resolve(process.cwd(), "build/client");
const dataDir = defaultDataDir();
const { zip, dataFileCount } = await buildDataArchive(dataDir);
const out = path.join(buildDir, "data", ARCHIVE_NAME);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, zip);
console.log(`archive: ${out} (${dataFileCount} data files + README, ${zip.length} bytes)`);
