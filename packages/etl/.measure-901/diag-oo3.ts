import { readFileSync } from "node:fs";
import { readPages } from "../src/sources/local/pdf-table.ts";
const pages = await readPages(readFileSync(new URL("../test/fixtures/shimane/r0711_giinbetu_kekka.pdf", import.meta.url)));
const page = pages[2];
const it = page.items.find(i=>i.str==="○ ○")!;
console.log(`"○ ○" x=${it.x.toFixed(2)} w=${it.w.toFixed(2)} 右端=${(it.x+it.w).toFixed(2)} y=${it.y.toFixed(2)}`);
const row = page.items.filter(i=>Math.abs(i.y-it.y)<2 && /^[○●]/.test(i.str)).sort((a,b)=>a.x-b.x);
console.log(`同じ行 ${row.length} 個: ${row.map(r=>`${r.str}@${r.x.toFixed(1)}`).join(" ")}`);
// 正常な行（この行の 1 つ上・1 つ下）の記号の x を列の基準に
const ys = [...new Set(page.items.filter(i=>/^[○●]$/.test(i.str)).map(i=>Number(i.y.toFixed(1))))].sort((a,b)=>b-a);
const near = ys.filter(y=>Math.abs(y-it.y)<40 && Math.abs(y-it.y)>1);
for (const y of near.slice(0,3)) {
  const r = page.items.filter(i=>Math.abs(i.y-y)<1 && /^[○●]$/.test(i.str)).sort((a,b)=>a.x-b.x);
  console.log(`y=${y} 記号 ${r.length} 個 x: ${r.map(q=>q.x.toFixed(1)).join(",")}`);
}
