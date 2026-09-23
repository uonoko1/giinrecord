/** 14 本すべてで、セルの原文の種類と「繋がったセル」を数える（母数つき。#757） */
import { parseVotePdf } from "../src/sources/local/shimane/votes-pdf.ts";
import { PoliteFetcher } from "../src/sources/local/polite-fetch.ts";
import { SHIMANE_HOST } from "../src/sources/local/shimane/site.ts";
const f = new PoliteFetcher(SHIMANE_HOST);
const urls: [string, string][] = JSON.parse(process.argv[2]);
let books=0, totalCells=0, joined=0, unknown=0;
for (const [label, url] of urls) {
  let pdf;
  try { pdf = await parseVotePdf(await f.bytes(url)); } catch (e) { console.log(`${label}\tTHROW\t${(e instanceof Error?e.message:String(e)).slice(0,70)}`); continue; }
  books++;
  const cells = pdf.rows.flatMap(r=>r.cells);
  totalCells += cells.length;
  const legend = new Set([...pdf.legend.keys()]);
  const odd = cells.filter(c => c !== "不明" && !legend.has(c));
  const tally: Record<string,number> = {};
  for (const c of odd) tally[c] = (tally[c]??0)+1;
  joined += odd.length;
  unknown += cells.filter(c=>c==="不明").length;
  console.log(`${label}\t行 ${pdf.rows.length}\t議員 ${pdf.members.length}\tセル ${cells.length}\t凡例に無いセル ${odd.length} ${JSON.stringify(tally)}\t不明 ${cells.filter(c=>c==="不明").length}`);
}
console.log(`--- 読めた本 ${books} / ${urls.length}  セル計 ${totalCells}  凡例に無いセル計 ${joined}  不明計 ${unknown}`);
