import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Issue #86: ETL をコンテナで動かす。Dockerfile / .dockerignore / compose / etl.yml の「契約」をテストで固定する。
// - 非 root ユーザーで実行する
// - secrets（.env）や data/ .cache をイメージに入れない（実行時に bind mount する）
// - etl.yml はイメージをビルドして `docker run` し、data/ と .cache を同じ uid でマウントする
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

function stepBlock(workflow: string, name: string): string {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `step "${name}" not found`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n\s*- (name|uses|run|id):/);
  return rest.slice(0, next < 0 ? undefined : next);
}

test("Dockerfile: 非 root USER で実行し、pnpm workspace だけをコピーする", () => {
  const df = read("packages/etl/Dockerfile");
  assert.match(df, /^FROM node:24-alpine/m);
  assert.match(df, /^USER (?!root\b)\S+/m, "must switch to a non-root USER");
  assert.match(df, /pnpm install --frozen-lockfile/);
  assert.doesNotMatch(df, /^(ENV|ARG)\s+\S*(TOKEN|SECRET|PASSWORD)/mi, "no secrets baked into the image");
  assert.match(df, /ENTRYPOINT/);
});

test(".dockerignore: data/ .cache .env node_modules はイメージに入れない", () => {
  const ignore = read(".dockerignore").split("\n").map((l) => l.trim());
  for (const p of ["data", "packages/etl/.cache", ".env", ".env.*", "node_modules", ".git"]) {
    assert.ok(ignore.includes(p), `.dockerignore must list ${p}`);
  }
});

test("deploy/docker-compose.etl.yml: etl サービスが data/ と .cache を bind mount し、ホストの uid で動く", () => {
  assert.ok(existsSync(resolve(root, "deploy/docker-compose.etl.yml")));
  const compose = read("deploy/docker-compose.etl.yml");
  assert.match(compose, /^\s+etl:\s*$/m);
  assert.match(compose, /dockerfile: packages\/etl\/Dockerfile/);
  assert.match(compose, /\.\.\/data:\/app\/data/);
  assert.match(compose, /\.\.\/packages\/etl\/\.cache:\/app\/packages\/etl\/\.cache/);
  assert.match(compose, /user: .*ETL_UID/);
});

test("etl.yml: イメージをキャッシュ付きでビルドし、docker run で data/ と .cache を同じ uid でマウントして実行する", () => {
  const workflow = read(".github/workflows/etl.yml");
  assert.match(workflow, /uses: docker\/build-push-action@/);
  assert.match(workflow, /cache-from: type=gha/);
  assert.match(workflow, /push: false/);
  const run = stepBlock(workflow, "Run ETL");
  assert.match(run, /docker run/);
  assert.match(run, /--user "\$\(id -u\):\$\(id -g\)"/);
  assert.match(run, /-v "\$PWD\/data:\/app\/data"/);
  assert.match(run, /-v "\$PWD\/packages\/etl\/\.cache:\/app\/packages\/etl\/\.cache"/);
  assert.match(run, /\| tee etl\.log/);
  assert.match(run, /^\s*shell: bash\s*$/m);
  assert.doesNotMatch(workflow, /pnpm install/, "ETL no longer runs on the runner's node; only the container");
});
