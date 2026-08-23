import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Issue #85: web は nginx コンテナ（docker compose）で配信し、共用 VPS のホスト nginx は proxy_pass + TLS だけにする。
// 受け入れ基準「セキュリティヘッダ・CSP・キャッシュが現状と同一（diff をテスト）」を、
// 旧 server block（deploy/nginx-gikailog.conf, Sprint 1〜5 で本番運用）の値をここに固定して検証する。
// Issue #127: staging（web-staging, 127.0.0.1:8083, /var/www/gikailog/staging）を同じ site.conf で足し、
// main push → staging 自動、production は release.yml の承認付き手動リリース。
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
const deploySite = read(".github/workflows/deploy-site.yml");
const deployStaging = read(".github/workflows/deploy-staging.yml");
const release = read(".github/workflows/release.yml");
const deployData = read(".github/workflows/deploy-data.yml");

/** 旧 deploy/nginx-gikailog.conf の add_header 行（順序・値とも同一であること）＋ #127 の X-Robots-Tag */
const EXPECTED_HEADERS = [
  "add_header X-Content-Type-Options nosniff always;",
  "add_header X-Frame-Options DENY always;",
  "add_header Referrer-Policy strict-origin-when-cross-origin always;",
  `add_header Content-Security-Policy "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'" always;`,
  // #127: "" on production hosts (nginx omits add_header with an empty value), "noindex, nofollow" for staging.gikailog.jp
  "add_header X-Robots-Tag $robots_tag always;",
];

function headerLines(conf: string): string[] {
  return conf
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("add_header ") && !/Cache-Control/.test(l));
}

test("site.conf: セキュリティヘッダと CSP は旧 server block と完全一致（+ staging 用 X-Robots-Tag）", () => {
  assert.deepEqual(headerLines(siteConf), EXPECTED_HEADERS);
});

test("site.conf: staging.gikailog.jp 宛てだけ X-Robots-Tag: noindex, nofollow（Host で判定。同じ conf を両コンテナで使う）", () => {
  assert.match(siteConf, /map \$host \$robots_tag \{\s*default "";\s*staging\.gikailog\.jp "noindex, nofollow";\s*\}/);
});

