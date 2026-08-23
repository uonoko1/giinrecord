import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Issue #85: web は nginx コンテナ（docker compose）で配信し、共用 VPS のホスト nginx は proxy_pass + TLS だけにする。
// 受け入れ基準「セキュリティヘッダ・CSP・キャッシュが現状と同一（diff をテスト）」を、
// 旧 server block（deploy/nginx-seiji-kiroku.conf, Sprint 1〜5 で本番運用）の値をここに固定して検証する。
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const uncommented = (s: string) =>
  s
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

const siteConf = read("deploy/nginx/site.conf");
const hostProxy = read("deploy/nginx-host-proxy.conf");
const compose = read("deploy/docker-compose.yml");
const setup = uncommented(read("deploy/vps-setup.sh"));
/** heredoc 本文（nginx 設定・案内メッセージ）を除いた、実際に実行されるシェル行 */
const setupCode = setup.replace(/<<'?(\w+)'?\n[\s\S]*?\n\1\n/g, "");
const ci = read(".github/workflows/ci.yml");

/** 旧 deploy/nginx-seiji-kiroku.conf の add_header 行（順序・値とも同一であること） */
const EXPECTED_HEADERS = [
  "add_header X-Content-Type-Options nosniff always;",
  "add_header X-Frame-Options DENY always;",
  "add_header Referrer-Policy strict-origin-when-cross-origin always;",
  `add_header Content-Security-Policy "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'" always;`,
];

function headerLines(conf: string): string[] {
  return conf
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("add_header ") && !/Cache-Control/.test(l));
}

test("site.conf: セキュリティヘッダと CSP は旧 server block と完全一致", () => {
  assert.deepEqual(headerLines(siteConf), EXPECTED_HEADERS);
});

test("site.conf: キャッシュ方針は旧 server block と同一（/assets/ immutable 1年、/data/ 1時間）", () => {
  assert.match(siteConf, /location \/assets\/ \{\s*add_header Cache-Control "public, max-age=31536000, immutable";/);
  assert.match(siteConf, /location \/data\/ \{\s*add_header Cache-Control "public, max-age=3600";/);
});

test("site.conf: プリレンダリング + SPA fallback の try_files と gzip は旧 server block と同一", () => {
  assert.match(siteConf, /try_files \$uri \$uri\/index\.html \/__spa-fallback\.html;/);
  assert.match(siteConf, /gzip_types text\/css application\/javascript application\/json image\/svg\+xml;/);
});

test("ホスト nginx は proxy_pass http://127.0.0.1:8081 だけで、静的配信もヘッダ付与もしない", () => {
  const code = uncommented(hostProxy);
  assert.match(code, /proxy_pass http:\/\/127\.0\.0\.1:8081;/);
  assert.doesNotMatch(code, /^\s*root\s/m);
  assert.doesNotMatch(code, /add_header/);
  assert.doesNotMatch(code, /try_files/);
});

test("docker-compose: nginx:alpine を 127.0.0.1:8081 にだけ公開し、サイトは読み取り専用 bind mount、healthcheck と restart あり", () => {
  assert.match(compose, /image: nginx:[\d.]*-?alpine/);
  assert.match(compose, /"127\.0\.0\.1:8081:80"/);
  assert.doesNotMatch(compose, /"0\.0\.0\.0:|^\s*- "8081:80"/m);
  assert.match(compose, /:\/usr\/share\/nginx\/html:ro/);
  assert.match(compose, /\.\/nginx\/site\.conf:\/etc\/nginx\/conf\.d\/default\.conf:ro/);
  assert.match(compose, /healthcheck:/);
  assert.match(compose, /restart: unless-stopped/);
});

test("docker-compose: 本番は /var/www/seiji-kiroku/site（rsync 先は不変）、ローカルは SITE_DIR で apps/web/build/client", () => {
  assert.match(compose, /\$\{SITE_DIR:-\/var\/www\/seiji-kiroku\/site\}/);
});

test("vps-setup.sh: 何もインストールせず docker を実行もしない。ubuntu に docker 権限を与えない", () => {
  assert.doesNotMatch(setupCode, /apt-get|apt |curl |snap install|get\.docker/);
  assert.doesNotMatch(setupCode, /usermod|gpasswd/);
  assert.doesNotMatch(setupCode, /docker/);
});

test("vps-setup.sh: ホスト proxy の server block を書き、web root を作り、docker compose の手順を表示する", () => {
  assert.match(setup, /proxy_pass http:\/\/127\.0\.0\.1:8081;/);
  assert.match(setup, /\/var\/www\/seiji-kiroku\/site/);
  assert.match(setup, /docker compose -f .*docker-compose\.yml up -d/);
  assert.doesNotMatch(setup, /^\s*root \/var\/www/m, "host nginx must not serve the files directly");
});

test("vps-setup.sh と nginx-host-proxy.conf の server block は同一（ファイルが仕様、スクリプトが写し）", () => {
  const fromScript = setup.match(/<<'CONF'\n([\s\S]*?)\nCONF\n/g);
  assert.ok(fromScript && fromScript.length >= 1, "heredoc CONF not found");
  const blocks = fromScript.map((h) => h.replace(/^<<'CONF'\n/, "").replace(/\nCONF\n$/, ""));
  const expected = uncommented(hostProxy).trim();
  assert.ok(
    blocks.some((b) => uncommented(b).trim() === expected),
    "vps-setup.sh heredoc must match deploy/nginx-host-proxy.conf",
  );
});

test("旧 nginx-seiji-kiroku.conf は削除済み", () => {
  assert.equal(existsSync(resolve(root, "deploy/nginx-seiji-kiroku.conf")), false);
});

test("vps-setup.sh は shellcheck と bash -n を通る", () => {
  const n = spawnSync("bash", ["-n", resolve(root, "deploy/vps-setup.sh")], { encoding: "utf8" });
  assert.equal(n.status, 0, n.stderr);
  const sc = spawnSync("shellcheck", [resolve(root, "deploy/vps-setup.sh")], { encoding: "utf8" });
  if (sc.error) return; // shellcheck not installed locally; CI runs it
  assert.equal(sc.status, 0, sc.stdout);
});

test("ci.yml: docker compose config → up → URL モード smoke（http://127.0.0.1:8081）のジョブがある", () => {
  assert.match(ci, /docker compose -f deploy\/docker-compose\.yml config/);
  assert.match(ci, /docker compose -f deploy\/docker-compose\.yml up -d/);
  assert.match(ci, /smoke -- --url http:\/\/127\.0\.0\.1:8081/);
});

test("docker compose config が通る（docker がある環境のみ）", () => {
  const r = spawnSync("docker", ["compose", "-f", resolve(root, "deploy/docker-compose.yml"), "config", "--quiet"], {
    encoding: "utf8",
    env: { ...process.env, SITE_DIR: resolve(root, "apps/web/build/client") },
  });
  if (r.error) return;
  assert.equal(r.status, 0, r.stderr);
});
