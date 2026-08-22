import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Issue #58 レビュー指摘: deploy 鍵ユーザー ubuntu を adm グループに入れると VPS 上の他サイトのログや
// auth.log まで読めてしまう。cron は root で動かし、集計 TSV だけを ubuntu 所有 mode 600 で渡す。
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const setup = readFileSync(resolve(root, "deploy/analytics/vps-analytics-setup.sh"), "utf8");
const daily = resolve(root, "deploy/analytics/daily.sh");
const fixture = resolve(here, "fixtures/analytics-access.log.txt");

function runDaily(day: string, owner: string) {
  const dir = mkdtempSync(join(tmpdir(), "analytics-"));
  const log = join(dir, "access.log");
  copyFileSync(fixture, log);
  const out = join(dir, "out");
  const r = spawnSync("bash", [daily, day], {
    encoding: "utf8",
    env: { ...process.env, ANALYTICS_LOG: log, ANALYTICS_OUT: out, ANALYTICS_OWNER: owner },
  });
  assert.equal(r.status, 0, r.stderr);
  return { out, stdout: r.stdout };
}

test("setup は ubuntu を adm グループに入れない", () => {
  const code = setup
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  assert.doesNotMatch(code, /usermod/);
  assert.doesNotMatch(code, /\badm\b/);
});

test("cron は root で daily.sh を実行する（ubuntu には /var/log/nginx の読み取り権限を与えない）", () => {
  const cronLine = setup.split("\n").find((l) => /^10 0 \* \* \* /.test(l));
  assert.ok(cronLine, "cron.d の行が無い");
  assert.match(cronLine, /^10 0 \* \* \* root /);
});

test("daily.sh は TSV を mode 600、出力ディレクトリを 700 で書き、tmp ファイルを残さない", () => {
  // root でない環境では chown は効かないが、mode と tmp の後始末は同じ経路で検証できる
  const { out } = runDaily("2026-08-22", "nobody");
  const tsv = join(out, "2026-08-22.tsv");
  assert.equal(statSync(tsv).mode & 0o777, 0o600);
  assert.equal(statSync(out).mode & 0o777, 0o700);
  assert.equal(readFileSync(tsv, "utf8").split("\n")[0], "date\tpage\treferrer\tpv");
  assert.throws(() => statSync(`${tsv}.tmp`));
});

test("daily.sh は ANALYTICS_OWNER が無くても（ubuntu の手動実行）動く", () => {
  const { stdout } = runDaily("2026-08-23", "");
  assert.match(stdout, /2026-08-23 -> /);
});
