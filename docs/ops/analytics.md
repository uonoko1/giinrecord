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

出力 TSV（タブ区切り、ヘッダーあり、**2 行目に日次の要約**、以降 pv 降順）:

```
date	page	referrer	pv
# 2026-08-22	pv=3	pages=2	per-page=1.50
2026-08-22	/members/	www.google.com	2
2026-08-22	/	-	1
```

### 2 行目の要約（`pv` / `pages`、#1184）

- `pv` = ページビュー数、`pages` = **異なるページ数**、`per-page` = `pv / pages`
- **クローラと人を読み手が区別するための数**。実測（#1178）:

| 日 | pv | pages | per-page | 読み方 |
|---|---|---|---|---|
| 2026-09-25 | 5631 | 4938 | 1.14 | 全ページを 1 回ずつ辿っている＝**クローラ** |
| 2026-09-16 | 87 | 25 | 3.50 | 数ページを読み進めている＝**人の形** |

- **クローラは除外しない。** 「怪しい綴りを並べる」のは denylist で、このプロジェクトは何度も落ちている（#1133 / #1089 / #1115）。数を出して判断は読み手に残す。
- 同じページをリファラ違いで 2 回なら**行は 2 本だが `pages` は 1**（`pages` は行数ではない）。
- 置き場所が `#` 行なのは、`head` しただけで目に入るから。**行空間を汚さない**ので、下の「見方」の one-liner は `!/^#/` を足すだけで済む（pv 合計のほうは `$4` が空なので足す前から正しい。実測で確認済み）。

PV として数える行：`GET` かつ `200`/`304` かつ HTML ページ（`/assets/`・`/data/`・拡張子付きファイルは除外）。日付は nginx の `$time_local`（サーバーのローカル時刻）。

集計結果は **VPS の `~ubuntu/analytics/`（mode 700、TSV は 600）にだけ**置く。リポジトリや公開ディレクトリには出さない（受け入れ基準「docs/ops または非公開の場所」のうち非公開を選択。公開したくなったら月次合計だけを docs に書く）。

### 権限の設計（ubuntu に adm を付けない）

`ubuntu` は deploy-site.yml（deploy-staging / release / deploy-data）が rsync に使う **CI デプロイ鍵のユーザー**。このユーザーを `adm` グループに入れると、鍵が漏れたときに共有 VPS 上の**全ログ**（他サイトの nginx アクセスログ＝IP/UA 入り、`auth.log`、`syslog`）が読めてしまい、この PR の目的（個人情報を持たない）に反する。そのため

- cron は **root** で動かし、`/var/log/nginx` を読むのは root だけ。`daily.sh` が `install -o ubuntu -m 600` で **集計 TSV 1 ファイルだけ**を ubuntu に渡す。
- root が実行するスクリプトは **root 所有の `/usr/local/lib/giinrecord-analytics/`** に置く（`~ubuntu` 配下を root の cron から実行すると、漏れた鍵で root 昇格できてしまう）。更新は `sudo install`。
- root は ubuntu 所有のディレクトリにリダイレクト（`>`）で書かない（`~/analytics` がシンボリックリンクなら中止、TSV は `mktemp` → `install`）。cron のログは `/var/log/giinrecord-analytics.log`（root 600）で、`/etc/logrotate.d/giinrecord-analytics`（monthly・12 世代、#288。→ `docs/ops/log-rotation.md`）で回る。

## セットアップ／設置し直し

**スクリプトの設置は setup がやる**（#1184 以降）。`vps-analytics-setup.sh` は**自分の隣の `aggregate.sh` / `daily.sh` を `/usr/local/lib/giinrecord-analytics/` に install する**ので、**checkout から実行すること**。手で `scp` する手順は無くなった。

```sh
VPS_SSH_HOST="${VPS_SSH_HOST:-sakura-vps}"   # ssh alias of the VPS (your ~/.ssh/config; the IP is not in the repo, #133)
# 1. checkout を最新にして setup を走らせる（冪等。nginx・cron・スクリプトをまとめて揃える）
ssh "$VPS_SSH_HOST" 'sudo git -C /opt/giinrecord pull --ff-only && sudo bash /opt/giinrecord/deploy/analytics/vps-analytics-setup.sh'
# 2. 翌日の cron を待たずに、その場で計器を確かめる
ssh "$VPS_SSH_HOST" 'sudo tail -3 /var/log/nginx/giinrecord.access.log'   # 行頭が "- - [" で IP が無いこと
ssh "$VPS_SSH_HOST" 'sudo ANALYTICS_OUT=/home/ubuntu/analytics ANALYTICS_OWNER=ubuntu /usr/local/lib/giinrecord-analytics/daily.sh "$(date +%F)"; echo "exit=$?"'
ssh "$VPS_SSH_HOST" 'head -2 ~/analytics/$(date +%F).tsv; ls -l ~/analytics | tail -3'   # -rw------- ubuntu ubuntu
```

**`bash deploy/run-remote.sh …`（stdin 経由）では設置できない**——`$HERE` が checkout を指さないので、setup は**スクリプトを更新できなかったことを言って非 0 で止まる**（黙って古いコピーを残さない。それが #1184 だった）。nginx と cron だけ直したいときも、checkout から走らせるのが正しい。

### `daily.sh` の終了コード（#1184）

| 終了 | 意味 | TSV |
|---|---|---|
| 0 | 測れて、PV が 1 件以上あった | 書く |
| 3 | `$LOG` / `.1` / `.2.gz` が**どれも無い（または空）**＝読む先が無い。**計器が壊れている** | **書かない** |
| 4 | ログは読めたが、その日の PV が 0 件 | 書く（`pv=0 pages=0`） |

