/**
 * Post-build step (cwd: apps/web): writes build/client/sitemap.xml and robots.txt.
 * Paths come from the same enumeration the prerender uses (app/lib/prerender.ts), so the
 * sitemap lists exactly the pages that exist; lastmod is data/meta.json fetchedAt.
 * SITE_ORIGIN sets the absolute URLs; unset → site-relative paths (the build still works).
 * Usage: runs from `pnpm --filter web build`; BUILD_DIR / SEIJI_DATA_DIR override defaults.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultDataDir, readMeta } from "../app/lib/data-files";
import { prerenderPaths } from "../app/lib/prerender";
import { normalizeOrigin } from "../app/lib/seo";
import { buildRobots, buildSitemap } from "../app/lib/sitemap";

const buildDir = process.env.BUILD_DIR ?? path.resolve(process.cwd(), "build/client");
const dataDir = defaultDataDir();
const origin = normalizeOrigin(process.env.SITE_ORIGIN);

const [paths, meta] = await Promise.all([prerenderPaths(dataDir), readMeta(dataDir)]);
await writeFile(path.join(buildDir, "sitemap.xml"), buildSitemap(paths, { origin, lastmod: meta?.fetchedAt ?? null }));
await writeFile(path.join(buildDir, "robots.txt"), buildRobots(origin));
console.log(`sitemap: ${paths.length} urls, origin=${origin || "(relative)"}, lastmod=${meta?.fetchedAt ?? "none"} -> ${buildDir}`);
