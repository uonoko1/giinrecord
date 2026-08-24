import { fileURLToPath } from "node:url";
import type { Bill as SharedBill, Question, RollCall, Speech } from "@seiji-kiroku/shared";
import { listRollCalls, parseRollCall, RollCallParseError, standingVoteNote } from "./sources/sangiin-votes.ts";
import { fetchMembers, memberListUrl, unmatchedGroups } from "./sources/sangiin-members.ts";
import { fetchShugiinMembers, memberListUrl as shugiinMemberListUrl, unmatchedShugiinGroups } from "./sources/shugiin-members.ts";
import { fetchText } from "./fetch.ts";
import { fetchSpeeches, speechPageUrl } from "./sources/kokkai-speeches.ts";
import { matchVotes, type GroupMismatch } from "./match-votes.ts";
import { shardUnmatched, type UnmatchedRow } from "./unmatched.ts";
import { billListUrl, committeeBills, fetchBills, matchBillResults, toBillDecisions, type Bill } from "./sources/sangiin-bills.ts";
import { matchSpeeches } from "./match-speeches.ts";
import { matchBills } from "./match-bills.ts";
import { fetchShugiinBills, shugiinBillListUrl } from "./sources/shugiin-bills.ts";
import { matchShugiinBills } from "./match-shugiin-bills.ts";
import { fetchShugiinQuestions, shugiinQuestionListUrl } from "./sources/shugiin-questions.ts";
import { fetchSangiinQuestions, sangiinQuestionListUrl } from "./sources/sangiin-questions.ts";
import { matchQuestions } from "./match-questions.ts";
import { attendancePageUrl, fetchCommitteeAttendance } from "./sources/kokkai-attendance.ts";
import { matchAttendance, type MatchedAttendance } from "./match-attendance.ts";
import { buildDataset, mergeRosters, rosterSessionsFor, type Roster } from "./aggregate.ts";
import { dietAssemblies, readSessionsOnDisk, validateDataset, writeDataset } from "./dataset.ts";
import { lostVoteMatches, planSessions, readCarried, shouldFetchShugiinSpeeches } from "./sessions.ts";

