# 配信の運用（web コンテナ + ホスト nginx、staging / production）

Issue #85・#127。構成と初回セットアップは `deploy/README.md`。ここは日常運用（リリース手順）と障害時の手順。

## 環境とワークフロー（#127）

| 環境 | URL | 配信元 | コード | データ |
|---|---|---|---|---|
| staging | https://staging.giinrecord.jp | `web-staging`（127.0.0.1:8083）← `/var/www/giinrecord/staging` | `main` への push で自動（`deploy-staging.yml`） | 自動（`deploy-data.yml`） |
| production | https://giinrecord.jp | `web`（127.0.0.1:8081）← `/var/www/giinrecord/site` | 手動リリース（`release.yml`、成功時にタグ `released` を更新） | 自動（`deploy-data.yml`：コードは `released`、`data/` は `main`） |

- 3 つとも再利用ワークフロー `deploy-site.yml`（`pnpm build` → `rsync --delete`）を呼ぶだけ。違いは Environment・`SITE_ORIGIN`・rsync 先・（production-data だけ）`data_ref: main` の overlay。
- staging ビルド（`SITE_ORIGIN=https://staging.giinrecord.jp`）は `robots.txt` が `Disallow: /`、全ページに `<meta name="robots" content="noindex, nofollow">`（`apps/web/app/lib/seo.ts`）。さらにコンテナの `site.conf` が Host `staging.giinrecord.jp` に `X-Robots-Tag: noindex, nofollow` を付ける。
- GitHub Environment：`staging`、`production`（**required reviewers = 承認ボタン**。PO が設定）、`production-data`（reviewers 無し）。3 つとも同じ `DEPLOY_*` secrets。

### リリース手順（production）

1. staging（https://staging.giinrecord.jp/）で確認する。`main` の最新は push 後数分で出ている（Actions → Deploy (staging)）。
2. Actions → **Release** → Run workflow。`ref` は既定 `main`（タグや SHA も可）→ Run。
3. `production` Environment の承認待ちになる → Review deployments → Approve。
4. 完了後 https://giinrecord.jp/ で確認（title『議員レコード』、`curl -sI https://giinrecord.jp/ | grep -i x-robots-tag` が空、sitemap の `<loc>` が `https://giinrecord.jp/`）。

ロールバックは「前の SHA を `ref` にして Release」。

### 日次データ（`deploy-data.yml`）

ETL の data PR がマージされると `etl.yml` / `districts.yml` が `gh workflow run deploy-data.yml --ref main` を起動し、staging と production（Environment `production-data`、承認なし）の両方に配る。

- **staging** は `main` をそのままビルドする（従来どおり）。
- **production** は「最後にリリースしたコード + `main` の `data/`」をビルドする（#134）。`main` にマージ済みで未リリースのコードは日次データと一緒に本番へ出ない。
  1. `resolve` ジョブが `scripts/ci/released-ref.sh resolve` で `refs/tags/released` の SHA を取る（タグが無ければ `main`。初回 Release 前のフォールバック）。
  2. `deploy-site.yml` がその SHA を checkout し、`data_ref: main` で `released-ref.sh overlay main`（`data/` を丸ごと main のものに置き換える。追加も削除も反映、`data/` 以外は触らない）→ `pnpm build` → rsync。
- タグ `released` は **Release が成功したときだけ** `release.yml` の `released-tag` ジョブが REST API（`GITHUB_TOKEN`、`contents: write`）で動かす（#127 の承認フローの外、deploy secrets は使わない）。ロールバックで古い SHA を Release すればタグもそこへ戻る。手で打ち直すなら `git push -f origin <sha>:refs/tags/released`（次の deploy-data から効く）。
- 確認：Actions → Deploy data の Summary に `production code ref: <sha>` と `deployed ref <sha> + data/ from main` が出る。`gh api repos/uonoko1/giinrecord/git/ref/tags/released` で現在のタグ。
- 注意：`released` が指す SHA には `scripts/ci/released-ref.sh` が含まれている必要がある（#134 以前の SHA を Release するとタグは動くが次の deploy-data が overlay ステップで失敗する。その場合は新しい SHA を Release し直す）。

## 構成の要点

