import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Member, RollCall, RollCallSummary } from "@seiji-kiroku/shared";
import { stableJson } from "../src/json.ts";
import { decisionOfResult } from "../src/sessions.ts";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * # **`cli.ts` が本当に遡りで判定の語を戻しているか**（Issue #1206）
 *
 * ## なぜ純粋関数のテストだけでは足りないか（**変異を当てて分かった**）
 *
 * **`restoreDecisions` / `lostDecisions` / `readCarried` の単体テストは 11 件あって全部緑だが、
 * `cli.ts` の呼び出しを元の壊れた形に戻しても 1 件も落ちなかった**（実測 2026-10-05）:
 *
 * ```
 * scripts/dev/mutate.sh run --file packages/etl/src/cli.ts \
 *   --from 'carried.previousDecisions, rollCalls);' \
 *   --to   'carried.decisions, carried.rollCalls);'      ← #1206 の原因そのもの
 *   -- node --test （rollcall-decision-restore / -published / sessions / published-data-validate）
 *
 *   → ℹ tests 72 / ℹ pass 72 / ℹ fail 0     **1 件も落ちない**
 * ```
 *
 * **これは「等価変異」ではない**——本番の遡りで 209-1128-v010 の「可決」が実際に消えた形である。
 * **「テストが何も主張していない」形**（`docs/WORKING_AGREEMENT.md` の分類 4）で、
 * **#901 で `local-cli.ts` が同じ理由で素通りしていたのと同型**（`local-cli-sessions.test.ts`）。
 *
 * **`data/` を基点と突き合わせる検査（`rollcall-decision-published.test.ts`）でも捕まらない。**
 * `data/` はリポジトリにコミットされた成果物なので、**`cli.ts` を書き換えても動かない**——
 * **動くのは次に ETL を流したときで、そのときには遅い。**
 *
 * ## どう測るか（**ネットワークに出ない。遡りを流さない**）
 *
 * **`cli.ts` は import しただけで取得を始める**ので、テストから読み込めない。
 * **だから子プロセスで起動し、`node --import` のフックで差し替える**（#901 と同じ技）:
 *
 *   - **取得する側のモジュールを、固定の値を返す別のソースに丸ごと差し替える**（**1 本も HTTP に出ない**）。
 *     **末尾に append する形（#901 がやっている形）は使えない**——`const f__stub = …` を足すと
 *     `Identifier 'f' has already been declared` で落ちる（実測 2026-10-05）。
 *     **だから原文を使わず、`cli.ts` が import する名前だけを持つソースに置き換える。**
 *     **置き換えたソースに名前が足りなければ import が落ちる**ので、
 *     **「差し替えたつもりで原文が動いていた」にはならない**（黙って通る形が無い）。
 *   - **`DATA`（書き出し先）を一時ディレクトリに向ける**
 *
 * **`cli.ts` 自身は 1 行も変えない。**
 *
 * ## fixture が再現する形（**実物の 209-1128-v010 から採る**）
 *
 * ```
 * 前回出力の rollcalls/index.json   209-1128-v010  「可決（賛成 244・反対 0）」
 * meta.json の sessions             [209, 221]
 * 今回の実行                        pnpm etl 209          ← **209 が targets に入る＝遡り**
 * 参院 議案情報（第209回）           案件名が一致しない議案だけ（突合は当たらない）
 * ```
 *
 * **日次の形（`pnpm etl 221`。209 は carried）も同じ fixture で流して、両方で語が残ることを見る。**
 * **直っていなければ遡りの側だけが落ちる**——**それが「遡りでだけ出る壊れ方」の定義である。**
 */

