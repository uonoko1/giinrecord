import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// 回帰テスト（Issue #11）: "Run ETL" ステップは `pnpm etl ... | tee etl.log` とパイプしているため、
// GitHub Actions 既定の `bash -e {0}`（pipefail なし）では ETL の非0終了が tee の exit 0 に隠れる。
// `shell: bash` を明示すると `bash --noprofile --norc -eo pipefail {0}` になり、ETL の失敗でステップが失敗する。
const here = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(resolve(here, "../../../.github/workflows/etl.yml"), "utf8");

function stepBlock(name: string): string {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `step "${name}" not found`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n\s*- (name|uses|run|id):/);
  return rest.slice(0, next < 0 ? undefined : next);
}

test("etl.yml: piped Run ETL step enables pipefail via shell: bash", () => {
  const block = stepBlock("Run ETL");
  assert.match(block, /\| tee etl\.log/);
  assert.match(block, /^\s*shell: bash\s*$/m, "Run ETL step must declare `shell: bash` so that pipefail applies");
});

test("bash -eo pipefail propagates non-zero exit through tee (sanity of the fix)", () => {
  const script = "false | tee /dev/null";
  const without = spawnSync("bash", ["-e", "-c", script]);
  const withPipefail = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script]);
  assert.equal(without.status, 0); // documents the trap
  assert.notEqual(withPipefail.status, 0);
});

/**
 * Issue #294: 作り直しのキャッシュ（ETL_CACHE_CLOSED_SESSIONS）は **rebuild の経路にだけ**立てる。
 *
 * 日次 cron にまで立つと、過去回次に後から追記が入ったときそれを取り逃す
 * （追記が起きないことは 11 回次 × 24 時間の観測でしか確かめていない）。
 * 日次 ETL の鮮度の振る舞いを変えないことが、この変更の最優先の制約である。
 */
test("etl.yml: ETL_CACHE_CLOSED_SESSIONS は rebuild=yes のときだけ立つ", () => {
  const block = stepBlock("Run ETL");
  assert.match(block, /ETL_CACHE_CLOSED_SESSIONS:/, "Run ETL に ETL_CACHE_CLOSED_SESSIONS が無い");
  // rebuild 入力が "yes" のときだけ "1"、それ以外は空文字（= 無効）になる式であること。
  const line = block.split("\n").find((l) => l.includes("ETL_CACHE_CLOSED_SESSIONS:")) ?? "";
  assert.match(line, /inputs\.rebuild/, "rebuild 入力に紐づいていない（cron でも立ってしまう）");
  assert.match(line, /==\s*'yes'/, "rebuild == 'yes' 以外でも立つ可能性がある");
  assert.match(line, /&&\s*'1'/, "有効化する値は '1' であること（fetch.ts の判定と一致させる）");
});

test("etl.yml: 日次 cron には rebuild 入力が無く、キャッシュは無効のまま", () => {
  // schedule 実行では github.event.inputs.rebuild が空なので、上の式は '' に評価される。
  // '' は fetch.ts の cacheClosedSessionsEnabled()（=== "1"）で false になる。
  assert.match(workflow, /schedule:/);
  const block = stepBlock("Run ETL");
  const line = block.split("\n").find((l) => l.includes("ETL_CACHE_CLOSED_SESSIONS:")) ?? "";
  // GitHub Actions の三項相当は `cond && 'A' || 'B'`。rebuild でないときに落ちる先が
  // 空文字であること（= 無効）を固定する。ここが '1' だと cron でもキャッシュが効いてしまう。
  const fallback = line.match(/\|\|\s*('[^']*')\s*\}\}/)?.[1];
  assert.equal(fallback, "''", `rebuild でないときの値は空文字であること（実際: ${fallback}）`);
});
