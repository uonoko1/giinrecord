import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Assembly, AssemblySession, LocalAssemblyMeta, LocalMember, LocalMemberDetail, LocalRollCall, LocalRollCallSummary, LocalUnmatchedName, LocalVoteEntry, MemberSummary,
} from "@seiji-kiroku/shared";
import { stableJson } from "./json.ts";
import { MIYAGI_ASSEMBLY } from "./sources/local/miyagi/site.ts";
import { runMiyagi } from "./sources/local/miyagi/index.ts";
import { TOKUSHIMA_ASSEMBLY } from "./sources/local/tokushima/site.ts";
import { runTokushima } from "./sources/local/tokushima/index.ts";
import { TOTTORI_ASSEMBLY } from "./sources/local/tottori/site.ts";
import { runTottori } from "./sources/local/tottori/index.ts";
import { MIE_ASSEMBLY } from "./sources/local/mie/site.ts";
import { runMie } from "./sources/local/mie/index.ts";
import { NARA_ASSEMBLY } from "./sources/local/nara/site.ts";
import { runNara } from "./sources/local/nara/index.ts";
import { SHIMANE_ASSEMBLY } from "./sources/local/shimane/site.ts";
import { runShimane } from "./sources/local/shimane/index.ts";

export { MIYAGI_ASSEMBLY, TOKUSHIMA_ASSEMBLY, TOTTORI_ASSEMBLY, MIE_ASSEMBLY, NARA_ASSEMBLY, SHIMANE_ASSEMBLY };

/** 議会ごとの取得部が返す形（buildLocalAssembly の入力になる部分）。 */
export interface LocalSourceRun {
  roster: { members: LocalMember[]; asOf: string };
  rollCalls: LocalRollCall[];
  sessions: LocalAssemblyMeta["sessions"];
  sources: LocalAssemblyMeta["sources"];
  /** 取得部が付けた名寄せの候補（鳥取 #184。姓だけの表記で同姓が 2 人以上のとき）。無い議会は省略 */
  unmatched?: LocalUnmatchedName[];
}
export interface LocalSource {
  assembly: Assembly;
  run(opts: { sessions: number; fetchedAt: string; log?: (line: string) => void }): Promise<LocalSourceRun>;
}
/** `pnpm etl:local <name>` の name → 議会。議会を足すときはここに 1 行足す（local-cli.ts は触らない）。 */
export const LOCAL_SOURCES: Record<string, LocalSource> = {
  miyagi: { assembly: MIYAGI_ASSEMBLY, run: runMiyagi },
  tokushima: { assembly: TOKUSHIMA_ASSEMBLY, run: runTokushima },
  tottori: { assembly: TOTTORI_ASSEMBLY, run: runTottori },
  mie: { assembly: MIE_ASSEMBLY, run: runMie },
  nara: { assembly: NARA_ASSEMBLY, run: runNara },
  shimane: { assembly: SHIMANE_ASSEMBLY, run: runShimane },
};

/**
 * 地方議会の出力（Issue #157、docs/DATA_CONTRACT.md「地方議会の Web 表示が読む形」#158）。Web は何も変えずに読める形で書く。
 *   data/assemblies/index.json                        国会の 2 行 ＋ 地方議会の行（この ETL は自分の行だけ入れ替える）
 *   data/members/index.json                           国会の行の後に地方議員の行（LocalMember。自分の議会の行だけ入れ替える）
 *   data/members/{memberId}.json                      LocalMemberDetail（timeline は localVote の行、新しい順）
 *   data/assemblies/{assemblyId}/sessions.json        AssemblySession[]（新しい順）
 *   data/assemblies/{assemblyId}/meta.json            LocalAssemblyMeta
 *   data/assemblies/{assemblyId}/rollcalls/index.json LocalRollCallSummary[]（新しい順）、rollcalls/{sessionId}/{id}.json LocalRollCall（表決の原本）
 *   data/assemblies/{assemblyId}/unmatched.json       LocalUnmatchedName[]
 * 国会の日次 ETL（dataset.ts）とは assemblies/index.json と members/index.json を共有する（互いに相手の行を残す）。
 */
