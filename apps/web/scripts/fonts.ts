/**
 * Regenerates the self-hosted fonts in public/fonts/ (Issue #168). Run by hand, not at build time:
 *   pnpm --filter web fonts
 * Fetches the Google Fonts CSS for FONT_FAMILIES as a woff2-capable browser (so it comes back as
 * ~120 unicode-range slices per weight), downloads every slice, writes public/fonts/fonts.css that
 * points only at local files, and copies the SIL OFL text. The outputs are committed; the site
 * itself never talks to Google (CSP: font-src 'self', no preconnect).
 * Only fonts.googleapis.com / fonts.gstatic.com / github.com (OFL text) are contacted.
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { FONT_FAMILIES, parseGoogleFontsCss, renderFontsCss, sliceFileName } from "../app/lib/self-hosted-fonts";

const ALLOWED_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com", "raw.githubusercontent.com"]);
/** woff2 + unicode-range are only served to a browser UA that advertises them */
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
/** google/fonts repo: each family ships its own OFL.txt (copyright holder differs per family) */
const OFL_URLS: Record<string, string> = {
  "Shippori Mincho": "https://raw.githubusercontent.com/google/fonts/main/ofl/shipporimincho/OFL.txt",
  "BIZ UDPGothic": "https://raw.githubusercontent.com/google/fonts/main/ofl/bizudpgothic/OFL.txt",
};

const outDir = process.env.FONTS_DIR ?? path.resolve(process.cwd(), "public/fonts");

async function get(url: string): Promise<Response> {
  if (!ALLOWED_HOSTS.has(new URL(url).hostname)) throw new Error(`fonts: refusing to fetch ${url}`);
  const r = await fetch(url, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`fonts: ${url} -> ${r.status}`);
  return r;
}

const query = FONT_FAMILIES.map((f) => `family=${f.family.replace(/ /g, "+")}:wght@${f.weights.join(";")}`).join("&");
const cssUrl = `https://fonts.googleapis.com/css2?${query}&display=swap`;
const faces = parseGoogleFontsCss(await (await get(cssUrl)).text());
if (faces.length === 0) throw new Error("fonts: no @font-face blocks in Google CSS");

await mkdir(outDir, { recursive: true });
for (const name of await readdir(outDir)) if (name.endsWith(".woff2")) await rm(path.join(outDir, name));

let total = 0;
const perFace = new Map<string, { files: number; bytes: number }>();
for (const face of faces) {
  const buf = Buffer.from(await (await get(face.sourceUrl)).arrayBuffer());
  await writeFile(path.join(outDir, sliceFileName(face)), buf);
  total += buf.length;
  const key = `${face.family} ${face.weight}`;
  const acc = perFace.get(key) ?? { files: 0, bytes: 0 };
  perFace.set(key, { files: acc.files + 1, bytes: acc.bytes + buf.length });
}
const css = renderFontsCss(faces);
await writeFile(path.join(outDir, "fonts.css"), css);
const ofl: string[] = [];
for (const f of FONT_FAMILIES) {
  const url = OFL_URLS[f.family];
  if (!url) throw new Error(`fonts: no OFL url for ${f.family}`);
  ofl.push(`==== ${f.family} ====\n\n${(await (await get(url)).text()).trim()}\n`);
}
await writeFile(path.join(outDir, "OFL.txt"), ofl.join("\n"));

for (const [key, v] of perFace) console.log(`fonts: ${key}: ${v.files} slices, ${(v.bytes / 1024).toFixed(0)} KB`);
console.log(`fonts: ${faces.length} slices, ${(total / 1024 / 1024).toFixed(2)} MB woff2 + fonts.css ${(css.length / 1024).toFixed(0)} KB -> ${outDir}`);
