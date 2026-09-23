import { readFileSync } from "node:fs";
import { parseVotePdf } from "../src/sources/local/shimane/votes-pdf.ts";
const pdf = await parseVotePdf(readFileSync(new URL("../test/fixtures/shimane/r0711_giinbetu_kekka.pdf", import.meta.url)));
console.log("rows", pdf.rows.length, "members", pdf.members.length, "unknownCells", pdf.unknownCells);
console.log("付託委員会のある行", pdf.rows.filter(r=>r.referredCommittees.length>0).length);
console.log("付託委員会の個数合計", pdf.rows.reduce((n,r)=>n+r.referredCommittees.length,0));
console.log("referredOffset 最大", Math.max(...pdf.rows.map(r=>Math.abs(r.referredOffset))).toFixed(2));
console.log("titleOffset 最大", Math.max(...pdf.rows.map(r=>Math.abs(r.titleOffset))).toFixed(2));
console.log("kind:", JSON.stringify(pdf.rows.reduce((m:any,r)=>{m[r.kind]=(m[r.kind]??0)+1;return m;},{})));
for (const r of pdf.rows.slice(0,6)) console.log(`  ${r.number} | ${r.title.slice(0,30)} | ${r.referredCommittees.join("／")} | ${r.result} | ${r.counts.yes}/${r.counts.no}`);
console.log("--- 不明セルの場所 ---");
for (const r of pdf.rows) {
  r.cells.forEach((c,i)=>{ if(c==="不明") console.log(`  ${r.number} 列${i} 議員=${pdf.members[i]} 賛否=${r.counts.yes}/${r.counts.no} 件名=${r.title.slice(0,24)}`); });
}
console.log("--- 記号の種類 ---", JSON.stringify(pdf.rows.flatMap(r=>r.cells).reduce((m:any,c)=>{m[c]=(m[c]??0)+1;return m;},{})));
console.log("--- 凡例 ---", JSON.stringify([...pdf.legend]));
