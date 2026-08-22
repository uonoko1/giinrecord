import { mkdir, writeFile } from "node:fs/promises";
import { listRollCalls, parseRollCall } from "./sources/sangiin-votes.ts";
import { fetchMembers, memberListUrl, serializeMembersIndex } from "./sources/sangiin-members.ts";
import { fetchText } from "./fetch.ts";
import { matchVotes, type GroupMismatch, type Unmatched } from "./match-votes.ts";
import { stableJson } from "./json.ts";

/**
 * ETL entry point. S1 scope: House of Councillors members and roll-call votes.
 * Writes normalized JSON under ../../data/ (committed to the repo, CC BY 4.0).
 * Usage: pnpm etl [session...]   (default: current session only)
 */
const sessions = process.argv.slice(2).map(Number).filter(Boolean);
const targets = sessions.length ? sessions : [221];
const DATA = new URL("../../../data/", import.meta.url);

// Members: the roster of the latest requested session is the current one.
const memberSession = Math.max(...targets);
const members = await fetchMembers(memberSession);
console.log(`session ${memberSession}: ${members.length} members`);
await mkdir(new URL("members/", DATA), { recursive: true });
await writeFile(new URL("members/index.json", DATA), serializeMembersIndex(members));

const unmatched: Unmatched[] = [];
const groupMismatch: GroupMismatch[] = [];
for (const session of targets) {
  const list = await listRollCalls(session);
  console.log(`session ${session}: ${list.length} roll calls`);
  const dir = new URL(`rollcalls/${session}/`, DATA);
  await mkdir(dir, { recursive: true });
  for (const item of list) {
    const html = await fetchText(item.href);
    const matched = matchVotes(parseRollCall(html, item.href, session), members);
    unmatched.push(...matched.unmatched);
    groupMismatch.push(...matched.groupMismatch);
    await writeFile(new URL(`${matched.rollCall.id}.json`, dir), stableJson(matched.rollCall));
  }
}
// 未突合は ETL を止めず、運用者が確認するために列挙する（docs/DATA_CONTRACT.md）。
await writeFile(new URL("unmatched.json", DATA), stableJson(unmatched));
if (unmatched.length) console.warn(`unmatched: ${unmatched.length} (see data/unmatched.json)`);
// 氏名だけで紐づけ会派が食い違った票は受け入れ基準（氏名＋会派）からの逸脱なので、運用者に見せる（Issue #3）。
// 会派改称・移籍なら正常、名簿にいない旧議員が同名の現職に紐づいていたら誤りなので、nameText ごとに要確認。
if (groupMismatch.length) {
  console.warn(`group mismatch (matched by name only): ${groupMismatch.length}`);
  for (const g of groupMismatch) console.warn(`  ${g.rollCallId} ${g.nameText} (${g.group}) -> ${g.memberId} (${g.rosterGroup})`);
}
await writeFile(new URL("meta.json", DATA), JSON.stringify({
  fetchedAt: new Date().toISOString(),
  sessions: targets,
  sources: [
    { name: "参議院 議員一覧", url: memberListUrl(memberSession), fetchedAt: new Date().toISOString() },
    { name: "参議院 本会議投票結果", url: "https://www.sangiin.go.jp/japanese/touhyoulist/", fetchedAt: new Date().toISOString() },
  ],
}, null, 2) + "\n");
console.log("done");