/**
 * ETL entry point. S1: House of Councillors members and roll-call votes. S2: plenary speeches (国会会議録API; 参院、#73 から衆院も).
 * Writes normalized JSON under ../../data/ (committed to the repo, CC BY 4.0):
 *   assemblies/index.json（国会の2議会。#156。地方議会は別 Issue の ETL が足す）,
 *   members/index.json, members/{id}.json, rollcalls/index.json, rollcalls/{session}/{id}.json,
 *   bills/index.json, bills/{session}/{id}.json（衆院 議案情報。S5 #72）,
 *   unmatched.json, unmatched-bills.json, unmatched-groups.json, group-mismatch.json, meta.json
 *   （timeline には委員会出席の attendance 行も入る。#109）
 * then runs validateDataset (docs/DATA_CONTRACT.md) and exits non-zero on any violation.
 * Usage: pnpm etl [session...]   (default: DEFAULT_SESSIONS = 217..221)
 * 回次の扱い（#103、sessions.ts）: ネットワークから取得するのは指定された回次（無ければ既定の直近 5 回次）だけ。
 * data/ に既にある他の回次（第200〜216回など、手動実行で足した分）は前回出力から引き継ぐ（採決は現行名簿で再突合）ので、
 * 部分実行で他回次の出力は消えず、日次実行が毎日全回次を取り直すこともない。
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
const requested = process.argv.slice(2).map(Number).filter(Boolean);
const plan = planSessions(requested, await readSessionsOnDisk(DATA));
const targets = plan.targets;
console.log(`sessions: ${targets.join(" ")}${plan.carried.length ? ` (carried from data/: ${plan.carried.join(" ")})` : ""}`);
const fetchedAt = new Date().toISOString();
const carried = await readCarried(DATA, plan.carried);
if (carried.withoutSession) console.warn(`carried: ${carried.withoutSession} timeline entries without session (output older than #103) cannot be carried; run \`pnpm etl <session>\` for those sessions to regenerate them`);

// Members: 回次ごとの名簿をプロフィールIDで統合する。current は最新回次の名簿に載っているか（辞職・補選で入れ替わった人も残す）。
// 名簿ページは各回次の終了後時点なので、最小回次の1つ前の名簿も取って会期中に退任した議員を覆う（rosterSessionsFor）。
// 引き継ぐ回次の採決も現行名簿で再突合するので、名簿は targets ∪ carried の全回次分を取る（第215回以前は公開されておらず 404 → 無い事実として飛ばす）。
const memberSession = Math.max(...plan.all);
const rosterSessions: number[] = [];
const rosters: Roster[] = [];
for (const session of rosterSessionsFor(plan.all)) {
  const roster = await fetchMembers(session);
  if (!roster) { console.log(`session ${session}: no roster published (404)`); continue; }
  console.log(`session ${session}: ${roster.length} members in roster`);
  rosterSessions.push(session);
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
// 衆院: 回次ごとの名簿は無く「現在」の名簿だけ（Issue #71）。個人別投票が公開されていないので採決の突合は参院名簿（members）だけで行い、
// 衆院名簿は 衆院 議案の提出者・賛成者（matchShugiinBills）と衆院本会議の発言（matchSpeeches）の名寄せに使う。公開する index には両院を並べる（house で区別）。
const shugiin = await fetchShugiinMembers(memberSession);
console.log(`shugiin: ${shugiin.members.length} members in roster (as of ${shugiin.asOf ?? "unknown"})`);
const shugiinGroupsUnknown = unmatchedShugiinGroups(shugiin.members);
if (shugiinGroupsUnknown.length) {
  console.warn(`unknown shugiin group abbreviations: ${shugiinGroupsUnknown.length} (see data/unmatched-groups.json; add to shugiin-groups.ts)`);
  for (const g of shugiinGroupsUnknown) console.warn(`  ${g.group}: ${g.memberIds.join(", ")}`);
}

const rollCalls: RollCall[] = [];
const unmatched: UnmatchedRow[] = [];
const groupMismatch: GroupMismatch[] = [];
const addRollCall = (rc: RollCall) => {
  const matched = matchVotes(rc, members);
  rollCalls.push(matched.rollCall);
  unmatched.push(...matched.unmatched);
  groupMismatch.push(...matched.groupMismatch);
};
// パースできなかったページ（未知のレイアウト等）。回次ごとに件数を出し、最後にまとめて再掲する（#219 のバックフィルで
// どの回次が取れなかったかを運用者が特定できるように）。推定で埋めることはしない。
const parseFailures: { session: number; sourceUrl: string; message: string }[] = [];
/** 一覧ページ自体が取れなかった回次（404 等）。 */
const sessionFailures: { session: number; message: string }[] = [];
for (const session of targets) {
  // 一覧ページが 404 の回次（押しボタン投票の導入前＝第141回以前は vote_ind.htm 自体が無い）は
  // 「ページが無い」事実として飛ばし、回次と理由をログに残す（#219）。ここで落とすとバックフィル全体が止まる。
  // 404 以外（5xx・タイムアウト）は障害なので飛ばさず例外のまま落とす: 取りこぼしを「無かった」と記録しないため。
  let list;
  try {
    list = await listRollCalls(session);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.startsWith("HTTP 404 ")) throw err;
    sessionFailures.push({ session, message });
    console.warn(`session ${session}: roll call list not published, skipped (${message})`);
    continue;
  }
  // 一覧には起立採決（個人票が無い）のページも載る（第200〜216回。第210回・第216回は全件）。RollCall にはならないので件数だけ出す（#103）。
  let standing = 0;
  let failed = 0;
  for (const item of list) {
    const html = await fetchText(item.href);
    if (standingVoteNote(html) !== undefined) { standing++; continue; }
    // 読めないページは飛ばしてログに残す（#219）。第142〜199回は全58回次の構造を事前確認していないので、
    // 1ページの未知のレイアウトでバックフィル全体が落ちないようにする。読めた採決は普通に収録される。
    try {
      addRollCall(parseRollCall(html, item.href, session));
    } catch (err) {
      if (!(err instanceof RollCallParseError)) throw err;
      failed++;
      parseFailures.push({ session, sourceUrl: err.sourceUrl, message: err.message });
      console.warn(`  skipped (parse error): ${err.message}`);
    }
  }
  console.log(`session ${session}: ${list.length} roll calls (${list.length - standing - failed} with individual votes, ${standing} standing votes skipped, ${failed} parse errors skipped)`);
}
if (sessionFailures.length) {
  console.warn(`sessions skipped (roll call list not published, 404): ${sessionFailures.map((f) => f.session).join(" ")}`);
}
if (parseFailures.length) {
  const bySession = [...new Set(parseFailures.map((f) => f.session))].sort((a, b) => a - b);
  console.warn(`roll call pages skipped (parse error): ${parseFailures.length} in sessions ${bySession.join(" ")}`);
  for (const f of parseFailures) console.warn(`  ${f.sourceUrl}: ${f.message}`);
}
// 引き継ぐ回次の採決（前回出力）。名簿は毎回取り直すので、票の氏名・会派を現行名簿で再突合する。
for (const rc of carried.rollCalls) addRollCall(rc);
if (carried.rollCalls.length) console.log(`carried: ${carried.rollCalls.length} roll calls from sessions ${plan.carried.join(" ")} re-matched against current rosters`);
// 引き継いだ採決の再突合で memberId の付いた票が前回出力より減ったら、名簿の取り漏れ（回次の飛びで必要な名簿を
// 取得していない等）の兆候。壊れた出力（票が unmatched に落ちた members/・rollcalls/）を書かずにここで止める（#103 レビュー）。
{
  const lost = lostVoteMatches(carried.matchedVotes, rollCalls);
  if (lost.length) {
    const votes = lost.reduce((n, l) => n + l.before - l.after, 0);
    console.error(`carried roll calls lost matched votes after re-matching (missing roster session?): ${lost.length} roll calls, ${votes} votes`);
    for (const l of lost) console.error(`  ${l.id}: ${l.before} -> ${l.after} votes with memberId`);
    process.exit(1);
  }
}
// 可決/否決は投票結果ページに無いので、参院 議案情報（事実）から取り、採決に紐づける（Issue #26）。引き継ぐ回次の分は前回出力の result から戻す。
const allBills: Bill[] = [];
for (const session of targets) {
  const list = await fetchBills(session);
  console.log(`session ${session}: ${list.length} bills (${toBillDecisions(list).length} decisions)`);
  allBills.push(...list);
}
const carriedIds = new Set(carried.rollCalls.map((rc) => rc.id));
const bills = matchBillResults(rollCalls.filter((rc) => !carriedIds.has(rc.id)), toBillDecisions(allBills));
const decisions = new Map([...bills.results].map(([id, r]) => [id, r.decision]));
for (const rc of carried.rollCalls) {
  const decision = carried.decisions.get(rc.id);
  if (decision) decisions.set(rc.id, decision);
  else bills.unmatched.push({ rollCallId: rc.id, title: rc.title, sourceUrl: rc.sourceUrl });
}
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
// 前回出力の議案（data/bills/）を先に入れ、今回取得した分で上書きする（引き継ぐ回次の議案を消さない。#103）。
const shugiinBills = new Map<string, SharedBill>(carried.bills.map((b) => [b.id, b]));
for (const session of targets) {
  const list = await fetchShugiinBills(session);
  console.log(`session ${session}: ${list.length} shugiin bills (${list.filter((b) => b.shugiinGroupStance).length} with group stance)`);
  for (const b of list) shugiinBills.set(b.id, b);
}
// 提出者・賛成者は衆院の名簿に名寄せして timeline の bill 行にする（Issue #73）。名簿は「現在」の1回次分（memberSession）しか無いので、
// 名寄せされるのはその回次に提出された議案だけ。過去回次の議案は氏名のまま残る（名簿 PBI #71 で回次ごとの名簿が入れば広がる）。
const shugiinMatched = matchShugiinBills([...shugiinBills.values()], shugiin.members);
const shugiinWithNames = [...shugiinBills.values()].filter((b) => b.submitterNames?.length || b.supporterNames?.length).length;
const shugiinLinked = shugiinMatched.bills.filter((b) => b.submitters?.length || b.supporters?.length).length;
console.log(`shugiin bills: ${shugiinBills.size} total, ${shugiinWithNames} with submitter/supporter names, ${shugiinLinked} linked to roster members (session ${memberSession} only)`);
unmatched.push(...shugiinMatched.unmatched);

