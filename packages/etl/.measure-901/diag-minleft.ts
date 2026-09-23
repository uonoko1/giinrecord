/**
 * 「最頻の左端」を「最小の左端」に変えたら、14 本で境目がどう動くかを測る。
 * 件名の続きの行が付託委員会の欄に食い込んでいれば、最小は件名側に落ちる（＝壊れる）。
 */
import { readPages, type Item, type PageGeometry } from "../src/sources/local/pdf-table.ts";
import { PoliteFetcher } from "../src/sources/local/polite-fetch.ts";
import { SHIMANE_HOST } from "../src/sources/local/shimane/site.ts";
const f = new PoliteFetcher(SHIMANE_HOST);
const urls: [string, string][] = JSON.parse(process.argv[2]);
const cluster = (xs: number[], tol: number): number[] => {
  const s = [...xs].sort((a, b) => a - b); const out: number[] = [];
  for (const x of s) if (out.length === 0 || x - out[out.length - 1] > tol) out.push(x);
  return out;
};
for (const [label, url] of urls) {
  let pages: PageGeometry[];
  try { pages = await readPages(await f.bytes(url)); } catch { console.log(`${label}\tREAD-THROW`); continue; }
  const head0 = pages[0].items.find((i) => i.str === "付託委員会");
  if (!head0) { console.log(`${label}\tno head`); continue; }
  // bodyTop はざっくり head.y-6（診断用）。titleCenter/hi も head から
  const lefts: number[] = [];
  const names: number[] = [];
  for (const page of pages) {
    const head = page.items.find((i) => i.str === "付託委員会"); if (!head) continue;
    for (const i of page.items) {
      if (i.y >= head.y - 6) continue;
      if (!(i.x > head.x - 80 && i.x < head.x + head.w + 5)) continue;
      lefts.push(i.x);
      if (/^[^※]{2,12}(委員会|審査会)$/.test(i.str)) names.push(i.x);
    }
  }
  if (names.length === 0) { console.log(`${label}\tn=0`); continue; }
  const cnt = (x: number) => lefts.filter((v) => Math.abs(v - x) <= 1).length;
  const g = cluster(lefts, 1);
  const mode = g.reduce((b, x) => (cnt(x) > cnt(b) ? x : b), g[0]);
  const minName = Math.min(...names);
  const minAll = Math.min(...lefts);
  console.log(`${label}\t委員会名 ${names.length}\t最頻の左端 ${mode.toFixed(1)}\t委員会名の最小左端 ${minName.toFixed(1)}\t欄内の全文字の最小左端 ${minAll.toFixed(1)}\t最頻より左に落ちる委員会名 ${names.filter(v=>v<mode-1).length}`);
}
