import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bill, BillSummary, Member, MemberDetail, MemberSpeeches, MemberSummary, RollCall, RollCallSummary, TimelineEntry } from "@seiji-kiroku/shared";
import { sessionField, type CarriedEntry } from "./aggregate.ts";
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
  /**
   * 採決 id → 前回出力の審議結果（原文）。**回次で絞らない**（#1206）。
   *
   * `decisions` は carried の回次だけなので、**遡り（対象の回次が targets に入る実行）では復元元が空になる**。
   * 判定の語は投票結果ページに無く（#26）参院 議案情報の案件名突合で付けているので、案件名が一致しない採決
   * （209-1128-v010 など）は突合に当たらず、**前回は出ていた語が消える**。実測 2026-10-04 で 380 行のうち 1 件。
   *
   * **語が残っているのは `rollcalls/index.json` だけ**である。個票（`rollcalls/{session}/{id}.json`）は
   * `result` を持たず（実測 40/40 で不在）、参院 議案情報は `data/` に永続化していない（`data/bills/` は衆院の別出典）。
   * 復元元はこの 1 つしか無いので、回次で捨てずに全部読む。使う側は `restoreDecisions`。
   */
  previousDecisions: Map<string, string>;
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
 * **`cabinetRole` は欄そのものが無く、id からも引けない**（#1152。`undefined` を返す）。
 */
export function sessionOfEntry(entry: TimelineEntry): number | undefined {
  const field = sessionField(entry);
  if (field !== undefined) return field;
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
  /** `committeeRoles` は counts に無い種別（#244）。counts を読む lostTimelineEntries では見えず、ここだけが検出経路。 */
  kind: "rollcalls" | "bills" | "speeches" | "questions" | "committeeRoles";
  before: number;
  after: number;
}

/**
 * timeline の kind → 数える種別。stance / attendance は数えない（契約どおり）。
 *
 * `committeeRoles`（#244）だけは `MemberSummary.counts` に**無い**種別。
 * `counts` を増やさないのは #244 の設計判断（出席回数を件数として見せない）だが、
 * `counts` に無い＝`lostTimelineEntries`（index.json の counts を読む）が**構造的に見られない**ということでもある。
 * `sessionCounts` は timeline を直接数えるので、**counts を増やさずに消失検出だけ効かせられる**。
 * ここから外すと committeeRole は「消えても誰も気づかない」種別に戻る（#235 と同型）。
 */
const COUNTED_KIND = { vote: "rollcalls", bill: "bills", speech: "speeches", question: "questions", committeeRole: "committeeRoles" } as const;

/** sessionCounts / lostSessionEntries が数える1議員分。#242 以降、発言は timeline ではなく speeches に入る。 */
export interface CountedDetail { id?: string; assemblyId?: string; house?: string; timeline?: readonly TimelineEntry[]; speeches?: readonly TimelineEntry[] }

/**
 * `members/{id}.json` の timeline と `members/{id}/speeches.json` の発言を議会 × 回次 × 種別で数える（#256 / #242）。
 * 回次は行の `session`（#103 以降は全行が持つ）だけを見る。`sessionOfEntry` のように id から引くことはしない:
 * 引ける行（question / 参法 bill）と引けない行（speech / attendance）で粒度が混ざると、
 * 「前回は引けたが今回は引けない」といった見かけの減少で偽陽性を出すため。回次の無い行は数えず、
 * 議会 × 種別の合計を見る `lostTimelineEntries` が引き続き覆う。
 *
 * `speeches` は #242 で発言が別ファイルになったぶん（`speeches: "speeches"` と同じ種別に数える）。
 * timeline に speech 行がある古い出力（#242 以前）も同じ数え方になるので、
 * **移行の前後で同じ値が出る**（ここがずれると「発言が全部消えた」という偽陽性で ETL が止まる）。
 */
export function sessionCounts(details: readonly CountedDetail[]): SessionCounts {
  const out: SessionCounts = new Map();
  for (const d of details) {
    if (!isDietMemberRow(d)) continue;
    // assemblyId の無い古い行は house から議会を決める（推定ではなく契約どおりの対応: diet-{house}）
    const assemblyId = d.assemblyId ?? (d.house ? `diet-${d.house}` : "diet-unknown");
    for (const e of [...(d.timeline ?? []), ...(d.speeches ?? [])]) {
      const kind = COUNTED_KIND[e.kind as keyof typeof COUNTED_KIND];
      if (!kind) continue;
      const session = sessionField(e);
      if (session === undefined) continue; // #103 以前の行。回次を推定しない
      const key = `${assemblyId}\t${session}\t${kind}`;
      out.set(key, (out.get(key) ?? 0) + 1);
    }
  }
  return out;
}

