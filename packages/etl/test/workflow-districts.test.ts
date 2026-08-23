import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// 選挙区 ETL のワークフロー（Issue #111）。日次 etl.yml と同じ data PR の流れを月次で流す。
const here = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(resolve(here, "../../../.github/workflows/districts.yml"), "utf8");
const daily = readFileSync(resolve(here, "../../../.github/workflows/etl.yml"), "utf8");

function stepBlock(name: string): string {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `step "${name}" not found`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n\s*- (name|uses|run|id):/);
  return rest.slice(0, next < 0 ? undefined : next);
}

test("districts.yml: 月 1 回の schedule と workflow_dispatch で動く（日次から分離）", () => {
  assert.match(workflow, /schedule:\s*\n\s*- cron: "\d+ \d+ \d+ \* \*"/, "monthly cron (fixed day of month)");
  assert.match(workflow, /workflow_dispatch:/);
});

test("districts.yml: ETL は日次と同じコンテナイメージで districts-cli.ts を走らせ、パイプの失敗を拾う（shell: bash）", () => {
  const block = stepBlock("Run districts ETL");
  assert.match(block, /gikailog-etl:ci/);
  assert.match(block, /--entrypoint node/);
  assert.match(block, /src\/districts-cli\.ts/);
  assert.match(block, /\| tee etl\.log/);
  assert.match(block, /^\s*shell: bash\s*$/m);
  assert.match(block, /--user "\$\(id -u\):\$\(id -g\)"/);
  assert.match(block, /-v "\$PWD\/data:\/app\/data"/);
});

test("districts.yml: data PR は日次と別のブランチ名で、日次と同じ concurrency group で直列化する", () => {
  assert.match(workflow, /DATA_BRANCH: data\/districts/);
  assert.doesNotMatch(workflow, /DATA_BRANCH: data\/refresh/);
  assert.match(workflow, /concurrency:\s*\n\s*group: etl\b/);
  assert.match(daily, /concurrency:\s*\n\s*group: etl\b/);
});

test("districts.yml: 失敗 Issue のタイトルは日次と別（同じ Issue にコメントが混ざらない）", () => {
  const title = workflow.match(/FAILURE_ISSUE_TITLE: "([^"]+)"/)?.[1];
  const dailyTitle = daily.match(/FAILURE_ISSUE_TITLE: "([^"]+)"/)?.[1];
  assert.ok(title && dailyTitle);
  assert.notEqual(title, dailyTitle);
  assert.match(title, /districts\.yml/);
});

test("districts.yml: Summary に分割市区町村の件数（推定せず候補を並べた数）を出す", () => {
  const block = stepBlock("Job summary");
  assert.match(block, /splitMunicipalities/);
  assert.match(block, /data\/districts\/meta\.json/);
});