**3 と 4 は別の事実**なので別の終了コードにしてある。3 は「測れなかった」（パスが違う・権限が無い・nginx が書いていない）、4 は「測れて 0 だった」。4 は小さなサイトの静かな 1 日なら在りうるので、**連続したときだけ**異常——その判定は監視側（`docs/ops/monitoring.md` の `analytics` check）が持つ。`daily.sh` の非 0 自体は cron ログに入るだけで誰も読まないため。

`access_log /var/log/nginx/giinrecord.access.log noip;` は `vps-setup.sh` が書く proxy block に最初から入っている（certbot が複製した 443 ブロックにも入る）。analytics の setup はその 1 行が無ければ中止する（空の TSV を黙って作らない）。ログローテーションは Ubuntu 既定の `/etc/logrotate.d/nginx`（daily, 14 世代, delaycompress）に乗る。（**nginx のアクセスログの話**。cron 自身のログは別で、#288 で回すようにした）`daily.sh` は `.log` `.log.1` `.log.2.gz` を読んで日付で絞るので、ローテーション時刻と cron の順序に依存しない。

## 見方

```sh
# 前日の上位ページ（1 行目がヘッダー、2 行目が pv/pages の要約）
ssh "$VPS_SSH_HOST" 'head -20 ~/analytics/$(date -d yesterday +%F).tsv'
# 月間の日次要約だけを並べる（クローラの日が per-page で見分けられる）
ssh "$VPS_SSH_HOST" 'grep -h "^#" ~/analytics/2026-09-*.tsv | sort'
# 月間 PV（#48 の判断材料）
ssh "$VPS_SSH_HOST" 'cat ~/analytics/2026-09-*.tsv | awk -F"\t" "!/^#/ && \$1!=\"date\"{s+=\$4} END{print s}"'
# 月間リファラ上位
ssh "$VPS_SSH_HOST" 'cat ~/analytics/2026-09-*.tsv | awk -F"\t" "!/^#/ && \$1!=\"date\"{r[\$3]+=\$4} END{for(k in r)print r[k]\"\t\"k}" | sort -rn | head'
```

`!/^#/` が要る理由: リファラ集計のほうは、付けないと要約行から `0` の行が 1 本混ざる（実測）。pv 合計のほうは要約行の `$4` が空なので、付けなくても答えは変わらない。

## 失敗モード

| 症状 | 原因 | 対応 |
|---|---|---|
| `/var/log/giinrecord-analytics.log` に `Permission denied` | cron が root で動いていない（`/etc/cron.d` の行が `root` でない）／`~/analytics` を ubuntu が作り直して `daily.sh` が書けない | setup を再実行（cron.d を書き直す）。`ls -ld ~ubuntu/analytics` がシンボリックリンクなら削除 |
| `daily.sh: refusing symlinked …` | `~ubuntu/analytics` がシンボリックリンク（root が追従しないよう中止） | リンクを消して setup を再実行 |
| `~/analytics/*.tsv` が ubuntu で読めない | `ANALYTICS_OWNER` が cron.d に無い／手動で root 実行したとき env を付け忘れた | `sudo chown ubuntu:ubuntu ~ubuntu/analytics/*.tsv`、setup を再実行 |
| `test -x …/daily.sh` で何も起きない | スクリプトが `/usr/local/lib/giinrecord-analytics/` に無い（`~/giinrecord-analytics` に置いた） | 手順 2 の `sudo install` をやり直す |
| TSV が要約行まで（`pv=0`）だけ | その日のアクセスが無い／`access_log … noip` が効いていない | `nginx -T \| grep giinrecord.access.log`。`sites-available` を書き直した場合（vps-setup.sh 再実行）は setup も再実行 |
| `daily.sh: no such log to read` で exit 3 | 読む先のログが無い。**設置済みのスクリプトが古く、改名前のログ名を読んでいる**のが #1184 の実例 | 上の「セットアップ／設置し直し」を checkout から実行して設置し直す。`md5sum` で checkout と `/usr/local/lib/giinrecord-analytics/daily.sh` を突き合わせる |
| `[monitor] vps: analytics` の Issue が開いた | 直近 3 日の TSV がぜんぶ `pv=0`、または 1 つも無い | `docs/ops/monitoring.md` の `analytics`。まず設置済みスクリプトの新しさを疑う（#1184） |
| 行頭に IP が出ている | `log_format noip` が読み込まれていない（`conf.d` が include されていない） | `nginx -T \| grep noip`。無ければ `nginx.conf` の `include /etc/nginx/conf.d/*.conf;` を確認 |
| `gawk: not found` | mawk しか無い | `sudo apt-get install gawk`（setup に含まれる） |

## 変えるとき

- 集計ロジックは `packages/etl/test/analytics-aggregate.test.ts` を先に直す（フィクスチャ `packages/etl/test/fixtures/analytics-access.log.txt`）。
- 取る項目を増やすなら、/about の「計測について」も同時に更新する。IP・UA・Cookie を足すことはしない。
- cron の権限（root 実行・adm 不使用・600）は `packages/etl/test/analytics-daily.test.ts` が固定している。
- **`daily.sh` の終了コードと「設置を setup がやる」ことも同じテストが固定している**（#1184）。「読む先が無い」を成功に戻すと落ちる。
- 連続 0 行の検出は `deploy/monitor/health.sh` の `analytics` check（テスト: `deploy/test/monitor-health.test.sh`）。**新しい監視の入口は作らない**（#1110）。
- **IP・UA・Cookie を足さない方針は #1184 でも変えていない。** 訪問者数は原理的に数えられないが、それは受け入れる（`pages` は「異なるページ数」で、人数ではない）。
