import { readFileSync } from "node:fs";
import { parseVotePdf } from "../src/sources/local/shimane/votes-pdf.ts";
const pdf = await parseVotePdf(readFileSync(new URL("../test/fixtures/shimane/r0711_giinbetu_kekka.pdf", import.meta.url)));
console.log("=== 公表の賛成/反対 と ○●の個数 を 55 行で突き合わせる（母数つき） ===");
let ok=0, bad=0, skip=0;
for (const r of pdf.rows) {
  const yes = r.cells.filter(c=>c==="○").length;
  const no  = r.cells.filter(c=>c==="●").length;
  const weird = r.cells.filter(c=>c!=="○"&&c!=="●"&&c!=="議⾧"&&c!=="除斥"&&c!=="棄権"&&c!=="－");
  if (weird.length) { skip++; console.log(`  SKIP ${r.number}: 公表 ${r.counts.yes}/${r.counts.no} 数え直し ${yes}/${no} 変なセル ${JSON.stringify(weird)}`); continue; }
  if (yes===r.counts.yes && no===r.counts.no) ok++; else { bad++; console.log(`  差 ${r.number}: 公表 ${r.counts.yes}/${r.counts.no} 数え直し ${yes}/${no}`); }
}
console.log(`一致 ${ok} / 不一致 ${bad} / 変なセルがあって数えられない ${skip}  （母数 ${pdf.rows.length}）`);
