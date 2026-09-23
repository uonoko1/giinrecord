import { readPages } from "../src/sources/local/pdf-table.ts";
import { PoliteFetcher } from "../src/sources/local/polite-fetch.ts";
import { SHIMANE_HOST } from "../src/sources/local/shimane/site.ts";
const f = new PoliteFetcher(SHIMANE_HOST);
const pages = await readPages(await f.bytes(process.argv[2]));
for (const [pi,page] of pages.entries()) {
  const head = page.items.find((i) => i.str === "付託委員会");
  if (!head) continue;
  const band = page.items.filter((i)=> i.y<head.y-6 && i.x>head.x-60 && i.x<head.x+head.w+60 && /^[^※]{2,12}(委員会|審査会)$/.test(i.str));
  console.log(`--- page ${pi+1} head x=${head.x.toFixed(1)} w=${head.w.toFixed(1)}`);
  const seen = new Map<string,number>();
  for (const i of band) { const k=`${i.x.toFixed(1)}|${i.w.toFixed(1)}|${i.str}`; seen.set(k,(seen.get(k)??0)+1); }
  for (const [k,v] of [...seen].sort()) console.log(`   x${k.split('|')[0].padStart(7)} w${k.split('|')[1].padStart(6)} ×${v}  ${k.split('|')[2]}`);
}