/**
 * 前回出力（`dir/members/`）の timeline と発言を議会 × 回次 × 種別で数える。members/ が無ければ空（初回実行）。
 * 発言は `members/{id}/speeches.json`（#242）から読む。無ければ timeline 側にある古い出力（#242 以前）を数える。
 */
export async function readSessionCounts(dir: string): Promise<SessionCounts> {
  const details: CountedDetail[] = [];
  for (const row of (await readMemberIndex(dir)).filter(isDietMemberRow)) {
    const detail = await readJson<MemberDetail | undefined>(join(dir, "members", `${row.id}.json`), undefined);
    if (!detail) continue;
    const file = await readJson<MemberSpeeches | undefined>(join(dir, "members", row.id, "speeches.json"), undefined);
    // 新形式があれば timeline 側の speech 行は見ない（両方あるときの二重計上を防ぐ）
    details.push(file ? { ...detail, timeline: detail.timeline.filter((e) => e.kind !== "speech"), speeches: file.speeches ?? [] } : detail);
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
export function lostSessionEntries(previous: SessionCounts, next: readonly CountedDetail[]): LostSessionEntries[] {
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

/**
 * **今回の突合（`matchBillResults`）に、前回出力の判定の語を足す**（Issue #1206）。
 *
 * 判定の語（可決・否決・同意・承認・是認・承諾・修正・除名）は投票結果ページに無い（#26）。
 * 参院 議案情報の審議結果を**案件名の完全一致**で突合して付けているので、案件名が議案名と
 * 一字でも違う採決は当たらない。前回は当たっていた採決が今回当たらなければ、語は消える。
 *
 * **復元の規則（受け入れ条件 2）:**
 * - **今回の突合が勝つ。** `fresh` に在る語は、前回と違っていても上書きしない。
 *   参院 議案情報が訂正されて「可決」→「否決」になった場合に、古い語を残さないため。
 * - **今回何も当たらなかった採決にだけ**、前回の語を戻す。
 * - **今回の出力に無い採決（`rollCalls` に居ない id）の語は持ち込まない。** 消えた採決を索引に復活させない。
 * - **前回も語が無かった採決は語を持たない**（`previous` に `decisionOfResult` が語を返した行しか入っていない）。
 *   人事案件・決議は議案情報に載らないので、これが正常な状態である。推定で語を作らない。
 *
 * **`restored` と `stillMissing` を返すのは、cli が「戻した」と「元から無い」を**
 * **ログで区別して出すため**である（「0 件」と「測れなかった」を混ぜない。#1056）。
 */
export function restoreDecisions(
  fresh: ReadonlyMap<string, string>,
  previous: ReadonlyMap<string, string>,
  rollCalls: readonly { id: string }[],
): { decisions: Map<string, string>; restored: string[]; stillMissing: string[] } {
  const decisions = new Map<string, string>();
  const restored: string[] = [];
  const stillMissing: string[] = [];
  for (const rc of rollCalls) {
    const now = fresh.get(rc.id);
    if (now) { decisions.set(rc.id, now); continue; }
    const before = previous.get(rc.id);
    if (before) { decisions.set(rc.id, before); restored.push(rc.id); continue; }
    stillMissing.push(rc.id);
  }
  return { decisions, restored, stillMissing };
}

/**
 * 前回出力の `rollcalls/index.json`（`lostDecisions` の基点）。無ければ空（初回実行）。
 *
 * `readCarried` の中ではなく別の関数にしてあるのは、**cli が `writeDataset` の直前の検査で使う**ためで、
 * `previousSessionCounts` / `previousIndex`（#235 / #256）と同じ位置づけである。
 */
export async function readRollCallIndex(dir: string): Promise<RollCallSummary[]> {
  return readJson<RollCallSummary[]>(join(dir, "rollcalls", "index.json"), []);
}

/**
 * **判定の語を持っていた採決が、今回の出力で語を失っていないか**（Issue #1206）。
 *
 * **これは「遡りでだけ出る壊れ方」を遡りを流さずに捕まえるための歯止めである。**
 * 遡り（`pnpm etl 200 … 216`）は冷えたキャッシュで 5 時間を超えるので CI では流せない（#1209）。
 * だから**壊れ方そのものを日次の経路に置く**: ETL は毎回この検査を通るので、復元が効かなくなれば
 * （既定 5 回次のどれかで突合が外れた日に）その日の実行が止まる。遡りを待つ必要が無い。
 *
 * **見るのは「語を失ったこと」だけ。**
 * - 語が**別の語に変わった**のは落とさない（議案情報の訂正。事実が変わったなら従う）
 * - 語が**増えた**のは落とさない（突合が広がった）
 * - **採決そのものが今回の出力に無い**のは落とさない。回次を減らす意図的な再構築まで止めてしまうし、
 *   行の消失は `lostSessionEntries`（#256）/ `lostTimelineEntries`（#235）の担当である
 * - **前回出力が無い初回実行**は `previous` が空なので何も言わない
 *
 * **見ないこと**: 語が正しいか（前回の語が誤っていた場合は、今回も同じ誤りが戻る）。
 * ここで守るのは「前回公開していた事実を黙って落とさない」ことだけで、語の正しさは突合側の責任である。
 */
export function lostDecisions(
  previous: readonly RollCallSummary[],
  next: readonly RollCallSummary[],
): { id: string; session: number; before: string; after: string | undefined }[] {
  const after = new Map(next.map((s) => [s.id, s]));
  const lost: { id: string; session: number; before: string; after: string | undefined }[] = [];
  for (const p of previous) {
    const before = decisionOfResult(p.result);
    if (!before) continue;
    const now = after.get(p.id);
    if (!now) continue; // 採決ごと消えた分はここの担当ではない（lostSessionEntries / lostTimelineEntries）
    const a = decisionOfResult(now.result);
    if (a === undefined) lost.push({ id: p.id, session: p.session, before, after: a });
  }
  return lost.sort((x, y) => x.session - y.session || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
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
  const previousDecisions = new Map<string, string>();
  for (const s of await readJson<RollCallSummary[]>(join(dir, "rollcalls", "index.json"), [])) {
    const decision = decisionOfResult(s.result);
    // 語の無い result（得票のみ）からは何も戻さない。「前回も語が無かった」を「可決だった」に化けさせない（#1056）
    if (!decision) continue;
    previousDecisions.set(s.id, decision);
    if (set.has(s.session)) decisions.set(s.id, decision);
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
    // 発言は members/{id}/speeches.json（#242）。
    // #242 以前の出力（初回実行で必ずこの状態になる）は timeline に speech 行があるので、そちらも読む。
    // 両方あるときは speeches.json だけを読む（同じ speechId が 2 行になり validateDataset の duplicate 違反になる）。
    // ここで読み落とすと全議員の発言が 1 回の実行で消える（#235 と同型の事故）ので、旧形式を黙って捨てない。
    const speechFile = await readJson<MemberSpeeches | undefined>(join(dir, "members", row.id, "speeches.json"), undefined);
    const rows: TimelineEntry[] = speechFile
      ? [...(detail?.timeline ?? []).filter((e) => e.kind !== "speech"), ...(speechFile.speeches ?? [])]
      : (detail?.timeline ?? []);
    for (const entry of rows) {
      if (!isCarriable(entry)) continue;
      // #103 以前の出力は session を持たない。id から引ける行（question / 参法 bill）は引いて引き継ぐ（#235）
      const session = sessionOfEntry(entry);
      if (session === undefined) { withoutSession++; continue; }
      if (set.has(session)) entries.push({ memberId: row.id, entry: { ...entry, session } });
    }
  }
  return { rollCalls, decisions, previousDecisions, matchedVotes, bills, entries, withoutSession };
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

/**
 * **取得し直した委員会の役職と同じ行の引き継ぎを落とす（Issue #1190）。`dropCarriedSpeeches` と同じ形。**
 *
 * **なぜ要るか**: `cli.ts` は衆院の委員会名簿を、発言と同じ理由で `memberSession` について**毎回取得する**
 * （衆院名簿は「現在」の 1 回次分しか無いので。#71 / #236）。
 * **`committeeRole` は `isCarriable` でもある**ので、
 * **`memberSession` が carried になる実行——過去回次だけの手動実行（遡り）——では
 * 取得した行と引き継いだ行の両方が timeline に入って二重になる。**
 *
 * **実測 2026-10-04**（#1190 の遡り `pnpm etl 200 … 216` の直後）:
 * **9,417 行のうち 2,047 行が重複**（異なりは 7,370 で `origin/main` と同じ）。
 * **2,047 は ETL のログの `(2047 committeeRole entries matched)` と逐語で一致する**
 * ——**取得した行がまるごと二重になっていた。**
 * **日次実行では発火しない**（`memberSession` は常に target なので carried に入らない）。
 *
 * **行の同一性は `(memberId, session, committee, meetingId)`**
 * ——`packages/etl/test/published-timeline-count.test.ts`（#1175）が本番 `data/` で見ている鍵と**同じもの**にする。
 * **`meetingId` だけでは足りない**: 同じ会議録に複数の委員会・複数の委員が載る。
 *
 * **取得が空なら何も落とさない**（取り漏れで既に出ている役職を消さない。`dropCarriedSpeeches` と同じ判断）。
 *
 * **`attendance` には要らない**: `fetchCommitteeAttendance` は `targets` の回次しか取らないので、
 * **carried の回次とぶつからない。** **ぶつかるのは「carried なのに取得する」種別だけ**である。
 */
export function dropCarriedCommitteeRoles(
  carried: readonly CarriedEntry[],
  fetched: readonly { memberId: string; session: number; committee: string; firstMeetingId: string }[],
): CarriedEntry[] {
  const k = (memberId: string, session: number, committee: string, meetingId: string) =>
    [memberId, session, committee, meetingId].join("\u0000");
  const keys = new Set(fetched.map((f) => k(f.memberId, f.session, f.committee, f.firstMeetingId)));
  if (keys.size === 0) return [...carried];
  return carried.filter((c) =>
    c.entry.kind !== "committeeRole" || !keys.has(k(c.memberId, c.entry.session, c.entry.committee, c.entry.meetingId)));
}

/**
 * 引き継げる行か（前回出力から作り直せない行だけ引き継ぐ）。
 *
 * **新しい種別を timeline に足したら、ここに足すかどうかを必ず判断する。**
 * 足し忘れると回次を絞った実行で `writeDataset` が `members/` を全消しした後に戻らず、黙って消える（#235）。
 * `committeeRole`（#244）は `counts` を持たない種別なので、漏れても `lostSessionEntries` が
 * 気づかない（下の COUNTED_KIND に無い）。**消失検出が空振りする種別ほど、ここに足す必要がある。**
 *
 * vote / stance を引き継がないのは「消しても良い」からではなく、**ファイルから作り直せる**ため:
 * vote は `rollcalls/{session}/` を現行名簿で再突合し、stance は `bills/` の会派態度から組み直す。
 */
function isCarriable(e: TimelineEntry): e is CarriableEntry {
  switch (e.kind) {
    case "speech": case "question": case "attendance": case "committeeRole": return true;
    case "bill": return SANGIIN_BILL_SOURCE.test(e.sourceUrl);
    // **`cabinetRole` は引き継がない**（#1152）。**名簿を毎回取り直す**ので前回出力から戻す必要が無く、
    // **そもそも回次を持たないので `readCarried` の回次の集合に入れようがない。**
    // **引き継いだら、辞任した大臣の役職が「現職」として残り続ける**（#569 の「別人の記録」と同じ型の害）。
    case "cabinetRole": return false;
    default: return false;
  }
}

/**
 * 引き継げる行の型（`isCarriable` が絞る先）。**`session` を必ず持つ種別だけ**である
 * ——`readCarried` は回次で絞って引き継ぐので、回次の無い行は引き継ぎようがない（#1152）。
 */
type CarriableEntry = Exclude<TimelineEntry, { kind: "cabinetRole" }>;

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
    // 引き継ぎ行は必ず回次を持つ（`readCarried` が `session === undefined` の行を落としている）。
    // **`cabinetRole` はそもそも引き継がない**（`isCarriable` が false。名簿を毎回取り直すので。#1152）。
    const session = sessionField(c.entry);
    if (session === undefined) return false;
    return tenureVerified(member, { session, date: c.entry.date });
  });
}
