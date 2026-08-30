import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Issue #308: deploy-data.yml の staging と production が同じホストへ同時に rsync すると、
// どちらか一方が `connection unexpectedly closed (0 bytes received)` で落ちることがある
// （落ちる側は固定されていない）。原因は未特定だが、同時実行は全ての失敗に共通する条件なので
// 直列化した。ここでは「直列化が外れていないこと」と「staging の失敗が本番を止めないこと」を守る。
const here = dirname(fileURLToPath(import.meta.url));
const deployData = readFileSync(resolve(here, "../../../.github/workflows/deploy-data.yml"), "utf8");
const deploySite = readFileSync(resolve(here, "../../../.github/workflows/deploy-site.yml"), "utf8");

function jobBlock(yaml: string, name: string): string {
  const start = yaml.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job "${name}" not found`);
  const rest = yaml.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return rest.slice(0, next < 0 ? undefined : next);
}

test("production は staging の後に走る（同じホストへの同時 rsync を避ける・#308）", () => {
  const production = jobBlock(deployData, "production");
  const needs = production.match(/needs:\s*(.+)/)?.[1] ?? "";
  assert.match(needs, /staging/, "production が staging を needs に含んでいない（直列化が外れている）");
  assert.match(needs, /resolve/, "production が resolve を needs に含んでいない");
});

test("staging が落ちても本番データの反映は止まらない（#308）", () => {
  const production = jobBlock(deployData, "production");
  // needs に staging を足した副作用で本番が止まると、直列化のために可用性を落とすことになる。
  assert.match(production, /if:\s*always\(\)/, "production に if: always() が無い（staging の失敗で本番が止まる）");
  assert.match(
    production,
    /needs\.resolve\.result\s*==\s*'success'/,
    "resolve の成功を条件にしていない（ref が決まらないまま本番へ流れる）",
  );
});

test("rsync は無応答のまま固まらない（#308 の診断）", () => {
  // 失敗時にログを残さず固まると、次に失敗したときも原因が分からないままになる。
  assert.match(deploySite, /rsync[^\n]*--timeout=\d+/, "rsync に --timeout が無い");
  assert.match(deploySite, /rsync[^\n]*--stats/, "rsync に --stats が無い（成功時との比較ができない）");
});

test("失敗を隠すリトライを足していない（#308）", () => {
  // 原因が未特定のままリトライを足すと、失敗が見えなくなるだけで前進しない。
  const rsyncStep = deploySite.slice(deploySite.indexOf("- name: rsync static site to VPS"));
  assert.doesNotMatch(rsyncStep.slice(0, 1200), /retry|until\s|for\s+i\s+in/i, "rsync にリトライが入っている");
});
