import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bill, BillSummary, Member, MemberDetail, MemberSummary, RollCall, RollCallSummary, TimelineEntry } from "@seiji-kiroku/shared";
import type { CarriedEntry } from "./aggregate.ts";
import { DEFAULT_SESSIONS } from "./dataset.ts";
import { isDietMemberRow, readMemberIndex } from "./local-assemblies.ts";
import { tenureVerified } from "./match-votes.ts";

/**
 * 回次の扱い（Issue #103）。
 * - targets: 今回ネットワークから取得する回次。指定があれば指定だけ、無ければ DEFAULT_SESSIONS（直近 5 回次）。
 * - carried: data/（meta.sessions）に既にあるが今回取得しない回次。前回出力から引き継ぐ（readCarried）。
 * - all: meta.sessions に書く回次（targets ∪ carried）。writeDataset はこの回次の rollcalls/{session}/ を書き直す。
 * 日次 ETL（指定なし）は直近 5 回次しか取得せず、手動で足した第200〜216回は毎日取り直さない。
 * 手動実行 `pnpm etl 200 … 216` では逆に直近回次が carried になり、data/ から消えない。
 */
export interface SessionPlan { targets: number[]; carried: number[]; all: number[] }

export function planSessions(requested: readonly number[], onDisk: readonly number[]): SessionPlan {
  const asc = (a: number, b: number) => a - b;
  const targets = [...new Set(requested.length ? requested : DEFAULT_SESSIONS)].sort(asc);
  const carried = [...new Set(onDisk.filter((s) => !targets.includes(s)))].sort(asc);
  return { targets, carried, all: [...targets, ...carried].sort(asc) };
}

/** 前回出力から引き継ぐもの。 */
export interface Carried {
  /** carried の回次の採決（rollcalls/{session}/*.json）。memberId は空に戻してある（cli が現行名簿で再突合する）。 */
  rollCalls: RollCall[];
  /** 採決 id → 議案情報の審議結果（原文）。rollcalls/index.json の result から戻す（decisionOfResult）。 */
  decisions: Map<string, string>;
  /** 採決 id → 前回出力で memberId が付いていた票の数。再突合の後退（名簿の取り漏れ）を cli が検出する（lostVoteMatches）。 */
  matchedVotes: Map<string, number>;
  /** data/bills/ の全議案。継続審議の議案は提出回次（carried）の下にあっても今回の回次の一覧に載るので、全部を先に入れて取得分で上書きする。 */
  bills: Bill[];
  /** carried の回次の timeline 行のうち、ファイルから作り直せないもの（speech / question / attendance / 参法の bill 行）。 */
  entries: CarriedEntry[];
  /**
   * 回次の引けない行の数（#103 以前の出力の speech / attendance）。引き継げないので cli が警告し、その回次を指定して取り直してもらう。
   * question / 参法 bill 行は id から回次を引いて引き継ぐので、ここには数えない（#235）。
   */
  withoutSession: number;
}

/**
 * timeline の行の回次。`session` があればそれ、無ければ（#103 以前の出力）id の先頭から引く（#235）。
 * 質問主意書（`questionId` = `{回次}-{house}-{番号}`）と参法（`billId` = `{提出回次}-{種別}-{番号}`）は
 * id の先頭が回次なので引ける（DATA_CONTRACT「未突合の置き場所」の sessionOfUnmatched と同じ規約）。
 * 発言（`speechId`）と委員会出席（`meetingId`）は NDL の会議録 id で回次を含まないので引けない（推定しない）。
 */
export function sessionOfEntry(entry: TimelineEntry): number | undefined {
  if (typeof entry.session === "number") return entry.session;
  const id = entry.kind === "question" ? entry.questionId : entry.kind === "bill" ? entry.billId : undefined;
  if (id === undefined) return undefined;
  const head = id.split("-")[0];
  return /^\d+$/.test(head) ? Number(head) : undefined;
}

/**
 * `members/index.json` の1行（国会の MemberSummary と地方議員の行が混ざる）。
 * 地方議員の行は `counts` に rollcalls しか持たないので、国会の種別は省略可として読む。
 */
type CountedMemberRow = { assemblyId?: string; house?: string; counts?: Partial<MemberSummary["counts"]> };

/** 前回出力より減った timeline 行の議会・種別と件数（lostTimelineEntries）。 */
export interface LostEntries {
  /** どの議会の行か（`diet-sangiin` / `diet-shugiin`。assemblyId の無い古い行は `diet-{house}` に寄せる） */
  assemblyId: string;
  kind: "rollcalls" | "bills" | "speeches" | "questions";
  before: number;
  after: number;
}