export interface LocalAssemblyInput {
  assembly: Assembly;
  members: LocalMember[];
  rollCalls: LocalRollCall[];
  fetchedAt: string;
  rosterAsOf: string;
  sources: LocalAssemblyMeta["sources"];
  sessions: LocalAssemblyMeta["sessions"];
  /** 取得部が付けた名寄せの候補（同姓が 2 人以上のとき。#184）。unmatched.json は rollCalls の memberId 空の票から作り直すので、候補だけここから写す */
  unmatched?: LocalUnmatchedName[];
}

export interface LocalAssemblyDataset {
  assembly: Assembly;
  index: LocalMember[];
  details: LocalMemberDetail[];
  sessions: AssemblySession[];
  rollCallIndex: LocalRollCallSummary[];
  rollCalls: LocalRollCall[];
  unmatched: LocalUnmatchedName[];
  meta: LocalAssemblyMeta;
}

const byDateDesc = <T extends { date: string; id?: string; rollCallId?: string }>(a: T, b: T) =>
  (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) || cmp(a.id ?? a.rollCallId ?? "", b.id ?? b.rollCallId ?? "");
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 国会の行か（`diet-` の assemblyId、または assemblyId の無い古い行）。地方議員は `diet-` 以外の assemblyId を持つ。 */
export const isDietMemberRow = (m: { assemblyId?: string }): boolean => m.assemblyId === undefined || m.assemblyId.startsWith("diet-");

/** timeline の 1 行。公表の原文（会期・方法・結果）をそのまま添える。可否は判定しない。 */
function toVoteEntry(rc: LocalRollCall, vote: LocalRollCall["votes"][number]): LocalVoteEntry {
  return { kind: "localVote", date: rc.date, rollCallId: rc.id, title: rc.title, vote: vote.value, sessionLabel: rc.sessionLabel, method: rc.method?.raw, result: rc.result, sourceUrl: rc.sourceUrl };
}

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
      list.push(toVoteEntry(rc, v));
      timelines.set(v.memberId, list);
    }
  }
  const memberIds = new Set(input.members.map((m) => m.id));
  for (const id of timelines.keys()) if (!memberIds.has(id)) throw new Error(`vote memberId ${id} is not in the roster`);
  const details: LocalMemberDetail[] = input.members.map((m) => {
    const timeline = (timelines.get(m.id) ?? []).sort(byDateDesc);
    return { ...m, counts: { rollcalls: timeline.length }, terms: [{ group: m.group, district: m.district, asOf: m.asOf }], timeline };
  });
  const index: LocalMember[] = details.map(({ timeline: _t, terms: _terms, ...m }) => m);
  const candidates = new Map((input.unmatched ?? []).filter((u) => u.candidates?.length).map((u) => [`${u.nameText}\t${u.group}`, u.candidates!]));
  const unmatchedList = [...unmatched.values()]
    .map((u) => {
      const c = candidates.get(`${u.nameText}\t${u.group}`);
      return { ...u, rollCallIds: [...u.rollCallIds].sort(cmp), ...(c ? { candidates: c } : {}) };
    })
    .sort((a, b) => cmp(a.nameText, b.nameText) || cmp(a.group, b.group));
  // 会期一覧（sessions.json）: date はその会期の最終議決日（rollcalls から）。表決の無い会期は書けない（date を推定しない）
  const sessions: AssemblySession[] = input.sessions
    .map((s) => {
      const dates = rollCalls.filter((rc) => rc.sessionId === s.sessionId).map((rc) => rc.date);
      if (dates.length === 0) throw new Error(`session ${s.sessionId} (${s.sessionLabel}) has no roll calls; cannot determine its last vote date`);
      return { id: s.sessionId, label: s.sessionLabel, date: dates.reduce((a, b) => (a > b ? a : b)), rollcalls: s.rollcalls, sourceUrl: s.sourceUrl, fetchedAt: input.fetchedAt };
    })
    .sort((a, b) => cmp(b.date, a.date) || cmp(b.id, a.id));
  const meta: LocalAssemblyMeta = {
    assemblyId: input.assembly.id,
    fetchedAt: input.fetchedAt,
    sources: input.sources,
    rosterAsOf: input.rosterAsOf,
    sessions: input.sessions,
    counts: { members: index.length, rollcalls: rollCalls.length, cells, unknownCells, unmatchedNames: unmatchedList.length },
  };
  return { assembly: input.assembly, index, details, sessions, rollCallIndex: rollCalls.map(({ votes: _v, ...s }) => s), rollCalls, unmatched: unmatchedList, meta };
}

