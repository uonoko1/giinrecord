/**
 * Post-build step (cwd: apps/web): rasterizes brand/icon-square.svg and brand/og-image.svg into
 * build/client/{favicon.ico, icon-192.png, icon-512.png, apple-touch-icon.png, og-image.png} (#129).
 * The SVG sources are committed; the PNG/ICO outputs are build artifacts and never committed.
 * Usage: runs from `pnpm --filter web build`; BUILD_DIR overrides the output directory.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderBrandAssets } from "../app/lib/icons";

const buildDir = process.env.BUILD_DIR ?? path.resolve(process.cwd(), "build/client");
const brandDir = path.resolve(process.cwd(), "brand");

const sources = {
  icon: await readFile(path.join(brandDir, "icon-square.svg")),
  og: await readFile(path.join(brandDir, "og-image.svg")),
};
const out = await renderBrandAssets(sources);
for (const [name, buf] of out) await writeFile(path.join(buildDir, name), buf);
console.log(`brand-assets: ${[...out.keys()].join(", ")} -> ${buildDir}`);
