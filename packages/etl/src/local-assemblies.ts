import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Assembly, LocalAssemblyMeta, LocalMember, LocalMemberDetail, LocalRollCall, LocalRollCallSummary, LocalUnmatchedName, LocalVoteEntry,
} from "@seiji-kiroku/shared";
import { stableJson } from "./json.ts";
import { MIYAGI_ASSEMBLY } from "./sources/local/miyagi/site.ts";

export { MIYAGI_ASSEMBLY };

/**
 * 地方議会の出力（Issue #157、docs/DATA_CONTRACT.md「地方議会」）。
 *   data/assemblies/index.json                       国会の 2 行 ＋ 地方議会の行（この ETL は自分の行だけ入れ替える）
 *   data/assemblies/{assemblyId}/meta.json           LocalAssemblyMeta
 *   data/assemblies/{assemblyId}/members/index.json  LocalMember[]、members/{id}.json LocalMemberDetail
 *   data/assemblies/{assemblyId}/rollcalls/index.json LocalRollCallSummary[]（新しい順）、rollcalls/{sessionId}/{id}.json LocalRollCall
 *   data/assemblies/{assemblyId}/unmatched.json      LocalUnmatchedName[]
 * 国会の日次 ETL（dataset.ts）とは members/ rollcalls/ を共有しない。assemblies/index.json だけを共有する。
 */
export interface LocalAssemblyInput {
  assembly: Assembly;
  members: LocalMember[];
  rollCalls: LocalRollCall[];
  fetchedAt: string;
  rosterAsOf: string;
  sources: LocalAssemblyMeta["sources"];
  sessions: LocalAssemblyMeta["sessions"];
}

export interface LocalAssemblyDataset {
  assembly: Assembly;
  index: LocalMember[];
  details: LocalMemberDetail[];
  rollCallIndex: LocalRollCallSummary[];
  rollCalls: LocalRollCall[];
  unmatched: LocalUnmatchedName[];
  meta: LocalAssemblyMeta;
}

const byDateDesc = <T extends { date: string; id?: string; rollCallId?: string }>(a: T, b: T) =>
  (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) || cmp(a.id ?? a.rollCallId ?? "", b.id ?? b.rollCallId ?? "");
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 議決結果の原文＋公表された人数（「可決（賛成 49・反対 5）」）。可否は判定しない。 */
export const localResultText = (rc: Pick<LocalRollCall, "result" | "counts">) => `${rc.result}（賛成 ${rc.counts.yes}・反対 ${rc.counts.no}）`;

export function buildLocalAssembly(input: LocalAssemblyInput): LocalAssemblyDataset {
  const ids = new Set<string>();
  for (const rc of input.rollCalls) {
    if (ids.has(rc.id)) throw new Error(`duplicate rollCall id ${rc.id}`);
    ids.add(rc.id);
    if (rc.assemblyId !== input.assembly.id) throw new Error(`${rc.id}: assemblyId ${rc.assemblyId} !== ${input.assembly.id}`);
  }
  const rollCalls = [...input.rollCalls].sort(byDateDesc);
  const timelines = new Map<string, LocalVoteEntry[]>();
  const unmatched = new Map<string, LocalUnmatchedName>();
  let cells = 0;
  let unknownCells = 0;
  for (const rc of rollCalls) {
    for (const v of rc.votes) {
      cells++;
      if (v.value.raw === "不明") unknownCells++;
      if (v.memberId === "") {
        const key = `${v.nameText}\t${v.group}`;
        const u = unmatched.get(key) ?? { nameText: v.nameText, group: v.group, rollCallIds: [] };
        u.rollCallIds.push(rc.id);
        unmatched.set(key, u);
        continue;
      }
      const list = timelines.get(v.memberId) ?? [];
      list.push({ kind: "local-vote", date: rc.date, rollCallId: rc.id, title: rc.title, value: v.value, result: localResultText(rc), sourceUrl: rc.sourceUrl });
      timelines.set(v.memberId, list);
    }
  }
  const memberIds = new Set(input.members.map((m) => m.id));
  for (const id of timelines.keys()) if (!memberIds.has(id)) throw new Error(`vote memberId ${id} is not in the roster`);
  const details: LocalMemberDetail[] = input.members.map((m) => {
    const timeline = (timelines.get(m.id) ?? []).sort(byDateDesc);
    return { ...m, counts: { rollcalls: timeline.length }, timeline };
  });
  const index: LocalMember[] = details.map(({ timeline: _t, ...m }) => m);
  const unmatchedList = [...unmatched.values()].map((u) => ({ ...u, rollCallIds: [...u.rollCallIds].sort(cmp) })).sort((a, b) => cmp(a.nameText, b.nameText) || cmp(a.group, b.group));
  const meta: LocalAssemblyMeta = {
    assemblyId: input.assembly.id,
    fetchedAt: input.fetchedAt,
    sources: input.sources,
    rosterAsOf: input.rosterAsOf,
    sessions: input.sessions,
    counts: { members: index.length, rollcalls: rollCalls.length, cells, unknownCells, unmatchedNames: unmatchedList.length },
  };
  return { assembly: input.assembly, index, details, rollCallIndex: rollCalls.map(({ votes: _v, ...s }) => s), rollCalls, unmatched: unmatchedList, meta };
}

