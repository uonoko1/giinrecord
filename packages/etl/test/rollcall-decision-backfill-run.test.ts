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
  await put("rollcalls/index.json", [SUMMARY]);
  await put("rollcalls/209/209-1128-v010.json", ROLL_CALL);
  await put("bills/index.json", []);
  await put("members/index.json", []);
  await put("assemblies/index.json", []);
  await put("unmatched.json", []);
}

/**
 * **取得する関数を差し替えるローダ。** 各モジュールの原文の末尾に数行足して export を上書きする。
 * **`cli.ts` は 1 行も変えない。** `DATA` だけは `cli.ts` のソースを置換して向け直す
 * （`DATA` は `const` で外から差し替えられないため。**置換するのは書き出し先の 1 行だけ**）。
 */
/**
 * **参院 議案情報の fixture**（`fetchBills` が返す 1 件）。
 * - `NO_MATCH`: 案件名が一致しない＝**突合が当たらない**。209-1128-v010 の実際の形。
 * - `MATCHES`: 案件名が一致する＝**突合が当たる**。前回の語と違う審議結果を入れて、どちらが勝つか見る。
 */
const NO_MATCH = { title: "まったく別の法律案", decision: "可決" } as const;
const MATCHES = { title: "租税特別措置法及び東日本大震災の被災者等に係る国税関係法律の臨時特例に関する法律の一部を改正する法律案", decision: "否決" } as const;

