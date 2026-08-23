import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import type { Bill, BillSummary, DatasetMeta, MemberDetail, MemberSummary, RollCall, RollCallSummary } from "@seiji-kiroku/shared";
import type { Aggregated } from "./aggregate.ts";
import { stableJson } from "./json.ts";
import type { GroupMismatch, Unmatched } from "./match-votes.ts";
import type { UnmatchedSpeech } from "./match-speeches.ts";
import type { UnmatchedBillProposer } from "./match-bills.ts";
import type { UnmatchedShugiinBillName } from "./match-shugiin-bills.ts";
import type { UnmatchedQuestionSubmitter } from "./match-questions.ts";
import type { UnmatchedAttendee } from "./match-attendance.ts";
import { toBillSummary } from "./sources/shugiin-bills.ts";
import type { UnmatchedBill } from "./sources/sangiin-bills.ts";
import type { UnmatchedGroup } from "./sources/sangiin-members.ts";

/** `data/` に書く一式（docs/DATA_CONTRACT.md）。 */
export interface Dataset extends Aggregated {
  rollCallDetails: RollCall[];
  /** 議案（衆院 議案情報から。Issue #72）。`bills/{提出回次}/{id}.json` と `bills/index.json` になる。 */
  bills: Bill[];
  /** 名寄せできなかった票（rollCallId）・発言（speechId）・参法の発議者 / 衆院 議案の提出者・賛成者（billId）・質問主意書の提出者（questionId）・委員会出席の発議者（meetingId）。 */
  unmatched: (Unmatched | UnmatchedSpeech | UnmatchedBillProposer | UnmatchedShugiinBillName | UnmatchedQuestionSubmitter | UnmatchedAttendee)[];
  /** 議案情報の審議結果と突合できなかった採決（得票のみの result になる）。 */
  unmatchedBills: UnmatchedBill[];
  /** 対応表（sangiin-groups.ts）に無い会派略称。group には原文のまま入る（Issue #36）。 */
  unmatchedGroups: UnmatchedGroup[];
  /** 氏名だけで紐づき、採決ページの会派がどの回次の名簿の会派とも違った票（Issue #24）。会派移動は推定しない。 */
  groupMismatch: GroupMismatch[];
  meta: DatasetMeta;
}

/** ETL の既定回次（直近2年: 第217〜221回）。`.github/workflows/etl.yml` の既定と同じ。 */
export const DEFAULT_SESSIONS: readonly number[] = [217, 218, 219, 220, 221];

/**
 * 今回処理する回次 = 指定された回次（空なら既定） ∪ data/ に既にある回次。
 * `pnpm etl 221` のような部分実行でも、他回次の採決・票が data/ から消えないようにする（#4 レビュー指摘）。
 * 回次を減らしたいときは data/ を消してから実行する。
 */
export function resolveSessions(requested: readonly number[], onDisk: readonly number[]): number[] {
  return [...new Set([...(requested.length ? requested : DEFAULT_SESSIONS), ...onDisk])].sort((a, b) => a - b);
}

/** `dir/meta.json` の sessions。無ければ空（初回実行）。 */
export async function readSessionsOnDisk(dir: string): Promise<number[]> {
  try {
    const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf-8")) as Partial<DatasetMeta>;
    return Array.isArray(meta.sessions) ? meta.sessions.filter((s): s is number => typeof s === "number") : [];
  } catch { return []; }
}

/**
 * 契約どおりのパスに stableJson で書く。
 * 前回実行の残骸が残らないよう members/ と、今回対象（meta.sessions）の回次の rollcalls/{session}/ は先に消す。
 * 対象外の回次の rollcalls/{session}/ は触らない。
 * bills/ は全部消す: 議案は「審議回次の一覧」から取り、継続審議の議案は提出回次（対象外のこともある）の下に置くので、回次単位では消せない。
 * ETL は常に「指定 ∪ data/ にある回次」を全部処理する（resolveSessions）ので、全消しでも他回次の議案は同じ実行で書き直される。
 */
