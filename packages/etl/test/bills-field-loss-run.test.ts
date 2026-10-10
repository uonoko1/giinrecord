import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Bill, BillSummary, Member } from "@seiji-kiroku/shared";
import { stableJson } from "../src/json.ts";
import { toBillSummary } from "../src/sources/shugiin-bills.ts";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * # **`cli.ts` が本当に「議案の個票から項目が消えた」で止まるか**（Issue #1266）
 *
 * ## なぜ純粋関数と `data/` の検査だけでは足りないか（**変異を当てて分かった**）
 *
 * `lostBillFields`（`sessions.ts`）の単体テストと、`data/bills/` の存在率を固定する
 * `bills-detail-field-presence.test.ts` は在る。**だが `cli.ts` の歯止めを丸ごと消しても
 * 1 件も落ちなかった**（PO 実測 2026-10-10、この枝の `04742d40`）:
 *
 * ```
 * packages/etl/src/cli.ts:442
 *   - const lost = lostBillFields(carried.bills, dataset.bills);
 *   + const lost = [];
 *
 *   cd packages/etl && pnpm test
 *   → rc=0   ℹ tests 2523 / ℹ pass 2523 / ℹ fail 0     **1 件も落ちない**
 * ```
 *
 * **これは #1206 で `lostDecisions` に起きたのと同じ形で、同じ理由である**
 * （`rollcall-decision-backfill-run.test.ts` の docblock がその穴を実測して塞いだと書いている）。
 *
 *   - **純粋関数のテストは関数だけを見る。** `cli.ts` が呼ぶのをやめても落ちない。
 *   - **`data/` を読む検査（`bills-detail-field-presence.test.ts`）はコミット済みの成果物を読む。**
 *     **`cli.ts` を書き換えても動かない**——動くのは次に ETL を流して `data/` が変わったときで、
 *     **そのときには項目はもう消えている**（止めるための歯止めなのに、止まった後でしか効かない）。
 *
 * **だから「いま走らせた `cli.ts` が止まるか」を見る層が要る。** それがこのファイルである。
 *
 * ## どう測るか（**ネットワークに出ない**）
 *
 * `rollcall-decision-backfill-run.test.ts` と**同じ技**（#901 / #1206）。
 * `cli.ts` は import しただけで取得を始めるのでテストから読み込めない。子プロセスで起動し、
 * `node --import` の `resolve` フックで `cli.ts` からの import だけを stub に向ける。
 * `load` フックで `DATA`（書き出し先）だけソース置換する（`const` なので外から差し替えられない）。
 *
 * **tsx の出力の形には依存しない**（#1206 が CI の Node の patch 違いで 1 回落ちてから直した形）。
 *
 * ## fixture は実データから採る（`fixtures-and-prose-drift-from-reality`）
 *
 * **題材は `215-衆法-1`**（`data/bills/215/215-衆法-1.json` の実物）。
 * **#1218 / #1232 で実際に項目が消えた形そのもの**である:
 *
 * ```
 * 第215回の経過ページ   referral.shugiin（地域活性化・こども政策・デジタル社会形成に関する特別 / 2024-11-28）
 *                       result.shugiin（閉会中審査）・received.shugiin   ← **記録が在る**
 * 第221回の経過ページ   同じ id（215-衆法-1）で、3 欄とも空            ← **後勝ちで前の記録が消えた**
 * ```
 *
 * **一次資料のページ自身が「内容がない箇所は情報が未定」と注記している**ので、
 * **空欄は「取り下げた」ではなく「まだ出ていない」**。だから**消してはいけない**。
 *
 * ## 何を測る 3 本か
 *
 * | | 何を流すか | 何を見るか |
 * |---|---|---|
 * | 1 | **直っている今の `cli.ts`** | `addShugiinBillPage` が重ねるので**項目が残り、歯止めは鳴らない**（rc=0） |
 * | 2 | **重ねる経路だけを壊す**（`breakMerge`） | **歯止めが鳴って `data/` を書かずに非0終了**し、**消えた議案と項目を名指しする** |
 * | 3 | 2 と同じ fixture | **`data/` が上書きされていない**（前回出力の項目がそのまま残る） |
 *
 * **2 本目が無いと、`cli.ts` の `lostBillFields` → `process.exit(1)` を丸ごと消しても落ちない**
 * （上の実測。#1206 の `breakRestore` と同じ役割）。
 * **1 本目が無いと「毎回鳴る」形（偽陽性で日次が止まる）に気づけない。**
 */

