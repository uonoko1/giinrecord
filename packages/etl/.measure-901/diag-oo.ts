/** 「○○」1 セルが、どの列にまたがっているかを座標で開く */
import { readFileSync } from "node:fs";
import { readPages } from "../src/sources/local/pdf-table.ts";
const pages = await readPages(readFileSync(new URL("../test/fixtures/shimane/r0711_giinbetu_kekka.pdf", import.meta.url)));
for (const [pi,page] of pages.entries()) {
  const oo = page.items.filter(i=>i.str==="○○");
  if (!oo.length) continue;
  for (const it of oo) {
    console.log(`page ${pi+1}: "○○" x=${it.x.toFixed(2)} w=${it.w.toFixed(2)} 右端=${(it.x+it.w).toFixed(2)} y=${it.y.toFixed(2)}`);
    // 同じ y の行の ○ を並べて、列の間隔を出す
    const row = page.items.filter(i=>Math.abs(i.y-it.y)<2 && (i.str==="○"||i.str==="●"||i.str==="○○")).sort((a,b)=>a.x-b.x);
    const xs = row.map(r=>Number(r.x.toFixed(2)));
    console.log(`  同じ行の記号 ${row.length} 個: ${row.map(r=>`${r.str}@${r.x.toFixed(1)}(w${r.w.toFixed(1)})`).join(" ")}`);
    const d = xs.slice(1).map((x,k)=>Number((x-xs[k]).toFixed(2)));
    console.log(`  隣との間隔: ${JSON.stringify(d)}`);
    // 上の行（正常な行）の記号の x を基準列として出す
    const above = page.items.filter(i=>Math.abs(i.y-(it.y+17.8))<3 && (i.str==="○"||i.str==="●")).sort((a,b)=>a.x-b.x);
    console.log(`  1 行上の記号 ${above.length} 個の x: ${above.map(r=>r.x.toFixed(1)).join(",")}`);
  }
}