- 静的ファイルは `deploy-site.yml` が `rsync --delete` で `/var/www/giinrecord/site/`（production）と `/var/www/giinrecord/staging/`（staging）に置く（所有者 `ubuntu`）。**ここは変えない**。
- それぞれを `web` / `web-staging` コンテナ（`nginx:alpine`、`deploy/docker-compose.yml`、同じ `site.conf`）が**読み取り専用**で bind mount し、`127.0.0.1:8081` / `127.0.0.1:8083` だけに公開する。
- ホスト nginx（共用。他サイトも同居）は `server_name` ごとの block で TLS を終端し `proxy_pass` するだけ（`deploy/nginx-host-proxy.conf`、`sites-available/giinrecord.conf` と `giinrecord-staging.conf`）。SPA fallback・キャッシュ・セキュリティヘッダ・staging の noindex は全部コンテナ側 `deploy/nginx/site.conf`。
- www→apex：ホスト側 `:80` block は www も apex も `https://giinrecord.jp` へ 301（テンプレートで定義。certbot の `--redirect` は使わない）。`:443` は両ホスト名を proxy し、https の www→apex 301 はコンテナの `site.conf`（#141）。
- 権限：`ubuntu`（CI の rsync 鍵）は docker を触れない。docker のインストールと `docker compose` は人間が sudo／docker 権限で行う。
- デプロイでコンテナの再起動は不要（bind mount なので rsync 直後から新ファイルが配信される）。**ただし `site.conf` / `docker-compose.yml` の変更は `git pull` だけでは反映されない**：bind mount した単一ファイルは `git pull` で inode が変わり、コンテナは古い inode を掴んだまま。必ず `docker compose ... up -d --force-recreate`（setup 系スクリプトは常にこれを付ける、#141）。

## CSP の方針（#168、#194）

`deploy/nginx/site.conf` の `Content-Security-Policy`：

```
default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; connect-src 'self'
```

- **外部ホストはどの directive にも書かない**（#168 でフォントを自サイト配信にして以来。第三者送信ゼロ）。`packages/etl/test/deploy-docker.test.ts` が `https?://` を含まないことを検査する。
- **`script-src` は `'self' 'unsafe-inline'`**（#194）。React Router のプリレンダリング HTML は inline `<script>` を 8 個持つ（hydration context の `window.__reactRouterContext`、`themeInit`、install capture）。`'self'` だけだとこれが全部遮断され、本番でハイドレーションが起きず検索・郵便番号・テーマ切替・比較が動かなかった（2026-08-24 の障害）。
- **ハッシュ方式（`'sha256-…'`）は採らない**：hydration context はページごと（loader data）・ビルドごとに中身が変わるので 1,100 ページ × ビルドごとのハッシュ一覧を nginx に渡すことになり維持できない。nonce は動的サーバが要る（静的配信 + nginx では不可）。ユーザー生成コンテンツが無い静的サイトなので inline 許可の実害は小さい。`'unsafe-eval'` は許可しない。
- **ヘッダだけでは検出できない**ので、CI の `docker-web` ジョブは URL smoke の後に `pnpm --filter web browser-check -- --url http://127.0.0.1:8081`（`apps/web/scripts/browser-check.ts`、Playwright chromium）を実行する：`/`・`/members/`・`/rollcalls/`・議員ページ 1 つを開き、console error と `securitypolicyviolation` が 0、`/members/` の検索入力で行数が減ることを確認。
- **本番反映後の確認（PO）**：VPS で `git pull && docker compose -f deploy/docker-compose.yml up -d --force-recreate` の後、手元で `pnpm --filter web exec playwright install --with-deps chromium`（初回のみ）→ `pnpm --filter web browser-check -- --url https://giinrecord.jp`。

## 改名の移行（gikailog → giinrecord）

VPS 上のパス・conf・cron・compose project はすべて `giinrecord` 名（`/opt/giinrecord`、`/var/www/giinrecord/site`、`sites-available/giinrecord.conf`、`conf.d/giinrecord-noip-log.conf`、`cron.d/giinrecord-analytics`、コンテナ `giinrecord-web-1`）。旧名（`gikailog`）が残っているホストでは `deploy/go-live.sh` の step 0（`migrate_legacy()`）が冪等に移行する。前回の `seiji-kiroku` → `gikailog`（#119）と同じ手口で、扱う旧名は 1 段（`gikailog`）だけ。