/** `assemblies/index.json` を読む（無ければ []）。 */
async function readAssemblies(dir: string): Promise<Assembly[]> {
  try { return JSON.parse(await readFile(join(dir, "assemblies", "index.json"), "utf8")) as Assembly[]; } catch { return []; }
}

/** 国会の 2 行の後に地方議会の行を id 順で並べる（国会の日次 ETL と地方 ETL のどちらが書いても同じ並び）。 */
export function mergeAssemblies(national: Assembly[], local: Assembly[]): Assembly[] {
  const locals = new Map<string, Assembly>();
  for (const a of local) if (a.kind !== "national") locals.set(a.id, a);
  return [...national.filter((a) => a.kind === "national"), ...[...locals.values()].sort((a, b) => cmp(a.id, b.id))];
}

/**
 * 書き込み先は data/assemblies/{assemblyId}/ だけ。assemblies/index.json は自分の行を入れ替える。
 * index.json にまだ国会の 2 行が無ければ（#156 以降の日次 ETL が一度も走っていない）`national` で補う（Web が国会の議員を引けなくならないように）。
 */
export async function writeLocalAssembly(dir: string, ds: LocalAssemblyDataset, opts: { national?: Assembly[] } = {}): Promise<void> {
  if (!/^(pref|city)-[0-9]+$/.test(ds.assembly.id)) throw new Error(`refusing to write assembly id ${ds.assembly.id}`);
  const base = join(dir, "assemblies", ds.assembly.id);
  await rm(base, { recursive: true, force: true });
  const put = async (rel: string, value: unknown) => {
    const file = join(base, rel);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, stableJson(value));
  };
  await put("members/index.json", ds.index);
  for (const d of ds.details) await put(`members/${d.id}.json`, d);
  await put("rollcalls/index.json", ds.rollCallIndex);
  for (const rc of ds.rollCalls) await put(`rollcalls/${rc.sessionId}/${rc.id}.json`, rc);
  await put("unmatched.json", ds.unmatched);
  await put("meta.json", ds.meta);
  const existing = await readAssemblies(dir);
  const national = existing.some((a) => a.kind === "national") ? existing : [...(opts.national ?? []), ...existing];
  const merged = mergeAssemblies(national, [...existing.filter((a) => a.id !== ds.assembly.id), ds.assembly]);
  await mkdir(join(dir, "assemblies"), { recursive: true });
  await writeFile(join(dir, "assemblies", "index.json"), stableJson(merged));
}

/* ---------- 不変条件 ---------- */

const VOTE_VALUES = new Set(["賛成", "反対", "投票なし"]);
const LOCAL_MEMBER_ID = /^p_(0[1-9]|[1-3]\d|4[0-7])_[A-Za-z0-9_-]+$/;

const safeHost = (url: string): string | undefined => { try { return new URL(url).host; } catch { return undefined; } };

/**
 * 地方議会のデータの不変条件（docs/DATA_CONTRACT.md「地方議会」）。assemblies/index.json の prefectural / municipal の行ごとに、
 * data/assemblies/{id}/ があれば検査する（無ければ違反にしない: その議会の ETL がまだ走っていないだけ）。
 */
