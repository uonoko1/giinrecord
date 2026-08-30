import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Issue #85: web は nginx コンテナ（docker compose）で配信し、共用 VPS のホスト nginx は proxy_pass + TLS だけにする。
// 受け入れ基準「セキュリティヘッダ・CSP・キャッシュが現状と同一（diff をテスト）」を、
// 旧 server block（deploy/nginx-seiji-kiroku.conf, Sprint 1〜5 で本番運用）の値をここに固定して検証する。
// Issue #127: staging（web-staging, 127.0.0.1:8083, /var/www/giinrecord/staging）を同じ site.conf で足し、
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

/**
 * 旧 deploy/nginx-seiji-kiroku.conf の add_header 行（順序・値とも同一であること）＋ #127 の X-Robots-Tag。
 * #168: フォントを自サイト配信にしたので CSP から fonts.googleapis.com / fonts.gstatic.com を外し、font-src 'self'。
 * #194: script-src に 'unsafe-inline'。React Router のプリレンダリング HTML は inline <script>（hydration context・themeInit）を
 * 持ち、内容がページ・ビルドごとに変わるためハッシュ方式は不可。'self' だけだと本番でクライアント JS が一切動かなかった。
 */
const EXPECTED_HEADERS = [
  "add_header X-Content-Type-Options nosniff always;",
  "add_header X-Frame-Options DENY always;",
  "add_header Referrer-Policy strict-origin-when-cross-origin always;",
  `add_header Content-Security-Policy "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; connect-src 'self'" always;`,
  // #127: "" on production hosts (nginx omits add_header with an empty value), "noindex, nofollow" for staging.giinrecord.jp
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

test("site.conf: staging.giinrecord.jp 宛てだけ X-Robots-Tag: noindex, nofollow（Host で判定。同じ conf を両コンテナで使う）", () => {
  assert.match(siteConf, /map \$host \$robots_tag \{\s*default "";\s*staging\.giinrecord\.jp "noindex, nofollow";\s*\}/);
});

// Rename #192（議員レコード / giinrecord.jp）: 旧ドメインは 1 年以上維持し、パスを保って新ドメインへ 301。
test("site.conf: www と旧ドメイン（gikailog.jp / www.gikailog.jp / staging.gikailog.jp）は 301、apex は default_server が配信する", () => {
  assert.match(siteConf, /server_name www\.giinrecord\.jp;\s*return 301 https:\/\/giinrecord\.jp\$request_uri;/);
  assert.match(siteConf, /server_name gikailog\.jp www\.gikailog\.jp;\s*return 301 https:\/\/giinrecord\.jp\$request_uri;/);
  assert.match(siteConf, /server_name staging\.gikailog\.jp;\s*return 301 https:\/\/staging\.giinrecord\.jp\$request_uri;/);
  assert.match(siteConf, /listen 80 default_server;/);
  assert.doesNotMatch(siteConf, /server_name giinrecord\.jp[ ;]/, "the new apex must be served by default_server, not redirected");
});

test("site.conf: キャッシュ方針は旧 server block と同一（/assets/ immutable 1年、/data/ 1時間）", () => {
  assert.match(siteConf, /location \/assets\/ \{\s*add_header Cache-Control "public, max-age=31536000, immutable";/);
  assert.match(siteConf, /location \/data\/ \{\s*add_header Cache-Control "public, max-age=3600";/);
});

test("site.conf: CSP はどの外部ホストも許可しない（#168 フォント自サイト配信。第三者送信ゼロ）", () => {
  const csp = headerLines(siteConf).find((l) => /Content-Security-Policy/.test(l)) ?? "";
  assert.doesNotMatch(csp, /https?:\/\//);
  assert.match(csp, /font-src 'self'/);
});

// Issue #194: 'self' だけの script-src は React Router の inline <script>（hydration context）を遮断し、検索・郵便番号・テーマ・
// 比較が全部動かなかった。inline は許可、外部ホスト・eval は不許可のまま。
test("site.conf: script-src は 'self' 'unsafe-inline'（inline hydration script を通す）。unsafe-eval や外部ホストは無い（#194）", () => {
  const csp = headerLines(siteConf).find((l) => /Content-Security-Policy/.test(l)) ?? "";
  assert.match(csp, /script-src 'self' 'unsafe-inline';/);
  assert.doesNotMatch(csp, /unsafe-eval/);
});

test("ci.yml: docker-web は URL smoke の後に Playwright（chromium）の browser-check を 8081 に対して実行する（#194）", () => {
  const job = ci.slice(ci.indexOf("  docker-web:"));
  assert.match(job, /playwright install --with-deps chromium/);
  assert.match(job, /actions\/cache@v4[\s\S]*?ms-playwright/, "chromium download is cached");
  assert.match(job, /browser-check -- --url http:\/\/127\.0\.0\.1:8081/);
  assert.ok(job.indexOf("smoke -- --url http://127.0.0.1:8081") < job.indexOf("browser-check -- --url"), "browser-check runs after the URL smoke");
});

test("site.conf: /fonts/ は 1 週間キャッシュ（ハッシュ無しのファイル名なので immutable にはしない）", () => {
  assert.match(siteConf, /location \/fonts\/ \{\s*add_header Cache-Control "public, max-age=604800";/);
});

// Issue #325: 存在しない URL が 200 を返していた（try_files の最後が /__spa-fallback.html だったため、
// タイプミスの議員 URL も外部の古いリンクも「中身のあるページ」として索引されうる）。
// 直し方は「try_files の最後を =404 にし、error_page 404 で fallback の本文を 404 のまま返す」。
// ただし /compare（#104）はクエリ依存でプリレンダーされないので、明示的に 200 で fallback を返す location が要る。
test("site.conf: プリレンダー済みは try_files、未知のパスは =404（本文は SPA fallback、ステータスは 404 のまま #325）", () => {
  const code = uncommented(siteConf);
  assert.match(code, /location \/ \{\s*try_files \$uri \$uri\/index\.html =404;/, "try_files の最後は =404");
  assert.doesNotMatch(code, /try_files [^;]*\/__spa-fallback\.html;/, "try_files で fallback に落とすと 200 になる");
  assert.match(code, /error_page 404 \/__spa-fallback\.html;/, "404 の本文は SPA fallback（catch-all ルートが 404 画面を描く）");
  assert.match(code, /location = \/__spa-fallback\.html \{[^}]*internal;/, "fallback 自体は直接取得させない");
  assert.match(code, /gzip_types text\/css application\/javascript application\/json image\/svg\+xml;/);
});

// Issue #104: /compare はクエリ依存でプリレンダーしない。#325 で未知パスを 404 にしたので、
// /compare だけは「fallback の本文を 200 で返す」location を明示しないと壊れる。
test("site.conf: /compare はプリレンダー無しでも 200（クエリ依存の SPA ページ #104 / #325）", () => {
  const code = uncommented(siteConf);
  const block = code.match(/location = \/compare \{[\s\S]*?\n {4}\}/)?.[0];
  assert.ok(block, "location = /compare がある");
  assert.match(block, /try_files \/__spa-fallback\.html =404;/, "fallback の本文をそのまま 200 で返す（rewrite ではなく try_files。=404 は shell が消えたときの保険）");
  assert.doesNotMatch(block, /return 404/, "/compare を無条件に 404 にしてはいけない");
  // `=` の完全一致であること: `location /compare {` だと /compare/anything まで 200 になる
  assert.match(code, /location = \/compare \{/, "前方一致ではなく完全一致");
});

// Issue #325: 設定ファイルの文字列（上の 2 件）と、合成 docroot での実機検査（deploy/test/nginx-404.test.sh）に加えて、
// **本物のビルド成果物**に対して CI が curl で確かめる。合成 docroot は「プリレンダー済みページの形」を真似ただけで、
// 本物のビルドが同じ形をしている保証は無い（prerender.ts が変われば変わる）。docker-web は artifact の
// build/client をそのまま配信しているので、そこで叩くのが最後の砦になる。
test("ci.yml: docker-web は本物のビルドに対して、未知パスが 404・プリレンダー済みと /compare が 200 であることを curl で確かめる（#325）", () => {
  const job = ci.slice(ci.indexOf("  docker-web:"));
  const step = job.slice(job.indexOf("Not found (#325)"), job.indexOf("Legacy domain 301"));
  assert.ok(step.length > 0, "Not found (#325) のステップがある");
  // プリレンダー済み: 退行していないこと
  for (const p of ["/", "/members/", "/coverage/", "/assemblies/", "/rollcalls/"]) {
    assert.match(step, new RegExp(`expect ${p.replace(/\//g, "\\/")}\\s+200`), `${p} が 200 であることを確かめる`);
  }
  // 実在の議員 id は data/ から取る（ハードコードした id は data の作り直しで消える）
  assert.match(step, /MEMBER=\$\(basename/, "議員 id はビルド成果物から取る");
  assert.match(step, /expect "\/members\/\$MEMBER\/"\s+200/);
  // #104: プリレンダー無しの実在ルート
  assert.match(step, /expect '\/compare\?m=[^']*'\s+200/, "/compare が 200 であることを確かめる");
  // #325: 存在しないパス
  assert.match(step, /expect \/this-does-not-exist\/\s+404/);
  assert.match(step, /expect \/__spa-fallback\.html\s+404/, "fallback を直接は取れない");
  // 404 の本文（ステータスだけ 404 で中身は出す）
  assert.match(step, /lang="ja"/);
  assert.match(step, /noindex/);
  assert.match(step, /Hey developer/, "開発者向けメッセージが出ていないことを確かめる");
  assert.ok(job.indexOf("Not found (#325)") > job.indexOf("docker compose -f deploy/docker-compose.yml up"), "コンテナを起動した後で叩く");
});

// Issue #189: the container nginx must not log requests at all (the default combined format writes the User-Agent
// to stdout / docker logs, contradicting the privacy policy). Only the host nginx keeps its IP-less "noip" log.
test("site.conf: access_log off を server 全体に（既定 combined 形式は User-Agent を docker logs に残す #189）", () => {
  const code = uncommented(siteConf);
  const main = code.slice(code.indexOf("listen 80 default_server"));
  const server = main.slice(0, main.indexOf("location /"));
  assert.match(server, /^\s*access_log off;$/m, "access_log off at server level, not only in /__health");
  assert.doesNotMatch(code, /access_log\s+\/|log_format/, "no access log file anywhere in the container conf");
});

test("docker-compose: json-file の logging に max-size / max-file の上限（古い docker logs はローテーションで消える #189）", () => {
  assert.match(compose, /^x-web: &web\n(?:.*\n)*?\s+logging:\n\s+driver: json-file\n\s+options:\n\s+max-size: "\d+[kmg]"\n\s+max-file: "\d+"/m);
});

test("ホスト proxy: 自サイトの server block ごとに error_log（crit のみ。接続元 IP は診断ログに短期間だけ残る #189）", () => {
  const code = uncommented(hostProxy);
  const lines = code.match(/^\s*error_log \/var\/log\/nginx\/LOG_NAME\.error\.log crit;$/gm) ?? [];
  assert.equal(lines.length, 2, "one error_log per server block (:80 and :443)");
  const fromScript = setup.match(/^\s*error_log \/var\/log\/nginx\/LOG_NAME\.error\.log crit;$/gm) ?? [];
  assert.ok(fromScript.length >= 3, "template (2 blocks) + bootstrap block in vps-setup.sh");
  assert.match(setup, /^ensure_error_log\(\)/m, "certbot-managed confs get the line inserted idempotently");
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

test("docker-compose: 本番は /var/www/giinrecord/site（rsync 先は不変）、ローカルは SITE_DIR で apps/web/build/client", () => {
  assert.match(compose, /\$\{SITE_DIR:-\/var\/www\/giinrecord\/site\}/);
});

test("docker-compose: web-staging は 127.0.0.1:8083 だけに公開し、/var/www/giinrecord/staging を同じ site.conf で読み取り専用配信する", () => {
  const at = compose.indexOf("web-staging:");
  assert.ok(at > 0, "web-staging service missing");
  const staging = compose.slice(at);
  // image / healthcheck / restart / logging come from the shared `x-web` anchor (same as `web`)
  assert.match(compose, /^x-web: &web\n\s+image: nginx:[\d.]*-?alpine/m);
  assert.match(staging, /<<: \*web/);
  assert.match(staging, /"127\.0\.0\.1:8083:80"/);
  assert.match(staging, /\$\{STAGING_SITE_DIR:-\/var\/www\/giinrecord\/staging\}:\/usr\/share\/nginx\/html:ro/);
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
  assert.match(setup, /\/var\/www\/giinrecord\/site/);
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

// Issue #127: vps-setup.sh <domain> [port] — 8081 = production (giinrecord.conf, site/), 8083 = staging (giinrecord-staging.conf, staging/).
// deploy/test/render-host-proxy.sh は同じ関数で server block を stdout に描くだけ（root 不要）。
test("vps-setup.sh: port 8083 なら staging の conf 名・web root・ログ名（8081 が既定）。置換後に placeholder が残らない", () => {
  assert.match(setupCode, /PORT="\$\{2:-8081\}"/);
  assert.match(setup, /8081\)\s*NAME=giinrecord;\s*SITE_DIR=\/var\/www\/giinrecord\/site/);
  assert.match(setup, /8083\)\s*NAME=giinrecord-staging;\s*SITE_DIR=\/var\/www\/giinrecord\/staging/);
  assert.match(setup, /SITE_CONF=\/etc\/nginx\/sites-available\/\$NAME\.conf/);
  const render = (domain: string, port: string) => {
    const r = spawnSync("bash", [resolve(root, "deploy/test/render-host-proxy.sh"), domain, port], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const prod = render("giinrecord.jp", "8081");
  assert.match(prod, /server_name giinrecord\.jp www\.giinrecord\.jp;/);
  assert.match(prod, /proxy_pass http:\/\/127\.0\.0\.1:8081;/);
  assert.match(prod, /access_log \/var\/log\/nginx\/giinrecord\.access\.log noip;/);
  const staging = render("staging.giinrecord.jp", "8083");
  assert.match(staging, /server_name staging\.giinrecord\.jp;/);
  assert.doesNotMatch(staging, /www\./);
  assert.match(staging, /proxy_pass http:\/\/127\.0\.0\.1:8083;/);
  assert.match(staging, /access_log \/var\/log\/nginx\/giinrecord-staging\.access\.log noip;/);
  for (const out of [prod, staging]) assert.doesNotMatch(out, /\bPORT\b|LOG_NAME|\bDOMAIN\b|SERVER_NAMES|CF_GATE/);
  // Issue #163: only the staging 443 location / is gated (Cloudflare ranges + Cf-Access-Jwt-Assertion); production is open
  assert.match(staging, /include \/etc\/nginx\/snippets\/giinrecord-cloudflare-allow\.conf;/);
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
  assert.match(ci, /Host: staging\.giinrecord\.jp/);
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
  assert.match(deploySite, /\/var\/www\/giinrecord\/\$TARGET_DIR\//);
  assert.match(deploySite, /TARGET_DIR: \$\{\{ inputs\.target_dir \}\}/);
  assert.doesNotMatch(uncommented(deploySite), /docker/);
});

test("deploy-staging.yml: main への push で environment staging、SITE_ORIGIN=https://staging.giinrecord.jp、rsync 先 staging", () => {
  assert.match(deployStaging, /push:\s*\n\s*branches: \[main\]/);
  assert.match(deployStaging, /uses: \.\/\.github\/workflows\/deploy-site\.yml/);
  assert.match(deployStaging, /environment: staging/);
  assert.match(deployStaging, /site_origin: https:\/\/staging\.giinrecord\.jp/);
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

// Issue #119: 改名（seiji-kiroku → giinrecord）の追従。パス・conf 名・project name は新名で、go-live.sh は旧環境を移行する。
test("compose project / パス / nginx conf / 計測 cron はすべて giinrecord 名", () => {
  assert.match(compose, /^name: giinrecord$/m);
  assert.match(setup, /\/etc\/nginx\/sites-available\/\$NAME\.conf/);
  assert.match(setup, /\/etc\/nginx\/conf\.d\/giinrecord-noip-log\.conf/);
  assert.match(deploySite, /\/var\/www\/giinrecord\//);
  const analytics = read("deploy/analytics/vps-analytics-setup.sh");
  assert.match(analytics, /\/etc\/cron\.d\/giinrecord-analytics/);
  assert.match(analytics, /\/usr\/local\/lib\/giinrecord-analytics/);
  assert.match(analytics, /\/var\/log\/nginx\/giinrecord\.access\.log/);
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
