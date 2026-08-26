# アクセス計測の運用（Cookie なし・IP を保存しない）

Issue #58。目的は広告（#48）の着手条件「月間 PV」を測ること。それ以上の情報は取らない。

## 方式の選定

| 候補 | VPS の負荷 | 運用 | 採否 |
|---|---|---|---|
| **nginx アクセスログの日次集計**（追加サービスなし） | なし（既存の nginx が書くログを 1 日 1 回 awk で数える） | sudo 1 回（log_format）＋ cron 1 行 | **採用** |
| GoatCounter セルフホスト | 常駐プロセス 1 つ＋SQLite。サイトに JS を追加 | バイナリ更新・バックアップが増える。IP は既定でハッシュ保存 | 不足が出たら検討 |
| Plausible セルフホスト | Docker（Postgres + ClickHouse）。メモリ 2GB 前後 | 共用 VPS には重い | 不採用 |

PV・ページ・リファラ・日付だけ分かればよいので、最も軽い方式を選んだ。JS を一切足さないので CSP もページ表示速度も変わらない。

## 記録しないもの（設計上、書かれない）

- **IP アドレス**：nginx の `log_format noip` に `$remote_addr` が無い。ハッシュ化もしない（日替わりソルトでも突合リスクが残るため、書かない方を選んだ）。
- **User-Agent**：同じく書かない（端末の指紋になりうる）。
- **Cookie・localStorage・fingerprint**：サイト側に計測コードは存在しない。
- リファラは**ホスト名だけ**に縮める（`https://www.google.com/search?q=…` → `www.google.com`）。自サイト内の遷移と無しは `-` にまとめる。
- クエリ文字列は捨てる（`/members?q=山` → `/members/`）。

## 構成

```
deploy/analytics/
  nginx-noip-log.conf       log_format noip（参考。setup が /etc/nginx/conf.d/ に同じ内容を書く）
  vps-analytics-setup.sh    sudo で 1 回：gawk、log_format、access_log、/usr/local/lib/giinrecord-analytics、cron
  daily.sh                  cron が root で実行：前日分を集計し ~ubuntu/analytics/YYYY-MM-DD.tsv を ubuntu 所有 600 で置く
  aggregate.sh              純粋な集計（stdin/ファイル → TSV）。packages/etl/test/analytics-aggregate.test.ts が仕様
```

出力 TSV（タブ区切り、ヘッダーあり、pv 降順）:

```
date	page	referrer	pv
2026-08-22	/members/	www.google.com	2
2026-08-22	/	-	1
```

PV として数える行：`GET` かつ `200`/`304` かつ HTML ページ（`/assets/`・`/data/`・拡張子付きファイルは除外）。日付は nginx の `$time_local`（サーバーのローカル時刻）。

集計結果は **VPS の `~ubuntu/analytics/`（mode 700、TSV は 600）にだけ**置く。リポジトリや公開ディレクトリには出さない（受け入れ基準「docs/ops または非公開の場所」のうち非公開を選択。公開したくなったら月次合計だけを docs に書く）。

### 権限の設計（ubuntu に adm を付けない）

`ubuntu` は deploy-site.yml（deploy-staging / release / deploy-data）が rsync に使う **CI デプロイ鍵のユーザー**。このユーザーを `adm` グループに入れると、鍵が漏れたときに共有 VPS 上の**全ログ**（他サイトの nginx アクセスログ＝IP/UA 入り、`auth.log`、`syslog`）が読めてしまい、この PR の目的（個人情報を持たない）に反する。そのため

- cron は **root** で動かし、`/var/log/nginx` を読むのは root だけ。`daily.sh` が `install -o ubuntu -m 600` で **集計 TSV 1 ファイルだけ**を ubuntu に渡す。
- root が実行するスクリプトは **root 所有の `/usr/local/lib/giinrecord-analytics/`** に置く（`~ubuntu` 配下を root の cron から実行すると、漏れた鍵で root 昇格できてしまう）。更新は `sudo install`。
- root は ubuntu 所有のディレクトリにリダイレクト（`>`）で書かない（`~/analytics` がシンボリックリンクなら中止、TSV は `mktemp` → `install`）。cron のログは `/var/log/giinrecord-analytics.log`（root 600）で、`/etc/logrotate.d/giinrecord-analytics`（monthly・12 世代、#288。→ `docs/ops/log-rotation.md`）で回る。

## 初回セットアップ

