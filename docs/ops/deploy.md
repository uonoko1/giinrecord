# 配信の運用（web コンテナ + ホスト nginx、staging / production）

Issue #85・#127。構成と初回セットアップは `deploy/README.md`。ここは日常運用（リリース手順）と障害時の手順。

## 環境とワークフロー（#127）

| 環境 | URL | 配信元 | コード | データ |
|---|---|---|---|---|
| staging | https://staging.gikailog.jp | `web-staging`（127.0.0.1:8082）← `/var/www/gikailog/staging` | `main` への push で自動（`deploy-staging.yml`） | 自動（`deploy-data.yml`） |
| production | https://gikailog.jp | `web`（127.0.0.1:8081）← `/var/www/gikailog/site` | 手動リリース（`release.yml`） | 自動（`deploy-data.yml`） |

- 3 つとも再利用ワークフロー `deploy-site.yml`（`pnpm build` → `rsync --delete`）を呼ぶだけ。違いは Environment・`SITE_ORIGIN`・rsync 先。
- staging ビルド（`SITE_ORIGIN=https://staging.gikailog.jp`）は `robots.txt` が `Disallow: /`、全ページに `<meta name="robots" content="noindex, nofollow">`（`apps/web/app/lib/seo.ts`）。さらにコンテナの `site.conf` が Host `staging.gikailog.jp` に `X-Robots-Tag: noindex, nofollow` を付ける。
- GitHub Environment：`staging`、`production`（**required reviewers = 承認ボタン**。PO が設定）、`production-data`（reviewers 無し）。3 つとも同じ `DEPLOY_*` secrets。

### リリース手順（production）

1. staging（https://staging.gikailog.jp/）で確認する。`main` の最新は push 後数分で出ている（Actions → Deploy (staging)）。
2. Actions → **Release** → Run workflow。`ref` は既定 `main`（タグや SHA も可）→ Run。
3. `production` Environment の承認待ちになる → Review deployments → Approve。
4. 完了後 https://gikailog.jp/ で確認（title『議会ログ』、`curl -sI https://gikailog.jp/ | grep -i x-robots-tag` が空、sitemap の `<loc>` が `https://gikailog.jp/`）。

ロールバックは「前の SHA を `ref` にして Release」。

### 日次データ（`deploy-data.yml`）

ETL の data PR がマージされると `etl.yml` / `districts.yml` が `gh workflow run deploy-data.yml --ref main` を起動し、staging と production（Environment `production-data`、承認なし）の両方を `main` でビルドして配る。
**S1 の簡略化**：本来 production へは「最後にリリースした ref」に data/ だけ載せるべきだが、現状は `main` 全体をビルドする。つまり main にマージ済みで未リリースのコード変更も日次データと一緒に production に出る。リリース前に main に置きたくない変更はマージしない運用（あるいは後続 PBI で「最終リリース ref の記録 + その ref でビルド」）。

## 構成の要点

- 静的ファイルは `deploy-site.yml` が `rsync --delete` で `/var/www/gikailog/site/`（production）と `/var/www/gikailog/staging/`（staging）に置く（所有者 `ubuntu`）。**ここは変えない**。
- それぞれを `web` / `web-staging` コンテナ（`nginx:alpine`、`deploy/docker-compose.yml`、同じ `site.conf`）が**読み取り専用**で bind mount し、`127.0.0.1:8081` / `127.0.0.1:8082` だけに公開する。
- ホスト nginx（共用。他サイトも同居）は `server_name` ごとの block で TLS を終端し `proxy_pass` するだけ（`deploy/nginx-host-proxy.conf`、`sites-available/gikailog.conf` と `gikailog-staging.conf`）。SPA fallback・キャッシュ・セキュリティヘッダ・staging の noindex は全部コンテナ側 `deploy/nginx/site.conf`。
- 権限：`ubuntu`（CI の rsync 鍵）は docker を触れない。docker のインストールと `docker compose` は人間が sudo／docker 権限で行う。
- デプロイでコンテナの再起動は不要（bind mount なので rsync 直後から新ファイルが配信される）。

## 改名の移行（#119、seiji-kiroku → gikailog）

VPS 上のパス・conf・compose project はすべて `gikailog` 名（`/opt/gikailog`、`/var/www/gikailog/site`、`sites-available/gikailog.conf`、`conf.d/gikailog-noip-log.conf`、`cron.d/gikailog-analytics`、コンテナ `gikailog-web-1`）。旧名が残っているホストでは `deploy/go-live.sh` の step 0 が冪等に移行する：