/** 実物（data/rollcalls/209/209-1128-v010.json）から採った形。votes は 1 票に縮めてある。 */
const ROLL_CALL: RollCall = {
  id: "209-1128-v010",
  session: 209,
  date: "2025-11-28",
  title: "日程第１　租税特別措置法及び東日本大震災の被災者等に係る国税関係法律の臨時特例に関する法律の一部を改正する法律案（衆議院提出）",
  totals: { total: 1, yes: 1, no: 0 },
  groups: [{ group: "自民", size: 1, yes: 1, no: 0 }],
  votes: [{ memberId: "", nameText: "一 郎", group: "自民", value: "賛成" }],
  sourceUrl: "https://www.sangiin.go.jp/japanese/touhyoulist/209/209-1128-v010.htm",
};
/** 前回出力の索引。**判定の語を持っている**＝これが唯一の復元元。 */
const SUMMARY: RollCallSummary = {
  id: ROLL_CALL.id, session: ROLL_CALL.session, date: ROLL_CALL.date, title: ROLL_CALL.title,
  totals: ROLL_CALL.totals, result: "可決（賛成 244・反対 0）", sourceUrl: ROLL_CALL.sourceUrl,
};
/**
 * **語を一度も持ったことがない採決**（人事案件。参院 議案情報に載らないので、語が無いのが正常な状態）。
 *
 * **これが無いと `unmatched-bills.json` の検査が恒真になる**: `ROLL_CALL` 1 件だけなら
 * 正しい出力は常に空配列で、**「申告の集合が空か」を見るだけの検査**になってしまう
 * （`[] === []` は「突き合わせた」ではない。#757 の母数の話）。
 * **語を持たない採決が 1 件在ることで、「空でない集合が逐語で一致するか」を測れる。**
 *
 * **実物から採っている**（`fixtures-and-prose-drift-from-reality`）。
 * **第209回には語を持たない採決が実際に 9 件在り、全部この「国家公務員等の任命に関する件」である**
 * （実測 2026-10-07: `data/rollcalls/index.json` の 380 行のうち語を持たない 32 行の回次分布は
 * `{200:2, 201:2, 209:9, 214:1, 217:10, 219:3, 221:5}`）。**その 1 件をそのまま使う**
 * （`id` / `title` / `sourceUrl` / `result` は `data/` の値そのもの。`totals` と `votes` だけ 1 票に縮めてある）。
 *
 * **前回出力の索引にも、語を持たない形で入れる**（票数だけ）——`lostDecisions` の基点として
 * 「元から語が無い行」を持たせ、歯止めが誤って鳴らないことも同時に押さえる。
 */
const NO_WORD_ROLL_CALL: RollCall = {
  id: "209-1128-v009",
  session: 209,
  date: "2025-11-28",
  title: "国家公務員等の任命に関する件「公害健康被害補償不服審査会委員（星景子君）」",
  totals: { total: 1, yes: 1, no: 0 },
  groups: [{ group: "自民", size: 1, yes: 1, no: 0 }],
  votes: [{ memberId: "", nameText: "一 郎", group: "自民", value: "賛成" }],
  sourceUrl: "https://www.sangiin.go.jp/japanese/touhyoulist/209/209-1128-v009.htm",
};
/** 前回出力の索引。**語を持たない**（`data/` の実物も `"賛成 238・反対 6"` で語が無い）。 */
const NO_WORD_SUMMARY: RollCallSummary = {
  id: NO_WORD_ROLL_CALL.id, session: NO_WORD_ROLL_CALL.session, date: NO_WORD_ROLL_CALL.date,
  title: NO_WORD_ROLL_CALL.title, totals: NO_WORD_ROLL_CALL.totals,
  result: "賛成 1・反対 0", sourceUrl: NO_WORD_ROLL_CALL.sourceUrl,
};
const MEMBER: Member = {
  id: "m_fixture", name: "一 郎", kana: "いち ろう", house: "sangiin", current: true,
  terms: [{ house: "sangiin", group: "自民", district: "東京", from: "", sessionFrom: 209 }],
  sourceUrl: "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm",
};

/** 前回出力（`data/`）を一時ディレクトリに作る。`meta.json` の sessions が carried / targets を決める。 */
async function seed(dir: string): Promise<void> {
  const put = async (rel: string, value: unknown) => {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), stableJson(value));
  };
  await put("meta.json", { fetchedAt: "2026-10-01T00:00:00.000Z", sessions: [209, 221], sources: [] });
  await put("rollcalls/index.json", [SUMMARY, NO_WORD_SUMMARY]);
  // 個票の置き場は id から導く（手で書くと fixture の id を変えたときに黙ってずれる）
  for (const rc of [ROLL_CALL, NO_WORD_ROLL_CALL]) await put(`rollcalls/${rc.session}/${rc.id}.json`, rc);
  await put("bills/index.json", []);
  await put("members/index.json", []);
  await put("assemblies/index.json", []);
  await put("unmatched.json", []);
}

