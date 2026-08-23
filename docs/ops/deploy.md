# 配信の運用（web コンテナ + ホスト nginx）

Issue #85。構成と初回セットアップは `deploy/README.md`。ここは日常運用と障害時の手順。

## 構成の要点

- 静的ファイルは `deploy.yml` が `rsync --delete` で `/var/www/gikailog/site/`（所有者 `ubuntu`）に置く。**ここは変えない**。
- その同じディレクトリを `web` コンテナ（`nginx:alpine`、`deploy/docker-compose.yml`）が**読み取り専用**で bind mount し、`127.0.0.1:8081` だけに公開する。
- ホスト nginx（共用。他サイトも同居）は `server_name DOMAIN` の block で TLS を終端し `proxy_pass http://127.0.0.1:8081` するだけ（`deploy/nginx-host-proxy.conf`）。SPA fallback・キャッシュ・セキュリティヘッダは全部コンテナ側 `deploy/nginx/site.conf`。
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
cd ~/gikailog
docker compose -f deploy/docker-compose.yml ps                 # State: running (healthy) を確認
docker compose -f deploy/docker-compose.yml logs --tail 50     # コンテナの nginx ログ（IP を含む。共有・保存しない）
docker compose -f deploy/docker-compose.yml up -d              # 設定変更後（git pull 後）に再作成
docker compose -f deploy/docker-compose.yml restart web
docker compose -f deploy/docker-compose.yml pull && docker compose -f deploy/docker-compose.yml up -d   # イメージ更新
curl -sI http://127.0.0.1:8081/ | head -1                      # コンテナ直叩き
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
| 外から 404、コンテナ直叩きも 404 | `/var/www/gikailog/site` が空（deploy.yml が未実行／失敗） | Actions の Deploy を確認。`ls /var/www/gikailog/site` |
| `up` で `bind source path does not exist` | `/var/www/gikailog/site` が無い | `vps-setup.sh` を再実行（ディレクトリ作成は冪等） |
| ヘルスチェックが unhealthy | `site.conf` の構文エラー | `docker compose logs web`。`docker compose exec web nginx -t` |
| ヘッダが付かない／CSP が違う | `site.conf` の変更漏れ（ホスト側には add_header が無い） | CI の `docker-web` が落ちているはず。`site.conf` を修正して `up -d` |
| `/assets/` に CSP が無い | nginx の仕様（location 内の `add_header` は server の add_header を継承しない）。旧 server block でも同じ挙動 | 仕様どおり（HTML ページには付く）。変えるなら site.conf と smoke-url.ts を同時に |
| アクセス集計 TSV が空 | ホスト block の `access_log … noip` が消えた（手編集時） | `nginx -T \| grep gikailog.access.log`。`deploy/nginx-host-proxy.conf` と突き合わせる |
| `docker` コマンドで permission denied | そのユーザーに docker 権限が無い | docker 権限のあるユーザーで実行。**`ubuntu` には付与しない** |
| 他サイトが影響を受けた | `vps-setup.sh` は `sites-available/gikailog.conf` と `conf.d/gikailog-noip-log.conf` しか書かない | 他のファイルを触った形跡があれば手順外の作業。`nginx -T` で差分確認 |

## やらないこと

- コンテナに TLS を持たせない（certbot はホスト nginx の担当。共用ホストで 80/443 を奪わない）。
- `ubuntu` を `docker` グループに入れない。deploy.yml から `docker` を呼ばない。
- コンテナからログを外に出さない（IP を含む。集計はホスト側の IP 無しログだけ、`docs/ops/analytics.md`）。
