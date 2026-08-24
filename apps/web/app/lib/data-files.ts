/**
 * Build-time readers for `data/` (see docs/DATA_CONTRACT.md).
 * Only runs in Node (prerender / build-time loaders); never shipped to the browser.
 * Every reader returns an empty value when the file is absent (ENOENT), so the site
 * still builds before the ETL has produced anything. Any other failure (malformed JSON,
 * permission errors) throws: a broken `data/` must fail the build, not silently drop pages.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Assembly } from "@seiji-kiroku/shared";
import { DIET_ASSEMBLIES, type AssemblySession, type DatasetMeta, type LocalRollCallSubject, type MemberDetail, type MemberSummary, type RollCall, type RollCallSummary } from "./data-contract";

/** `data/` at the repo root; override with SEIJI_DATA_DIR. cwd is apps/web during build. */
export function defaultDataDir(): string {
  return process.env.SEIJI_DATA_DIR ?? path.resolve(process.cwd(), "../../data");
}

async function readJson<T>(file: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(text) as T;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** プリレンダー対象: 一覧 `/members`（データが無くても存在する）と、index.json の全議員ページ。 */
export async function memberPaths(dataDir: string): Promise<string[]> {
  const index = await readJson<MemberSummary[]>(path.join(dataDir, "members", "index.json"));
  return ["/members", ...(index ?? []).map((m) => `/members/${m.id}`)];
}

export async function readMemberDetail(dataDir: string, id: string): Promise<MemberDetail | null> {
  if (!SAFE_ID.test(id)) return null;
  return readJson<MemberDetail>(path.join(dataDir, "members", `${id}.json`));
}

/**
 * `/rollcalls`, one `/rollcalls/{session}` per session (ascending), then every
 * `/rollcalls/{session}/{id}` in index order. Empty when data/ has no roll calls,
 * so the list route (which has a build-time loader) is only prerendered when it can load.
 */
export async function rollCallPaths(dataDir: string): Promise<string[]> {
  const index = await readRollCallIndex(dataDir);
  if (index.length === 0) return [];
  const sessions = [...new Set(index.map((r) => r.session))].sort((a, b) => a - b);
  return [
    "/rollcalls",
    ...sessions.map((s) => `/rollcalls/${s}`),
    ...index.map((r) => `/rollcalls/${r.session}/${r.id}`),
  ];
}

export async function readRollCallIndex(dataDir: string): Promise<RollCallSummary[]> {
  return (await readJson<RollCallSummary[]>(path.join(dataDir, "rollcalls", "index.json"))) ?? [];
}

export async function readRollCall(dataDir: string, session: string, id: string): Promise<RollCall | null> {
  if (!SAFE_ID.test(session) || !SAFE_ID.test(id)) return null;
  return readJson<RollCall>(path.join(dataDir, "rollcalls", session, `${id}.json`));
}

/** `assemblies/index.json`（#156）。無い（古いデータ）なら null */
export async function readAssemblies(dataDir: string): Promise<Assembly[] | null> {
  return readJson<Assembly[]>(path.join(dataDir, "assemblies", "index.json"));
}

/**
 * プリレンダー対象（#158）: 一覧 `/assemblies` と、index.json の全議会 `/assemblies/{id}`。
 * index.json が無い（#156 より前の）データでは国会の2議会（ページ側の fallback と同じ）。
 */
export async function assemblyPaths(dataDir: string): Promise<string[]> {
  const assemblies = (await readAssemblies(dataDir)) ?? DIET_ASSEMBLIES;
  return ["/assemblies", ...assemblies.map((a) => `/assemblies/${a.id}`)];
}

/** `assemblies/{id}/sessions.json`（地方議会の会期一覧、#158）。無ければ null */
export async function readAssemblySessions(dataDir: string, assemblyId: string): Promise<AssemblySession[] | null> {
  if (!SAFE_ID.test(assemblyId)) return null;
  return readJson<AssemblySession[]>(path.join(dataDir, "assemblies", assemblyId, "sessions.json"));
}

/**
 * `assemblies/{id}/rollcalls/index.json`（LocalRollCallSummary[] のうち Web が読む項目、#204）。無ければ null。
 * 議員ページが timeline に `voteSubject` / `committeeReport` を結合するために読む（joinVoteSubjects）。
 */
export async function readLocalRollCallIndex(dataDir: string, assemblyId: string): Promise<LocalRollCallSubject[] | null> {
  if (!SAFE_ID.test(assemblyId)) return null;
  return readJson<LocalRollCallSubject[]>(path.join(dataDir, "assemblies", assemblyId, "rollcalls", "index.json"));
}

export async function readMeta(dataDir: string): Promise<DatasetMeta | null> {
  return readJson<DatasetMeta>(path.join(dataDir, "meta.json"));
}