**中身ごと `mv` するもの**（新パスが既にあれば旧を残して警告するだけ。上書きも併合もしない）:

| 旧 | 新 |
|---|---|
| `/opt/gikailog` | `/opt/giinrecord` |
| `/var/www/gikailog`（`site` / `staging`） | `/var/www/giinrecord` |
| `/usr/local/lib/gikailog-analytics` | `/usr/local/lib/giinrecord-analytics` |
| `/usr/local/lib/gikailog-monitor` | `/usr/local/lib/giinrecord-monitor` |
| `/usr/local/lib/gikailog-cloudflare-allowlist.sh` | `/usr/local/lib/giinrecord-cloudflare-allowlist.sh` |
| `/etc/gikailog/`（`monitor.token` を含む） | `/etc/giinrecord/` |
| `/var/lib/gikailog-monitor/`（open-issue 状態） | `/var/lib/giinrecord-monitor/` |
| `/var/log/gikailog-monitor.log` / `-analytics.log` | `/var/log/giinrecord-monitor.log` / `-analytics.log` |
| `/var/log/nginx/gikailog{,-staging}.{access,error}.log` | `/var/log/nginx/giinrecord{,-staging}.…` |

**削除するもの**（新名は各 setup スクリプトが書き直す。残すと二重に効く）:

- `conf.d/gikailog-noip-log.conf` — 残すと `log_format noip` が二重定義になり `nginx -t` が "duplicate log_format" で落ちる
- `snippets/gikailog-cloudflare-allow.conf` — 誰も include しない死んだファイルになる
- `cron.d/gikailog-analytics`・`gikailog-monitor`・`gikailog-cloudflare-allowlist` — 残すと新旧が同時に走り、監視 Issue の二重オープン・集計の二重実行になる
- 旧 compose project `gikailog`（ネットワーク `gikailog_default`）が残っていれば `docker compose -p gikailog down --remove-orphans`。落とさないと旧コンテナが 127.0.0.1:8081 / 8083 を掴んだままで `ensure_port_free` が exit 1 する

**`migrate_legacy()` では扱えない手作業**（step 0 が毎回チェックリストとして印字する）:

1. `~ubuntu/.ssh/authorized_keys` — CI の deploy 鍵の `command="/usr/bin/rrsync /var/www/gikailog"` を `/var/www/giinrecord` に、鍵コメント `gikailog github-actions deploy` を `giinrecord github-actions deploy` に書き換える。直さないと **deploy の rsync が rrsync に拒否されて全部失敗**し、さらに `deploy/ops-user-setup.sh:26` の `grep -q 'giinrecord github-actions'` が偽になって rrsync 制限が黙って適用されなくなる。
2. `/etc/giinrecord/monitor.token` — `mv` は自動化されているが、fine-grained PAT なので移行後に `sudo ls -l /etc/giinrecord/monitor.token`（600、root）で存在と権限を確認する。失われると `health.sh` はフェイルソフトし、**無言で監視が効かなくなる**。
3. 本番の nginx conf は certbot 管理 + 手編集で、`vps-setup.sh` は書き換えない設計。`sites-available/giinrecord.conf` への改名と certbot の管理対象名の整合は手作業。
4. Cloudflare ダッシュボード — Access Application 名 `gikailog staging`、Service Token 名 `gikailog-monitor`（`docs/ops/staging-access.md`）。リポジトリからは触れない。Service Token 名の変更はトークン再発行を伴う。
5. OS ユーザー `gikaiops` → `giinops`（**2026-09-01 に完了**、#336）— `ops-user-setup.sh` は冪等に「作る」だけで旧ユーザーを消さないので、そのまま実行すると sudo 可能な運用ユーザーが 2 つ並存する。**実際この移行は途中で止まり、`gikaiops` が `NOPASSWD:ALL` を持ったまま数日生きていた**（しかも同じ鍵でログインできた）。`giinops` をどれだけ絞っても迂回できる状態だったので、`giinops` の allowlist 化（#333）は単体では意味を成していなかった。**新ユーザーを絞ったら、旧ユーザーを消すまでが1つの作業。**「新ユーザー作成 → 鍵移行 → 動作確認 → 旧ユーザー削除 + `/etc/sudoers.d/90-gikaiops` 削除」の 4 段で行う。sudoers は `visudo -cf` で検証し、別セッションで root を開いたまま作業する。