/** `assemblies/index.json` を読む（無ければ []）。 */
async function readAssemblies(dir: string): Promise<Assembly[]> {
  try { return JSON.parse(await readFile(join(dir, "assemblies", "index.json"), "utf8")) as Assembly[]; } catch { return []; }
}

/** `members/index.json` を読む（無ければ []）。国会の行と地方の行が混ざる。 */
export async function readMemberIndex(dir: string): Promise<(MemberSummary | LocalMember)[]> {
  try { return JSON.parse(await readFile(join(dir, "members", "index.json"), "utf8")) as (MemberSummary | LocalMember)[]; } catch { return []; }
}

/** 国会の 2 行の後に地方議会の行を id 順で並べる（国会の日次 ETL と地方 ETL のどちらが書いても同じ並び）。 */
export function mergeAssemblies(national: Assembly[], local: Assembly[]): Assembly[] {
  const locals = new Map<string, Assembly>();
  for (const a of local) if (a.kind !== "national") locals.set(a.id, a);
  return [...national.filter((a) => a.kind === "national"), ...[...locals.values()].sort((a, b) => cmp(a.id, b.id))];
}

/**
 * `members/index.json` の並び: 国会の行（日次 ETL の順のまま）→ 地方議員の行（assemblyId 順 → id 順）。
 * 地方の行が無ければ国会の行だけ（byte-identical）。
 */
export function mergeMemberIndex(national: readonly (MemberSummary | LocalMember)[], local: readonly (MemberSummary | LocalMember)[]): (MemberSummary | LocalMember)[] {
  const locals = new Map<string, MemberSummary | LocalMember>();
  for (const m of local) if (!isDietMemberRow(m)) locals.set(m.id, m);
  return [...national.filter(isDietMemberRow), ...[...locals.values()].sort((a, b) => cmp(a.assemblyId, b.assemblyId) || cmp(a.id, b.id))];
}

/**
 * 書き込み先は data/assemblies/{assemblyId}/ と、members/ のうち自分の議会の議員。assemblies/index.json・members/index.json は自分の行を入れ替える。
 * index.json にまだ国会の 2 行が無ければ（#156 以降の日次 ETL が一度も走っていない）`national` で補う（Web が国会の議員を引けなくならないように）。
 */