// 質問主意書（Issue #106）: 衆院 質問答弁情報（一覧→経過ページ）、参院 質問主意書（一覧→詳細ページ）。提出者・件名・提出日・答弁書は原文（事実）。
// 提出者は参院は回次ごとの参院名簿、衆院は「現在」の衆院名簿（覆う回次＝memberSession だけ）に名寄せして timeline の question 行にする。
const rawQuestions: Question[] = [];
for (const session of targets) {
  const sh = await fetchShugiinQuestions(session);
  const sa = await fetchSangiinQuestions(session);
  console.log(`session ${session}: ${sh.length} shugiin questions, ${sa.length} sangiin questions`);
  rawQuestions.push(...sh, ...sa);
}
const questions = matchQuestions(rawQuestions, [...members, ...shugiin.members]);
console.log(`questions: ${rawQuestions.length} total, ${questions.questions.filter((q) => q.submitters?.length).length} linked to roster members (shugiin: session ${memberSession} only)`);
unmatched.push(...questions.unmatched);

// 発言: 国会会議録API（公開まで約1ヶ月のラグ。meta.sources[].fetchedAt が「いつ時点の会議録か」を示す）。
// 参院本会議は全回次を参院名簿（回次ごと）に突合する。衆院本会議（Issue #73）は衆院名簿が「現在」の1回次分しか無いので、
// 議案の名寄せと同じく名簿が覆う回次（memberSession）だけ取得・突合し、過去回次は取得しない（名簿に無い旧議員を同名の現職に紐づけない）。
const speeches: Speech[] = [];
for (const session of targets) {
  const matched = matchSpeeches(await fetchSpeeches(session, "sangiin"), members, session);
  const matchedCount = matched.speeches.filter((s) => s.memberId).length;
  const positioned = matched.speeches.filter((s) => s.memberId && s.position).length;
  console.log(`session ${session}: ${matched.speeches.length} sangiin speeches (${matchedCount} matched, ${positioned} with position)`);
  speeches.push(...matched.speeches);
  unmatched.push(...matched.unmatched);
}
// memberSession が carried のとき（過去回次だけの手動実行）は取得しない: readCarried がその回次の speech 行を引き継ぐので、
// 取得すると同じ speechId が2行になる（validateDataset の duplicate speechId 違反。#103 レビュー）。次の日次実行が取り直す。
if (shouldFetchShugiinSpeeches(plan)) {
  const matched = matchSpeeches(await fetchSpeeches(memberSession, "shugiin"), shugiin.members, memberSession);
  const matchedCount = matched.speeches.filter((s) => s.memberId).length;
  const positioned = matched.speeches.filter((s) => s.memberId && s.position).length;
  console.log(`session ${memberSession}: ${matched.speeches.length} shugiin speeches (${matchedCount} matched, ${positioned} with position; roster covers session ${memberSession} only)`);
  speeches.push(...matched.speeches);
  unmatched.push(...matched.unmatched);
} else {
  console.log(`session ${memberSession}: shugiin speeches not fetched (session is carried; carrying previous speech rows instead)`);
}
// 委員会出席（Issue #109）: 委員会会議録の冒頭「出席者」欄の「発議者」（参議院側だけ。案件に参法がある会議録だけ）を参院名簿に名寄せし、
// timeline の attendance 行（「委員会に発議者として出席」）にする。出席した発議者は発議者全員ではないので Bill.submitters / bill 行には決して入れない。
const attendance: MatchedAttendance[] = [];
for (const session of targets) {
  const meetings = await fetchCommitteeAttendance(session);
  const matched = matchAttendance(meetings, members);
  console.log(`session ${session}: ${meetings.length} committee meetings with 参法 proposers in attendance (${matched.entries.length} attendance entries matched, ${matched.unmatched.length} unmatched)`);
  attendance.push(...matched.entries);
  unmatched.push(...matched.unmatched);
}
// 引き継ぐ回次の speech / question / attendance / 参法 bill 行（#103）。名簿から消えた memberId の行は付け先が無いので落とし、件数を出す
// （その回次を指定して取り直せば現行名簿で名寄せし直される）。
const memberIds = new Set(members.map((m) => m.id).concat(shugiin.members.map((m) => m.id)));
const carriedEntries = carried.entries.filter((c) => memberIds.has(c.memberId));
if (carried.entries.length) console.log(`carried: ${carriedEntries.length} timeline entries from sessions ${plan.carried.join(" ")}${carriedEntries.length < carried.entries.length ? ` (${carried.entries.length - carriedEntries.length} dropped: memberId no longer in rosters)` : ""}`);
// 未突合は ETL を止めず、運用者が確認するために列挙する（docs/DATA_CONTRACT.md）。
if (unmatched.length) {
  const { bySession, rest } = shardUnmatched(unmatched);
  const perSession = [...bySession].sort((a, b) => a[0] - b[0]).map(([s, rows]) => `${s}:${rows.length}`).join(" ");
  console.warn(`unmatched: ${unmatched.length} (see data/unmatched/{session}.json and data/unmatched.json)`);
  console.warn(`  by session: ${perSession}${rest.length ? ` (no session: ${rest.length})` : ""}`);
}
// 氏名だけで紐づき、採決ページの会派がどの回次の名簿の会派とも違った票は data/group-mismatch.json に永続化する（Issue #24）。
// 名簿に現れない会派改称・移籍なら正常、名簿にいない旧議員が同名の現職に紐づいていたら誤りなので、運用者がファイルで確認する。
if (groupMismatch.length) console.warn(`group mismatch (matched by name only): ${groupMismatch.length} (see data/group-mismatch.json)`);