**順序**（1 つ抜けるとデプロイか監視が黙って死ぬ）: `go-live.sh` を実行（step 0 が上表を処理し、compose を落とす）→ `authorized_keys` を書き換え → `deploy/cloudflare-allowlist.sh --install-cron` を新名で実行（先に走らせないと `vps-setup.sh` の `ensure_cf_snippet` が fail-closed で `deny all;` を書き、staging が全 403 になる）→ `go-live.sh` の残り step が `vps-setup.sh` / compose up / analytics を新名で作る → `deploy/monitor/setup.sh` を再実行。

**消さないもの（重要）**: `sites-{available,enabled}/gikailog.conf` と `gikailog-staging.conf`。**ファイル名が旧称なだけで、中身は旧ドメインを 301 する現役の設定**であり、残骸ではない。

```
$ ls /etc/nginx/sites-enabled/          # VPS 実測 2026-08-26
giinrecord.conf          → server_name giinrecord.jp          （現行の配信）
gikailog.conf            → server_name gikailog.jp            （旧ドメインの 301）
giinrecord-staging.conf  → server_name staging.giinrecord.jp
gikailog-staging.conf    → server_name staging.gikailog.jp    （旧ドメインの 301）

$ curl -sSI https://gikailog.jp/members/
HTTP/1.1 301 Moved Permanently
Location: https://giinrecord.jp/members/
```

4 つとも有効で、**`server_name` が違うので重複していない**（同一 `server_name` の 443 が 2 つできるという心配は当たらない）。#192 で旧ドメインは 1 年維持（2027-08 まで）と決めているので、**消すと旧 URL からの転送が止まる**。`migrate_legacy()` はこの 4 つに触れず、`deploy/test/go-live.test.sh` の「旧ドメイン 301 の conf は消さない」が削除の再混入を防ぐ。

> 不揃い: `sites-enabled/gikailog.conf` だけ実ファイルで、他 3 つはシンボリックリンク（実測）。動作に影響はないので本 PR では揃えていない。

**手で触らないもの**: 旧ドメイン `gikailog.jp` の certbot 証明書とコンテナ側の 301（`deploy/nginx/site.conf`。#192 で 1 年維持と決めた。2027-08 までは撤去しない）。`/var/log/nginx/gikailog.access.log.1` 以降の logrotate 済み過去世代（14 日で自然に消える。その間 `daily.sh` の集計対象からは外れ、改名日をまたぐ 1 日分は欠測しうる）。

テストは `bash deploy/test/go-live.test.sh`（`GO_LIVE_PREFIX` で全パスを一時ディレクトリ配下に、docker 等はスタブ）。

## よく使うコマンド（VPS 上、docker 権限のあるユーザー）

```sh
cd /opt/giinrecord
docker compose -f deploy/docker-compose.yml ps                 # State: running (healthy) を確認
docker compose -f deploy/docker-compose.yml logs --tail 50     # コンテナの nginx ログ（IP を含む。共有・保存しない）
docker compose -f deploy/docker-compose.yml up -d --force-recreate   # 設定変更後（git pull 後）。--force-recreate 必須（bind mount の inode）
docker compose -f deploy/docker-compose.yml restart web            # staging は web-staging
docker compose -f deploy/docker-compose.yml pull && docker compose -f deploy/docker-compose.yml up -d   # イメージ更新
curl -sI http://127.0.0.1:8081/ | head -1                      # コンテナ直叩き（staging は 8083）
curl -sI https://DOMAIN/ | grep -i -E "content-security|x-frame" # 外から見たヘッダ
```

## 設定を変えるとき

