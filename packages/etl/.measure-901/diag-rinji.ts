/** 2025-05 臨時会が読めない機序（#874 分類 E）を確かめる: 議案番号が 4 行中 3 行で空 */
import { readPages } from "../src/sources/local/pdf-table.ts";
import { PoliteFetcher } from "../src/sources/local/polite-fetch.ts";
import { SHIMANE_HOST } from "../src/sources/local/shimane/site.ts";
const f = new PoliteFetcher(SHIMANE_HOST);
const pages = await readPages(await f.bytes(process.argv[2]));
for (const [pi,page] of pages.entries()) {
  const head = page.items.find(i=>i.str==="付託委員会");
  console.log(`--- page ${pi+1} head=${head? head.y.toFixed(1):"なし"}`);
  if (!head) continue;
  const body = page.items.filter(i=>i.y < head.y-6);
  // 議案番号らしきもの
  const nums = body.filter(i=>/^(第|議員提出|請願|承認|同意)/.test(i.str) && i.x < head.x-100);
  console.log(`  議案番号らしき文字 ${nums.length}: ${nums.map(n=>`"${n.str.slice(0,18)}"@y${n.y.toFixed(1)}`).join(" ")}`);
  // 記号の行
  const ys=[...new Set(body.filter(i=>/^[○●]$/.test(i.str)).map(i=>Number(i.y.toFixed(1))))].sort((a,b)=>b-a);
  console.log(`  記号の行 ${ys.length}: ${ys.join(",")}`);
  const joined = body.filter(i=>/^[○●\s]+$/.test(i.str) && i.str.replace(/\s/g,"").length>1);
  console.log(`  繋がった記号 ${joined.length}: ${joined.map(j=>`${JSON.stringify(j.str)}@x${j.x.toFixed(1)}w${j.w.toFixed(1)}`).join(" ")}`);
}