export async function writeLocalAssembly(dir: string, ds: LocalAssemblyDataset, opts: { national?: Assembly[] } = {}): Promise<void> {
  if (!/^(pref|city)-[0-9]+$/.test(ds.assembly.id)) throw new Error(`refusing to write assembly id ${ds.assembly.id}`);
  const base = join(dir, "assemblies", ds.assembly.id);
  await rm(base, { recursive: true, force: true });
  const put = async (file: string, value: unknown) => {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, stableJson(value));
  };
  await put(join(base, "sessions.json"), ds.sessions);
  await put(join(base, "rollcalls", "index.json"), ds.rollCallIndex);
  for (const rc of ds.rollCalls) await put(join(base, "rollcalls", rc.sessionId, `${rc.id}.json`), rc);
  await put(join(base, "unmatched.json"), ds.unmatched);
  await put(join(base, "meta.json"), ds.meta);

  // members/: 自分の議会の古い行（名簿から消えた人の detail ファイル）を消し、国会と他の議会の行は触らない
  const existingMembers = await readMemberIndex(dir);
  const keep = new Set(ds.index.map((m) => m.id));
  for (const m of existingMembers) {
    if (m.assemblyId === ds.assembly.id && !keep.has(m.id)) await rm(join(dir, "members", `${m.id}.json`), { force: true });
  }
  const others = existingMembers.filter((m) => m.assemblyId !== ds.assembly.id);
  await put(join(dir, "members", "index.json"), mergeMemberIndex(others, [...others, ...ds.index]));
  for (const d of ds.details) await put(join(dir, "members", `${d.id}.json`), d);

  const existing = await readAssemblies(dir);
  const national = existing.some((a) => a.kind === "national") ? existing : [...(opts.national ?? []), ...existing];
  const merged = mergeAssemblies(national, [...existing.filter((a) => a.id !== ds.assembly.id), ds.assembly]);
  await put(join(dir, "assemblies", "index.json"), merged);
}

/* ---------- 不変条件 ---------- */

const VOTE_VALUES = new Set(["賛成", "反対", "投票なし"]);
const LOCAL_MEMBER_ID = /^p_(0[1-9]|[1-3]\d|4[0-7])_[A-Za-z0-9_-]+$/;

const safeHost = (url: string): string | undefined => { try { return new URL(url).host; } catch { return undefined; } };

/**
 * 地方議会のデータの不変条件（docs/DATA_CONTRACT.md「地方議会」）。assemblies/index.json の prefectural / municipal の行ごとに検査する。
 * data/assemblies/{id}/ が無い議会は、members/index.json にその議会の行が無ければ違反にしない（その議会の ETL がまだ走っていないだけ）。
 */