/**
 * 前回出力の `215-衆法-1`（**実物から採った。氏名は 1 人に縮めてある**）。
 * **`referral` / `result` / `received` を持っている**＝これが消える側の基点である。
 */
const CARRIED_BILL: Bill = {
  house: "shugiin",
  id: "215-衆法-1",
  kind: "衆法",
  number: 1,
  referral: { shugiin: { committee: "地域活性化・こども政策・デジタル社会形成に関する特別", date: "2024-11-28" } },
  result: { shugiin: "閉会中審査" },
  received: { shugiin: "2024-11-28" },
  session: 215,
  sourceUrl: "https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian/keika/1DDD7AE.htm",
  status: "衆議院で閉会中審査",
  submitterGroups: ["立憲民主党・無所属"],
  submitterNames: ["森田俊和"],
  submitterText: "森田 俊和君外十二名",
  supporterNames: ["青柳陽一郎"],
  title: "行政手続における特定の個人を識別するための番号の利用等に関する法律等の一部を改正する法律の一部を改正する法律案",
};

/**
 * **第221回の一覧に載る、同じ id の経過ページ**（`fetchShugiinBills(221)` が返す形）。
 *
 * **`referral` / `result` / `received` が無い**——**継続審議の最新回次のページは 3 欄とも空である**
 * （実測。ページ自身が「内容がない箇所は情報が未定」と注記している）。
 * **URL も違う**（回次ごとに別ページ）。`addShugiinBillPage` が重ねれば前の記録は残る。
 */
const LATER_PAGE: Bill = {
  house: "shugiin",
  id: CARRIED_BILL.id,
  kind: "衆法",
  number: 1,
  session: 215,
  sourceUrl: "https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian/keika/1E0D1AE.htm",
  status: "衆議院で閉会中審査",
  submitterGroups: ["立憲民主党・無所属"],
  submitterNames: ["森田俊和"],
  submitterText: "森田 俊和君外十二名",
  supporterNames: ["青柳陽一郎"],
  title: CARRIED_BILL.title,
};

/**
 * **名簿は 1 回次分だけ要る**（議案の項目とは無関係だが、**0 件だと `mergeRosters` が
 * "no rosters to merge" で落ちて歯止めに到達しない**）。実物の形（第221回の参院名簿）。
 */
const MEMBER: Member = {
  id: "m_fixture", name: "一 郎", kana: "いち ろう", house: "sangiin", current: true,
  terms: [{ house: "sangiin", group: "自民", district: "東京", from: "", sessionFrom: 215 }],
  sourceUrl: "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm",
};

/** **消える側の項目**（#1218 / #1232 で実際に落ちたもの）。**数は散文に書かず fixture から導く**（#1189）。 */
const VANISHING_FIELDS = ["received", "referral", "result"] as const;

/** 前回出力（`data/`）を一時ディレクトリに作る。`meta.json` の sessions が carried / targets を決める。 */
async function seed(dir: string): Promise<void> {
  const put = async (rel: string, value: unknown) => {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), stableJson(value));
  };
  await put("meta.json", { fetchedAt: "2026-10-01T00:00:00.000Z", sessions: [215, 221], sources: [] });
  // **個票の置き場は id/session から導く**（手で書くと fixture を変えたときに黙ってずれる）
  await put("bills/index.json", [toBillSummary(CARRIED_BILL)] satisfies BillSummary[]);
  await put(`bills/${CARRIED_BILL.session}/${CARRIED_BILL.id}.json`, CARRIED_BILL);
  await put("rollcalls/index.json", []);
  await put("members/index.json", []);
  await put("assemblies/index.json", []);
  await put("unmatched.json", []);
}

interface Stub {
  /** 差し替える `cli.ts` からの import 指定子（`cli.ts` のソースにある相対パスそのまま）。 */
  readonly spec: string;
  /** stub ファイルの中身。`REAL` が原文のモジュールの URL に置き換わる。 */
  readonly source: string;
}

/**
 * **取得する側を全部塞ぐ**（1 本も HTTP に出ない）。
 * **衆院 議案情報だけが中身を返す**: 第221回の一覧に `LATER_PAGE` が 1 件載っている体にする。
 * `addShugiinBillPage` / `mergeShugiinBill` / `matchShugiinBills` は `export * from REAL` で本物が効く
 * （**重ねる規則を模造しない**。模造したらこのテストは何も測っていない）。
 */