- `/opt/seiji-kiroku` → `/opt/gikailog`、`/var/www/seiji-kiroku` → `/var/www/gikailog`、`/usr/local/lib/seiji-kiroku-analytics` → `…/gikailog-analytics` を `mv`（新パスが既にあれば旧を残して警告するだけ）
- 旧 `sites-enabled/seiji-kiroku.conf`・`sites-available/seiji-kiroku.conf`・`conf.d/seiji-kiroku-noip-log.conf`・`cron.d/seiji-kiroku-analytics` を削除（新 conf は直後の `vps-setup.sh` が書く）
- 旧 compose project `seiji-kiroku`（ネットワーク `seiji-kiroku_default`）が残っていれば `docker compose -p seiji-kiroku down --remove-orphans`

手で触らないもの：旧ドメインの certbot 証明書と `/var/log/nginx/seiji-kiroku.access.log*`（不要なら `sudo certbot delete --cert-name <旧ドメイン>` と logrotate 任せ）。テストは `bash deploy/test/go-live.test.sh`。

## よく使うコマンド（VPS 上、docker 権限のあるユーザー）

```sh
cd /opt/gikailog
docker compose -f deploy/docker-compose.yml ps                 # State: running (healthy) を確認
docker compose -f deploy/docker-compose.yml logs --tail 50     # コンテナの nginx ログ（IP を含む。共有・保存しない）
docker compose -f deploy/docker-compose.yml up -d              # 設定変更後（git pull 後）に再作成
docker compose -f deploy/docker-compose.yml restart web            # staging は web-staging
docker compose -f deploy/docker-compose.yml pull && docker compose -f deploy/docker-compose.yml up -d   # イメージ更新
curl -sI http://127.0.0.1:8081/ | head -1                      # コンテナ直叩き（staging は 8082）
curl -sI https://DOMAIN/ | grep -i -E "content-security|x-frame" # 外から見たヘッダ
```

## 設定を変えるとき

1. `packages/etl/test/deploy-docker.test.ts`（ヘッダ・キャッシュの固定値）と `apps/web/app/lib/smoke-url.ts`（URL モード smoke の期待値）を先に直す。
2. `deploy/nginx/site.conf` / `deploy/docker-compose.yml` を変更。CI の `docker-web` ジョブが `compose config → up → smoke --url` で検証する。
3. マージ後、VPS で `git pull && docker compose -f deploy/docker-compose.yml up -d`。
4. ホスト側 `deploy/nginx-host-proxy.conf` を変える場合は `vps-setup.sh` の heredoc も同じ内容にする（テストが同一性を検査）。certbot 済みのホストでは setup は上書きしないので、`sudo nano /etc/nginx/sites-available/gikailog.conf` → `sudo nginx -t && sudo systemctl reload nginx`。

## 失敗モード

| 症状 | 原因 | 対応 |
|---|---|---|
| 外から 502 Bad Gateway | コンテナが落ちている／docker が起動していない | `docker compose ps`。`systemctl status docker`。`up -d` |
| 外から 404、コンテナ直叩きも 404 | `/var/www/gikailog/site` が空（Release / Deploy data が未実行／失敗。staging なら `/var/www/gikailog/staging` と Deploy (staging)） | Actions の Release / Deploy data / Deploy (staging) を確認。`ls /var/www/gikailog/site`、`ls /var/www/gikailog/staging` |
| `up` で `bind source path does not exist` | `/var/www/gikailog/site` が無い | `vps-setup.sh` を再実行（ディレクトリ作成は冪等） |
| ヘルスチェックが unhealthy | `site.conf` の構文エラー | `docker compose logs web`。`docker compose exec web nginx -t` |
| ヘッダが付かない／CSP が違う | `site.conf` の変更漏れ（ホスト側には add_header が無い） | CI の `docker-web` が落ちているはず。`site.conf` を修正して `up -d` |
| `/assets/` に CSP が無い | nginx の仕様（location 内の `add_header` は server の add_header を継承しない）。旧 server block でも同じ挙動 | 仕様どおり（HTML ページには付く）。変えるなら site.conf と smoke-url.ts を同時に |
| アクセス集計 TSV が空 | ホスト block の `access_log … noip` が消えた（手編集時） | `nginx -T \| grep gikailog.access.log`。`deploy/nginx-host-proxy.conf` と突き合わせる |
| `docker` コマンドで permission denied | そのユーザーに docker 権限が無い | docker 権限のあるユーザーで実行。**`ubuntu` には付与しない** |
| 他サイトが影響を受けた | `vps-setup.sh` は `sites-available/gikailog.conf`（8082 なら `gikailog-staging.conf`）と `conf.d/gikailog-noip-log.conf` しか書かない | 他のファイルを触った形跡があれば手順外の作業。`nginx -T` で差分確認 |

## やらないこと

- コンテナに TLS を持たせない（certbot はホスト nginx の担当。共用ホストで 80/443 を奪わない）。
- `ubuntu` を `docker` グループに入れない。deploy-site.yml から `docker` を呼ばない。
- コンテナからログを外に出さない（IP を含む。集計はホスト側の IP 無しログだけ、`docs/ops/analytics.md`）。
