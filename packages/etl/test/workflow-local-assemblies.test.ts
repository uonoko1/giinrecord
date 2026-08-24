import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// 地方議会 ETL のワークフロー（Issue #157）。選挙区 ETL（districts.yml）と同じ data PR の流れを月次で流す（議会は会期単位で更新される）。
const here = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(resolve(here, "../../../.github/workflows/local-assemblies.yml"), "utf8");
const districts = readFileSync(resolve(here, "../../../.github/workflows/districts.yml"), "utf8");
const daily = readFileSync(resolve(here, "../../../.github/workflows/etl.yml"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8")) as { scripts: Record<string, string> };

function stepBlock(name: string): string {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `step "${name}" not found`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n\s*- (name|uses|run|id):/);
  return rest.slice(0, next < 0 ? undefined : next);
}

test("local-assemblies.yml: 月 1 回の schedule と workflow_dispatch で動く", () => {
  assert.match(workflow, /schedule:\s*\n\s*- cron: "\d+ \d+ \d+ \* \*"/, "monthly cron (fixed day of month)");
  assert.match(workflow, /workflow_dispatch:/);
});

test("local-assemblies.yml: 日次と同じイメージで local-cli.ts を ASSEMBLIES（miyagi=pref-04 tokushima=pref-36 tottori=pref-31）の順に走らせ、パイプの失敗を拾う（shell: bash）", () => {
  assert.match(workflow, /ASSEMBLIES: "miyagi=pref-04 tokushima=pref-36 tottori=pref-31"/, "鳥取県議会（#184）も同じループで走る");
  const block = stepBlock("Run local assemblies ETL");
  assert.match(block, /for pair in \$ASSEMBLIES; do/);
  assert.match(block, /gikailog-etl:ci/);
  assert.match(block, /--entrypoint node/);
  assert.match(block, /src\/local-cli\.ts "\$name"/);
  assert.match(block, /\| tee -a etl\.log/);
  assert.match(block, /^\s*shell: bash\s*$/m);
  assert.match(block, /--user "\$\(id -u\):\$\(id -g\)"/);
  assert.match(block, /-v "\$PWD\/data:\/app\/data"/);
});

test("local-assemblies.yml: data PR は別ブランチ名・別の失敗 Issue タイトル・ワークフロー固有の concurrency group（#201）", () => {
  assert.match(workflow, /DATA_BRANCH: data\/local-assemblies/);
  // Sprint 10 レトロ: 日次（バックフィル）と group を共有していたためキャンセルされた。3本の group は互いに別名。
  assert.match(workflow, /concurrency:\s*\n\s*group: etl-local-assemblies\b/);
  const groupOf = (w: string) => w.match(/concurrency:\s*\n\s*group: (\S+)/)?.[1];
  const groups = [workflow, districts, daily].map(groupOf);
  assert.ok(groups.every(Boolean));
  assert.equal(new Set(groups).size, 3, "concurrency group はワークフローごとに別名");
  const title = workflow.match(/FAILURE_ISSUE_TITLE: "([^"]+)"/)?.[1];
  const others = [districts, daily].map((w) => w.match(/FAILURE_ISSUE_TITLE: "([^"]+)"/)?.[1]);
  assert.ok(title);
  assert.match(title, /local-assemblies\.yml/);
  assert.ok(!others.includes(title));
  // 他の ETL と同じ: マージ待ち → deploy-data.yml 起動、失敗 Issue の dedupe
  assert.match(workflow, /gh workflow run deploy-data\.yml --ref main/);
  assert.match(workflow, /Open failure Issue \(deduped by title\)/);
});

test("local-assemblies.yml: Summary に不明セル（推定せず「不明」にした数）と名寄せできなかった氏名の数を出す", () => {
  const block = stepBlock("Job summary");
  assert.match(block, /unknownCells/);
  assert.match(block, /unmatchedNames/);
  assert.match(block, /data\/assemblies\/"\+process\.argv\[2\]\+"\/meta\.json/); // 議会ごとに meta.json を読む
  assert.match(block, /for pair in \$ASSEMBLIES; do/);
});

test("package.json: `pnpm etl:local miyagi` が local-cli.ts を起動する", () => {
  assert.equal(pkg.scripts["etl:local"], "tsx src/local-cli.ts");
});