/**
 * **参院 議案情報の fixture**（`fetchBills` が返す 1 件）。
 * - `NO_MATCH`: 案件名が一致しない＝**突合が当たらない**。209-1128-v010 の実際の形。
 * - `MATCHES`: 案件名が一致する＝**突合が当たる**。前回の語と違う審議結果を入れて、どちらが勝つか見る。
 */
const NO_MATCH = { title: "まったく別の法律案", decision: "可決" } as const;
const MATCHES = { title: "租税特別措置法及び東日本大震災の被災者等に係る国税関係法律の臨時特例に関する法律の一部を改正する法律案", decision: "否決" } as const;

/**
 * **`cli.ts` が import する先を差し替える。**
 *
 * ## tsx の出力の形に依存しない（**CI で 1 回落ちてから直した**）
 *
 * **最初は `load` フックで、tsx が変換した後のソースを書き換えていた**
 * （`export{a,b,c};` の 1 語を `NAME__stub as NAME` にする）。
 * **手元（Node 24.10.0）では通ったが、CI（Node 24.21.0）で落ちた**——
 * `export{…}` の行が無く、`__export(exports, {...})` 系の別の形だった。
 *
 * **`.nvmrc` は major しか固定しないので、patch は勝手に上がる。**
 * **「いまの tsx がこう出す」に依存した検査は、いつ落ちてもおかしくない。**
 *
 * **だから `resolve` フックで差し替える**: `cli.ts` からの import だけを、
 * **実ファイルとして書き出した stub** に向ける。stub は原文を `export *` で読み直し、
 * 差し替えたい名前だけを自分で export する。**変換後のソースを一切見ない。**
 *
 * `cli.ts` 以外からの import（`sangiin-bills.ts` を `match-bills.ts` が読むなど）は差し替えない——
 * **`parentURL` で判定する**ので、純粋関数（`matchBillResults` など）は本物が効く。
 */
interface Stub {
  /** 差し替える `cli.ts` からの import 指定子（`cli.ts` のソースにある相対パスそのまま）。 */
  readonly spec: string;
  /** stub ファイルの中身。`REAL` が原文のモジュールの URL に置き換わる。 */
  readonly source: string;
}

