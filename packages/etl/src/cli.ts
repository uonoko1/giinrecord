import { fileURLToPath } from "node:url";
import type { Bill as SharedBill, RollCall, Speech } from "@seiji-kiroku/shared";
import { listRollCalls, parseRollCall } from "./sources/sangiin-votes.ts";
import { fetchMembers, memberListUrl, unmatchedGroups } from "./sources/sangiin-members.ts";
import { fetchShugiinMembers, memberListUrl as shugiinMemberListUrl, unmatchedShugiinGroups } from "./sources/shugiin-members.ts";
import { fetchText } from "./fetch.ts";
import { fetchSpeeches, speechPageUrl } from "./sources/kokkai-speeches.ts";
import { matchVotes, type GroupMismatch, type Unmatched } from "./match-votes.ts";
import { billListUrl, committeeBills, fetchBills, matchBillResults, toBillDecisions, type Bill } from "./sources/sangiin-bills.ts";
import { matchSpeeches, type UnmatchedSpeech } from "./match-speeches.ts";
import { matchBills, type UnmatchedBillProposer } from "./match-bills.ts";
import { fetchShugiinBills, shugiinBillListUrl } from "./sources/shugiin-bills.ts";
import { matchShugiinBills, type UnmatchedShugiinBillName } from "./match-shugiin-bills.ts";
import { buildDataset, mergeRosters, rosterSessionsFor } from "./aggregate.ts";
import { readSessionsOnDisk, resolveSessions, validateDataset, writeDataset } from "./dataset.ts";

