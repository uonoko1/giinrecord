# ログのローテーションと肥大の確認

Issue #288。VPS に置かれる**このプロジェクトのログ**が、どれも無制限に伸びないようにする話。

## 何が回っていて、何が回っていなかったか

| ログ | 誰が書くか | ローテーション |
|---|---|---|
| `/var/log/nginx/giinrecord.access.log` | nginx（IP 無し `noip` 形式、#58） | `/etc/logrotate.d/nginx`（OS 同梱）**もともと回る** |
| `/var/log/giinrecord-monitor.log` | root cron `*/5`（`deploy/monitor/setup.sh`） | `/etc/logrotate.d/giinrecord-monitor`（**#288 で追加**） |
| `/var/log/giinrecord-analytics.log` | root cron 毎日 00:10（`deploy/analytics/vps-analytics-setup.sh`） | `/etc/logrotate.d/giinrecord-analytics`（**#288 で追加**） |

後ろ 2 つは **どの logrotate 設定にも該当していなかった**。Ubuntu 既定の `/etc/logrotate.d/rsyslog` は `/var/log/syslog`・`/var/log/auth.log` のように**ファイル名を列挙**する形で、`/var/log/*.log` を一括で回す設定ではない。だから「`/var/log` に置けばいつか回る」は成り立たない。

## 選んだ値と根拠

両方とも **`monthly` × `rotate 12`（＝約 1 年）、`maxsize 32M`、`compress`**。

- **実測（2026-08-27 時点）**: `giinrecord-monitor.log` は作成 2026-08-23 21:22 から 3.11 日で 129,012 バイト。**約 41 KB/日、約 1.2 MB/月**。`giinrecord-analytics.log` は同じく 2026-08-23 作成で、1 日 1 回の cron 出力のため同時点で 221 バイト（約 55 バイト/日）。
- **1 年保持**でも監視ログは圧縮前で約 15 MB、`compress` 後はこれよりかなり小さい。`/` の空きは 65 GB（99 GB 中 32% 使用）なので**容量は制約にならない**。
- **短くしない理由**: 監視ログは障害の事後調査に使う。「先月から時々 502 が出ていた」を確かめられる必要があるので、数週間では足りない。
- **`daily` にしない理由**: 41 KB/日では 1 日分のファイルが細かすぎ、障害の期間をまたいで `zgrep` するのが面倒になるだけで、得るものが無い。
- **`maxsize 32M` の役割**: 上の見積りが崩れた場合（`health.sh` がループして毎回出力する等）の**上限**。logrotate の日次 cron が月末を待たずに回すので、最悪でも概ね `32M × (12+1)` で頭打ちになる。

`su root root` / `create 0600 root root` を明示しているのは、**ローテート後のファイルも 600 root:root のままにする**ため。`/etc/logrotate.conf` の既定は `su root adm` なので、指定しないと世代が adm グループから読める状態になりうる。共用 VPS では読める人を増やさない。

**ログの中身は触らない。** どちらの設定にも `postrotate` は書かない（#58 の「ログに IP を残さない」方針は nginx の `noip` 形式側の話で、ここは回すだけ）。

## 共用 VPS で他サイトを巻き込まないこと

この VPS には他のサイトが同居している。`/etc/logrotate.d/` に置く設定が `/var/log/*.log` のようなワイルドカードだと、**他サイトのログまで一緒に回してしまう**。

設定はどちらも**ファイルを 1 本ずつ名指し**している。確認は次の 2 つ。

```bash
# 1. 設定に書かれたパスにワイルドカードが無いこと（deploy/test/logrotate.test.sh が CI で毎回検査する）
bash deploy/test/logrotate.test.sh

# 2. 実機で、その設定が実際にどのファイルを対象にするか（--debug は何も書き換えない）
ssh "${VPS_SSH_HOST:-sakura-vps}" 'logrotate --debug /etc/logrotate.d/giinrecord-monitor' \
  | grep -E "Handling|rotating pattern"
```

`Handling 1 logs` と、`rotating pattern` に自分のログだけが出れば正しい。他サイトのパスが出たら設定が広すぎる。

## 既存のログが肥大していないかの確認

```bash
# サイズと最終更新（ファイルは 600 root:root なので中身は sudo が要るが、ls / stat は要らない）
ssh "${VPS_SSH_HOST:-sakura-vps}" 'ls -la /var/log/giinrecord-*.log /var/log/nginx/giinrecord.*.log*'

# 増加ペース: 作成時刻からの平均バイト/日
ssh "${VPS_SSH_HOST:-sakura-vps}" 'for f in /var/log/giinrecord-*.log; do
  s=$(stat -c %s "$f"); b=$(stat -c %W "$f"); n=$(date +%s)
  [ "$b" -gt 0 ] && echo "$f: $s bytes, $(( s / ((n-b)/86400 + 1) )) bytes/day since $(stat -c %w "$f" | cut -d" " -f1)"
done'

# ディスク全体の余裕（監視の disk check も同じものを見ている）
ssh "${VPS_SSH_HOST:-sakura-vps}" 'df -h /'
```

**目安**: 監視ログが 100 MB を超えていたら想定の 80 倍以上で、ローテーションが効いていないか、`health.sh` が想定外の量を出している。まず `logrotate` の状態を見る。

```bash
# いつ回ったか（状態ファイルは root のみ読めるので sudo が要る）
ssh "${VPS_SSH_HOST:-sakura-vps}" 'sudo grep giinrecord /var/lib/logrotate/status'

# 手で 1 回試す（-f は強制。--debug と違い実際に回るので、上の確認をしてから）
ssh "${VPS_SSH_HOST:-sakura-vps}" 'sudo logrotate -v /etc/logrotate.d/giinrecord-monitor'
```

回った後は `giinrecord-monitor.log.1`、以降 `.2.gz` … が並ぶ（`delaycompress` なので直近 1 世代は非圧縮）。過去分の検索は `zgrep`。

```bash
ssh "${VPS_SSH_HOST:-sakura-vps}" 'sudo zgrep -h "ERROR" /var/log/giinrecord-monitor.log*'
```

## 設定はどこから来るか

リポジトリの fixture が唯一の出所で、セットアップスクリプトがそれを置く。

- `deploy/monitor/logrotate.conf` → `deploy/monitor/setup.sh` が `install -m 644` で `/etc/logrotate.d/giinrecord-monitor` へコピー
- `deploy/analytics/logrotate.conf` → `deploy/analytics/vps-analytics-setup.sh` が同じ内容を heredoc で `/etc/logrotate.d/giinrecord-analytics` に書く
  - こちらが埋め込みなのは、このスクリプトが `sudo bash -s` で**標準入力から**流して実行される場合があり、チェックアウト上のファイルを読めないため。**二重管理になるので、`deploy/test/logrotate.test.sh` が fixture と埋め込みの差分を検査**していて、ずれると CI が落ちる。

`/etc/logrotate.d/` のファイルは **644 でなければならない**（group/other 書き込み可の設定を logrotate は読み飛ばす）。両方とも 644 で置く。

セットアップし直すには、それぞれの手順（`docs/ops/monitoring.md` / `docs/ops/analytics.md`）をもう一度実行すればよい。どちらも冪等。