function stubsFor(bill: { title: string; decision: string }): Stub[] {
  return [
    { spec: "./sources/sangiin-members.ts", source: [
      `export * from REAL;`,
      `export const fetchMembers = async (s) => (s === 209 || s === 221 ? ${JSON.stringify([MEMBER])} : undefined);`,
    ].join("\n") },
    { spec: "./sources/shugiin-members.ts", source: [
      `export * from REAL;`,
      `export const fetchShugiinMembers = async () => ({ members: [], asOf: "2026-10-01" });`,
    ].join("\n") },
    // **投票結果ページは「取り直せる」**ようにする——**これが遡りの本質である。**
    // 遡りでは対象の回次の採決がネットワークから取り直され、`carried` に入らない。
    // 一覧を空にすると採決そのものが消えて別の壊れ方になるので、取り直した体にする。
    // **判定の語は投票結果ページに無い**（#26）ので、取り直した採決に語は付かない——
    // **語は前回出力から戻すしかない。**
    // **2 件返す**: 語を復元する採決（`ROLL_CALL`）と、語を一度も持たない採決（`NO_WORD_ROLL_CALL`）。
    // `parseRollCall` は第 2 引数の sourceUrl でどちらかを返す（`cli.ts` が item.href を渡す）。
    { spec: "./sources/sangiin-votes.ts", source: [
      `export * from REAL;`,
      `const PAGES = ${JSON.stringify([ROLL_CALL, NO_WORD_ROLL_CALL])};`,
      `export const listRollCalls = async (s) => (s === 209 ? PAGES.map((rc) => ({ href: rc.sourceUrl, title: rc.title })) : []);`,
      `export const parseRollCall = (_html, sourceUrl) => {`,
      `  const rc = PAGES.find((p) => p.sourceUrl === sourceUrl);`,
      `  if (!rc) throw new Error("fixture に無い投票結果ページ: " + sourceUrl);`,
      `  return rc;`,
      `};`,
      `export const standingVoteNote = () => undefined;`,
    ].join("\n") },
    // **参院 議案情報は「取れたが案件名が一致しない」状態にする**——これが 209-1128-v010 の実際の形。
    // 空配列ではなく議案を 1 件返すので、「取得に失敗した」とは区別できる（#1056）。
    // `matchBillResults` / `toBillDecisions` は `export * from REAL` でそのまま効く（突合を模造しない）。
    { spec: "./sources/sangiin-bills.ts", source: [
      `export * from REAL;`,
      `export const fetchBills = async () => [{ id: "209-閣法-1", session: 209, kind: "閣法", house: "sangiin", title: ${JSON.stringify(bill.title)}, submitterText: "内閣", plenary: [{ decision: ${JSON.stringify(bill.decision)}, date: "2025-11-28" }], sourceUrl: "https://www.sangiin.go.jp/japanese/joho1/kousei/gian/209/meisai/m209080209001.htm" }];`,
    ].join("\n") },
    { spec: "./sources/kokkai-speeches.ts", source: [`export * from REAL;`, `export const fetchSpeeches = async () => [];`].join("\n") },
    { spec: "./sources/shugiin-bills.ts", source: [`export * from REAL;`, `export const fetchShugiinBills = async () => [];`].join("\n") },
    { spec: "./sources/shugiin-questions.ts", source: [`export * from REAL;`, `export const fetchShugiinQuestions = async () => [];`].join("\n") },
    { spec: "./sources/sangiin-questions.ts", source: [`export * from REAL;`, `export const fetchSangiinQuestions = async () => [];`].join("\n") },
    { spec: "./sources/kokkai-attendance.ts", source: [`export * from REAL;`, `export const fetchCommitteeAttendance = async () => [];`].join("\n") },
    { spec: "./sources/kokkai-committee.ts", source: [`export * from REAL;`, `export const fetchCommitteeRosters = async () => [];`].join("\n") },
    // **`fetchText` も塞ぐ**（上の差し替えから漏れた経路が 1 本でも在れば HTTP に出る）。
    // `cli.ts` は投票結果ページだけ `fetchText` を直に呼ぶので、その 1 本は空文字を返す
    // （`standingVoteNote` / `parseRollCall` は上で差し替えてあるので中身は使われない）。
    // **それ以外の URL は例外にする**——**黙ってネットワークに出ることが無い。**
    // **実際にこれが漏れを 1 本捕まえた。**
    { spec: "./fetch.ts", source: [
      `export * from REAL;`,
      `export const fetchText = async (u) => {`,
      `  if (/\\/touhyoulist\\//.test(u)) return "";`,
      `  throw new Error("fixture が塞いでいない取得: " + u);`,
      `};`,
    ].join("\n") },
  ];
}

/**
 * stub ファイルを `work/stubs/` に書き出し、`resolve` フックのソースを返す。
 *
 * **`DATA`（書き出し先）だけは `load` で `cli.ts` のソースを置換する**——
 * `const` なので外から差し替えられない。**置換は `new URL(…)` の 1 か所だけ**で、
 * **当たらなければ例外にする**（黙って実物の `data/` に書き出す形を作らない）。
 * **`import.meta.url` を含む文字列は tsx が変換しても残る**ので、ここは形に依存しない。
 */