/**
 * ETL entry point. S1: House of Councillors members and roll-call votes. S2: plenary speeches (国会会議録API).
 * Writes normalized JSON under ../../data/ (committed to the repo, CC BY 4.0):
 *   members/index.json, members/{id}.json, rollcalls/index.json, rollcalls/{session}/{id}.json,
 *   bills/index.json, bills/{session}/{id}.json（衆院 議案情報。S5 #72）,
 *   unmatched.json, unmatched-bills.json, unmatched-groups.json, group-mismatch.json, meta.json
 * then runs validateDataset (docs/DATA_CONTRACT.md) and exits non-zero on any violation.
 * Usage: pnpm etl [session...]   (default: DEFAULT_SESSIONS = 217..221)
 * 回次は「指定 ∪ data/ に既にある回次」を全部処理する（部分実行で他回次の出力を消さないため）。
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
const requested = process.argv.slice(2).map(Number).filter(Boolean);
const targets = resolveSessions(requested, await readSessionsOnDisk(DATA));
console.log(`sessions: ${targets.join(" ")}`);
const fetchedAt = new Date().toISOString();

// Members: 回次ごとの名簿をプロフィールIDで統合する。current は最新回次の名簿に載っているか（辞職・補選で入れ替わった人も残す）。
// 名簿ページは各回次の終了後時点なので、最小回次の1つ前の名簿も取って会期中に退任した議員を覆う（rosterSessionsFor）。
const memberSession = Math.max(...targets);
const rosterSessions = rosterSessionsFor(targets);
const rosters = [];
for (const session of rosterSessions) {
  const roster = await fetchMembers(session);
  console.log(`session ${session}: ${roster.length} members in roster`);
  rosters.push({ session, members: roster });
}
const members = mergeRosters(rosters);
console.log(`members: ${members.length} (${members.filter((m) => m.current).length} current)`);
// 名簿の会派略称は正式名称に解決して公開する。未知の略称は ETL を止めず原文のまま出し、運用者が対応表に追記する（Issue #36）。
const groupsUnknown = unmatchedGroups(members);
if (groupsUnknown.length) {
  console.warn(`unknown group abbreviations: ${groupsUnknown.length} (see data/unmatched-groups.json; add to sangiin-groups.ts)`);
  for (const g of groupsUnknown) console.warn(`  ${g.group}: ${g.memberIds.join(", ")}`);
}
// 衆院: 回次ごとの名簿は無く「現在」の名簿だけ（Issue #71）。個人別投票が公開されていないので名寄せには使わず、
// 採決・発言・議案の突合は参院名簿（members）だけで行い、公開する index には両院を並べる（house で区別）。
const shugiin = await fetchShugiinMembers(memberSession);
console.log(`shugiin: ${shugiin.members.length} members in roster (as of ${shugiin.asOf ?? "unknown"})`);
const shugiinGroupsUnknown = unmatchedShugiinGroups(shugiin.members);
if (shugiinGroupsUnknown.length) {
  console.warn(`unknown shugiin group abbreviations: ${shugiinGroupsUnknown.length} (see data/unmatched-groups.json; add to shugiin-groups.ts)`);
  for (const g of shugiinGroupsUnknown) console.warn(`  ${g.group}: ${g.memberIds.join(", ")}`);
}

const rollCalls: RollCall[] = [];
const unmatched: (Unmatched | UnmatchedSpeech | UnmatchedBillProposer | UnmatchedShugiinBillName)[] = [];
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
// 可決/否決は投票結果ページに無いので、参院 議案情報（事実）から取り、採決に紐づける（Issue #26）。
const allBills: Bill[] = [];
for (const session of targets) {
  const list = await fetchBills(session);
  console.log(`session ${session}: ${list.length} bills (${toBillDecisions(list).length} decisions)`);
  allBills.push(...list);
}
const bills = matchBillResults(rollCalls, toBillDecisions(allBills));
// 人事案件・決議など議案情報に載らない採決は得票のみの表示になる。件数を出して運用者が確認できるようにする。
if (bills.unmatched.length) console.warn(`roll calls without bill decision: ${bills.unmatched.length} (see data/unmatched-bills.json)`);
// 提出法案: 参法の発議者（議案ページに載る筆頭者。「外N名」の氏名は公表されていない）を名簿に名寄せして timeline の bill 行にする（Issue #56）。
const proposed = matchBills(allBills, members);
console.log(`bills: ${allBills.filter((b) => b.kind === "参法").length} 参法, ${proposed.entries.length} proposer entries matched`);
const committee = committeeBills(allBills);
if (committee.length) console.log(`bills: ${committee.length} 参法 by committee (no individual proposer; not in timeline): ${committee.map((b) => `${b.id} ${b.submitterText ?? "?"}`).join(", ")}`);
unmatched.push(...proposed.unmatched);

// 衆院 議案情報（Issue #72）: 一覧（審議回次）→経過ページ。提出者一覧・賛成者は個人名（事実）、会派態度は会派単位（推定）で Bill.shugiinGroupStance にだけ入る。
// 継続審議の議案は複数回次の一覧に同じ経過ページで載るので id で重複を除く（後の回次の一覧＝新しい状態を採る）。
const shugiinBills = new Map<string, SharedBill>();
for (const session of targets) {
  const list = await fetchShugiinBills(session);
  console.log(`session ${session}: ${list.length} shugiin bills (${list.filter((b) => b.shugiinGroupStance).length} with group stance)`);
  for (const b of list) shugiinBills.set(b.id, b);
}
const shugiinMatched = matchShugiinBills([...shugiinBills.values()], members);
unmatched.push(...shugiinMatched.unmatched);

// 発言: 国会会議録API（公開まで約1ヶ月のラグ。meta.sources[].fetchedAt が「いつ時点の会議録か」を示す）。
const speeches: Speech[] = [];
for (const session of targets) {
  const matched = matchSpeeches(await fetchSpeeches(session), members, session);
  const matchedCount = matched.speeches.filter((s) => s.memberId).length;
  const positioned = matched.speeches.filter((s) => s.memberId && s.position).length;
  console.log(`session ${session}: ${matched.speeches.length} speeches (${matchedCount} matched, ${positioned} with position)`);
  speeches.push(...matched.speeches);
  unmatched.push(...matched.unmatched);
}
// 未突合は ETL を止めず、運用者が確認するために列挙する（docs/DATA_CONTRACT.md）。
if (unmatched.length) console.warn(`unmatched: ${unmatched.length} (see data/unmatched.json)`);
// 氏名だけで紐づき、採決ページの会派がどの回次の名簿の会派とも違った票は data/group-mismatch.json に永続化する（Issue #24）。
// 名簿に現れない会派改称・移籍なら正常、名簿にいない旧議員が同名の現職に紐づいていたら誤りなので、運用者がファイルで確認する。
if (groupMismatch.length) console.warn(`group mismatch (matched by name only): ${groupMismatch.length} (see data/group-mismatch.json)`);

await writeDataset(DATA, {
  ...buildDataset([...members, ...shugiin.members], rollCalls, new Map([...bills.results].map(([id, r]) => [id, r.decision])), speeches, proposed.entries),
  rollCallDetails: rollCalls,
  bills: shugiinMatched.bills,
  unmatched,
  unmatchedBills: bills.unmatched,
  unmatchedGroups: [...groupsUnknown, ...shugiinGroupsUnknown],
  groupMismatch,
  meta: {
    fetchedAt,
    sessions: targets,
    sources: [
      ...rosterSessions.map((s) => ({ name: `参議院 議員一覧（第${s}回）`, url: memberListUrl(s), fetchedAt })),
      { name: `衆議院 議員一覧（${shugiin.asOf ?? "取得日"}現在）`, url: shugiinMemberListUrl(1), fetchedAt },
      { name: "参議院 本会議投票結果", url: "https://www.sangiin.go.jp/japanese/touhyoulist/", fetchedAt },
      { name: "国会会議録検索システム 検索用API（参議院 本会議）", url: speechPageUrl(memberSession), fetchedAt },
      ...targets.map((s) => ({ name: `参議院 議案情報（第${s}回）`, url: billListUrl(s), fetchedAt })),
      ...targets.map((s) => ({ name: `衆議院 議案情報（第${s}回）`, url: shugiinBillListUrl(s), fetchedAt })),
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