function loaderSource(dataDir: string, bill: { title: string; decision: string }): string {
  // **モジュールの原文は残したまま、取得する関数だけを差し替える。**
  //
  // **末尾に `const f__stub = …` を足す形（#901 がやっている形）は使えない**——
  // `f` は `async function f` で既に宣言されているので
  // `Identifier 'f' has already been declared` で落ちる（実測 2026-10-05）。
  //
  // **ローダに届くのは tsx が変換した後のソースである**（実測 2026-10-05）:
  // `export` は宣言から外され、末尾の 1 行にまとめられている——
  // `export{RollCallParseError,listRollCalls,parseRollCall,…};`
  //
  // **だからその export の 1 語だけを差し替える**: `listRollCalls` → `listRollCalls__stub as listRollCalls`。
  // 原文の実装は宣言ごとそのまま残り（誰も呼ばない）、**公開される名前だけが stub を指す。**
  // **置換が当たらなければ例外にする**——**当たっていないのに当たったつもりで測ると
  // 本物の取得が走ってネットワークに出る**（#514 の形）。
  const stubs: [string, string[], string][] = [
    ["src/sources/sangiin-members.ts", ["fetchMembers"],
      `const fetchMembers__stub = async (s) => (s === 209 || s === 221 ? ${JSON.stringify([MEMBER])} : undefined);`],
    ["src/sources/shugiin-members.ts", ["fetchShugiinMembers"],
      `const fetchShugiinMembers__stub = async () => ({ members: [], asOf: "2026-10-01" });`],
    // **投票結果ページは「取り直せる」**ようにする——**これが遡りの本質である。**
    // 遡りでは対象の回次の採決がネットワークから取り直され、`carried` に入らない。
    // 一覧を空にすると採決そのものが消えて別の壊れ方になるので、取り直した体にする
    // （`parseRollCall` が fixture の採決を返す）。**判定の語は投票結果ページに無い**（#26）ので、
    // 取り直した採決に語は付かない——**語は前回出力から戻すしかない。**
    ["src/sources/sangiin-votes.ts", ["listRollCalls", "parseRollCall", "standingVoteNote"], [
      `const listRollCalls__stub = async (s) => (s === 209 ? [{ href: ${JSON.stringify(ROLL_CALL.sourceUrl)}, title: ${JSON.stringify(ROLL_CALL.title)} }] : []);`,
      `const parseRollCall__stub = () => (${JSON.stringify(ROLL_CALL)});`,
      `const standingVoteNote__stub = () => undefined;`,
    ].join("\n")],
    // **参院 議案情報は「取れたが案件名が一致しない」状態にする**——これが 209-1128-v010 の実際の形。
    // 空配列ではなく議案を 1 件返すので、「取得に失敗した」とは区別できる（#1056）。
    // `matchBillResults` / `toBillDecisions` は原文のまま効く（突合の挙動を模造しない）。
    ["src/sources/sangiin-bills.ts", ["fetchBills"],
      `const fetchBills__stub = async () => [{ id: "209-閣法-1", session: 209, kind: "閣法", house: "sangiin", title: ${JSON.stringify(bill.title)}, submitterText: "内閣", plenary: [{ decision: ${JSON.stringify(bill.decision)}, date: "2025-11-28" }], sourceUrl: "https://www.sangiin.go.jp/japanese/joho1/kousei/gian/209/meisai/m209080209001.htm" }];`],
    ["src/sources/kokkai-speeches.ts", ["fetchSpeeches"], `const fetchSpeeches__stub = async () => [];`],
    ["src/sources/shugiin-bills.ts", ["fetchShugiinBills"], `const fetchShugiinBills__stub = async () => [];`],
    ["src/sources/shugiin-questions.ts", ["fetchShugiinQuestions"], `const fetchShugiinQuestions__stub = async () => [];`],
    ["src/sources/sangiin-questions.ts", ["fetchSangiinQuestions"], `const fetchSangiinQuestions__stub = async () => [];`],
    ["src/sources/kokkai-attendance.ts", ["fetchCommitteeAttendance"], `const fetchCommitteeAttendance__stub = async () => [];`],
    ["src/sources/kokkai-committee.ts", ["fetchCommitteeRosters"], `const fetchCommitteeRosters__stub = async () => [];`],
    // **`fetchText` も塞ぐ**（上の差し替えから漏れた経路が 1 本でも在れば HTTP に出る）。
    // `cli.ts` は投票結果ページだけ `fetchText` を直に呼ぶので、その 1 本は空文字を返す
    // （`standingVoteNote` / `parseRollCall` は上で差し替えてあるので中身は使われない）。
    // **それ以外の URL は例外にする**——**黙ってネットワークに出ることが無い。**
    ["src/fetch.ts", ["fetchText"], [
      `const fetchText__stub = async (u) => {`,
      `  if (/\\/touhyoulist\\//.test(u)) return "";`,
      `  throw new Error("fixture が塞いでいない取得: " + u);`,
      `};`,
    ].join("\n")],
  ];
  const cases = stubs.map(([rel, names, extra]) => {
    const steps = names.map((n) =>
      `    { const re = new RegExp("([{,])${n}([,}])"); `
      + `const next2 = src.replace(re, "$1${n}__stub as ${n}$2"); `
      + `if (next2 === src) throw new Error("${rel} の export から ${n} を差し替えられなかった（本物の取得が走る）"); src = next2; }`
    ).join("\n");
    return [
      `  if (p.endsWith(${JSON.stringify(rel)})) {`,
      `    let src = r.source.toString();`,
      `    if (!/export\\{/.test(src)) throw new Error(${JSON.stringify(rel)} + " に export{…} の行が無い（tsx の出力の形が変わった）");`,
      steps,
      `    return { ...r, source: src + "\\n" + ${JSON.stringify(extra)} + "\\n" };`,
      `  }`,
    ].join("\n");
  }).join("\n");
  const dataUrl = pathToFileURL(join(dataDir, "/")).href;
  return [
    'export async function load(url, context, next) {',
    '  const r = await next(url, context);',
    '  const p = url.replace(/\\\\/g, "/").replace(/\\?.*$/, "");',
    cases,
    '  if (p.endsWith("src/cli.ts")) {',
    // **tsx は空白を詰めてから渡してくる**（実測: `new URL("../../../data/",import.meta.url)`）
    `    const re = /new URL\\(\\s*"\\.\\.\\/\\.\\.\\/\\.\\.\\/data\\/"\\s*,\\s*import\\.meta\\.url\\s*\\)/;`,
    `    const src = r.source.toString().replace(re, ${JSON.stringify(JSON.stringify(dataUrl))});`,
    '    if (src === r.source.toString()) throw new Error("cli.ts の DATA を差し替えられなかった（書き出し先が実物の data/ のままになる）");',
    '    return { ...r, source: src };',
    '  }',
    '  return r;',
    '}',
  ].join("\n");
}

