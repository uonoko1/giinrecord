import { mkdir, writeFile } from "node:fs/promises";
import { listRollCalls, parseRollCall } from "./sources/sangiin-votes.ts";
import { fetchText } from "./fetch.ts";

/**
 * ETL entry point. S1 scope: House of Councillors roll-call votes.
 * Writes normalized JSON under ../../data/ (committed to the repo, CC BY 4.0).
 * Usage: pnpm etl [session...]   (default: current session only)
 */
const sessions = process.argv.slice(2).map(Number).filter(Boolean);
const targets = sessions.length ? sessions : [221];
const DATA = new URL("../../../data/", import.meta.url);

for (const session of targets) {
  const list = await listRollCalls(session);
  console.log(`session ${session}: ${list.length} roll calls`);
  const dir = new URL(`rollcalls/${session}/`, DATA);
  await mkdir(dir, { recursive: true });
  for (const item of list) {
    const html = await fetchText(item.href);
    const rc = parseRollCall(html, item.href, session);
    await writeFile(new URL(`${rc.id}.json`, dir), JSON.stringify(rc, null, 1) + "\n");
  }
}
await writeFile(new URL("meta.json", DATA), JSON.stringify({
  fetchedAt: new Date().toISOString(),
  sessions: targets,
  sources: [{ name: "参議院 本会議投票結果", url: "https://www.sangiin.go.jp/japanese/touhyoulist/", fetchedAt: new Date().toISOString() }],
}, null, 2) + "\n");
console.log("done");