export async function writeDataset(dir: string, ds: Dataset): Promise<void> {
  await rm(join(dir, "members"), { recursive: true, force: true });
  for (const session of ds.meta.sessions) await rm(join(dir, "rollcalls", String(session)), { recursive: true, force: true });
  await rm(join(dir, "bills"), { recursive: true, force: true });
  const put = async (rel: string, value: unknown) => {
    const file = join(dir, rel);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, stableJson(value));
  };
  await put("members/index.json", ds.index);
  for (const d of ds.details) await put(`members/${d.id}.json`, d);
  await put("rollcalls/index.json", ds.rollCalls);
  for (const rc of ds.rollCallDetails) await put(`rollcalls/${rc.session}/${rc.id}.json`, rc);
  const bills = sortBills(ds.bills);
  await put("bills/index.json", bills.map(toBillSummary));
  for (const b of bills) await put(`bills/${b.session}/${b.id}.json`, b);
  await put("unmatched.json", ds.unmatched);
  await put("unmatched-bills.json", ds.unmatchedBills);
  await put("unmatched-groups.json", ds.unmatchedGroups);
  await put("group-mismatch.json", ds.groupMismatch);
  await put("meta.json", ds.meta);
}

const SOURCE_HOST = /(^|\.)(sangiin\.go\.jp|shugiin\.go\.jp|ndl\.go\.jp)$/;
const VOTE_VALUES = new Set(["賛成", "反対", "投票なし"]);
/** result は必ず得票を含む: 「賛成 N・反対 N」または「<審議結果の原文>（賛成 N・反対 N）」。可否だけの表示にはしない。 */
const RESULT_FORM = /^(?:[^（）]+（賛成 \d+・反対 \d+）|賛成 \d+・反対 \d+)$/;
/** group-mismatch.json の1行に必須のキー（GroupMismatch）。 */
const MISMATCH_KEYS = ["memberId", "nameText", "voteGroup", "rosterGroup", "rollCallId"] as const;
/** 衆院 議案情報の経過ページ（衆院議員の提出・賛同、会派態度の一次資料）。 */
const KEIKA_SOURCE = /^https:\/\/www\.shugiin\.go\.jp\/internet\/itdb_gian\.nsf\/html\/gian\/keika\/[^/]+\.htm$/;
/** bill 行の sourceUrl は参院 議案情報の議案詳細ページ（提出者・審議状況の一次資料）か衆院の経過ページ。 */
const BILL_SOURCE = /^https:\/\/www\.sangiin\.go\.jp\/japanese\/joho1\/kousei\/gian\/\d+\/meisai\/m\d+\.htm$/;
const STANCE_VALUES = new Set(["賛成", "反対"]);
/** question 行の sourceUrl は衆院 質問答弁情報の経過ページか参院 質問主意書の詳細ページ（提出日・提出者の一次資料、#106）。 */
const QUESTION_SOURCE = /^https:\/\/(?:www\.shugiin\.go\.jp\/internet\/itdb_shitsumon\.nsf\/html\/shitsumon\/\d+\.htm|www\.sangiin\.go\.jp\/japanese\/joho1\/kousei\/syuisyo\/\d+\/meisai\/m\d+\.htm)$/;
/** attendance 行の sourceUrl は国会会議録検索システムの会議録（冒頭情報）。 */
const ATTENDANCE_SOURCE = /^https:\/\/kokkai\.ndl\.go\.jp\/txt\/[0-9A-Za-z]+\/\d+$/;
/** bills/ の id は `{提出回次}-{種別原文}-{番号 or 経過ページ id}`。 */
const BILL_ID = /^(\d+)-[^-]+-[^-]+$/;