async function writeLoader(work: string, dataDir: string, bill: { title: string; decision: string }, breakRestore: boolean): Promise<string> {
  const etlSrc = pathToFileURL(join(repo, "packages/etl/src/")).href;
  const stubDir = join(work, "stubs");
  await mkdir(stubDir, { recursive: true });
  const map: [string, string][] = [];
  for (const [i, st] of stubsFor(bill).entries()) {
    const real = new URL(st.spec.replace(/^\.\//, ""), etlSrc).href;
    const file = join(stubDir, `stub${i}.mjs`);
    await writeFile(file, st.source.replace(/\bREAL\b/g, JSON.stringify(real)) + "\n");
    map.push([real, pathToFileURL(file).href]);
  }
  // **復元の経路だけを壊す fixture**（`breakRestore`）。`readCarried` が返す `previousDecisions` を
  // 空にする——**復元元が在るのに復元が効かない**状態、つまり #1206 そのものの形である。
  // **cli.ts の歯止め（`lostDecisions` → `process.exit(1)`）が鳴るのはこのときだけ**なので、
  // これが無いと歯止めを消す変異が素通りする（実測 2026-10-05: 25 件すべて緑だった）。
  if (breakRestore) {
    const real = new URL("sessions.ts", etlSrc).href;
    const file = join(stubDir, "stub-sessions.mjs");
    await writeFile(file, [
      `import { readCarried as real } from ${JSON.stringify(real)};`,
      `export * from ${JSON.stringify(real)};`,
      `export const readCarried = async (...a) => ({ ...(await real(...a)), previousDecisions: new Map() });`,
      ``,
    ].join("\n"));
    map.push([real, pathToFileURL(file).href]);
  }
  const cliUrl = pathToFileURL(join(repo, "packages/etl/src/cli.ts")).href;
  const dataUrl = pathToFileURL(join(dataDir, "/")).href;
  const loader = [
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
  ].join("\n");
  await writeFile(join(work, "loader.mjs"), loader);
  // **差し替えの表が空でないこと**（空のまま走ると本物の取得が全部走る。#514 / #757 の母数）
  assert.equal(map.length, breakRestore ? 12 : 11, "差し替えの表の件数が意図と食い違っている");
  return loader;
}

/**
 * `pnpm etl <sessions>` を、取得なし・一時ディレクトリで走らせて、**書き出された 2 つのファイル**を返す。
 *
 * **`unmatched-bills.json` も返すのが要点である**（レビューで素通りした変異を塞ぐ）。
 * `rollcalls/index.json` だけ読んでいたので、**`cli.ts` の `unmatchedBills` を
 * `bills.unmatched`（＝復元を見ない今回の突合だけ）に戻しても 1 件も落ちなかった**
 * （実測 2026-10-07: 母数 76 のうち 0 件 fail）。**「索引には語が在るのに、
 * 同じリポジトリの別のファイルが『この採決は突合できていない』と申告している」**出力が全緑で出る。
 *
 * **`rollcall-decision-published.test.ts` の 2 本目が同じ整合を見ているが、そちらは
 * コミット済みの `data/` を読む**ので、`cli.ts` を書き換えても動かない（この層を足した理由と同じ）。
 * **整合を「いま走らせた出力」の上で見る層が無かった。**
 */
async function etl(
  sessions: number[],
  bill: { title: string; decision: string } = NO_MATCH,
  opts: { breakRestore?: boolean } = {},
): Promise<{ rows: RollCallSummary[]; declaredUnmatched: { rollCallId: string }[]; log: string; code: number }> {
  const work = await mkdtemp(join(tmpdir(), "giinrecord-1206-"));
  const data = join(work, "data");
  await mkdir(data, { recursive: true });
  await seed(data);
  const breakRestore = opts.breakRestore ?? false;
  await writeLoader(work, data, bill, breakRestore);
  // **fixture が本当にこの形で入っていること**を、書き出した stub の上で確かめる。
  // 空振りに気づかず測ると、結果が全部無意味になる（#514）
  const billStub = await readFile(join(work, "stubs", "stub3.mjs"), "utf8");
  assert.ok(billStub.includes(bill.title), `fixture の議案名が stub に入っていない: ${billStub.slice(0, 300)}`);
  assert.ok(billStub.includes(bill.decision), `fixture の審議結果が stub に入っていない: ${billStub.slice(0, 300)}`);
  assert.ok(billStub.includes("fetchBills"), "差し替えたのは fetchBills の stub ではない");
  const hook = join(work, "hook.mjs");
  await writeFile(hook, [
    'import { register } from "node:module";',
    `register("./loader.mjs", ${JSON.stringify(pathToFileURL(join(work, "/")).href)});`,
  ].join("\n"));
  // **非0終了も「結果」である**（歯止めが鳴ったこと自体を測る）。throw させずに終了コードを受け取る。
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
  const raw = await readFile(join(data, "rollcalls", "index.json"), "utf8");
  // **無いことと空であることを混ぜない**（#1056）。歯止めで止まった実行は `writeDataset` に到達しないので
  // このファイルは存在しない。**空配列として読むと「申告 0 件」に化けて、整合検査が偽で緑になる。**
  const unmatchedPath = join(data, "unmatched-bills.json");
  let declaredUnmatched: { rollCallId: string }[] = [];
  try {
    declaredUnmatched = JSON.parse(await readFile(unmatchedPath, "utf8")) as { rollCallId: string }[];
  } catch (err) {
    // 0 で終わった実行は必ず書いているはず。**読めないまま空として返さない。**
    if (code === 0) throw new Error(`ETL は 0 で終わったのに unmatched-bills.json が読めない: ${unmatchedPath}\n${String(err)}`);
  }
  return { rows: JSON.parse(raw) as RollCallSummary[], declaredUnmatched, log: out, code };
}

const resultOf = (rows: RollCallSummary[]): string | undefined => rows.find((s) => s.id === "209-1128-v010")?.result;

test("#1206 遡り（対象の回次を取り直す実行）でも、前回出力の判定の語が残る", async () => {
  // targets = [209] / carried = [221]。**209 が carried から出る**＝元のコードでは復元が効かない形
  const { rows, log, code } = await etl([209]);
  assert.equal(code, 0, `ETL が非0で終わった:\n${log.slice(-1500)}`);
  // 件数は fixture から導く（手で書くと fixture を増やしたときにずれる。#1189）
  assert.deepEqual(rows.map((s) => s.id).sort(), [ROLL_CALL.id, NO_WORD_ROLL_CALL.id].sort(), `fixture の採決が全部書かれているはず:\n${log.slice(-1500)}`);
  assert.equal(resultOf(rows), "可決（賛成 1・反対 0）", `遡りで判定の語が消えた。cli.ts の restoreDecisions を見る:\n${log.slice(-1500)}`);
  // **復元が「効いた」とログで言っていること**（黙って通るのと区別する。#1056）
  assert.match(log, /roll call decisions restored from the previous rollcalls\/index\.json: 1\b/, `復元の件数がログに出ていない:\n${log.slice(-1500)}`);
});

test("#1206 日次の形（対象外の回次として引き継ぐ実行）でも語が残る——こちらは元から壊れていない", async () => {
  // targets = [221] / carried = [209]。**この経路は #1206 の前から正しく動いていた**。
  // 直したことで壊していないことを見る（片側を直して対の側を壊す形を塞ぐ）。
  const { rows, log, code } = await etl([221]);
  assert.equal(code, 0, `ETL が非0で終わった:\n${log.slice(-1500)}`);
  assert.equal(resultOf(rows), "可決（賛成 1・反対 0）", `引き継ぎ側で語が消えた:\n${log.slice(-1500)}`);
});

test("#1206 今回の突合が当たれば、前回と違っても今回の語を採る（古い語で上書きしない。受け入れ条件 2）", async () => {
  // 参院 議案情報の議案名を採決の案件名と一致させ、審議結果を「否決」にする。
  // **前回出力は「可決」**なので、復元が今回の突合を上書きしていれば「可決」が出て落ちる。
  const { rows, log, code } = await etl([209], MATCHES);
  assert.equal(code, 0, `ETL が非0で終わった:\n${log.slice(-1500)}`);
  assert.equal(resultOf(rows), "否決（賛成 1・反対 0）", `今回の突合（否決）が前回の語（可決）に上書きされた:\n${log.slice(-1500)}`);
  // 今回当たった採決は復元の対象にしない（件数が 0 件＝ログに行が出ない）
  assert.doesNotMatch(log, /roll call decisions restored/, `今回当たったのに復元も走っている:\n${log.slice(-1500)}`);
});

/** 判定の語（`decisionOfResult`）を持たない採決の id。`result` は票数だけでも非空なので、語で見る。 */
const withoutDecisionWord = (rows: RollCallSummary[]): string[] =>
  rows.filter((s) => decisionOfResult(s.result) === undefined).map((s) => s.id).sort();

/**
 * **索引の語と `unmatched-bills.json` の申告が、いま走らせた出力の上でずれていないこと。**
 *
 * ## なぜこの層が要るのか（**レビューで変異が素通りした**）
 *
 * `cli.ts` は `unmatchedBills` を **`restored.stillMissing`**（復元の後に残った分）から作る。
 * これを **`bills.unmatched`**（復元を見ない、今回の突合だけ）に戻すと:
 *
 * ```
 * 実測 2026-10-07（この検査を足す前）
 *   mutate.sh run --file packages/etl/src/cli.ts
 *     --from 'const unmatchedBills = rollCalls.filter((rc) => missing.has(rc.id)).map(...)'
 *     --to   'const unmatchedBills = bills.unmatched;'
 *     → 母数 76 のうち fail 0 件   **素通り**
 * ```
 *
 * **出力は実際に壊れる**（復元で語が付いた採決が、申告にだけ残る）。
 * **語は正しいのに、同じリポジトリの別のファイルが「この採決は突合できていない」と言う**——
 * **「別のものが出る」側の壊れ方**で、利用者からは検出できない。
 *
 * `rollcall-decision-published.test.ts` の 2 本目が同じ整合を見ているが、
 * **あれはコミット済みの `data/` を読むので `cli.ts` を書き換えても動かない。**
 *
 * ## 恒真にしないための fixture（**母数を空にしない**）
 *
 * **語を持たない採決を 1 件混ぜてある**（`NO_WORD_ROLL_CALL`。人事案件の形）。
 * **これが無いと正しい出力は常に空配列**で、「空かどうか」しか見ない検査になる。
 * **数は散文に書かず、`rollcalls/index.json` 側から導いて突き合わせる**——
 * **期待値を手で書くと、fixture を増やしたときにずれる**（#1189 / #1200）。
 */
test("#1206 書き出された unmatched-bills.json が、索引で語を持たない採決と逐語で一致する（復元した採決を未突合と申告しない）", async () => {
  const { rows, declaredUnmatched, log, code } = await etl([209]);
  assert.equal(code, 0, `ETL が非0で終わった:\n${log.slice(-1500)}`);

  const withoutWord = withoutDecisionWord(rows);
  const declared = [...declaredUnmatched.map((r) => r.rollCallId)].sort();

  // **母数（#757）**: 「一致した」と「どちらも空だった」を区別する。
  // 語を持たない採決が 1 件も無ければ、この検査は何も突き合わせていない。
  assert.ok(
    withoutWord.length > 0,
    `索引に語を持たない採決が 1 件も無い。この検査は何も突き合わせていない（fixture が変わった）: ${JSON.stringify(rows.map((s) => s.result))}`,
  );
  // **復元が効いたことも押さえる**（復元が走らない形になっていたら、両方空でも一致してしまう）
  assert.match(log, /roll call decisions restored from the previous rollcalls\/index\.json: 1\b/, `復元が走っていない:\n${log.slice(-1500)}`);

  assert.deepEqual(declared, withoutWord, [
    `unmatched-bills.json の申告が、索引で語を持たない採決と食い違っている`,
    `  索引で語が無い（${withoutWord.length} 件 / 全 ${rows.length} 件）: ${withoutWord.join(" ") || "（無し）"}`,
    `  未突合と申告（${declared.length} 件）:                  ${declared.join(" ") || "（無し）"}`,
    "",
    "復元（restoreDecisions）で語が付いた採決は、未突合ではない。",
    "cli.ts の unmatchedBills は restored.stillMissing から作ること（bills.unmatched は復元前の集合で、二重に数える）。",
  ].join("\n"));
});

/**
 * **歯止めが鳴ることを測る**（受け入れ条件 3 の「変異で示す」側）。
 *
 * **これが無いと、`cli.ts` の `lostDecisions` → `process.exit(1)` を丸ごと消しても
 * 1 件も落ちない**（実測 2026-10-05: `const lost = lostDecisions(…)` を `const lost = []` に
 * 置き換えて 25 件すべて緑だった）。
 *
 * **復元の経路だけを壊して**（`readCarried` の `previousDecisions` を空にする）、
 * **歯止めが語の消失を名指しして、`data/` を書かずに止まること**を見る。
 */
test("#1206 復元が効かなくなったら、歯止めが語の消失を名指しして data/ を書かずに止まる", async () => {
  const { rows, log, code } = await etl([209], NO_MATCH, { breakRestore: true });
  assert.equal(code, 1, `語が消えたのに ETL が 0 で終わった（歯止めが鳴っていない）:\n${log.slice(-2000)}`);
  // **何が消えたかを名指ししていること**（「違反 1 件」だけでは運用者が何も直せない）
  assert.match(log, /roll call decisions lost since the previous output/, `歯止めのメッセージが出ていない:\n${log.slice(-2000)}`);
  assert.match(log, /209-1128-v010 \(session 209\): 可決 -> \(no decision\)/, `消えた採決と語を名指ししていない:\n${log.slice(-2000)}`);
  // **data/ が書き換わっていない**（壊れた出力を公開しない）。前回出力の語がそのまま残る
  assert.equal(resultOf(rows), "可決（賛成 244・反対 0）", "止めたのに data/ が上書きされている");
});