function stubs(): Stub[] {
  return [
    { spec: "./sources/shugiin-bills.ts", source: [
      `export * from REAL;`,
      `const PAGES = ${JSON.stringify([LATER_PAGE])};`,
      `export const fetchShugiinBills = async (s) => (s === 221 ? PAGES : []);`,
    ].join("\n") },
    // **名簿は 1 回次分だけ返す**（0 件だと `mergeRosters` が "no rosters to merge" で落ちて、
    // **歯止めに到達する前に非0終了する**——「鳴った」と見分けが付かない。実測で 1 回踏んだ）
    { spec: "./sources/sangiin-members.ts", source: [
      `export * from REAL;`,
      `const MEMBERS = ${JSON.stringify([MEMBER])};`,
      `export const fetchMembers = async (s) => (s === 215 || s === 221 ? MEMBERS : undefined);`,
    ].join("\n") },
    { spec: "./sources/shugiin-members.ts", source: [`export * from REAL;`, `export const fetchShugiinMembers = async () => ({ members: [], asOf: "2026-10-01" });`].join("\n") },
    { spec: "./sources/sangiin-votes.ts", source: [
      `export * from REAL;`,
      `export const listRollCalls = async () => [];`,
      `export const standingVoteNote = () => undefined;`,
    ].join("\n") },
    { spec: "./sources/sangiin-bills.ts", source: [`export * from REAL;`, `export const fetchBills = async () => [];`].join("\n") },
    { spec: "./sources/kokkai-speeches.ts", source: [`export * from REAL;`, `export const fetchSpeeches = async () => [];`].join("\n") },
    { spec: "./sources/shugiin-questions.ts", source: [`export * from REAL;`, `export const fetchShugiinQuestions = async () => [];`].join("\n") },
    { spec: "./sources/sangiin-questions.ts", source: [`export * from REAL;`, `export const fetchSangiinQuestions = async () => [];`].join("\n") },
    { spec: "./sources/kokkai-attendance.ts", source: [`export * from REAL;`, `export const fetchCommitteeAttendance = async () => [];`].join("\n") },
    { spec: "./sources/kokkai-committee.ts", source: [`export * from REAL;`, `export const fetchCommitteeRosters = async () => [];`].join("\n") },
    // **`fetchText` も塞ぐ**（上の差し替えから漏れた経路が 1 本でも在れば HTTP に出る）。
    // **黙ってネットワークに出ることが無い**ように、どの URL も例外にする。
    { spec: "./fetch.ts", source: [
      `export * from REAL;`,
      `export const fetchText = async (u) => { throw new Error("fixture が塞いでいない取得: " + u); };`,
    ].join("\n") },
  ];
}

/**
 * stub ファイルを `work/stubs/` に書き出し、`resolve` / `load` フックのローダを書く。
 *
 * **`breakMerge` が「重ねる経路だけを壊す」fixture である**（#1206 の `breakRestore` と同じ役割）。
 * `addShugiinBillPage` を**後勝ちの `set`** に戻す——**これが #1218 の原因そのもの**で、
 * **`cli.ts` の歯止め（`lostBillFields` → `process.exit(1)`）が鳴るのはこのときだけ**である。
 * **これが無いと歯止めを消す変異が素通りする。**
 *
 * **`cli.ts` が呼ぶ `addShugiinBillPage` だけを差し替える**（`parentURL` で判定するので
 * `mergeShugiinBill` の単体テストは本物を見ている）。
 */