/** bills/index.json の順: 提出回次の降順、同じ回次では id の昇順（決定的な並び）。 */
export function sortBills(bills: readonly Bill[]): Bill[] {
  return [...bills].sort((a, b) => b.session - a.session || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * docs/DATA_CONTRACT.md の不変条件を `dir` 上のファイルに対して検証し、違反を文字列で返す（空なら合格）。
 * ETL の最後に呼び、違反があれば非0終了する。例外ではなく列挙で返すのは、運用者が一度に全部見られるように。
 */
export async function validateDataset(dir: string): Promise<string[]> {
  const v: string[] = [];
  const read = async <T,>(rel: string): Promise<T | undefined> => {
    let text: string;
    try { text = await readFile(join(dir, rel), "utf-8"); } catch { v.push(`${rel}: missing`); return undefined; }
    let value: T;
    try { value = JSON.parse(text) as T; } catch { v.push(`${rel}: not JSON`); return undefined; }
    if (text !== stableJson(value)) v.push(`${rel}: not in stableJson form (sorted keys, indent 1, trailing newline)`);
    return value;
  };
  const checkSource = (rel: string, rec: { sourceUrl?: unknown }, label = "") => {
    const url = rec.sourceUrl;
    const host = typeof url === "string" ? safeHost(url) : undefined;
    if (!host) v.push(`${rel}${label}: sourceUrl missing or invalid (${String(url)})`);
    else if (!SOURCE_HOST.test(host)) v.push(`${rel}${label}: sourceUrl host not allowed: ${host}`);
  };

  const meta = await read<DatasetMeta>("meta.json");
  if (meta && (typeof meta.fetchedAt !== "string" || !Array.isArray(meta.sessions))) v.push("meta.json: fetchedAt / sessions required");

  const index = (await read<MemberSummary[]>("members/index.json")) ?? [];
  const ids = new Set<string>();
  for (const m of index) {
    if (ids.has(m.id)) v.push(`members/index.json: duplicate id ${m.id}`);
    ids.add(m.id);
  }
  const voteCounts = new Map<string, number>();
  for (const m of index) {
    const d = await read<MemberDetail>(`members/${m.id}.json`);
    if (!d) continue;
    const rel = `members/${m.id}.json`;
    if (d.id !== m.id) v.push(`${rel}: id ${d.id} !== ${m.id}`);
    checkSource(rel, d);
    let votes = 0;
    let speeches = 0;
    let bills = 0;
    let questions = 0;
    for (let i = 0; i < d.timeline.length; i++) {
      const e = d.timeline[i];
      checkSource(rel, e, ` timeline[${i}]`);
      if (e.kind === "speech") speeches++;
      if (e.kind === "bill") {
        bills++;
        if (!BILL_SOURCE.test(e.sourceUrl) && !KEIKA_SOURCE.test(e.sourceUrl)) v.push(`${rel} timeline[${i}]: bill sourceUrl must be the 議案ページ (kousei/gian/{session}/meisai/ or gian/keika/), got ${e.sourceUrl}`);
      }
      if (e.kind === "stance") {
        // 推定の行: 型で事実と分ける不変条件（estimated は常に true、出典は衆院の経過ページ）
        if (d.house !== "shugiin") v.push(`${rel} timeline[${i}]: stance row is allowed only for house=shugiin members, got house=${d.house}`);
        if (e.estimated !== true) v.push(`${rel} timeline[${i}]: stance row must have estimated: true`);
        if (!STANCE_VALUES.has(e.stance)) v.push(`${rel} timeline[${i}]: stance must be 賛成/反対, got ${e.stance}`);
        if (!KEIKA_SOURCE.test(e.sourceUrl)) v.push(`${rel} timeline[${i}]: stance sourceUrl must be the 衆院 経過ページ (gian/keika/), got ${e.sourceUrl}`);
      }
      if (e.kind === "question") {
        questions++;
        if (!QUESTION_SOURCE.test(e.sourceUrl)) v.push(`${rel} timeline[${i}]: question sourceUrl must be the 衆院 経過ページ (itdb_shitsumon.nsf/html/shitsumon/) or 参院 詳細ページ (kousei/syuisyo/{session}/meisai/), got ${e.sourceUrl}`);
        if (e.answerUrl !== undefined) {
          const host = safeHost(e.answerUrl);
          if (!host || !SOURCE_HOST.test(host)) v.push(`${rel} timeline[${i}]: question answerUrl host not allowed: ${String(e.answerUrl)}`);
        }
      }
      if (e.kind === "attendance") {
        // 委員会出席（事実）: 出席した発議者は発議者全員ではないので bill 行とは別の kind。参院の委員会の発議者は参議院議員にだけ付く（#109）
        if (d.house !== "sangiin") v.push(`${rel} timeline[${i}]: attendance row is allowed only for house=sangiin members, got house=${d.house}`);
        if (e.estimated !== false) v.push(`${rel} timeline[${i}]: attendance row must have estimated: false`);
        if (e.role !== "発議者") v.push(`${rel} timeline[${i}]: attendance role must be 発議者, got ${String((e as { role: unknown }).role)}`);
        if (!ATTENDANCE_SOURCE.test(e.sourceUrl)) v.push(`${rel} timeline[${i}]: attendance sourceUrl must be the 会議録 (kokkai.ndl.go.jp/txt/), got ${e.sourceUrl}`);
      }
      if (e.kind === "vote") {
        votes++;
        if (!VOTE_VALUES.has(e.value)) v.push(`${rel} timeline[${i}]: vote value must be 賛成/反対/投票なし, got ${e.value}`);
      }
      if (i > 0 && d.timeline[i - 1].date < e.date) v.push(`${rel}: timeline not in descending date order at [${i}]`);
    }
    voteCounts.set(m.id, votes);
    if (m.counts.rollcalls !== votes) v.push(`members/index.json ${m.id}: counts.rollcalls ${m.counts.rollcalls} !== timeline votes ${votes}`);
    if (m.counts.bills !== bills) v.push(`members/index.json ${m.id}: counts.bills ${m.counts.bills} !== timeline bills ${bills}`);
    if (m.counts.speeches !== speeches) v.push(`members/index.json ${m.id}: counts.speeches ${m.counts.speeches} !== timeline speeches ${speeches}`);
    if (m.counts.questions !== questions) v.push(`members/index.json ${m.id}: counts.questions ${m.counts.questions} !== timeline questions ${questions}`);
  }

  const unmatched = (await read<Dataset["unmatched"]>("unmatched.json")) ?? [];
  const unmatchedKeys = new Set(unmatched.map((u) => ("rollCallId" in u ? `${u.rollCallId}\t${u.nameText}` : "")));
  const summaries = (await read<RollCallSummary[]>("rollcalls/index.json")) ?? [];
  let matchedVotes = 0;
  for (let i = 0; i < summaries.length; i++) {
    const s = summaries[i];
    checkSource("rollcalls/index.json", s, `[${i}]`);
    if (!RESULT_FORM.test(s.result)) v.push(`rollcalls/index.json[${i}]: result must contain the tally (賛成 N・反対 N), got "${s.result}"`);
    if (i > 0 && summaries[i - 1].date < s.date) v.push(`rollcalls/index.json: not in descending date order at [${i}]`);
    const rel = `rollcalls/${s.session}/${s.id}.json`;
    const rc = await read<RollCall>(rel);
    if (!rc) continue;
    checkSource(rel, rc);
    const size = rc.groups.reduce((a, g) => a + g.size, 0);
    if (size !== rc.votes.length) v.push(`${rel}: Σ groups[].size ${size} !== votes.length ${rc.votes.length}`);
    for (const vote of rc.votes) {
      if (!VOTE_VALUES.has(vote.value)) v.push(`${rel}: vote value must be 賛成/反対/投票なし, got ${vote.value} (${vote.nameText})`);
      if (vote.memberId === "") {
        if (!unmatchedKeys.has(`${rc.id}\t${vote.nameText}`)) v.push(`${rel}: "${vote.nameText}" has empty memberId but is not listed in unmatched.json`);
      } else if (!ids.has(vote.memberId)) v.push(`${rel}: memberId ${vote.memberId} not in members/index.json`);
      else matchedVotes++;
    }
  }
  // bills/: index と各ファイルの整合、sourceUrl、会派態度（推定）の形（Issue #72）
  const billIndex = (await read<BillSummary[]>("bills/index.json")) ?? [];
  const billIds = new Set<string>();
  for (let i = 0; i < billIndex.length; i++) {
    const s = billIndex[i];
    if (billIds.has(s.id)) v.push(`bills/index.json: duplicate id ${s.id}`);
    billIds.add(s.id);
    checkSource("bills/index.json", s, `[${i}]`);
    if (!BILL_ID.test(s.id)) v.push(`bills/index.json[${i}]: id must be {回次}-{種別}-{番号}, got ${s.id}`);
    const rel = `bills/${s.session}/${s.id}.json`;
    const b = await read<Bill>(rel);
    if (!b) continue;
    if (b.id !== s.id) v.push(`${rel}: id ${b.id} !== ${s.id}`);
    if (b.session !== s.session) v.push(`${rel}: session ${b.session} !== ${s.session}`);
    if (b.house !== s.house) v.push(`${rel}: house ${b.house} !== ${s.house}`);
    checkSource(rel, b);
    const st = b.shugiinGroupStance;
    if (st !== undefined) {
      if (typeof st.stanceText !== "string" || !Array.isArray(st.yes) || !Array.isArray(st.no)) v.push(`${rel}: shugiinGroupStance must be {stanceText, yes[], no[]}`);
      if (st.unanimous !== undefined && (st.unanimous !== true || st.stanceText !== "全会一致")) v.push(`${rel}: unanimous may be true only when stanceText is 全会一致 (got ${st.stanceText})`);
    }
    for (const key of ["submitters", "supporters"] as const) {
      for (const id of b[key] ?? []) if (!ids.has(id)) v.push(`${rel}: ${key} memberId ${id} not in members/index.json`);
    }
  }
  const billFiles = new Set(billIndex.map((s) => `bills/${s.session}/${s.id}.json`));
  for (const rel of await listJsonFiles(dir, "bills")) {
    if (rel !== "bills/index.json" && !billFiles.has(rel)) v.push(`${rel}: not in bills/index.json (stale file from a previous run?)`);
  }
  // group-mismatch.json: 行の形と、memberId / rollCallId が公開データ上に実在することを検査（Issue #24）
  const mismatch = await read<unknown>("group-mismatch.json");
  if (mismatch !== undefined) {
    if (!Array.isArray(mismatch)) v.push("group-mismatch.json: must be an array");
    else {
      const rollCallIds = new Set(summaries.map((s) => s.id));
      mismatch.forEach((row: unknown, i) => {
        const rec = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
        for (const key of MISMATCH_KEYS) {
          if (typeof rec[key] !== "string" || rec[key] === "") v.push(`group-mismatch.json[${i}]: ${key} must be a non-empty string`);
        }
        if (typeof rec.memberId === "string" && rec.memberId && !ids.has(rec.memberId)) v.push(`group-mismatch.json[${i}]: memberId ${rec.memberId} not in members/index.json`);
        if (typeof rec.rollCallId === "string" && rec.rollCallId && !rollCallIds.has(rec.rollCallId)) v.push(`group-mismatch.json[${i}]: rollCallId ${rec.rollCallId} not in rollcalls/index.json`);
      });
    }
  }
  for (const rel of await listJsonFiles(dir, "members")) {
    if (rel !== "members/index.json" && !ids.has(rel.slice("members/".length, -".json".length))) v.push(`${rel}: not in members/index.json (stale file from a previous run?)`);
  }
  const summaryFiles = new Set(summaries.map((s) => `rollcalls/${s.session}/${s.id}.json`));
  for (const rel of await listJsonFiles(dir, "rollcalls")) {
    if (rel !== "rollcalls/index.json" && !summaryFiles.has(rel)) v.push(`${rel}: not in rollcalls/index.json (stale file from a previous run?)`);
  }
  const countSum = [...voteCounts.values()].reduce((a, b) => a + b, 0);
  if (countSum !== matchedVotes) v.push(`Σ counts.rollcalls ${countSum} !== matched votes across all roll calls ${matchedVotes}`);
  return v;
}

/** `dir/sub` 以下の *.json を `sub/...` 形式の相対パス（'/' 区切り）で再帰列挙する。無ければ空。 */
async function listJsonFiles(dir: string, sub: string): Promise<string[]> {
  let entries: Dirent[];
  try { entries = await readdir(join(dir, sub), { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    const rel = `${sub}/${e.name}`;
    if (e.isDirectory()) out.push(...(await listJsonFiles(dir, rel)));
    else if (e.name.endsWith(".json")) out.push(rel);
  }
  return out.sort();
}

function safeHost(url: string): string | undefined {
  try { return new URL(url).hostname; } catch { return undefined; }
}
