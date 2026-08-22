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
