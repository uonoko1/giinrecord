/** 付託委員会の境目が、その本の委員会名を何個取りこぼすかを 14 本で数える（母数つき。#757） */
import { readPages } from "../src/sources/local/pdf-table.ts";
import { PoliteFetcher } from "../src/sources/local/polite-fetch.ts";
import { SHIMANE_HOST } from "../src/sources/local/shimane/site.ts";
const f = new PoliteFetcher(SHIMANE_HOST);
const urls: [string, string][] = JSON.parse(process.argv[2]);
for (const [label, url] of urls) {
  let pages;
  try { pages = await readPages(await f.bytes(url)); } catch (e) { console.log(`${label}\tREAD-THROW\t${e instanceof Error ? e.message : e}`); continue; }
  let all = 0, distinctLeft = 0, distinctCentre = 0, below = 0, minL = Infinity, maxL = -Infinity;
  for (const [pi, page] of pages.entries()) {
    const head = page.items.find((i) => i.str === "付託委員会");
    if (!head) { continue; }
    const band = page.items.filter((i) => i.y < head.y - 6 && i.x > head.x - 60 && i.x < head.x + head.w + 60 && /委員会|予算特別|審査特別/.test(i.str));
    all += band.length;
    const ls = band.map((i) => Number(i.x.toFixed(1)));
    const cs = band.map((i) => Number((i.x + i.w / 2).toFixed(1)));
    distinctLeft = Math.max(distinctLeft, new Set(ls).size);
    distinctCentre = Math.max(distinctCentre, new Set(cs).size);
    if (ls.length) { minL = Math.min(minL, ...ls); maxL = Math.max(maxL, ...ls); }
    // 「一番多く並んでいる左端」より左に落ちる個数
    const cnt = (x: number) => ls.filter((v) => Math.abs(v - x) <= 1).length;
    const right = ls.length ? ls.reduce((b, x) => (cnt(x) > cnt(b) ? x : b), ls[0]) : 0;
    below += ls.filter((v) => v < right - 1).length;
  }
  console.log(`${label}\t委員会名 ${all}\t相異なる左端(最大/頁) ${distinctLeft}\t相異なる中心(最大/頁) ${distinctCentre}\t左端 ${minL===Infinity?"-":minL}..${maxL===-Infinity?"-":maxL}\t最頻の左端より左 ${below}`);
}