1. `packages/etl/test/deploy-docker.test.ts`（ヘッダ・キャッシュの固定値）と `apps/web/app/lib/smoke-url.ts`（URL モード smoke の期待値）を先に直す。
2. `deploy/nginx/site.conf` / `deploy/docker-compose.yml` を変更。CI の `docker-web` ジョブが `compose config → up → smoke --url → browser-check --url`（Playwright）で検証する。
3. マージ後、VPS で反映する（`up -d` だけでは古い `site.conf` のまま）。`/opt/giinrecord` は root 所有なので `sudo` が要る。`giinops` はこの 2 コマンドだけ NOPASSWD 許可されている（#333）ので、手元から非対話で叩ける:

   ```sh
   ssh giinops@<host> 'sudo -n git -C /opt/giinrecord pull \
     && sudo -n docker compose -f /opt/giinrecord/deploy/docker-compose.yml up -d --force-recreate'
   ```

   `ubuntu` でやる場合はパスワード sudo なので `ssh -t`（TTY）が必要。
4. ホスト側 `deploy/nginx-host-proxy.conf` を変える場合は `vps-setup.sh` の heredoc も同じ内容にする（テストが同一性を検査）。反映は `sudo bash deploy/vps-setup.sh giinrecord.jp`（staging は `staging.giinrecord.jp 8083`）の再実行。**certbot 管理の conf（`# managed by Certbot` を含む、#141 以前に構築したホスト）は書き換えず `proxy_pass` のポートだけ合わせる**ので、そのホストでは `sudo nano /etc/nginx/sites-available/giinrecord.conf` → `sudo nginx -t && sudo systemctl reload nginx`。テンプレートへ移行したいときは `sudo certbot certonly`（既存証明書があるので実際には不要）→ conf を退避して削除 → `vps-setup.sh` 再実行。

## setup スクリプトの冪等性と安全装置（#141）

`deploy/go-live.sh`（production）と `deploy/staging-setup.sh`（staging）は何度実行しても同じ状態に収束する。実行前に必ず先頭の usage を読む（Sprint 7 の事故：staging-setup に本番ドメインを渡した）。

| 装置 | 内容 |
|---|---|
| 引数検証 | `staging-setup.sh` は `staging.` で始まるドメインだけ受け付ける。`go-live.sh` と `vps-setup.sh <domain> 8081` は `staging.*` を拒否、`vps-setup.sh <domain> 8083` は `staging.*` だけ受け付ける。違反時は何も実行せず exit 1 |
| ポート空き検査 | コンテナ起動前に `ss -tln` で `127.0.0.1:8081`／`8083` を確認。自分の compose service（`docker compose ps -q web`）以外が LISTEN していれば exit 1（共用ホストの他サイトを奪わない） |
| `--force-recreate` | `docker compose up -d --wait --force-recreate` を常に使う（上記 inode 問題） |
| certbot | `/etc/letsencrypt/live/<domain>/fullchain.pem` があれば certbot を実行しない（`-0001` の重複証明書を作らない）。無ければ `certbot certonly --nginx -d <domain> [-d www.<domain>] --deploy-hook 'systemctl reload nginx'`（conf は編集させない） |
| ホスト conf の保護 | `vps-setup.sh` は `# managed by Certbot` を含む既存 conf を書き換えない（`proxy_pass` のポートだけ同期）。証明書が無ければ `:80` の proxy block だけ（certbot の challenge 用）、あればテンプレート全体（`:80` 301 + `:443` proxy）を書く。setup スクリプトは certbot の後にもう一度 `vps-setup.sh` を呼ぶ |
| 他サイト | `sites-available/giinrecord*.conf` と `conf.d/giinrecord-noip-log.conf` 以外に書かない |

本番ホストの現状（2026-08-23）：`sites-available/giinrecord.conf` は certbot 管理 + 手編集（`:80` で www も `https://giinrecord.jp` へ、www の 443 block は削除して 1 つの 443 block が両ホスト名を持つ）。テンプレートはこの挙動を再現しており、`go-live.sh giinrecord.jp` の再実行は conf を変えない（no-op）。テストは `bash deploy/test/vps-setup.test.sh`、`go-live.test.sh`、`staging-setup.test.sh`（root・docker・nginx・certbot は不要、全部スタブ）。

## 失敗モード