test("site.conf: キャッシュ方針は旧 server block と同一（/assets/ immutable 1年、/data/ 1時間）", () => {
  assert.match(siteConf, /location \/assets\/ \{\s*add_header Cache-Control "public, max-age=31536000, immutable";/);
  assert.match(siteConf, /location \/data\/ \{\s*add_header Cache-Control "public, max-age=3600";/);
});

test("site.conf: プリレンダリング + SPA fallback の try_files と gzip は旧 server block と同一", () => {
  assert.match(siteConf, /try_files \$uri \$uri\/index\.html \/__spa-fallback\.html;/);
  assert.match(siteConf, /gzip_types text\/css application\/javascript application\/json image\/svg\+xml;/);
});

test("ホスト nginx は proxy_pass http://127.0.0.1:PORT（vps-setup.sh が 8081/8083 を埋める）だけで、静的配信もヘッダ付与もしない", () => {
  const code = uncommented(hostProxy);
  assert.match(code, /proxy_pass http:\/\/127\.0\.0\.1:PORT;/);
  assert.match(code, /access_log \/var\/log\/nginx\/LOG_NAME\.access\.log noip;/);
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

test("docker-compose: 本番は /var/www/gikailog/site（rsync 先は不変）、ローカルは SITE_DIR で apps/web/build/client", () => {
  assert.match(compose, /\$\{SITE_DIR:-\/var\/www\/gikailog\/site\}/);
});

test("docker-compose: web-staging は 127.0.0.1:8083 だけに公開し、/var/www/gikailog/staging を同じ site.conf で読み取り専用配信する", () => {
  const at = compose.indexOf("web-staging:");
  assert.ok(at > 0, "web-staging service missing");
  const staging = compose.slice(at);
  // image / healthcheck / restart / logging come from the shared `x-web` anchor (same as `web`)
  assert.match(compose, /^x-web: &web\n\s+image: nginx:[\d.]*-?alpine/m);
  assert.match(staging, /<<: \*web/);
  assert.match(staging, /"127\.0\.0\.1:8083:80"/);
  assert.match(staging, /\$\{STAGING_SITE_DIR:-\/var\/www\/gikailog\/staging\}:\/usr\/share\/nginx\/html:ro/);
  assert.match(staging, /\.\/nginx\/site\.conf:\/etc\/nginx\/conf\.d\/default\.conf:ro/);
  assert.doesNotMatch(compose, /"0\.0\.0\.0:|^\s*- "8083:80"/m);
});

test("vps-setup.sh: 何もインストールせず docker を実行もしない。ubuntu に docker 権限を与えない", () => {
  assert.doesNotMatch(setupCode, /apt-get|apt |curl |snap install|get\.docker/);
  assert.doesNotMatch(setupCode, /usermod|gpasswd/);
  assert.doesNotMatch(setupCode, /docker/);
});

test("vps-setup.sh: ホスト proxy の server block を書き、web root を作り、docker compose の手順を表示する", () => {
  assert.match(setup, /proxy_pass http:\/\/127\.0\.0\.1:PORT;/);
  assert.match(setup, /\/var\/www\/gikailog\/site/);
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

// Issue #127: vps-setup.sh <domain> [port] — 8081 = production (gikailog.conf, site/), 8083 = staging (gikailog-staging.conf, staging/).
// deploy/test/render-host-proxy.sh は同じ関数で server block を stdout に描くだけ（root 不要）。
test("vps-setup.sh: port 8083 なら staging の conf 名・web root・ログ名（8081 が既定）。置換後に placeholder が残らない", () => {
  assert.match(setupCode, /PORT="\$\{2:-8081\}"/);
  assert.match(setup, /8081\)\s*NAME=gikailog;\s*SITE_DIR=\/var\/www\/gikailog\/site/);
  assert.match(setup, /8083\)\s*NAME=gikailog-staging;\s*SITE_DIR=\/var\/www\/gikailog\/staging/);
  assert.match(setup, /SITE_CONF=\/etc\/nginx\/sites-available\/\$NAME\.conf/);
  const render = (domain: string, port: string) => {
    const r = spawnSync("bash", [resolve(root, "deploy/test/render-host-proxy.sh"), domain, port], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const prod = render("gikailog.jp", "8081");
  assert.match(prod, /server_name gikailog\.jp www\.gikailog\.jp;/);
  assert.match(prod, /proxy_pass http:\/\/127\.0\.0\.1:8081;/);
  assert.match(prod, /access_log \/var\/log\/nginx\/gikailog\.access\.log noip;/);
  const staging = render("staging.gikailog.jp", "8083");
  assert.match(staging, /server_name staging\.gikailog\.jp;/);
  assert.doesNotMatch(staging, /www\./);
  assert.match(staging, /proxy_pass http:\/\/127\.0\.0\.1:8083;/);
  assert.match(staging, /access_log \/var\/log\/nginx\/gikailog-staging\.access\.log noip;/);
  for (const out of [prod, staging]) assert.doesNotMatch(out, /\bPORT\b|LOG_NAME|\bDOMAIN\b|SERVER_NAMES|CF_GATE/);
  // Issue #163: only the staging 443 location / is gated (Cloudflare ranges + Cf-Access-Jwt-Assertion); production is open
  assert.match(staging, /include \/etc\/nginx\/snippets\/gikailog-cloudflare-allow\.conf;/);
  assert.match(staging, /if \(\$http_cf_access_jwt_assertion = ""\) \{ return 403; \}/);
  assert.doesNotMatch(prod, /cloudflare|cf_access|403/);
  assert.match(hostProxy, /^CF_GATE$/m, "the template keeps the CF_GATE placeholder in the 443 location /");
  const bad = spawnSync("bash", [resolve(root, "deploy/test/render-host-proxy.sh"), "x.example", "9000"], { encoding: "utf8" });
  assert.notEqual(bad.status, 0, "unknown port must be rejected");
});

test("vps-setup.sh は shellcheck と bash -n を通る", () => {
  const n = spawnSync("bash", ["-n", resolve(root, "deploy/vps-setup.sh")], { encoding: "utf8" });
  assert.equal(n.status, 0, n.stderr);
  const sc = spawnSync("shellcheck", [resolve(root, "deploy/vps-setup.sh")], { encoding: "utf8" });
  if (sc.error) return; // shellcheck not installed locally; CI runs it
  assert.equal(sc.status, 0, sc.stdout);
});

test("ci.yml: docker compose config → up → URL モード smoke を 8081 と 8083 の両方で、staging の X-Robots-Tag も検査する", () => {
  assert.match(ci, /docker compose -f deploy\/docker-compose\.yml config/);
  assert.match(ci, /docker compose -f deploy\/docker-compose\.yml up -d/);
  assert.match(ci, /smoke -- --url http:\/\/127\.0\.0\.1:8081/);
  assert.match(ci, /smoke -- --url http:\/\/127\.0\.0\.1:8083/);
  assert.match(ci, /STAGING_SITE_DIR:/);
  assert.match(ci, /Host: staging\.gikailog\.jp/);
  assert.match(ci, /x-robots-tag: noindex, nofollow/i);
});

// Issue #127: main push → staging（自動）、production は release.yml（workflow_dispatch + environment production の承認）。
// 日次データは deploy-data.yml が staging と production の両方へ流す（bot のマージは push イベントを起こさない）。
test("deploy-site.yml: 再利用ワークフロー。environment / site_origin / target_dir / ref を入力で受け、docker を呼ばない", () => {
  assert.match(deploySite, /workflow_call:/);
  for (const input of ["environment", "site_origin", "target_dir", "ref"]) assert.match(deploySite, new RegExp(`^\\s+${input}:`, "m"), input);
  assert.match(deploySite, /environment: \$\{\{ inputs\.environment \}\}/);
  assert.match(deploySite, /SITE_ORIGIN: \$\{\{ inputs\.site_origin \}\}/);
  assert.match(deploySite, /ref: \$\{\{ inputs\.ref \}\}/);
  assert.match(deploySite, /rsync -az --delete --exclude '\.well-known'/);
  assert.match(deploySite, /\/var\/www\/gikailog\/\$TARGET_DIR\//);
  assert.match(deploySite, /TARGET_DIR: \$\{\{ inputs\.target_dir \}\}/);
  assert.doesNotMatch(uncommented(deploySite), /docker/);
});

test("deploy-staging.yml: main への push で environment staging、SITE_ORIGIN=https://staging.gikailog.jp、rsync 先 staging", () => {
  assert.match(deployStaging, /push:\s*\n\s*branches: \[main\]/);
  assert.match(deployStaging, /uses: \.\/\.github\/workflows\/deploy-site\.yml/);
  assert.match(deployStaging, /environment: staging/);
  assert.match(deployStaging, /site_origin: https:\/\/staging\.gikailog\.jp/);
  assert.match(deployStaging, /target_dir: staging/);
  assert.doesNotMatch(deployStaging, /production/);
});

test("release.yml: workflow_dispatch（入力 ref、既定 main）だけで起動し、environment production（required reviewers）へ rsync 先 site", () => {
  assert.match(release, /workflow_dispatch:/);
  assert.doesNotMatch(release, /^\s*push:/m);
  assert.doesNotMatch(release, /^\s*schedule:/m);
  assert.match(release, /^\s+ref:\s*\n(\s+\w+:[^\n]*\n)*?\s+default: main$/m);
  assert.match(release, /environment: production\s*$/m);
  assert.match(release, /site_origin: \$\{\{ vars\.SITE_ORIGIN \}\}/);
  assert.match(release, /target_dir: site/);
  assert.match(release, /ref: \$\{\{ inputs\.ref \}\}/);
});

test("deploy-data.yml: workflow_dispatch（etl.yml / districts.yml から）で staging と production-data の両方へ main を配る", () => {
  assert.match(deployData, /workflow_dispatch:/);
  assert.match(deployData, /environment: staging/);
  assert.match(deployData, /environment: production-data/);
  assert.match(deployData, /target_dir: staging/);
  assert.match(deployData, /target_dir: site/);
  assert.doesNotMatch(deployData, /environment: production\s*$/m, "the data path must not wait for the production reviewers");
  for (const f of [".github/workflows/etl.yml", ".github/workflows/districts.yml"]) {
    assert.match(read(f), /gh workflow run deploy-data\.yml --ref main/, `${f} must dispatch deploy-data.yml`);
    assert.doesNotMatch(read(f), /gh workflow run deploy\.yml/, `${f} still dispatches the removed deploy.yml`);
  }
});

// Issue #134: production の日次データは「最後にリリースした ref のコード + main の data/」。release.yml が成功時にタグ
// `released` を動かし、deploy-data.yml はそれを resolve して deploy-site.yml に ref として渡し、data_ref: main で overlay する。
test("release.yml: 成功時だけ GITHUB_TOKEN（contents: write）で refs/tags/released を released sha へ動かす", () => {
  assert.match(release, /^\s+released-tag:\s*\n\s+(#[^\n]*\n\s+)*needs: production$/m, "runs after (and only on success of) the production job");
  assert.match(release, /contents: write/);
  assert.match(release, /needs\.production\.outputs\.sha/);
  assert.match(release, /refs\/tags\/released/);
  assert.doesNotMatch(release, /DEPLOY_SSH_KEY/, "the tag job must not touch the deploy key");
});

test("deploy-site.yml: data_ref 入力（既定空）で released-ref.sh overlay を呼び、ビルドした sha を output に出す", () => {
  assert.match(deploySite, /^\s+data_ref:\s*\n(\s+\w+:[^\n]*\n)*?\s+default: ""$/m);
  assert.match(deploySite, /scripts\/ci\/released-ref\.sh overlay "\$DATA_REF"/);
  assert.match(deploySite, /DATA_REF: \$\{\{ inputs\.data_ref \}\}/);
  assert.match(deploySite, /^\s+sha:\s*\n\s+description:[^\n]*\n\s+value: \$\{\{ jobs\.deploy\.outputs\.sha \}\}$/m);
  const overlayAt = deploySite.lastIndexOf("released-ref.sh overlay");
  assert.ok(overlayAt > deploySite.indexOf("actions/checkout") && overlayAt < deploySite.indexOf("pnpm build"), "overlay runs after checkout and before the build");
});

test("deploy-data.yml: staging は main、production は released-ref.sh resolve の ref + data_ref: main", () => {
  const staging = deployData.slice(deployData.indexOf("  staging:"), deployData.indexOf("  production:"));
  assert.match(staging, /ref: main/);
  assert.doesNotMatch(staging, /data_ref/);
  const production = deployData.slice(deployData.indexOf("  production:"));
  assert.match(production, /ref: \$\{\{ needs\.resolve\.outputs\.ref \}\}/);
  assert.match(production, /data_ref: main/);
  assert.match(deployData, /scripts\/ci\/released-ref\.sh resolve/);
});

test("released-ref.sh: resolve / overlay のテスト（scripts/ci/test/released-ref.test.sh）が通る", () => {
  const r = spawnSync("bash", [resolve(root, "scripts/ci/test/released-ref.test.sh")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("staging-setup.sh: 1 回だけの root 作業のテスト（deploy/test/staging-setup.test.sh）が通る", () => {
  const r = spawnSync("bash", [resolve(root, "deploy/test/staging-setup.test.sh")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// Issue #119: 改名（seiji-kiroku → gikailog）の追従。パス・conf 名・project name は新名で、go-live.sh は旧環境を移行する。
test("compose project / パス / nginx conf / 計測 cron はすべて gikailog 名", () => {
  assert.match(compose, /^name: gikailog$/m);
  assert.match(setup, /\/etc\/nginx\/sites-available\/\$NAME\.conf/);
  assert.match(setup, /\/etc\/nginx\/conf\.d\/gikailog-noip-log\.conf/);
  assert.match(deploySite, /\/var\/www\/gikailog\//);
  const analytics = read("deploy/analytics/vps-analytics-setup.sh");
  assert.match(analytics, /\/etc\/cron\.d\/gikailog-analytics/);
  assert.match(analytics, /\/usr\/local\/lib\/gikailog-analytics/);
  assert.match(analytics, /\/var\/log\/nginx\/gikailog\.access\.log/);
  for (const f of [
    "deploy/go-live.sh",
    "deploy/staging-setup.sh",
    "deploy/vps-setup.sh",
    "deploy/docker-compose.yml",
    "deploy/nginx-host-proxy.conf",
    ".github/workflows/deploy-site.yml",
    ".github/workflows/deploy-staging.yml",
    ".github/workflows/release.yml",
    ".github/workflows/deploy-data.yml",
  ]) {
    // go-live.sh は移行元として OLD=seiji-kiroku を 1 箇所だけ持つ
    const code = uncommented(read(f)).replace(/^OLD=seiji-kiroku$/m, "");
    assert.doesNotMatch(code, /seiji-kiroku/, `${f} still references the old name`);
  }
});

test("go-live.sh: 旧パス移行のテスト（deploy/test/go-live.test.sh）が通る", () => {
  const r = spawnSync("bash", [resolve(root, "deploy/test/go-live.test.sh")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("docker compose config が通る（docker がある環境のみ）", () => {
  const r = spawnSync("docker", ["compose", "-f", resolve(root, "deploy/docker-compose.yml"), "config", "--quiet"], {
    encoding: "utf8",
    env: { ...process.env, SITE_DIR: resolve(root, "apps/web/build/client"), STAGING_SITE_DIR: resolve(root, "apps/web/build/client") },
  });
  if (r.error) return;
  assert.equal(r.status, 0, r.stderr);
});
