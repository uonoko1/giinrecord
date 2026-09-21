import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { defaultSessionsFor } from "../src/local-assemblies.ts";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * # **`local-cli.ts` が本当に議会ごとの既定を使っているか**（Issue #901）
 *
 * ## なぜ「`defaultSessionsFor` が 4 を返す」だけでは足りないか
 *
 * **変異を当てて分かった**（2026-09-20）。**`local-cli.ts` の
 * `defaultSessionsFor(target)` を素の `2` に書き換えても、`tsc` も 1,870 件のテストも
 * 1 件も落ちなかった**——**`defaultSessionsFor` 自身のテストは関数を直接呼ぶだけで、
 * CLI がそれを使っているかを一度も見ていなかった。**
 *
 * **これは「等価変異」ではない**（本番の三重が 733 本から 365 本に戻る）。
 * **「テストが何も主張していない」形である**（`docs/WORKING_AGREEMENT.md` の分類 4）。
 *
 * **`local-cli.ts` は import しただけで取得を始める**ので、テストから読み込めない。
 * **だから子プロセスで起動し、`LOCAL_SOURCES` の `run` だけを差し替えて
 * 「いくつの `sessions` で呼ばれたか」を記録させる**（**ネットワークには一切出ない**）。
 *
 * **`node --import` のフックでモジュールを差し替える**ので、`local-cli.ts` 自身は 1 行も変えない。
 */
async function sessionsPassedTo(target: string, extra: string[] = []): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "giinrecord-cli-"));
  const base = pathToFileURL(join(dir, "/")).href;
  // **`LOCAL_SOURCES` の `run` を「sessions を印字して終わる」ものに差し替えるローダ。**
  // **`local-assemblies.ts` の原文の末尾に数行足すだけで、`local-cli.ts` は 1 行も変えない。**
  // **記録したらそこで終わるので、取得にも書き出しにも進まない**（ネットワークに出ない）。
  const loader = [
    'export async function load(url, context, next) {',
    '  const r = await next(url, context);',
    '  if (!url.replace(/\\\\/g, "/").endsWith("src/local-assemblies.ts")) return r;',
    '  const extra = [',
    '    "for (const k of Object.keys(LOCAL_SOURCES)) {",',
    '    "  const s = LOCAL_SOURCES[k];",',
    '    "  LOCAL_SOURCES[k] = { assembly: s.assembly, run: async (o) => { console.log(\'SESSIONS=\' + o.sessions); process.exit(0); } };",',
    '    "}",',
    '  ].join("\\n");',
    '  return { ...r, source: r.source.toString() + "\\n" + extra + "\\n" };',
    '}',
  ].join("\n");
  await writeFile(join(dir, "loader.mjs"), loader);
  const hook = join(dir, "hook.mjs");
  await writeFile(hook, [
    'import { register } from "node:module";',
    `register("./loader.mjs", ${JSON.stringify(base)});`,
  ].join("\n"));
  const { stdout } = await run(
    process.execPath,
    ["--import", "tsx", "--import", pathToFileURL(hook).href, join(repo, "packages/etl/src/local-cli.ts"), target, ...extra],
    { cwd: join(repo, "packages/etl"), timeout: 120_000 },
  );
  const m = stdout.match(/SESSIONS=(\d+)/);
  assert.ok(m, `CLI が run を呼んでいない: ${stdout.slice(0, 300)}`);
  return Number(m[1]);
}

test("#901 `--sessions` を渡さないとき、CLI は議会ごとの既定を使う（三重 4 / 徳島 4 / 宮城 11 / 鳥取 2）", async () => {
  // **これが M9 を殺す検査**——**CLI の中の `defaultSessionsFor(target)` を `2` に書き換えると落ちる**
  assert.equal(await sessionsPassedTo("mie"), 4, "三重は 4（令和5年第2回定例会まで）");
  assert.equal(await sessionsPassedTo("tokushima"), 4, "徳島は 4（令和7年11月定例会まで）");
  assert.equal(await sessionsPassedTo("miyagi"), 11, "宮城は 11（第390回まで。12 本目は 2023-10 の一般選挙の前）");
  assert.equal(await sessionsPassedTo("tottori"), 2, "測っていない議会は 2 のまま");
  // **関数の返り値と、CLI が実際に渡した値が同じ**（片方だけ直して食い違う形を塞ぐ）
  assert.equal(await sessionsPassedTo("mie"), defaultSessionsFor("mie"));
  assert.equal(await sessionsPassedTo("tokushima"), defaultSessionsFor("tokushima"));
  assert.equal(await sessionsPassedTo("miyagi"), defaultSessionsFor("miyagi"));
  assert.equal(await sessionsPassedTo("tottori"), defaultSessionsFor("tottori"));
});

test("#901 `--sessions N` を渡したときは、既定ではなく N が使われる（既定が N を上書きしない）", async () => {
  assert.equal(await sessionsPassedTo("mie", ["--sessions", "1"]), 1, "明示した 1 が勝つ");
  assert.equal(await sessionsPassedTo("mie", ["--sessions", "7"]), 7, "既定より大きい値も渡せる");
  assert.equal(await sessionsPassedTo("miyagi", ["--sessions", "3"]), 3);
});
