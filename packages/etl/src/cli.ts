import { fileURLToPath } from "node:url";
import type { RollCall, Speech } from "@seiji-kiroku/shared";
import { listRollCalls, parseRollCall } from "./sources/sangiin-votes.ts";
import { fetchMembers, memberListUrl, unmatchedGroups } from "./sources/sangiin-members.ts";
import { fetchText } from "./fetch.ts";
import { fetchSpeeches, speechPageUrl } from "./sources/kokkai-speeches.ts";
import { matchVotes, type GroupMismatch, type Unmatched } from "./match-votes.ts";
import { billListUrl, fetchBills, matchBillResults, toBillDecisions, type Bill } from "./sources/sangiin-bills.ts";
import { matchSpeeches, type UnmatchedSpeech } from "./match-speeches.ts";
import { matchBills, type UnmatchedBillProposer } from "./match-bills.ts";
import { buildDataset, mergeRosters, rosterSessionsFor } from "./aggregate.ts";
import { readSessionsOnDisk, resolveSessions, validateDataset, writeDataset } from "./dataset.ts";

/**
 * ETL entry point. S1: House of Councillors members and roll-call votes. S2: plenary speeches (国会会議録API).
 * Writes normalized JSON under ../../data/ (committed to the repo, CC BY 4.0):
 *   members/index.json, members/{id}.json, rollcalls/index.json, rollcalls/{session}/{id}.json,
 *   unmatched.json, unmatched-bills.json, unmatched-groups.json, meta.json
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

const rollCalls: RollCall[] = [];
const unmatched: (Unmatched | UnmatchedSpeech | UnmatchedBillProposer)[] = [];
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
unmatched.push(...proposed.unmatched);

// 発言: 国会会議録API（公開まで約1ヶ月のラグ。meta.sources[].fetchedAt が「いつ時点の会議録か」を示す）。
const speeches: Speech[] = [];
for (const session of targets) {
  const matched = matchSpeeches(await fetchSpeeches(session), members);
  const matchedCount = matched.speeches.filter((s) => s.memberId).length;
  const positioned = matched.speeches.filter((s) => s.memberId && s.position).length;
  console.log(`session ${session}: ${matched.speeches.length} speeches (${matchedCount} matched, ${positioned} with position)`);
  speeches.push(...matched.speeches);
  unmatched.push(...matched.unmatched);
}
// 未突合は ETL を止めず、運用者が確認するために列挙する（docs/DATA_CONTRACT.md）。
if (unmatched.length) console.warn(`unmatched: ${unmatched.length} (see data/unmatched.json)`);
// 氏名だけで紐づけ会派が食い違った票は受け入れ基準（氏名＋会派）からの逸脱なので、運用者に見せる（Issue #3）。
// 会派改称・移籍なら正常、名簿にいない旧議員が同名の現職に紐づいていたら誤りなので、nameText ごとに要確認。
// 回次をまたぐと会派の改称（sangiin-groups.ts の旧名称表に無いもの）で同じ組み合わせが大量に出るので、（投票ページの会派 → 名簿の会派）ごとに件数でまとめる。
if (groupMismatch.length) {
  console.warn(`group mismatch (matched by name only): ${groupMismatch.length}`);
  const byPair = new Map<string, GroupMismatch[]>();
  for (const g of groupMismatch) byPair.set(`${g.group} -> ${g.rosterGroup}`, [...(byPair.get(`${g.group} -> ${g.rosterGroup}`) ?? []), g]);
  for (const [pair, list] of [...byPair].sort((a, b) => b[1].length - a[1].length)) {
    const names = [...new Set(list.map((g) => `${g.nameText}=${g.memberId}`))];
    console.warn(`  ${pair}: ${list.length} votes, ${names.length} members (${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""})`);
  }
}

await writeDataset(DATA, {
  ...buildDataset(members, rollCalls, new Map([...bills.results].map(([id, r]) => [id, r.decision])), speeches, proposed.entries),
  rollCallDetails: rollCalls,
  unmatched,
  unmatchedBills: bills.unmatched,
  unmatchedGroups: groupsUnknown,
  meta: {
    fetchedAt,
    sessions: targets,
    sources: [
      ...rosterSessions.map((s) => ({ name: `参議院 議員一覧（第${s}回）`, url: memberListUrl(s), fetchedAt })),
      { name: "参議院 本会議投票結果", url: "https://www.sangiin.go.jp/japanese/touhyoulist/", fetchedAt },
      { name: "国会会議録検索システム 検索用API（参議院 本会議）", url: speechPageUrl(memberSession), fetchedAt },
      ...targets.map((s) => ({ name: `参議院 議案情報（第${s}回）`, url: billListUrl(s), fetchedAt })),
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