/**
 * 前回出力（members/index.json）にあった timeline 行が今回の出力で減っていないか（#235）。
 * `writeDataset` は members/ を毎回消して書き直すので、引き継ぎが壊れると出力から黙って消える
 * （2026-08-24: #103 以前の出力の question 行 524 件が carried で落ち、誰も気づかないまま消えた）。
 * 減っていたら cli が出力せずに非0終了する（lostVoteMatches と同じ扱い）。
 * 増える・同じは正常（回次を足した、名寄せが良くなった）。地方議員の行は国会の counts を持たないので数えない。
 *
 * **院ごとに数える**のが要点: 2026-08-24 の事故では衆院の質問 42 件が消えた一方、同じ実行で
 * 参院のバックフィルが 482 → 1374 に増えたため、両院を足した合計では**減っていない**（524 → 1374）。
 * 合計だけを見ると片方の消失を反対側の増加が覆い隠すので、議会（院）ごとに突き合わせる。
 */
export function lostTimelineEntries(previous: readonly CountedMemberRow[], next: readonly CountedMemberRow[]): LostEntries[] {
  const kinds = ["rollcalls", "bills", "speeches", "questions"] as const;
  const totals = (rows: readonly CountedMemberRow[]): Map<string, Map<string, number>> => {
    const out = new Map<string, Map<string, number>>();
    for (const m of rows) {
      if (!isDietMemberRow(m)) continue;
      // assemblyId の無い古い行は house から議会を決める（推定ではなく契約どおりの対応: diet-{house}）
      const assemblyId = m.assemblyId ?? (m.house ? `diet-${m.house}` : "diet-unknown");
      const byKind = out.get(assemblyId) ?? new Map<string, number>();
      for (const kind of kinds) byKind.set(kind, (byKind.get(kind) ?? 0) + (m.counts?.[kind] ?? 0));
      out.set(assemblyId, byKind);
    }
    return out;
  };
  const before = totals(previous);
  const after = totals(next);
  const lost: LostEntries[] = [];
  for (const [assemblyId, byKind] of [...before].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    for (const kind of kinds) {
      const b = byKind.get(kind) ?? 0;
      const a = after.get(assemblyId)?.get(kind) ?? 0;
      if (a < b) lost.push({ assemblyId, kind, before: b, after: a });
    }
  }
  return lost;
}

/** 議会 × 回次 × 種別の件数（lostSessionEntries）。鍵は `{assemblyId}\t{session}\t{kind}`。 */
export type SessionCounts = Map<string, number>;

/** 前回出力より減った timeline 行の議会・回次・種別と件数（lostSessionEntries）。 */
export interface LostSessionEntries {
  assemblyId: string;
  session: number;
  kind: "rollcalls" | "bills" | "speeches" | "questions";
  before: number;
  after: number;
}

/** timeline の kind → counts の種別。stance / attendance は counts を持たないので数えない（契約どおり）。 */
const COUNTED_KIND = { vote: "rollcalls", bill: "bills", speech: "speeches", question: "questions" } as const;

/**
 * `members/{id}.json` の timeline を議会 × 回次 × 種別で数える（#256）。
 * 回次は行の `session`（#103 以降は全行が持つ）だけを見る。`sessionOfEntry` のように id から引くことはしない:
 * 引ける行（question / 参法 bill）と引けない行（speech / attendance）で粒度が混ざると、
 * 「前回は引けたが今回は引けない」といった見かけの減少で偽陽性を出すため。回次の無い行は数えず、
 * 議会 × 種別の合計を見る `lostTimelineEntries` が引き続き覆う。
 */
export function sessionCounts(details: readonly { assemblyId?: string; house?: string; timeline?: readonly TimelineEntry[] }[]): SessionCounts {
  const out: SessionCounts = new Map();
  for (const d of details) {
    if (!isDietMemberRow(d)) continue;
    // assemblyId の無い古い行は house から議会を決める（推定ではなく契約どおりの対応: diet-{house}）
    const assemblyId = d.assemblyId ?? (d.house ? `diet-${d.house}` : "diet-unknown");
    for (const e of d.timeline ?? []) {
      const kind = COUNTED_KIND[e.kind as keyof typeof COUNTED_KIND];
      if (!kind) continue;
      if (typeof e.session !== "number") continue; // #103 以前の行。回次を推定しない
      const key = `${assemblyId}\t${e.session}\t${kind}`;
      out.set(key, (out.get(key) ?? 0) + 1);
    }
  }
  return out;
}

/** 前回出力（`dir/members/`）の timeline を議会 × 回次 × 種別で数える。members/ が無ければ空（初回実行）。 */
export async function readSessionCounts(dir: string): Promise<SessionCounts> {
  const details: MemberDetail[] = [];
  for (const row of (await readMemberIndex(dir)).filter(isDietMemberRow)) {
    const detail = await readJson<MemberDetail | undefined>(join(dir, "members", `${row.id}.json`), undefined);
    if (detail) details.push(detail);
  }
  return sessionCounts(details);
}

