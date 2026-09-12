/** 取得済みのファイルで runShiga を回す（県のサーバーへの新しいリクエストは 0 件）。 */
import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import iconv from "iconv-lite";
import { runShiga, type Fetcher } from "./src/sources/local/shiga/index.ts";
const DL = "/tmp/claude-1000/-home-uonoko-Development-gikailog/9db68a27-69bc-431e-807c-6a6c7d2cb0c2/scratchpad/741/dl";
const fetcher: Fetcher = {
  async textShiftJis(url: string) {
    const u = new URL(url);
    let file: string;
    if (u.pathname === "/g07_giinlistP.asp") file = `${DL}/giinlist.html`;
    else if (u.searchParams.get("YMSel") === "9999") file = `${DL}/years.html`;
    else if (u.searchParams.has("Y1")) file = `${DL}/html/year-${u.searchParams.get("Tmode") === "0" ? "t0-" : ""}${u.searchParams.get("Y1")}.html`;
    else if (u.searchParams.has("KaigiID")) file = `${DL}/html/kaigi-${u.searchParams.get("KaigiID")}.html`;
    else throw new Error(`no fixture for ${url}`);
    if (!existsSync(file)) throw new Error(`missing fixture ${file} for ${url}`);
    return iconv.decode(readFileSync(file), "Shift_JIS");
  },
  async bytes(url: string) {
    const name = decodeURIComponent(basename(new URL(url).pathname));
    const file = `${DL}/pdf/${name}`;
    if (!existsSync(file)) throw new Error(`missing pdf ${file}`);
    return readFileSync(file);
  },
};
const sessions = Number(process.argv[2] ?? 2);
const run = await runShiga({ sessions, fetchedAt: new Date().toISOString(), fetcher, log: (l) => console.log(l) });
console.log(JSON.stringify({ members: run.roster.members.length, rollCalls: run.rollCalls.length, unmatched: run.unmatched.length, sessions: run.sessions.length, unreadable: run.unreadableSources.length }));
for (const u of run.unmatched) console.log("  unmatched", JSON.stringify(u.nameText), u.group, u.rollCallIds.length);
for (const u of run.unreadableSources) console.log("  unreadable", u.url, u.reason);
