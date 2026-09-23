/** 2025-11（r0711）の付託委員会の欄を座標で開く。#874 分類 B「委員会名が中央揃え」を再確認する。 */
import { readFileSync } from "node:fs";
import { readPages } from "../src/sources/local/pdf-table.ts";
import { PoliteFetcher } from "../src/sources/local/polite-fetch.ts";
import { SHIMANE_HOST } from "../src/sources/local/shimane/site.ts";
const url = process.argv[2];
const f = new PoliteFetcher(SHIMANE_HOST);
const pages = await readPages(await f.bytes(url));
console.log("pages:", pages.length);
for (const [pi, page] of pages.entries()) {
  const head = page.items.find((i) => i.str === "付託委員会");
  if (!head) { console.log(`page ${pi+1}: no 付託委員会 header`); continue; }
  console.log(`page ${pi+1}: 付託委員会 header x=${head.x.toFixed(1)} w=${head.w.toFixed(1)} centre=${(head.x+head.w/2).toFixed(1)} y=${head.y.toFixed(1)}`);
  // ヘッダより下、x がヘッダの帯の中にあるアイテム
  const band = page.items.filter((i) => i.y < head.y - 6 && i.x > head.x - 60 && i.x < head.x + head.w + 60 && /委員会|予算|審査/.test(i.str));
  const xs = band.map((i) => i.x);
  console.log(`  本文の委員会名 ${band.length} 個: 左端 min=${Math.min(...xs).toFixed(1)} max=${Math.max(...xs).toFixed(1)}  相異なる左端 ${new Set(xs.map(x=>x.toFixed(1))).size}`);
  const bycentre = band.map((i) => (i.x + i.w/2));
  console.log(`  中心 min=${Math.min(...bycentre).toFixed(1)} max=${Math.max(...bycentre).toFixed(1)} 相異なる中心 ${new Set(bycentre.map(x=>x.toFixed(1))).size}`);
  for (const i of band.slice(0, 12)) console.log(`    x=${i.x.toFixed(1)} w=${i.w.toFixed(1)} c=${(i.x+i.w/2).toFixed(1)} y=${i.y.toFixed(1)} "${i.str}"`);
  if (pi >= 1) break;
}
