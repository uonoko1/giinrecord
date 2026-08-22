/**
 * Build-time readers for `data/` (see docs/DATA_CONTRACT.md).
 * Only runs in Node (prerender / build-time loaders); never shipped to the browser.
 * Every reader returns an empty value when the file is absent (ENOENT), so the site
 * still builds before the ETL has produced anything. Any other failure (malformed JSON,
 * permission errors) throws: a broken `data/` must fail the build, not silently drop pages.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DatasetMeta, MemberDetail, MemberSummary } from "./data-contract";

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

export async function memberPaths(dataDir: string): Promise<string[]> {
  const index = await readJson<MemberSummary[]>(path.join(dataDir, "members", "index.json"));
  return (index ?? []).map((m) => `/members/${m.id}`);
}

export async function readMemberDetail(dataDir: string, id: string): Promise<MemberDetail | null> {
  if (!SAFE_ID.test(id)) return null;
  return readJson<MemberDetail>(path.join(dataDir, "members", `${id}.json`));
}

export async function readMeta(dataDir: string): Promise<DatasetMeta | null> {
  return readJson<DatasetMeta>(path.join(dataDir, "meta.json"));
}