/**
 * 前回出力にあった timeline 行が、**議会 × 回次 × 種別**の粒度で今回減っていないか（#256）。
 *
 * `lostTimelineEntries`（#235）は議会 × 種別の合計しか見ないので、同じ院・同じ種別の中の
 * 入れ替わり —「第221回の質問 42 件が消え、第200回のバックフィル 42 件が入った」— は
 * 合計が保たれて素通りする。回次を鍵に加えて、その穴だけを塞ぐ。
 *
 * **保証すること**: ある議会のある回次のある種別の行数が前回より減っていたら止まる。
 * **保証しないこと**（どれも合計が同じ回次・同じ種別に留まるので、この検出では見えない）:
 * - 同じ議会・回次・種別の中で行が別のものに**すり替わる**（第221回の発言 A が消え、別の発言 B が同数入った）。
 *   行の同一性（speechId / questionId 単位）は見ていない。件数だけを見る検算であることを忘れないこと。
 * - 行の**中身**の劣化（date / title / sourceUrl / 紐づけ先議員の入れ替わり）。
 * - 回次を持たない行（#103 以前の出力）の消失。回次を推定せず数えないので、こちらは
 *   `lostTimelineEntries` の合計側だけが覆う。
 *
 * 偽陽性の扱いは `lostTimelineEntries` と同じ: 回次を減らす意図的な再構築は `data/` を消してから実行する
 * （前回出力が無いので引っかからない）。改選で名簿から消えた議員の行が落ちる分は #235 で受け入れた偽陽性と同じ範囲で、
 * 回次を鍵に足しても増えない（同じ行が同じ回次で減るだけ）。
 */
export function lostSessionEntries(previous: SessionCounts, next: readonly { assemblyId?: string; house?: string; timeline?: readonly TimelineEntry[] }[]): LostSessionEntries[] {
  const after = sessionCounts(next);
  const lost: LostSessionEntries[] = [];
  for (const [key, before] of previous) {
    const a = after.get(key) ?? 0;
    if (a >= before) continue;
    const [assemblyId, session, kind] = key.split("\t");
    lost.push({ assemblyId, session: Number(session), kind: kind as LostSessionEntries["kind"], before, after: a });
  }
  return lost.sort((x, y) => (x.assemblyId < y.assemblyId ? -1 : x.assemblyId > y.assemblyId ? 1 : 0) || x.session - y.session || (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0));
}

/** summarizeRollCall の逆: 「可決（賛成 N・反対 N）」→「可決」。得票だけの result からは何も戻さない（推定しない）。 */
export function decisionOfResult(result: string): string | undefined {
  return result.match(/^(.+?)（賛成 \d+・反対 \d+）$/)?.[1];
}

/** 参院 議案情報の議案ページ（timeline の参法 bill 行の出典）。衆院の bill 行（経過ページ）は bills/ から作り直すので引き継がない。 */
const SANGIIN_BILL_SOURCE = /^https:\/\/www\.sangiin\.go\.jp\/japanese\/joho1\/kousei\/gian\/\d+\/meisai\//;

export async function readCarried(dir: string, carried: readonly number[]): Promise<Carried> {
  const set = new Set(carried);
  const rollCalls: RollCall[] = [];
  const matchedVotes = new Map<string, number>();
  for (const session of carried) {
    for (const file of await listJson(join(dir, "rollcalls", String(session)))) {
      const rc = JSON.parse(await readFile(file, "utf8")) as RollCall;
      matchedVotes.set(rc.id, rc.votes.filter((v) => v.memberId).length);
      rollCalls.push({ ...rc, votes: rc.votes.map((v) => ({ ...v, memberId: "" })) });
    }
  }
  const decisions = new Map<string, string>();
  for (const s of await readJson<RollCallSummary[]>(join(dir, "rollcalls", "index.json"), [])) {
    const decision = set.has(s.session) ? decisionOfResult(s.result) : undefined;
    if (decision) decisions.set(s.id, decision);
  }
  const bills: Bill[] = [];
  for (const s of await readJson<BillSummary[]>(join(dir, "bills", "index.json"), [])) {
    const bill = await readJson<Bill | undefined>(join(dir, "bills", String(s.session), `${s.id}.json`), undefined);
    if (!bill) throw new Error(`bills/index.json lists ${s.id} but bills/${s.session}/${s.id}.json is missing`);
    bills.push(bill);
  }
  const entries: CarriedEntry[] = [];
  let withoutSession = 0;
  for (const row of (await readMemberIndex(dir)).filter(isDietMemberRow)) {
    const detail = await readJson<MemberDetail | undefined>(join(dir, "members", `${row.id}.json`), undefined);
    for (const entry of detail?.timeline ?? []) {
      if (!isCarriable(entry)) continue;
      // #103 以前の出力は session を持たない。id から引ける行（question / 参法 bill）は引いて引き継ぐ（#235）
      const session = sessionOfEntry(entry);
      if (session === undefined) { withoutSession++; continue; }
      if (set.has(session)) entries.push({ memberId: row.id, entry: { ...entry, session } });
    }
  }
  return { rollCalls, decisions, matchedVotes, bills, entries, withoutSession };
}