async function writeLoader(work: string, dataDir: string, breakMerge: boolean): Promise<void> {
  const etlSrc = pathToFileURL(join(repo, "packages/etl/src/")).href;
  const stubDir = join(work, "stubs");
  await mkdir(stubDir, { recursive: true });
  const map: [string, string][] = [];
  for (const [i, st] of stubs().entries()) {
    const real = new URL(st.spec.replace(/^\.\//, ""), etlSrc).href;
    const source = breakMerge && st.spec === "./sources/shugiin-bills.ts"
      ? [
        st.source,
        // **後勝ちで潰す**（#1218 の壊れ方）。`previous` を読まないので前の回次の記録が消える。
        `export const addShugiinBillPage = (bills, page) => { const had = bills.has(page.id); bills.set(page.id, page); return had; };`,
      ].join("\n")
      : st.source;
    const file = join(stubDir, `stub${i}.mjs`);
    await writeFile(file, source.replace(/\bREAL\b/g, JSON.stringify(real)) + "\n");
    map.push([real, pathToFileURL(file).href]);
  }
  const cliUrl = pathToFileURL(join(repo, "packages/etl/src/cli.ts")).href;
  const dataUrl = pathToFileURL(join(dataDir, "/")).href;
  await writeFile(join(work, "loader.mjs"), [
    `const MAP = new Map(${JSON.stringify(map)});`,
    `const CLI = ${JSON.stringify(cliUrl)};`,
    `export async function resolve(spec, ctx, next) {`,
    `  const r = await next(spec, ctx);`,
    //   **`cli.ts` からの import だけ**を差し替える（他から読まれた分は本物のまま）
    `  if (ctx.parentURL !== CLI) return r;`,
    `  const to = MAP.get(r.url);`,
    `  return to ? { ...r, url: to, shortCircuit: true } : r;`,
    `}`,
    `export async function load(url, context, next) {`,
    `  const r = await next(url, context);`,
    `  if (url !== CLI) return r;`,
    //   tsx は空白を詰めることがあるので正規表現で当てる
    // （テンプレートリテラルの中なので、ローダに出す `\` は 2 つ書く）
    `  const re = /new URL\\(\\s*"\\.\\.\\/\\.\\.\\/\\.\\.\\/data\\/"\\s*,\\s*import\\.meta\\.url\\s*\\)/;`,
    `  const src = r.source.toString().replace(re, ${JSON.stringify(JSON.stringify(dataUrl))});`,
    `  if (src === r.source.toString()) throw new Error("cli.ts の DATA を差し替えられなかった（書き出し先が実物の data/ のままになる）");`,
    `  return { ...r, source: src };`,
    `}`,
    ``,
  ].join("\n"));
  // **差し替えの表が空でないこと**（空のまま走ると本物の取得が全部走る。#514 / #757 の母数）
  assert.equal(map.length, stubs().length, "差し替えの表の件数が意図と食い違っている");
  // **fixture が本当にこの形で入っていること**（空振りに気づかず測ると結果が全部無意味になる。#514）
  const billStub = await readFile(join(stubDir, "stub0.mjs"), "utf8");
  assert.ok(billStub.includes("fetchShugiinBills"), "差し替えたのは fetchShugiinBills の stub ではない");
  assert.equal(
    billStub.includes("addShugiinBillPage"), breakMerge,
    `重ねる経路の差し替えが breakMerge=${breakMerge} と食い違っている（鳴らない形で測ってしまう）`,
  );
  for (const f of VANISHING_FIELDS) {
    assert.ok(!(f in LATER_PAGE), `後の回次のページに ${f} が在る。それでは「消える」形を測っていない`);
    assert.ok(f in CARRIED_BILL, `前回出力に ${f} が無い。それでは基点が無く、歯止めは原理的に鳴らない`);
  }
}

/**
 * `pnpm etl <sessions>` を、取得なし・一時ディレクトリで走らせて、**書き出された個票**を返す。
 *
 * **非0終了も「結果」である**（歯止めが鳴ったこと自体を測る）。throw させずに終了コードを受け取る。
 * **`data/` を読み直すのは「止めたのに書いていないか」を見るため**で、
 * 止まった実行では**前回出力の個票がそのまま残っているはず**である。
 */
async function etl(sessions: number[], opts: { breakMerge?: boolean } = {}): Promise<{ bill: Bill; log: string; code: number }> {
  const work = await mkdtemp(join(tmpdir(), "giinrecord-1266-"));
  const data = join(work, "data");
  await mkdir(data, { recursive: true });
  await seed(data);
  await writeLoader(work, data, opts.breakMerge ?? false);
  const hook = join(work, "hook.mjs");
  await writeFile(hook, [
    'import { register } from "node:module";',
    `register("./loader.mjs", ${JSON.stringify(pathToFileURL(join(work, "/")).href)});`,
  ].join("\n"));
  let code = 0;
  let out = "";
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ["--import", "tsx", "--import", pathToFileURL(hook).href, join(repo, "packages/etl/src/cli.ts"), ...sessions.map(String)],
      { cwd: join(repo, "packages/etl"), timeout: 180_000, maxBuffer: 32 * 1024 * 1024 },
    );
    out = stdout + stderr;
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    code = typeof e.code === "number" ? e.code : -1;
    out = (e.stdout ?? "") + (e.stderr ?? "");
  }
  // **読めないまま空として返さない**（#1056: 「無い」と「空」を混ぜると検査が偽で緑になる）
  const file = join(data, "bills", String(CARRIED_BILL.session), `${CARRIED_BILL.id}.json`);
  const bill = JSON.parse(await readFile(file, "utf8")) as Bill;
  return { bill, log: out, code };
}

