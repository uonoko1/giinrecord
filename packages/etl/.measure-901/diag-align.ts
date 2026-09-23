/**
 * 付託委員会の欄が「左端が揃う」か「中心が揃う」かを、14 本すべてで PDF 自身の座標から測る。
 * 決め打ちにしないために、**どちらの揃い方のほうがばらつきが小さいか**を数で出す。
 */
import { readPages } from "../src/sources/local/pdf-table.ts";
import { PoliteFetcher } from "../src/sources/local/polite-fetch.ts";
import { SHIMANE_HOST } from "../src/sources/local/shimane/site.ts";
const f = new PoliteFetcher(SHIMANE_HOST);
const urls: [string, string][] = JSON.parse(process.argv[2]);
const sd = (xs: number[]) => { const m = xs.reduce((a,b)=>a+b,0)/xs.length; return Math.sqrt(xs.reduce((a,b)=>a+(b-m)**2,0)/xs.length); };
for (const [label, url] of urls) {
  let pages;
  try { pages = await readPages(await f.bytes(url)); } catch { console.log(`${label}\tREAD-THROW`); continue; }
  const L: number[] = [], C: number[] = [], R: number[] = [];
  for (const page of pages) {
    const head = page.items.find((i) => i.str === "付託委員会");
    if (!head) continue;
    for (const i of page.items) {
      if (i.y >= head.y - 6) continue;
      if (!(i.x > head.x - 60 && i.x < head.x + head.w + 60)) continue;
      if (!/^[^※]{2,12}(委員会|審査会)$/.test(i.str)) continue;
      L.push(i.x); C.push(i.x + i.w / 2); R.push(i.x + i.w);
    }
  }
  if (L.length === 0) { console.log(`${label}\tn=0`); continue; }
  // 幅が 1 種類しかないと左右も中心も同じばらつきになるので、幅の種類も出す
  const widths = new Set(R.map((r, k) => Number((r - L[k]).toFixed(1))));
  console.log(`${label}\tn=${L.length}\t幅の種類 ${widths.size}\t左端 sd=${sd(L).toFixed(2)}\t中心 sd=${sd(C).toFixed(2)}\t右端 sd=${sd(R).toFixed(2)}\t→ ${sd(C) < sd(L) - 0.5 ? "中心そろえ" : "左そろえ"}`);
}