/**
 * 引き継いだ採決の再突合（現行名簿）で memberId の付いた票が前回出力（matchedVotes）より減った採決（#103 レビュー）。
 * 名簿は毎回取り直すので、前回紐づいた票は今回も紐づくはず。減るのは名簿の取り漏れ（回次の飛びで
 * rosterSessionsFor が必要な名簿を返さなかった等）の兆候なので、cli は空でなければ出力せずに非0終了する。
 */
export function lostVoteMatches(previous: ReadonlyMap<string, number>, rollCalls: readonly RollCall[]): { id: string; before: number; after: number }[] {
  const lost: { id: string; before: number; after: number }[] = [];
  for (const rc of rollCalls) {
    const before = previous.get(rc.id);
    if (before === undefined) continue;
    const after = rc.votes.filter((v) => v.memberId).length;
    if (after < before) lost.push({ id: rc.id, before, after });
  }
  return lost;
}

/**
 * 取得し直した発言と同じ speechId の引き継ぎ行を落とす（#236）。
 *
 * 衆院の名簿は回次ごとの公開が無く「現在」の 1 回次分しか無い（#71）ので、衆院本会議の発言は名簿が覆う回次
 * （memberSession = max(all)）の分しか名寄せできない。この制約は #73 のときから変わっていない。
 *
 * #103 レビューではこれを「memberSession が targets のときだけ取得する」（shouldFetchShugiinSpeeches）で扱っていた。
 * memberSession が carried になる実行（過去回次だけの手動実行・#219 のバックフィルの chunk）で取得すると、
 * readCarried が引き継ぐ同じ回次の speech 行と重複して同じ speechId が 2 行になるためで、重複を避ける意図は正しい。
 * だが「取得しない」で避けると衆院の発言が丸ごと前回出力頼みになり、引き継ぎが 1 度でも欠ければ
 * （#103 以前の session の無い行、名簿から消えた memberId など）0 に落ちたまま自力では戻らない（#236 の実害）。
 *
 * そこで取得は常に行い、重複は「取得した speechId の引き継ぎ行を落とす」ことで防ぐ。
 * 取得した方が新しい（今の名簿で名寄せし直した）ので、残すのは取得した行。取得が空なら何も落とさない
 * （取り漏れで既に出ている発言を消さない）。
 */
export function dropCarriedSpeeches(carried: readonly CarriedEntry[], fetched: readonly { id: string }[]): CarriedEntry[] {
  const ids = new Set(fetched.map((s) => s.id));
  if (ids.size === 0) return [...carried];
  return carried.filter((c) => !(c.entry.kind === "speech" && ids.has(c.entry.speechId)));
}

function isCarriable(e: TimelineEntry): boolean {
  switch (e.kind) {
    case "speech": case "question": case "attendance": return true;
    case "bill": return SANGIIN_BILL_SOURCE.test(e.sourceUrl);
    default: return false;
  }
}

async function listJson(dir: string): Promise<string[]> {
  try { return (await readdir(dir)).filter((f) => f.endsWith(".json")).sort().map((f) => join(dir, f)); } catch { return []; }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return fallback; }
}

/**
 * 引き継いだ timeline 行のうち、**その時点の在職を今の名簿から確認できる**行だけを残す（#230）。
 *
 * 引き継ぎ（readCarried）は前回出力の `memberId` をそのまま戻すので、採決（rollcalls/ を再突合する）と違って
 * speech / question / attendance / 参法 bill の行は**名寄せをやり直さない**。#230 より前の出力には
 * 在職未確認の氏名一致で付いた行が入っているので、そのまま戻すと厳格化した名寄せの結果と食い違う
 * （取得し直した回次だけが直り、引き継いだ回次は古い紐づけのまま残る）。
 *
 * 落とした行は消えるのではなく、その回次を取り直せば現行の名寄せで作り直される（紐づかなければ unmatched に載る）。
 * 判定は `resolveMember` と同じ `tenureVerified` を使う（1 か所で定義する）。
 */
export function carriedTenureVerified(carried: readonly CarriedEntry[], members: readonly Member[]): CarriedEntry[] {
  const byId = new Map(members.map((m) => [m.id, m]));
  return carried.filter((c) => {
    const member = byId.get(c.memberId);
    if (member === undefined) return false;
    return tenureVerified(member, { session: c.entry.session, date: c.entry.date });
  });
}