/** `pnpm etl <sessions>` を、取得なし・一時ディレクトリで走らせて、書かれた `rollcalls/index.json` を返す。 */
async function etl(sessions: number[], bill: { title: string; decision: string } = NO_MATCH): Promise<{ rows: RollCallSummary[]; log: string }> {
  const work = await mkdtemp(join(tmpdir(), "giinrecord-1206-"));
  const data = join(work, "data");
  await mkdir(data, { recursive: true });
  await seed(data);
  const loader = loaderSource(data, bill);
  // **fixture が本当にこの形で入っていること**を、ローダのソースの上で確かめる。
  // 空振りに気づかず測ると、結果が全部無意味になる（#514）
  // （ローダのソースは二重に JSON で囲まれているので、逐語ではなく中身の文字列で見る）
  assert.ok(loader.includes(bill.title), "fixture の議案名がローダに入っていない");
  assert.ok(loader.includes(bill.decision), "fixture の審議結果がローダに入っていない");
  await writeFile(join(work, "loader.mjs"), loader);
  const hook = join(work, "hook.mjs");
  await writeFile(hook, [
    'import { register } from "node:module";',
    `register("./loader.mjs", ${JSON.stringify(pathToFileURL(join(work, "/")).href)});`,
  ].join("\n"));
  const { stdout, stderr } = await run(
    process.execPath,
    ["--import", "tsx", "--import", pathToFileURL(hook).href, join(repo, "packages/etl/src/cli.ts"), ...sessions.map(String)],
    { cwd: join(repo, "packages/etl"), timeout: 180_000, maxBuffer: 32 * 1024 * 1024 },
  );
  const rows = JSON.parse(await readFile(join(data, "rollcalls", "index.json"), "utf8")) as RollCallSummary[];
  return { rows, log: stdout + stderr };
}

const resultOf = (rows: RollCallSummary[]): string | undefined => rows.find((s) => s.id === "209-1128-v010")?.result;

test("#1206 遡り（対象の回次を取り直す実行）でも、前回出力の判定の語が残る", async () => {
  // targets = [209] / carried = [221]。**209 が carried から出る**＝元のコードでは復元が効かない形
  const { rows, log } = await etl([209]);
  assert.equal(rows.length, 1, `採決が 1 件書かれているはず:\n${log.slice(-1500)}`);
  assert.equal(resultOf(rows), "可決（賛成 1・反対 0）", `遡りで判定の語が消えた。cli.ts の restoreDecisions を見る:\n${log.slice(-1500)}`);
  // **復元が「効いた」とログで言っていること**（黙って通るのと区別する。#1056）
  assert.match(log, /roll call decisions restored from the previous rollcalls\/index\.json: 1\b/, `復元の件数がログに出ていない:\n${log.slice(-1500)}`);
});

test("#1206 日次の形（対象外の回次として引き継ぐ実行）でも語が残る——こちらは元から壊れていない", async () => {
  // targets = [221] / carried = [209]。**この経路は #1206 の前から正しく動いていた**。
  // 直したことで壊していないことを見る（片側を直して対の側を壊す形を塞ぐ）。
  const { rows, log } = await etl([221]);
  assert.equal(resultOf(rows), "可決（賛成 1・反対 0）", `引き継ぎ側で語が消えた:\n${log.slice(-1500)}`);
});

test("#1206 今回の突合が当たれば、前回と違っても今回の語を採る（古い語で上書きしない。受け入れ条件 2）", async () => {
  // 参院 議案情報の議案名を採決の案件名と一致させ、審議結果を「否決」にする。
  // **前回出力は「可決」**なので、復元が今回の突合を上書きしていれば「可決」が出て落ちる。
  const { rows, log } = await etl([209], MATCHES);
  assert.equal(resultOf(rows), "否決（賛成 1・反対 0）", `今回の突合（否決）が前回の語（可決）に上書きされた:\n${log.slice(-1500)}`);
  // 今回当たった採決は復元の対象にしない（件数が 0 件＝ログに行が出ない）
  assert.doesNotMatch(log, /roll call decisions restored/, `今回当たったのに復元も走っている:\n${log.slice(-1500)}`);
});