/** 個票が持っている（`billFieldPresent` と同じ数え方の）`VANISHING_FIELDS`。 */
const presentFields = (b: Bill): string[] =>
  VANISHING_FIELDS.filter((f) => {
    const v = b[f];
    return v !== undefined && Object.keys(v as object).length > 0;
  });

test("#1266 継続審議の議案に後の回次の空のページが重なっても、個票の項目は消えない（今の cli.ts。歯止めは鳴らない）", async () => {
  // targets = [221] / carried = [215]。**第221回の一覧に 215-衆法-1 の空のページが載る**＝#1218 の形
  const { bill, log, code } = await etl([221]);
  assert.equal(code, 0, `歯止めが鳴った（偽陽性なら日次 ETL が毎晩止まる）:\n${log.slice(-2000)}`);
  assert.deepEqual(
    presentFields(bill), [...VANISHING_FIELDS],
    `個票から項目が消えた。cli.ts の addShugiinBillPage の重ね方を見る:\n${log.slice(-2000)}`,
  );
  // **重ねたことをログで言っている**こと（黙って通るのと区別する。#1056）
  assert.match(log, /merged 1 additional session pages onto existing bills/, `重ねたことがログに出ていない:\n${log.slice(-2000)}`);
  // 後のページが書いている欄は後を採る（`sourceUrl` は第221回のページ）
  assert.equal(bill.sourceUrl, LATER_PAGE.sourceUrl, "後のページが書いている欄が前の値のままになっている");
});

test("#1266 重ねる経路が壊れたら、歯止めが消えた議案と項目を名指しして data/ を書かずに止まる", async () => {
  const { log, code } = await etl([221], { breakMerge: true });
  assert.equal(code, 1, `項目が消えたのに ETL が 0 で終わった（歯止めが鳴っていない）:\n${log.slice(-3000)}`);
  // **何が消えたかを名指ししていること**（「違反 1 件」だけでは運用者が何も直せない）
  assert.match(log, /bill fields lost since the previous output/, `歯止めのメッセージが出ていない:\n${log.slice(-3000)}`);
  // **母数つきで言っていること**（#757: 「1 件」だけでは全体の何分の 1 か分からない）
  assert.match(log, /: 1 bills of 1\b/, `件数を母数つきで言っていない:\n${log.slice(-3000)}`);
  // **議案 id と消えた項目を名指し**（期待値は fixture から導く。手で書くと fixture を変えたときにずれる。#1189）
  assert.match(
    log,
    new RegExp(`${CARRIED_BILL.id} \\(session ${CARRIED_BILL.session}\\): ${[...VANISHING_FIELDS].join(" ")}`),
    `消えた議案と項目を名指ししていない:\n${log.slice(-3000)}`,
  );
  // **項目ごとの内訳**（どの項目が何件消えたか。運用者が一次資料のどこを見ればよいか分かる）
  for (const f of VANISHING_FIELDS) {
    assert.match(log, new RegExp(`^ {2}${f}: 1 bills$`, "m"), `${f} の内訳が出ていない:\n${log.slice(-3000)}`);
  }
});

test("#1266 止めた実行は data/ を上書きしない（前回出力の項目がそのまま残る）", async () => {
  const { bill, log, code } = await etl([221], { breakMerge: true });
  assert.equal(code, 1, `歯止めが鳴っていない:\n${log.slice(-3000)}`);
  assert.deepEqual(
    presentFields(bill), [...VANISHING_FIELDS],
    `止めたのに個票が上書きされている（壊れた出力を公開しないための停止である）:\n${log.slice(-2000)}`,
  );
  assert.equal(bill.sourceUrl, CARRIED_BILL.sourceUrl, "止めたのに個票が書き換わっている");
});