| 症状 | 原因 | 対応 |
|---|---|---|
| 外から 502 Bad Gateway | コンテナが落ちている／docker が起動していない | `docker compose ps`。`systemctl status docker`。`up -d` |
| 外から 404、コンテナ直叩きも 404 | `/var/www/giinrecord/site` が空（Release / Deploy data が未実行／失敗。staging なら `/var/www/giinrecord/staging` と Deploy (staging)） | Actions の Release / Deploy data / Deploy (staging) を確認。`ls /var/www/giinrecord/site`、`ls /var/www/giinrecord/staging` |
| `up` で `bind source path does not exist` | `/var/www/giinrecord/site` が無い | `vps-setup.sh` を再実行（ディレクトリ作成は冪等） |
| `git pull` したのに `site.conf` の変更が効かない | bind mount の inode 問題 | `docker compose -f deploy/docker-compose.yml up -d --force-recreate` |
| setup スクリプトが `port 8081/8083 は別のプロセスが LISTEN 中` で止まる | 共用ホストの別プロセス（他サイト）がそのポートを使っている | `ss -tlnp` で確認。他サイトなら `docker-compose.yml` と `vps-setup.sh` のポートを変える PBI を切る。自分の古いコンテナなら `docker compose ps` → `down` |
| `https://www.giinrecord.jp` が証明書エラー | 443 block の `server_name` に www が無い（手編集時） | `nginx -T \| grep server_name`。テンプレート（`deploy/nginx-host-proxy.conf`）は両名を持つ |
| ヘルスチェックが unhealthy | `site.conf` の構文エラー | `docker compose logs web`。`docker compose exec web nginx -t` |
| ヘッダが付かない／CSP が違う | `site.conf` の変更漏れ（ホスト側には add_header が無い） | CI の `docker-web` が落ちているはず。`site.conf` を修正して `up -d --force-recreate` |
| ページは表示されるが検索・郵便番号・テーマ切替・比較が動かない | CSP が inline `<script>` を遮断している（#194）。DevTools console に `violates the following Content Security Policy directive 'script-src …'` | `curl -sI https://giinrecord.jp/ \| grep -i content-security` が `script-src 'self' 'unsafe-inline'` か確認。古ければ `git pull && up -d --force-recreate`。`pnpm --filter web browser-check -- --url https://giinrecord.jp` で再確認 |
| `/assets/` に CSP が無い | nginx の仕様（location 内の `add_header` は server の add_header を継承しない）。旧 server block でも同じ挙動 | 仕様どおり（HTML ページには付く）。変えるなら site.conf と smoke-url.ts を同時に |
| アクセス集計 TSV が空 | ホスト block の `access_log … noip` が消えた（手編集時） | `nginx -T \| grep giinrecord.access.log`。`deploy/nginx-host-proxy.conf` と突き合わせる |
| `docker` コマンドで permission denied | そのユーザーに docker 権限が無い | docker 権限のあるユーザーで実行。**`ubuntu` には付与しない** |
| 他サイトが影響を受けた | `vps-setup.sh` は `sites-available/giinrecord.conf`（8083 なら `giinrecord-staging.conf`）と `conf.d/giinrecord-noip-log.conf` しか書かない | 他のファイルを触った形跡があれば手順外の作業。`nginx -T` で差分確認 |

## やらないこと

- コンテナに TLS を持たせない（certbot はホスト nginx の担当。共用ホストで 80/443 を奪わない）。
- `ubuntu` を `docker` グループに入れない。deploy-site.yml から `docker` を呼ばない。
- コンテナからログを外に出さない（IP を含む。集計はホスト側の IP 無しログだけ、`docs/ops/analytics.md`）。

## 運用ユーザーと鍵の権限（2026-08-23）
- `giinops`：**コマンドを固定した NOPASSWD sudo の allowlist**（`NOPASSWD:ALL` ではない、#333）。鍵は運用者の1本のみ（`deploy/ops-user-setup.sh` が生成。サーバー上で手編集しない）。PO はこのユーザーで許可済みの root 作業を非対話で実行する
  - 中身は `ssh giinops@<host> 'sudo -n -l'` で確認できる。**追加してよいのは引数まで書ききれるコマンドだけ**——`bash /tmp/*.sh` のようなワイルドカードは任意コード実行なので `NOPASSWD:ALL` と変わらない（実際 `91-giinops` にこの形が残っていた、#333）
  - `deploy/` の反映（#325）に必要な 2 つを含む：`git -C /opt/giinrecord pull` と `docker compose -f /opt/giinrecord/deploy/docker-compose.yml up -d --force-recreate`
  - 状態の確認に `docker compose -f ... ps` も許可する（#375）。**`logs` は許可しない**——
    コンテナの nginx ログは IP を含む（`docs/ops/analytics.md`）。ログが要るほどの障害は
    `ubuntu` のパスワード sudo（人間の作業）で見る
  - 検査は `deploy/test/ops-user-setup.test.sh`（CI の `deploy/test/*.test.sh` に入る）。**許可行の集合を完全一致で照合する**ので、許可を1つ足すとテストが落ちる＝レビューを必ず通る