export async function validateLocalAssemblies(dir: string): Promise<string[]> {
  const v: string[] = [];
  const assemblies = await readAssemblies(dir);
  for (const a of assemblies) {
    if (a.kind === "national") continue;
    const base = join(dir, "assemblies", a.id);
    try { await readdir(base); } catch { continue; }
    const host = safeHost(a.sourceUrl);
    if (!host) { v.push(`assemblies/index.json ${a.id}: sourceUrl invalid`); continue; }
    const read = async <T,>(rel: string): Promise<T | undefined> => {
      const label = `assemblies/${a.id}/${rel}`;
      let text: string;
      try { text = await readFile(join(base, rel), "utf-8"); } catch { v.push(`${label}: missing`); return undefined; }
      let value: T;
      try { value = JSON.parse(text) as T; } catch { v.push(`${label}: not JSON`); return undefined; }
      if (text !== stableJson(value)) v.push(`${label}: not in stableJson form (sorted keys, indent 1, trailing newline)`);
      return value;
    };
    const checkSource = (label: string, rec: { sourceUrl?: unknown }) => {
      const h = typeof rec.sourceUrl === "string" ? safeHost(rec.sourceUrl) : undefined;
      if (!h || !/^https:\/\//.test(String(rec.sourceUrl))) v.push(`${label}: sourceUrl missing or not https (${String(rec.sourceUrl)})`);
      else if (h !== host) v.push(`${label}: sourceUrl host not allowed for ${a.id}: ${h} (expected ${host})`);
    };
    const meta = await read<LocalAssemblyMeta>("meta.json");
    if (meta) {
      if (meta.assemblyId !== a.id) v.push(`assemblies/${a.id}/meta.json: assemblyId ${meta.assemblyId} !== ${a.id}`);
      if (typeof meta.fetchedAt !== "string" || typeof meta.rosterAsOf !== "string" || !Array.isArray(meta.sessions)) v.push(`assemblies/${a.id}/meta.json: fetchedAt / rosterAsOf / sessions required`);
    }
    const index = (await read<LocalMember[]>("members/index.json")) ?? [];
    const memberIds = new Set<string>();
    const voteCounts = new Map<string, number>();
    for (const m of index) {
      const label = `assemblies/${a.id}/members/index.json ${m.id}`;
      if (memberIds.has(m.id)) v.push(`${label}: duplicate id`);
      memberIds.add(m.id);
      if (!LOCAL_MEMBER_ID.test(m.id) || (a.prefCode && !m.id.startsWith(`p_${a.prefCode}_`))) v.push(`${label}: id must be p_{prefCode}_…`);
      if (m.assemblyId !== a.id) v.push(`${label}: assemblyId ${String(m.assemblyId)} !== ${a.id}`);
      if (typeof m.name !== "string" || m.name === "") v.push(`${label}: name required`);
      if (typeof m.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(m.asOf)) v.push(`${label}: asOf must be ISO date`);
      checkSource(label, m);
      checkSource(`${label} profileUrl`, { sourceUrl: m.profileUrl });
      const d = await read<LocalMemberDetail>(`members/${m.id}.json`);
      if (!d) continue;
      const rel = `assemblies/${a.id}/members/${m.id}.json`;
      if (d.id !== m.id) v.push(`${rel}: id ${d.id} !== ${m.id}`);
      let votes = 0;
      for (let i = 0; i < d.timeline.length; i++) {
        const e = d.timeline[i];
        if (e.kind !== "local-vote") { v.push(`${rel} timeline[${i}]: kind must be local-vote`); continue; }
        votes++;
        checkSource(`${rel} timeline[${i}]`, e);
        checkLocalVote(v, `${rel} timeline[${i}]`, e.value);
        if (i > 0 && d.timeline[i - 1].date < e.date) v.push(`${rel}: timeline not in descending date order at [${i}]`);
      }
      voteCounts.set(m.id, votes);
      if (m.counts?.rollcalls !== votes) v.push(`${label}: counts.rollcalls ${String(m.counts?.rollcalls)} !== timeline votes ${votes}`);
    }
    const unmatched = (await read<LocalUnmatchedName[]>("unmatched.json")) ?? [];
    const unmatchedKeys = new Set<string>();
    for (const u of unmatched) for (const id of u.rollCallIds) unmatchedKeys.add(`${id}\t${u.nameText}`);
    const summaries = (await read<LocalRollCallSummary[]>("rollcalls/index.json")) ?? [];
    const seenVotes = new Map<string, number>();
    let cells = 0;
    let unknownCells = 0;
    for (let i = 0; i < summaries.length; i++) {
      const s = summaries[i];
      const label = `assemblies/${a.id}/rollcalls/index.json[${i}]`;
      checkSource(label, s);
      if ("votes" in s) v.push(`${label}: index row must not carry votes`);
      if (i > 0 && summaries[i - 1].date < s.date) v.push(`assemblies/${a.id}/rollcalls/index.json: not in descending date order at [${i}]`);
      const rel = `rollcalls/${s.sessionId}/${s.id}.json`;
      const rc = await read<LocalRollCall>(rel);
      if (!rc) continue;
      const rcLabel = `assemblies/${a.id}/${rel}`;
      if (rc.id !== s.id || rc.assemblyId !== a.id) v.push(`${rcLabel}: id/assemblyId mismatch`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(rc.date)) v.push(`${rcLabel}: date must be ISO`);
      if (typeof rc.kind !== "string" || rc.kind === "" || typeof rc.title !== "string" || rc.title === "") v.push(`${rcLabel}: kind / title required`);
      if (!rc.method || typeof rc.method.raw !== "string" || typeof rc.method.legend !== "string" || rc.method.legend === "") v.push(`${rcLabel}: method.raw / method.legend required`);
      if (typeof rc.result !== "string" || rc.result === "") v.push(`${rcLabel}: result required`);
      checkSource(rcLabel, rc);
      if (!Array.isArray(rc.votes)) { v.push(`${rcLabel}: votes required`); continue; }
      for (const vote of rc.votes) {
        cells++;
        checkLocalVote(v, `${rcLabel} (${vote.nameText})`, vote.value);
        if (vote.value?.raw === "不明") unknownCells++;
        if (vote.memberId === "") {
          if (!unmatchedKeys.has(`${rc.id}\t${vote.nameText}`)) v.push(`${rcLabel}: "${vote.nameText}" has empty memberId but is not listed in unmatched.json`);
        } else if (!memberIds.has(vote.memberId)) v.push(`${rcLabel}: memberId ${vote.memberId} not in members/index.json`);
        else seenVotes.set(vote.memberId, (seenVotes.get(vote.memberId) ?? 0) + 1);
      }
    }
    for (const [id, n] of voteCounts) if ((seenVotes.get(id) ?? 0) !== n) v.push(`assemblies/${a.id}: member ${id} has ${n} timeline votes but ${seenVotes.get(id) ?? 0} in rollcalls/`);
    if (meta) {
      // 議員数×議案数＝セル数（不明を含む）は PDF 単位の不変条件。meta の counts と実ファイルの数が一致することを検査する
      if (meta.counts.cells !== cells) v.push(`assemblies/${a.id}/meta.json: counts.cells ${meta.counts.cells} !== ${cells} cells in rollcalls/`);
      if (meta.counts.unknownCells !== unknownCells) v.push(`assemblies/${a.id}/meta.json: counts.unknownCells ${meta.counts.unknownCells} !== ${unknownCells}`);
      if (meta.counts.rollcalls !== summaries.length) v.push(`assemblies/${a.id}/meta.json: counts.rollcalls ${meta.counts.rollcalls} !== ${summaries.length}`);
      if (meta.counts.members !== index.length) v.push(`assemblies/${a.id}/meta.json: counts.members ${meta.counts.members} !== ${index.length}`);
      if (meta.counts.unmatchedNames !== unmatched.length) v.push(`assemblies/${a.id}/meta.json: counts.unmatchedNames ${meta.counts.unmatchedNames} !== ${unmatched.length}`);
    }
  }
  return v;
}

/** LocalVote の形: raw は空でなく、legend は空でない原文、mapped は国会の 3 値だけ（凡例から読めたときだけ）。 */
function checkLocalVote(v: string[], label: string, value: { raw?: unknown; legend?: unknown; mapped?: unknown } | undefined): void {
  if (!value || typeof value.raw !== "string" || value.raw === "") { v.push(`${label}: vote value.raw required`); return; }
  if (typeof value.legend !== "string" || value.legend === "") v.push(`${label}: vote value.legend required (raw ${value.raw})`);
  if (value.mapped !== undefined && !VOTE_VALUES.has(value.mapped as string)) v.push(`${label}: vote value.mapped must be 賛成/反対/投票なし, got ${String(value.mapped)}`);
  if (value.raw === "不明" && value.mapped !== undefined) v.push(`${label}: vote value.mapped must be omitted for 不明`);
}
