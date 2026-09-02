import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stableJson } from "./json.ts";
import type { Unmatched } from "./match-votes.ts";
import type { UnmatchedSpeech } from "./match-speeches.ts";
import type { UnmatchedBillProposer } from "./match-bills.ts";
import type { UnmatchedShugiinBillName } from "./match-shugiin-bills.ts";
import type { UnmatchedQuestionSubmitter } from "./match-questions.ts";
import type { UnmatchedAttendee } from "./match-attendance.ts";
import type { UnmatchedCommitteeMember } from "./match-committee.ts";

/** `unmatched.json` / `unmatched/{session}.json` の1行（名寄せできなかった氏名表記）。 */
export type UnmatchedRow =
  | Unmatched | UnmatchedSpeech | UnmatchedBillProposer | UnmatchedShugiinBillName | UnmatchedQuestionSubmitter | UnmatchedAttendee | UnmatchedCommitteeMember;

/** 回次別に分けた未突合を置くディレクトリ（`data/unmatched/`）。 */
export const UNMATCHED_DIR = "unmatched";

/**
 * 未突合の行から回次を引く（Issue #219）。
 * 票（`rollCallId` = `{回次}-MMDD-vNNN`）・議案の提出者/発議者（`billId` = `{提出回次}-{種別}-{番号}`）・
 * 質問主意書の提出者（`questionId` = `{回次}-{house}-{番号}`）は id の先頭が回次なので引ける。
 * 発言（`speechId`）と委員会出席・委員会の役職（`meetingId`）は NDL の会議録 id（`114215254X00219980114`）で回次を含まないので引けない。
 * 発言は Issue 370 で `session`（発言そのものの回次。会議録 API の値）を行に持たせたが、**分け方は変えない**:
 * `unmatched.json` は Web のビルドがコピーして /coverage が読む唯一のファイルで、
 * ここから発言を回次別ファイルへ移すと /coverage から見えなくなる。件数も小さい（301 行）。
 * 引けない行は捨てず `unmatched.json` に残す（件数が小さく、回次を推定して分けることはしない）。
 */
export function sessionOfUnmatched(row: UnmatchedRow): number | undefined {
  const id = "rollCallId" in row ? row.rollCallId : "billId" in row ? row.billId : "questionId" in row ? row.questionId : undefined;
  if (id === undefined) return undefined;
  const head = id.split("-")[0];
  return /^\d+$/.test(head) ? Number(head) : undefined;
}

/** 回次で引ける行を回次ごとにまとめ、引けない行は rest に残す（1行も落とさない）。 */
export function shardUnmatched(rows: readonly UnmatchedRow[]): { bySession: Map<number, UnmatchedRow[]>; rest: UnmatchedRow[] } {
  const bySession = new Map<number, UnmatchedRow[]>();
  const rest: UnmatchedRow[] = [];
  for (const row of rows) {
    const session = sessionOfUnmatched(row);
    if (session === undefined) rest.push(row);
    else bySession.set(session, [...(bySession.get(session) ?? []), row]);
  }
  return { bySession, rest };
}

/**
 * 未突合を `unmatched/{session}.json`（回次で引ける行）と `unmatched.json`（引けない行）に書く。
 * 第142〜199回は全票が未突合になるので単一ファイルでは百万行規模になる（spike #217 の 5 節）。回次で分けると
 * 1 ファイルは 1 回次ぶん（数百〜数万行）に収まり、バックフィルの差分もその回次のファイルだけになる。
 * 前回実行が書いた回次のファイルは先に消す（未突合が無くなった回次のファイルを残さない）。
 * `unmatched.json` は未突合が 0 件でも空配列で書く（`OPS_DATA_FILES` として Web のビルドがコピーし、運用者と監視が読む）。
 */
export async function writeUnmatched(dir: string, rows: readonly UnmatchedRow[]): Promise<void> {
  const { bySession, rest } = shardUnmatched(rows);
  await rm(join(dir, UNMATCHED_DIR), { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "unmatched.json"), stableJson(rest));
  if (bySession.size === 0) return;
  await mkdir(join(dir, UNMATCHED_DIR), { recursive: true });
  for (const [session, list] of [...bySession].sort((a, b) => a[0] - b[0])) {
    await writeFile(join(dir, UNMATCHED_DIR, `${session}.json`), stableJson(list));
  }
}

/**
 * 書いた未突合を全部読む（`unmatched.json` ＋ `unmatched/*.json`）。
 * `validateDataset` は「空 `memberId` の票が未突合に載っているか」をここで見るので、分割前の出力
 * （回次別ファイルが無く `unmatched.json` に票が入っている）もそのまま読める必要がある。
 * ファイルの置き場所は信用せず、行の中身（`rollCallId` など）だけで突き合わせる。
 */
export async function readUnmatched(dir: string): Promise<UnmatchedRow[]> {
  const out = [...(await readRows(join(dir, "unmatched.json")))];
  let names: string[] = [];
  try {
    names = (await readdir(join(dir, UNMATCHED_DIR))).filter((f) => f.endsWith(".json")).sort();
  } catch { /* 分割ファイルが無い（#219 より前の出力・未突合 0 件） */ }
  for (const name of names) out.push(...(await readRows(join(dir, UNMATCHED_DIR, name))));
  return out;
}

async function readRows(file: string): Promise<UnmatchedRow[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf-8"));
    return Array.isArray(parsed) ? (parsed as UnmatchedRow[]) : [];
  } catch { return []; }
}