export async function validateLocalAssemblies(dir: string): Promise<string[]> {
  const v: string[] = [];
  const assemblies = await readAssemblies(dir);
  const allMembers = await readMemberIndex(dir);
  const localIds = new Set(assemblies.filter((a) => a.kind !== "national").map((a) => a.id));
  for (const m of allMembers) {
    if (!isDietMemberRow(m) && !localIds.has(m.assemblyId)) v.push(`members/index.json ${m.id}: assemblyId ${m.assemblyId} not in assemblies/index.json (地方議会の行が無い)`);
  }
  for (const a of assemblies) {
    if (a.kind === "national") continue;
    const base = join(dir, "assemblies", a.id);
    const index = allMembers.filter((m) => m.assemblyId === a.id) as LocalMember[];
    try { await readdir(base); } catch {
      if (index.length) v.push(`assemblies/${a.id}/: missing but members/index.json has ${index.length} rows of ${a.id}`);
      continue;
    }
    const host = safeHost(a.sourceUrl);
    if (!host) { v.push(`assemblies/index.json ${a.id}: sourceUrl invalid`); continue; }
    const read = async <T,>(rel: string): Promise<T | undefined> => {
      let text: string;
      try { text = await readFile(join(dir, rel), "utf-8"); } catch { v.push(`${rel}: missing`); return undefined; }
      let value: T;
      try { value = JSON.parse(text) as T; } catch { v.push(`${rel}: not JSON`); return undefined; }
      if (text !== stableJson(value)) v.push(`${rel}: not in stableJson form (sorted keys, indent 1, trailing newline)`);
      return value;
    };
    const checkSource = (label: string, rec: { sourceUrl?: unknown }) => {
      const h = typeof rec.sourceUrl === "string" ? safeHost(rec.sourceUrl) : undefined;
      if (!h || !/^https:\/\//.test(String(rec.sourceUrl))) v.push(`${label}: sourceUrl missing or not https (${String(rec.sourceUrl)})`);
      else if (h !== host) v.push(`${label}: sourceUrl host not allowed for ${a.id}: ${h} (expected ${host})`);
    };
    const meta = await read<LocalAssemblyMeta>(`assemblies/${a.id}/meta.json`);
    if (meta) {
      if (meta.assemblyId !== a.id) v.push(`assemblies/${a.id}/meta.json: assemblyId ${meta.assemblyId} !== ${a.id}`);
      if (typeof meta.fetchedAt !== "string" || typeof meta.rosterAsOf !== "string" || !Array.isArray(meta.sessions)) v.push(`assemblies/${a.id}/meta.json: fetchedAt / rosterAsOf / sessions required`);
    }
    const memberIds = new Set<string>();
    const voteCounts = new Map<string, number>();
    for (const m of index) {
      const label = `members/index.json ${m.id}`;
      if (memberIds.has(m.id)) v.push(`${label}: duplicate id`);
      memberIds.add(m.id);
      if (!LOCAL_MEMBER_ID.test(m.id) || (a.prefCode && !m.id.startsWith(`p_${a.prefCode}_`))) v.push(`${label}: id must be p_{prefCode}_…`);
      if ("house" in m) v.push(`${label}: local member row must not carry house (国会の院)`);
      if (typeof m.name !== "string" || m.name === "") v.push(`${label}: name required`);
      if (typeof m.kana !== "string" || typeof m.group !== "string" || typeof m.district !== "string") v.push(`${label}: kana / group / district required`);
      if (typeof m.current !== "boolean") v.push(`${label}: current must be boolean`);
      if (typeof m.asOf !== "string" || !ISO_DATE.test(m.asOf)) v.push(`${label}: asOf must be ISO date`);
      checkSource(label, m);
      checkSource(`${label} profileUrl`, { sourceUrl: m.profileUrl });
      const rel = `members/${m.id}.json`;
      const d = await read<LocalMemberDetail>(rel);
      if (!d) continue;
      if (d.id !== m.id) v.push(`${rel}: id ${d.id} !== ${m.id}`);
      if (d.assemblyId !== a.id) v.push(`${rel}: assemblyId ${String(d.assemblyId)} !== ${a.id}`);
      if ("house" in d) v.push(`${rel}: local member must not carry house`);
      if (!Array.isArray(d.terms) || d.terms.length === 0 || d.terms.some((t) => typeof t.group !== "string" || typeof t.district !== "string" || !ISO_DATE.test(String(t.asOf)))) v.push(`${rel}: terms[] of { group, district, asOf } required`);
      if (!Array.isArray(d.timeline)) { v.push(`${rel}: timeline required`); continue; }
      let votes = 0;
      for (let i = 0; i < d.timeline.length; i++) {
        const e = d.timeline[i];
        if (e.kind !== "localVote") { v.push(`${rel} timeline[${i}]: kind must be localVote`); continue; }
        votes++;
        checkSource(`${rel} timeline[${i}]`, e);
        checkLocalVote(v, `${rel} timeline[${i}]`, e.vote);
        if (typeof e.sessionLabel !== "string" || e.sessionLabel === "") v.push(`${rel} timeline[${i}]: sessionLabel required`);
        if (typeof e.rollCallId !== "string" || typeof e.title !== "string" || !ISO_DATE.test(String(e.date))) v.push(`${rel} timeline[${i}]: rollCallId / title / date required`);
        if (i > 0 && d.timeline[i - 1].date < e.date) v.push(`${rel}: timeline not in descending date order at [${i}]`);
      }
      voteCounts.set(m.id, votes);
      if (m.counts?.rollcalls !== votes) v.push(`${label}: counts.rollcalls ${String(m.counts?.rollcalls)} !== timeline votes ${votes}`);
      if (d.counts?.rollcalls !== votes) v.push(`${rel}: counts.rollcalls ${String(d.counts?.rollcalls)} !== timeline votes ${votes}`);
    }
    const unmatched = (await read<LocalUnmatchedName[]>(`assemblies/${a.id}/unmatched.json`)) ?? [];
    const unmatchedKeys = new Set<string>();
    for (const u of unmatched) {
      for (const id of u.rollCallIds) unmatchedKeys.add(`${id}\t${u.nameText}`);
      // 候補（同姓が 2 人以上）は名簿の id を指す。空の配列は書かない（無ければ省略）
      if ("candidates" in u) {
        if (!Array.isArray(u.candidates) || u.candidates.length === 0) v.push(`assemblies/${a.id}/unmatched.json ${u.nameText}: candidates must be a non-empty array when present`);
        else for (const c of u.candidates) if (!memberIds.has(c.id) || typeof c.name !== "string" || c.name === "") v.push(`assemblies/${a.id}/unmatched.json ${u.nameText}: candidate ${String(c.id)} not in members/index.json`);
      }
    }
    const summaries = (await read<LocalRollCallSummary[]>(`assemblies/${a.id}/rollcalls/index.json`)) ?? [];
    const seenVotes = new Map<string, number>();
    const perSession = new Map<string, { rollcalls: number; last: string }>();
    let cells = 0;
    let unknownCells = 0;
    for (let i = 0; i < summaries.length; i++) {
      const s = summaries[i];
      const label = `assemblies/${a.id}/rollcalls/index.json[${i}]`;
      checkSource(label, s);
      if ("votes" in s) v.push(`${label}: index row must not carry votes`);
      if (i > 0 && summaries[i - 1].date < s.date) v.push(`assemblies/${a.id}/rollcalls/index.json: not in descending date order at [${i}]`);
      const ps = perSession.get(s.sessionId) ?? { rollcalls: 0, last: "" };
      ps.rollcalls++;
      if (s.date > ps.last) ps.last = s.date;
      perSession.set(s.sessionId, ps);
      const rel = `assemblies/${a.id}/rollcalls/${s.sessionId}/${s.id}.json`;
      const rc = await read<LocalRollCall>(rel);
      if (!rc) continue;
      if (rc.id !== s.id || rc.assemblyId !== a.id) v.push(`${rel}: id/assemblyId mismatch`);
      if (!ISO_DATE.test(rc.date)) v.push(`${rel}: date must be ISO`);
      if (typeof rc.kind !== "string" || rc.kind === "" || typeof rc.title !== "string" || rc.title === "") v.push(`${rel}: kind / title required`);
      // method は PDF に表決方法の欄がある議会（宮城）だけ。あれば raw と legend（空でない）を持つ
      if (rc.method !== undefined && (typeof rc.method.raw !== "string" || typeof rc.method.legend !== "string" || rc.method.legend === "")) v.push(`${rel}: method.raw / method.legend required when method is present`);
      if (rc.committeeResult !== undefined && typeof rc.committeeResult !== "string") v.push(`${rel}: committeeResult must be a string`);
      if (typeof rc.result !== "string" || rc.result === "") v.push(`${rel}: result required`);
      // counts はその欄がある PDF（宮城・鳥取・島根）だけ。あれば yes / no は数値、present（宮城）・voting（宮城・鳥取）は公表する議会だけ
      if (rc.counts !== undefined && ([rc.counts.yes, rc.counts.no].some((n) => typeof n !== "number") || ("present" in rc.counts && typeof rc.counts.present !== "number") || ("voting" in rc.counts && typeof rc.counts.voting !== "number"))) v.push(`${rel}: counts.yes / no must be numbers (counts, present and voting optional)`);
      // referredCommittees は付託委員会の欄がある議会（島根）だけ。あれば空でない文字列の空でない配列
      if ("referredCommittees" in rc && (!Array.isArray(rc.referredCommittees) || rc.referredCommittees.length === 0 || rc.referredCommittees.some((c) => typeof c !== "string" || c === ""))) v.push(`${rel}: referredCommittees must be a non-empty array of non-empty strings when present`);
      if ("voteSubject" in rc && (typeof rc.voteSubject !== "string" || rc.voteSubject === "")) v.push(`${rel}: voteSubject must be a non-empty string when present`);
      if ("committeeReport" in rc && (typeof rc.committeeReport !== "string" || rc.committeeReport === "")) v.push(`${rel}: committeeReport must be a non-empty string when present`);
      checkSource(rel, rc);
      if (!Array.isArray(rc.votes)) { v.push(`${rel}: votes required`); continue; }
      for (const vote of rc.votes) {
        cells++;
        checkLocalVote(v, `${rel} (${vote.nameText})`, vote.value);
        if (vote.value?.raw === "不明") unknownCells++;
        if (vote.memberId === "") {
          if (!unmatchedKeys.has(`${rc.id}\t${vote.nameText}`)) v.push(`${rel}: "${vote.nameText}" has empty memberId but is not listed in unmatched.json`);
        } else if (!memberIds.has(vote.memberId)) v.push(`${rel}: memberId ${vote.memberId} not in members/index.json`);
        else seenVotes.set(vote.memberId, (seenVotes.get(vote.memberId) ?? 0) + 1);
      }
    }
    for (const [id, n] of voteCounts) if ((seenVotes.get(id) ?? 0) !== n) v.push(`assemblies/${a.id}: member ${id} has ${n} timeline votes but ${seenVotes.get(id) ?? 0} in rollcalls/`);
    // sessions.json（Web の会期一覧）: rollcalls/ と同じ会期・件数・最終議決日
    const sessions = (await read<AssemblySession[]>(`assemblies/${a.id}/sessions.json`)) ?? [];
    const sessionIds = new Set<string>();
    sessions.forEach((s, i) => {
      const label = `assemblies/${a.id}/sessions.json[${i}]`;
      if (typeof s.id !== "string" || s.id === "" || sessionIds.has(s.id)) v.push(`${label}: id must be non-empty and unique`);
      sessionIds.add(s.id);
      if (typeof s.label !== "string" || s.label === "") v.push(`${label}: label required`);
      if (!ISO_DATE.test(String(s.date))) v.push(`${label}: date must be ISO`);
      if (typeof s.fetchedAt !== "string" || Number.isNaN(Date.parse(s.fetchedAt))) v.push(`${label}: fetchedAt must be ISO datetime`);
      checkSource(label, s);
      if (i > 0 && sessions[i - 1].date < s.date) v.push(`assemblies/${a.id}/sessions.json: not in descending date order at [${i}]`);
      const ps = perSession.get(s.id);
      if (!ps) v.push(`${label}: session ${s.id} has no roll calls in rollcalls/index.json`);
      else {
        if (ps.rollcalls !== s.rollcalls) v.push(`${label}: rollcalls ${s.rollcalls} !== ${ps.rollcalls} in rollcalls/index.json`);
        if (ps.last !== s.date) v.push(`${label}: date ${s.date} !== last vote date ${ps.last}`);
      }
    });
    for (const id of perSession.keys()) if (!sessionIds.has(id)) v.push(`assemblies/${a.id}/sessions.json: session ${id} of rollcalls/ is missing`);
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
  if (!value || typeof value.raw !== "string" || value.raw === "") { v.push(`${label}: vote raw required`); return; }
  if (typeof value.legend !== "string" || value.legend === "") v.push(`${label}: vote legend required (raw ${value.raw})`);
  if (value.mapped !== undefined && !VOTE_VALUES.has(value.mapped as string)) v.push(`${label}: vote mapped must be 賛成/反対/投票なし, got ${String(value.mapped)}`);
  if (value.raw === "不明" && value.mapped !== undefined) v.push(`${label}: vote mapped must be omitted for 不明`);
}
