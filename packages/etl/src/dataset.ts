import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import type { DatasetMeta, MemberDetail, MemberSummary, RollCall, RollCallSummary } from "@seiji-kiroku/shared";
import type { Aggregated } from "./aggregate.ts";
import { stableJson } from "./json.ts";
import type { Unmatched } from "./match-votes.ts";
import type { UnmatchedSpeech } from "./match-speeches.ts";
import type { UnmatchedBill } from "./sources/sangiin-bills.ts";
import type { UnmatchedGroup } from "./sources/sangiin-members.ts";

/** `data/` に書く一式（docs/DATA_CONTRACT.md）。 */
export interface Dataset extends Aggregated {
  rollCallDetails: RollCall[];
  /** 名寄せできなかった票（rollCallId）と発言（speechId）。 */
  unmatched: (Unmatched | UnmatchedSpeech)[];
  /** 議案情報の審議結果と突合できなかった採決（得票のみの result になる）。 */
  unmatchedBills: UnmatchedBill[];
  /** 対応表（sangiin-groups.ts）に無い会派略称。group には原文のまま入る（Issue #36）。 */
  unmatchedGroups: UnmatchedGroup[];
  meta: DatasetMeta;
}

/** 契約どおりのパスに stableJson で書く。前回実行の残骸が残らないよう members/・rollcalls/ は先に消す。 */
export async function writeDataset(dir: string, ds: Dataset): Promise<void> {
  for (const sub of ["members", "rollcalls"]) await rm(join(dir, sub), { recursive: true, force: true });
  const put = async (rel: string, value: unknown) => {
    const file = join(dir, rel);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, stableJson(value));
  };
  await put("members/index.json", ds.index);
  for (const d of ds.details) await put(`members/${d.id}.json`, d);
  await put("rollcalls/index.json", ds.rollCalls);
  for (const rc of ds.rollCallDetails) await put(`rollcalls/${rc.session}/${rc.id}.json`, rc);
  await put("unmatched.json", ds.unmatched);
  await put("unmatched-bills.json", ds.unmatchedBills);
  await put("unmatched-groups.json", ds.unmatchedGroups);
  await put("meta.json", ds.meta);
}

const SOURCE_HOST = /(^|\.)(sangiin\.go\.jp|shugiin\.go\.jp|ndl\.go\.jp)$/;
const VOTE_VALUES = new Set(["賛成", "反対", "投票なし"]);
/** result は必ず得票を含む: 「賛成 N・反対 N」または「<審議結果の原文>（賛成 N・反対 N）」。可否だけの表示にはしない。 */
const RESULT_FORM = /^(?:[^（）]+（賛成 \d+・反対 \d+）|賛成 \d+・反対 \d+)$/;

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
    for (let i = 0; i < d.timeline.length; i++) {
      const e = d.timeline[i];
      checkSource(rel, e, ` timeline[${i}]`);
      if (e.kind === "speech") speeches++;
      if (e.kind === "vote") {
        votes++;
        if (!VOTE_VALUES.has(e.value)) v.push(`${rel} timeline[${i}]: vote value must be 賛成/反対/投票なし, got ${e.value}`);
      }
      if (i > 0 && d.timeline[i - 1].date < e.date) v.push(`${rel}: timeline not in descending date order at [${i}]`);
    }
    voteCounts.set(m.id, votes);
    if (m.counts.rollcalls !== votes) v.push(`members/index.json ${m.id}: counts.rollcalls ${m.counts.rollcalls} !== timeline votes ${votes}`);
    if (m.counts.speeches !== speeches) v.push(`members/index.json ${m.id}: counts.speeches ${m.counts.speeches} !== timeline speeches ${speeches}`);
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
