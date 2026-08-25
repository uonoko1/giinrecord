/**
 * Build-time readers for `data/` (see docs/DATA_CONTRACT.md).
 * Only runs in Node (prerender / build-time loaders); never shipped to the browser.
 * Every reader returns an empty value when the file is absent (ENOENT), so the site
 * still builds before the ETL has produced anything. Any other failure (malformed JSON,
 * permission errors) throws: a broken `data/` must fail the build, not silently drop pages.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Assembly } from "@seiji-kiroku/shared";
import type { ShugiinBillNameStats } from "./coverage";
import { DIET_ASSEMBLIES, type AssemblySession, type DatasetMeta, type LocalRollCallSubject, type MemberDetail, type MemberSpeeches, type MemberSummary, type RollCall, type RollCallSummary } from "./data-contract";

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
 * 発言の**件数だけ**を `members/{id}/speeches.json` から読む（#242）。
 * ビルド時に本文まで読むが、返すのは数だけなのでプリレンダーされる HTML には発言が焼き込まれない
 * （そこが #242 の目的。#263 の実測では HTML は元 JSON の 2.15 倍になる）。
 * ファイルが無ければ 0（契約: ETL は 0 件のファイルを作らない）。
 */
export async function readMemberSpeechCount(dataDir: string, id: string): Promise<number> {
  if (!SAFE_ID.test(id)) return 0;
  const file = await readJson<MemberSpeeches>(path.join(dataDir, "members", id, "speeches.json"));
  return file?.speeches?.length ?? 0;
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

/**
 * 名寄せの正規化。ETL の `normalizeName`（packages/etl/src/match-votes.ts）と同じ規則にそろえる:
 * NFKC・空白（全角含む）の除去・異体字の最小限の吸収。ETL 側の表を増やしたらここも足す
 * （そろっていないと、この画面の「現在の名簿にある数」だけが ETL の紐づけと食い違う）。
 */
const NAME_VARIANTS: Readonly<Record<string, string>> = { 髙: "高", 﨑: "崎", 德: "徳", 濵: "浜", 邊: "辺", 邉: "辺" };

function normalizeName(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\s　]+/g, "")
    .replace(/[髙﨑德濵邊邉]/g, (c) => NAME_VARIANTS[c] ?? c);
}

/** `data/bills/{回次}/{id}.json` のうち、氏名の数え上げに使う項目だけ。 */
type BillNames = {
  house?: string;
  session?: number;
  submitterNames?: string[];
  supporterNames?: string[];
  submitters?: string[];
  supporters?: string[];
};

/**
 * 衆院の議案の提出者・賛成者の氏名を数える（#251）。`bills/index.json` には氏名が無いので、
 * 議案 1 件ずつの `bills/{回次}/{id}.json` を読んで数える（ビルド時。ブラウザには数えた結果だけが渡る）。
 * - `names`: 氏名の延べ数、`linked`: そのうち名簿の議員に紐づいた数（memberId の延べ数）
 * - `sessions`: 回次ごとの異なり氏名の数と、そのうち現在の名簿にある数（空白を除いた氏名の一致で数える）
 * `bills/` が無ければ null（無い事実を作らない）。
 */
export async function readShugiinBillNameStats(dataDir: string): Promise<ShugiinBillNameStats | null> {
  const billsDir = path.join(dataDir, "bills");
  let entries: string[];
  try {
    entries = (await readdir(billsDir, { withFileTypes: true })).filter((e) => e.isDirectory() && SAFE_ID.test(e.name)).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const index = await readJson<MemberSummary[]>(path.join(dataDir, "members", "index.json"));
  const rosterNames = (index ?? []).filter((m) => m.house === "shugiin").map((m) => normalizeName(m.name));
  const roster = new Set(rosterNames);

  let names = 0;
  let linked = 0;
  /** 回次 -> その回次の議案に載る異なり氏名（正規化後） */
  const bySession = new Map<number, Set<string>>();
  for (const dir of entries) {
    const files = (await readdir(path.join(billsDir, dir))).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const bill = await readJson<BillNames>(path.join(billsDir, dir, file));
      if (!bill || bill.house !== "shugiin" || typeof bill.session !== "number") continue;
      const billNames = [...(bill.submitterNames ?? []), ...(bill.supporterNames ?? [])];
      names += billNames.length;
      linked += (bill.submitters?.length ?? 0) + (bill.supporters?.length ?? 0);
      const set = bySession.get(bill.session) ?? new Set<string>();
      for (const n of billNames) set.add(normalizeName(n));
      bySession.set(bill.session, set);
    }
  }

  return {
    names,
    linked,
    sessions: [...bySession.entries()]
      .map(([session, set]) => ({ session, names: set.size, inRoster: [...set].filter((n) => roster.has(n)).length }))
      .sort((a, b) => a.session - b.session),
    rosterMembers: rosterNames.length,
    rosterDuplicateNames: rosterNames.length - roster.size,
  };
}
