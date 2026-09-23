import { readFileSync } from "node:fs";
import { readPages } from "../src/sources/local/pdf-table.ts";
const pages = await readPages(readFileSync(new URL("../test/fixtures/shimane/r0711_giinbetu_kekka.pdf", import.meta.url)));
for (const [pi,page] of pages.entries()) {
  const hits = page.items.filter(i=>/○/.test(i.str) && i.str!=="○");
  for (const it of hits) console.log(`page ${pi+1}: ${JSON.stringify(it.str)} x=${it.x.toFixed(2)} w=${it.w.toFixed(2)} y=${it.y.toFixed(2)}`);
}
