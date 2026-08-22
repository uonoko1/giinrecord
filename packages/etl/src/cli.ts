import { fileURLToPath } from "node:url";
import type { RollCall } from "@seiji-kiroku/shared";
import { listRollCalls, parseRollCall } from "./sources/sangiin-votes.ts";
import { fetchMembers, memberListUrl } from "./sources/sangiin-members.ts";
import { fetchText } from "./fetch.ts";
import { matchVotes, type GroupMismatch, type Unmatched } from "./match-votes.ts";
import { buildDataset } from "./aggregate.ts";
import { validateDataset, writeDataset } from "./dataset.ts";

/**
 * ETL entry point. S1 scope: House of Councillors members and roll-call votes.
 * Writes normalized JSON under ../../data/ (committed to the repo, CC BY 4.0):
 *   members/index.json, members/{id}.json, rollcalls/index.json, rollcalls/{session}/{id}.json, unmatched.json, meta.json
 * then runs validateDataset (docs/DATA_CONTRACT.md) and exits non-zero on any violation.
 * Usage: pnpm etl [session...]   (default: current session only)
 */
const sessions = process.argv.slice(2).map(Number).filter(Boolean);
const targets = sessions.length ? sessions : [221];
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
const fetchedAt = new Date().toISOString();

// Members: the roster of the latest requested session is the current one.
const memberSession = Math.max(...targets);
const members = await fetchMembers(memberSession);
console.log(`session ${memberSession}: ${members.length} members`);

const rollCalls: RollCall[] = [];
const unmatched: Unmatched[] = [];
const groupMismatch: GroupMismatch[] = [];
for (const session of targets) {
  const list = await listRollCalls(session);
  console.log(`session ${session}: ${list.length} roll calls`);
  for (const item of list) {
    const html = await fetchText(item.href);
    const matched = matchVotes(parseRollCall(html, item.href, session), members);
    rollCalls.push(matched.rollCall);
    unmatched.push(...matched.unmatched);
    groupMismatch.push(...matched.groupMismatch);
  }
}
// 未突合は ETL を止めず、運用者が確認するために列挙する（docs/DATA_CONTRACT.md）。
if (unmatched.length) console.warn(`unmatched: ${unmatched.length} (see data/unmatched.json)`);
// 氏名だけで紐づけ会派が食い違った票は受け入れ基準（氏名＋会派）からの逸脱なので、運用者に見せる（Issue #3）。
// 会派改称・移籍なら正常、名簿にいない旧議員が同名の現職に紐づいていたら誤りなので、nameText ごとに要確認。
if (groupMismatch.length) {
  console.warn(`group mismatch (matched by name only): ${groupMismatch.length}`);
  for (const g of groupMismatch) console.warn(`  ${g.rollCallId} ${g.nameText} (${g.group}) -> ${g.memberId} (${g.rosterGroup})`);
}

await writeDataset(DATA, {
  ...buildDataset(members, rollCalls),
  rollCallDetails: rollCalls,
  unmatched,
  meta: {
    fetchedAt,
    sessions: targets,
    sources: [
      { name: "参議院 議員一覧", url: memberListUrl(memberSession), fetchedAt },
      { name: "参議院 本会議投票結果", url: "https://www.sangiin.go.jp/japanese/touhyoulist/", fetchedAt },
    ],
  },
});

// 契約違反のデータは公開しない: 違反があれば全部列挙して非0終了（CI が止まる）。
const violations = await validateDataset(DATA);
if (violations.length) {
  console.error(`data contract violations: ${violations.length}`);
  for (const line of violations) console.error(`  ${line}`);
  process.exit(1);
}
console.log("done");