```sh
# 1. sudo で nginx と cron を設定（冪等。2 回走らせても access_log 行は増えない）
ssh "$VPS_SSH_HOST" 'sudo bash -s' < deploy/analytics/vps-analytics-setup.sh
# 2. スクリプトを root 所有で配置（更新時も同じ。~ubuntu 配下には置かない）
VPS_SSH_HOST="${VPS_SSH_HOST:-sakura-vps}"   # ssh alias of the VPS (your ~/.ssh/config; the IP is not in the repo, #133)
scp deploy/analytics/aggregate.sh deploy/analytics/daily.sh "$VPS_SSH_HOST":/tmp/
ssh "$VPS_SSH_HOST" 'sudo install -o root -g root -m 755 /tmp/aggregate.sh /tmp/daily.sh /usr/local/lib/giinrecord-analytics/ && rm /tmp/aggregate.sh /tmp/daily.sh'
# 3. 確認
ssh "$VPS_SSH_HOST" 'sudo tail -3 /var/log/nginx/giinrecord.access.log'   # 行頭が "- - [" で IP が無いこと
ssh "$VPS_SSH_HOST" 'sudo ANALYTICS_OUT=/home/ubuntu/analytics ANALYTICS_OWNER=ubuntu /usr/local/lib/giinrecord-analytics/daily.sh "$(date +%F)"' # 今日分を手動集計
ssh "$VPS_SSH_HOST" 'ls -l ~/analytics'                                      # -rw------- ubuntu ubuntu
```

`access_log /var/log/nginx/giinrecord.access.log noip;` は `vps-setup.sh` が書く proxy block に最初から入っている（certbot が複製した 443 ブロックにも入る）。analytics の setup はその 1 行が無ければ中止する（空の TSV を黙って作らない）。ログローテーションは Ubuntu 既定の `/etc/logrotate.d/nginx`（daily, 14 世代, delaycompress）に乗る。（**nginx のアクセスログの話**。cron 自身のログは別で、#288 で回すようにした）`daily.sh` は `.log` `.log.1` `.log.2.gz` を読んで日付で絞るので、ローテーション時刻と cron の順序に依存しない。

## 見方

```sh
# 前日の上位ページ
ssh "$VPS_SSH_HOST" 'head -20 ~/analytics/$(date -d yesterday +%F).tsv'
# 月間 PV（#48 の判断材料）
ssh "$VPS_SSH_HOST" 'cat ~/analytics/2026-09-*.tsv | awk -F"\t" "\$1!=\"date\"{s+=\$4} END{print s}"'
# 月間リファラ上位
ssh "$VPS_SSH_HOST" 'cat ~/analytics/2026-09-*.tsv | awk -F"\t" "\$1!=\"date\"{r[\$3]+=\$4} END{for(k in r)print r[k]\"\t\"k}" | sort -rn | head'
```

## 失敗モード

| 症状 | 原因 | 対応 |
|---|---|---|
| `/var/log/giinrecord-analytics.log` に `Permission denied` | cron が root で動いていない（`/etc/cron.d` の行が `root` でない）／`~/analytics` を ubuntu が作り直して `daily.sh` が書けない | setup を再実行（cron.d を書き直す）。`ls -ld ~ubuntu/analytics` がシンボリックリンクなら削除 |
| `daily.sh: refusing symlinked …` | `~ubuntu/analytics` がシンボリックリンク（root が追従しないよう中止） | リンクを消して setup を再実行 |
| `~/analytics/*.tsv` が ubuntu で読めない | `ANALYTICS_OWNER` が cron.d に無い／手動で root 実行したとき env を付け忘れた | `sudo chown ubuntu:ubuntu ~ubuntu/analytics/*.tsv`、setup を再実行 |
| `test -x …/daily.sh` で何も起きない | スクリプトが `/usr/local/lib/giinrecord-analytics/` に無い（`~/giinrecord-analytics` に置いた） | 手順 2 の `sudo install` をやり直す |
| TSV がヘッダーだけ | その日のアクセスが無い／`access_log … noip` が効いていない | `nginx -T \| grep giinrecord.access.log`。`sites-available` を書き直した場合（vps-setup.sh 再実行）は setup も再実行 |
| 行頭に IP が出ている | `log_format noip` が読み込まれていない（`conf.d` が include されていない） | `nginx -T \| grep noip`。無ければ `nginx.conf` の `include /etc/nginx/conf.d/*.conf;` を確認 |
| `gawk: not found` | mawk しか無い | `sudo apt-get install gawk`（setup に含まれる） |

## 変えるとき

- 集計ロジックは `packages/etl/test/analytics-aggregate.test.ts` を先に直す（フィクスチャ `packages/etl/test/fixtures/analytics-access.log.txt`）。
- 取る項目を増やすなら、/about の「計測について」も同時に更新する。IP・UA・Cookie を足すことはしない。
- cron の権限（root 実行・adm 不使用・600）は `packages/etl/test/analytics-daily.test.ts` が固定している。