await writeDataset(DATA, {
  // 議会一覧（#156）: 国会の2行。members の assemblyId（diet-sangiin / diet-shugiin）はこの id を指す。
  assemblies: dietAssemblies(memberSession),
  ...buildDataset([...members, ...shugiin.members], rollCalls, decisions, speeches, proposed.entries, shugiinMatched.bills, questions.questions, attendance, carriedEntries),
  rollCallDetails: rollCalls,
  bills: shugiinMatched.bills,
  unmatched,
  unmatchedBills: bills.unmatched,
  unmatchedGroups: [...groupsUnknown, ...shugiinGroupsUnknown],
  groupMismatch,
  meta: {
    fetchedAt,
    sessions: plan.all,
    sources: [
      ...rosterSessions.map((s) => ({ name: `参議院 議員一覧（第${s}回）`, url: memberListUrl(s), fetchedAt })),
      { name: `衆議院 議員一覧（${shugiin.asOf ?? "取得日"}現在）`, url: shugiinMemberListUrl(1), fetchedAt },
      { name: "参議院 本会議投票結果", url: "https://www.sangiin.go.jp/japanese/touhyoulist/", fetchedAt },
      { name: "国会会議録検索システム 検索用API（参議院 本会議）", url: speechPageUrl(memberSession, 1, "sangiin"), fetchedAt },
      ...(shouldFetchShugiinSpeeches(plan) ? [{ name: "国会会議録検索システム 検索用API（衆議院 本会議）", url: speechPageUrl(memberSession, 1, "shugiin"), fetchedAt }] : []),
      { name: "国会会議録検索システム 検索用API（参議院 委員会の出席者欄）", url: attendancePageUrl(memberSession), fetchedAt },
      ...targets.map((s) => ({ name: `参議院 議案情報（第${s}回）`, url: billListUrl(s), fetchedAt })),
      ...targets.map((s) => ({ name: `衆議院 議案情報（第${s}回）`, url: shugiinBillListUrl(s), fetchedAt })),
      ...targets.map((s) => ({ name: `衆議院 質問答弁情報（第${s}回）`, url: shugiinQuestionListUrl(s), fetchedAt })),
      ...targets.map((s) => ({ name: `参議院 質問主意書（第${s}回）`, url: sangiinQuestionListUrl(s), fetchedAt })),
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