### この allowlist が安全である前提（崩れたら root 昇格しうる、#333）

allowlist は「コマンドを固定したから安全」なのではなく、**次の前提の上で**安全である。前提が崩れれば昇格経路になる。

| 前提 | なぜ必要か | 確認 |
|---|---|---|
| `/opt/giinrecord` 配下を `giinops` が1バイトも書けない（全て root 所有） | 書けると `.git/config` の `core.pager` や `docker-compose.yml` 自体を書き換えて、root で実行させられる | `ssh giinops@<host> 'find /opt/giinrecord ! -user root \| head'` が空 |
| 環境変数が sudo に渡らない（`env_reset` / `!setenv`） | `docker-compose.yml` の `${SITE_DIR:-...}` に `SITE_DIR=/` を渡すと、**ホストの `/` を root 権限のコンテナに mount** できる。`:ro` でも `/etc/shadow` や他サイトのファイルを読める | 生成 sudoers の `Defaults:giinops env_reset, !setenv, use_pty`（テストが検査） |
| `main` への push 権限 = この VPS の root 権限 | `git pull` 自体は実行しないが、pull した `docker-compose.yml` を直後に root で `up` する。**GitHub の書き込み権限が信頼境界**になっている | ブランチ保護 |

- **`giinops` に nginx conf を書く許可（`tee`）は与えない**（#335、2026-09-02 に削除）。nginx master は root で動くので、conf に任意の内容を書ける者は `location /x { root /; }` で任意ファイルを HTTP 公開でき、`ssl_certificate_key` に他サイトの秘密鍵を指定でき、`access_log` の書き込み先を通じて root 権限でファイルを作れる。`nginx -t` はこれらを検査しない＝**実質 root 相当**。共用ホストなので影響は自サイトに閉じない。
  - **消しても誰も困らなかった。** conf を書く作業（`vps-setup.sh` / `cloudflare-allowlist.sh`）は元から `ssh <host> 'sudo bash -s' < script` で root として実行しており、この許可を使っていなかった。**「使っていない強い権限」が一番危ない**（誰も気づかない）
  - `giinops` に残る nginx の許可は `nginx -t` / `systemctl reload nginx` / `systemctl status nginx` の3つだけ。設定を書き換えられないので、reload できても内容は変えられない
  - conf を変えるときは従来どおり `ssh -t <host> 'sudo bash -s ...' < deploy/vps-setup.sh`（`ubuntu` のパスワード sudo）
- `ubuntu` の CI deploy 鍵：`command="/usr/bin/rrsync /var/www/giinrecord"` ＋ `restrict`。rsync で `/var/www/giinrecord` 配下に書くこと以外できない（漏洩しても root 化不可）。`deploy-site.yml` の宛先はこの root 相対（`site/`・`staging/`）
- `ubuntu` のパスワード sudo は変更しない
- **`ubuntu`（uid 1000）は OS 初期アカウントで、共用 VPS の同居サイトも使っている**（2026-09-01 に判明）。
  `deploy/go-live.sh` の `gpasswd -d ubuntu docker`（CI の deploy 鍵に root 相当を渡さないための正しい措置）が、
  **同居サイトの docker デプロイを巻き添えで壊した**（`permission denied ... /var/run/docker.sock`）。
  設計は変えない——共用ホストで `ubuntu` に docker 権限を残す方が危険なので——が、
  **共用ユーザー・共用グループへの変更は、ファイルと同じく「他サイトに触る」行為**だと認識すること。
  自サイト専用のユーザーに権限を付ける方が、干渉しないぶん安全。
  - 調査の型：`/etc/group-` `/etc/passwd-`（変更前のバックアップ）と現在を diff すると、
    「自分がやったか」を推測でなく証拠で答えられる
