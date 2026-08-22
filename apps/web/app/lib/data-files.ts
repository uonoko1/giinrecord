/**
 * Build-time readers for `data/` (see docs/DATA_CONTRACT.md).
 * Only runs in Node (prerender / build-time loaders); never shipped to the browser.
 * Every reader returns an empty value when the file is absent (ENOENT), so the site
 * still builds before the ETL has produced anything. Any other failure (malformed JSON,
 * permission errors) throws: a broken `data/` must fail the build, not silently drop pages.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DatasetMeta, MemberDetail, MemberSummary, RollCall, RollCallSummary } from "./data-contract";

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

export async function readMeta(dataDir: string): Promise<DatasetMeta | null> {
  return readJson<DatasetMeta>(path.join(dataDir, "meta.json"));
}
