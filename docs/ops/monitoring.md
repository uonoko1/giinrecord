# 監視の運用（SaaS なし・自前）

Issue #135。外部 SaaS（UptimeRobot / Datadog / Sentry 等）は使わない。**ダッシュボードは無い。label `monitor` の open Issue 一覧が現在の状態**（0 件 = 正常）。

```
GitHub Actions  monitor.yml ──10分おき──▶ https://giinrecord.jp          ┐ /, /members/, /assemblies/, 議会ページ, /data/meta.json, TLS 期限
                            ──毎時────▶ https://staging.giinrecord.jp  ┘ deploy/monitor/probe.sh → run.sh → report.sh (gh)
                                                                              │ 2 回連続で失敗 → Issue "[monitor] <env>: <check>"
VPS  root cron 5分  /usr/local/lib/giinrecord-monitor/health.sh                 │ 復旧 → 自動 close
       コンテナ healthy・ディスク・nginx・rsync 先の鮮度                        │
       → /var/log/giinrecord-monitor.log, ~ubuntu/monitor/latest.json           │
       → curl で Issues API（/etc/giinrecord/monitor.token、無ければ通知なし） ──┘ Issue "[monitor] vps: <check>"
```

## 何を見ているか

### 外から（`.github/workflows/monitor.yml`）

| check | 条件 | 失敗時に疑うもの |
|---|---|---|
| `http` | `/`・`/members/`・`/assemblies/`・`/data/meta.json` が 200、HTML の `<title>` に『議員レコード』。加えて**議会ページ `/assemblies/{id}`**（#248、下記） | コンテナ停止（502）、ホスト nginx 停止、rsync 先が空（404）、DNS、プリレンダー漏れ |
| `data` | `meta.fetchedAt`（トップレベル＝ETL 実行時刻）が 48 時間以内 | `etl.yml` の失敗、data PR が未マージ、`deploy-data.yml` の失敗 |
| `tls` | 証明書の残り 14 日以上 | certbot の自動更新が止まっている（`sudo certbot renew --dry-run`） |

- production は `*/10`、staging は毎時 7 分（両方 `workflow_dispatch` 可）。
- staging は Cloudflare Access の裏（#163）：repo secrets `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`（Service Token）でヘッダを付けて
  probe する。無ければ `::warning::` を出してスキップ（誤報しない）。設定とローテーションは `docs/ops/staging-access.md`。
- **2 回連続**（60 秒空けて再試行）で失敗した check だけ Issue にする（`deploy/monitor/run.sh`）。1 回だけの失敗は run のログに残るのみ。
- Issue は title `[monitor] production: http` のように **環境 × check で 1 つ**。同名の open Issue があれば作らない（`deploy/monitor/report.sh`）。check が通れば「Recovered」コメントを付けて close する。
- 本文に書くのは環境名・check・理由（パスと HTTP status、経過時間、残日数）・run へのリンクだけ。

#### 議会ページの監視（#248）

地方議会が 0→7 と増えるあいだ、`/assemblies/` も個別の議会ページも監視対象外だった（500 や 404 でも素通り）。いまは `http` check がここも見る。

- **対象はハードコードしない。** probe は **`/assemblies/` のページに出ている `href="/assemblies/{id}"` リンクから id を列挙**し、`/assemblies/{id}` を叩く。議会が増えれば次の run から自動で監視対象になり、`probe.sh` に足し忘れることが起きない。`/assemblies/` にリンクが 1 本も無ければ、それ自体が `http` の失敗になる（黙って「議会 0 件だから全部 pass」にはならない）。
- **なぜ `data/assemblies/index.json` を使わないか。** そのファイルは `apps/web/app/lib/dataset.ts` が `import.meta.glob` でビルド時に JS チャンクへバンドルしており、**`/data/` 配下に配信されない**。`/data/` に出るのは `apps/web/scripts/copy-member-data.ts` がコピーする `data/members/*.json` と `OPS_DATA_FILES`（`apps/web/app/lib/smoke.ts`）だけで、assemblies は含まれない。実際 `https://giinrecord.jp/data/assemblies/index.json` は **404**（`/data/meta.json` が 200 なのは #152 で明示的にコピー対象へ足したため）。**監視の情報源には「本番に実在するもの」しか使わないこと。**
- **1 回の run で叩く議会ページは `PROBE_ASSEMBLY_SAMPLE`（既定 3）本だけ。** 10 分スロットごとに **sample 幅ずつ**ずらして巡回する（1 つずつだと前回と重複して一巡が 3 倍かかる）。**議会が何議会に増えても 1 run のリクエスト数は一定**（`/`・`/members/`・`/assemblies/`・`/data/meta.json` ＋ 議会ページ 3 ＝ **7 本**）。一巡は `ceil(議会数 / sample)` スロット＝ 9 議会なら 30 分。
- **判定は既存と同じ厳しさ。** 200 であること、`<title>` に『議員レコード』が入っていること。プリレンダーが消えた場合、nginx は `/__spa-fallback.html` を 200 で返すが、**その `<title>` は `Loading...` でサイト名を含まない**ので、この既存判定だけで弾ける。
  - 加えて **ページ本文がその議会の id を含むこと**も見る。これは唯一の防御ではなく**多層防御**（fallback の title が将来変わった場合への耐性、別の議会のページが返る取り違えの検知）。判定に**名前ではなく id を使う**のは、id が ASCII で HTML/JSON エスケープの影響を受けないため。名前で照合すると `A&B議会` が `A&amp;B議会` として配信されて誤検知する。
- **Issue は増えない。** 失敗はすべて既存の `http` check に合流するので、Issue は従来どおり `[monitor] production: http` の 1 本。議会ごとに Issue が乱立することはない。理由の文字列にどのパスが落ちたかが入る。
- 2 回のラウンド（60 秒あけて再試行）は**同じ議会ページ**を見る（`run.sh` が `PROBE_NOW` を固定する）。ずれると「2 回連続で失敗」が別々のページの話になってしまうため。

##### 運用目標: 全議会を 60 分以内に一度は見る

**リクエスト数を固定に保つことは目的ではなく手段**である。巡回方式は「1 run のコストを抑える」ためのものだが、議会数が増えるほど一巡が延び、**最悪検知遅延（＝ページが落ちてから Issue が開くまで）が一巡時間 ＋ 10 分程度**に伸びる。放置すると「監視している」という安心感だけがあって実効が無い状態になる。

そこで運用目標を **「全議会を 60 分以内に一度は見る」** とする。議会が増えたら `PROBE_ASSEMBLY_SAMPLE` を引き上げてこれを維持すること。目安（一巡 = `ceil(n / sample)` × 10 分）:

| 議会数 | 必要な sample | 1 run のリクエスト数 | 一巡 |
|---|---|---|---|
| 9（現在） | 3（既定のまま） | 7 | 30 分 |
| 18 | 3 | 7 | 60 分 |
| 30 | 5 | 9 | 60 分 |
| 47（全都道府県） | 8 | 12 | 60 分 |
| 67 | 12 | 16 | 60 分 |

**現在の 9 議会・sample 3 は一巡 30 分・最悪検知遅延およそ 40 分**で目標内なので、既定値は 3 のまま変更しない。`18 議会を超えたら sample を上げる`のが次の判断ポイント。1 run が 20 リクエストを超えるようなら、巡回ではなく別の手段（議会ページのビルド時スモークテストなど）を検討したほうがよい。

### VPS 側（`deploy/monitor/health.sh`、root cron 5 分）

| check | 条件 | 失敗時に疑うもの |
|---|---|---|
| `container-web` / `container-web-staging` | `docker inspect` の Health が `healthy` | `docker compose ps`、`docker compose logs web`、`site.conf` の構文（`docs/ops/deploy.md` 失敗モード） |
| `nginx` | `systemctl is-active nginx` が `active` | `systemctl status nginx`、`nginx -t` |
| `disk` | web root のあるファイルシステム使用率 ≤ 85% | `journalctl --vacuum`、docker の `json-file` ログ、他サイトの増分（共用 VPS） |
| `site-production` / `site-staging` | `/var/www/giinrecord/{site,staging}/data/meta.json` が存在し更新 48 時間以内 | `deploy-data.yml` / Release / Deploy (staging) の失敗、rrsync の鍵 |

- 結果は毎回 `/var/log/giinrecord-monitor.log`（root 600）に 1 行（`<UTC> OK` / `<UTC> FAIL <check>: <理由>; …`）。最新の結果は `~ubuntu/monitor/latest.json`（owner ubuntu、600）にも置く（`{"checkedAt","ok","failures":[…]}`）。
- 2 回連続（10 分）で失敗した check は Issue `[monitor] vps: <check>`。Issue 番号は `/var/lib/giinrecord-monitor/issue.<check>`（root）に覚え、消えていても同名の open Issue を採用して重複させない。復旧でコメント＋close。
- **トークンが無い・API が失敗しても監視は止まらない**（ログに `note:` を 1 行書くだけ。終了コードは check の結果のみ）。
- Issue 本文は check 名と時刻のみ。ホスト名・IP・ユーザー名・パスは書かない。

## 初回セットアップ

### GitHub 側

何もしない。`monitor.yml` は `GITHUB_TOKEN`（`issues: write`）で動き、label `monitor` は初回の Issue 作成時に `gh label create --force` で作られる。
マージ後に Actions → Monitor → Run workflow で 1 回手動実行し、両 job が green（Issue が増えない）ことを確認する。

### VPS 側（PO が `giinops` で）

```sh
VPS_SSH_HOST="${VPS_SSH_HOST:-sakura-vps}"
# 1. 最新の main を VPS の checkout に
ssh "$VPS_SSH_HOST" 'cd /opt/giinrecord && sudo git pull --ff-only'
# 2. 冪等セットアップ（root 所有の health.sh、/etc/giinrecord（700）、log、state、~ubuntu/monitor、cron.d）
ssh "$VPS_SSH_HOST" 'sudo bash /opt/giinrecord/deploy/monitor/setup.sh'
# 3. fine-grained PAT を置く（root 600）。GitHub → Settings → Developer settings → Fine-grained tokens:
#    Repository access = このリポジトリのみ、Permissions = Issues: Read and write のみ、期限は 1 年以内
ssh -t "$VPS_SSH_HOST"                    # VPS のシェルで（トークンをコマンド行・履歴に残さない）:
#   sudo sh -c 'umask 077; read -r t; printf "%s\n" "$t" > /etc/giinrecord/monitor.token'   ← 空行のプロンプトに貼り付けて Enter
# 4. 確認（手動実行。OK なら何も出力しない）
ssh "$VPS_SSH_HOST" 'sudo /usr/local/lib/giinrecord-monitor/health.sh; sudo tail -3 /var/log/giinrecord-monitor.log'
ssh "$VPS_SSH_HOST" 'cat ~/monitor/latest.json'   # ubuntu として読める
```

`setup.sh` はパッケージを入れず、nginx・docker・sudoers に触れない。`health.sh` は `/opt/giinrecord` の checkout から root 所有の `/usr/local/lib/giinrecord-monitor/` に**コピー**される（root の cron が他ユーザーの書ける場所を実行しないため。analytics と同じ設計）。`health.sh` を変えたら `setup.sh` をもう一度走らせる。

トークンのローテーション：新しい PAT を同じ手順 3 で上書きするだけ。古い PAT は GitHub 側で revoke。

## 見方・止め方

```sh
# 状態 = open Issue
gh issue list --label monitor --state open
# VPS のログ
ssh "$VPS_SSH_HOST" 'sudo tail -20 /var/log/giinrecord-monitor.log'
# 一時停止（メンテナンスで誤報させたくないとき）
ssh "$VPS_SSH_HOST" 'sudo mv /etc/cron.d/giinrecord-monitor /root/giinrecord-monitor.cron.off'   # 戻すときは逆
#   Actions 側: Actions → Monitor → … → Disable workflow（終わったら Enable）
```

メンテナンス中に作られた Issue は復旧時に自動 close される。手で close しても次の失敗で作り直される（それが仕様）。

## 失敗モード

| 症状 | 原因 | 対応 |
|---|---|---|
| Actions の Monitor が失敗、Issue も立つ | 本当に落ちている | Issue の理由を見て `docs/ops/deploy.md` 失敗モードへ |
| Monitor が失敗したが Issue が無い | 1 回目だけ失敗（2 回目で回復） | 何もしない。続くなら run のログを見る |
| `[monitor] production: tls` | certbot の自動更新失敗 | `sudo certbot renew`、`systemctl list-timers \| grep certbot` |
| `[monitor] production: data` と `[monitor] vps: site-production` が同時 | ETL か deploy-data の失敗（データが届いていない） | Actions の ETL / Deploy data |
| `[monitor] production: data` だけ（vps 側は OK） | rsync は届いたが `fetchedAt` が古い＝ETL は走ったがデータを更新していない | ETL のログ |
| log に `note: no token at …` | トークン未設置 | 初回セットアップ 3 |
| log に `note: API … HTTP 401/403` | PAT 失効・権限不足（Issues: write が要る）・リポジトリ指定漏れ | PAT を作り直す |
| log に `note: API … curl failed` | VPS からの outbound が不通 | 監視自体は続く。復旧後に自動で報告される |
| `health.sh: refusing symlinked …` | `~ubuntu/monitor` がシンボリックリンク | 消して `setup.sh` を再実行 |
| 同じ check で Issue が 2 つ | 人が title を編集した／label を外した | 片方を close。title は触らない |
| `[monitor] vps: disk` | 共用 VPS の他サイト・docker ログ・journal | `df -h`、`docker system df`、`journalctl --disk-usage`。他サイトの資産は触らない |

## やらないこと

- SaaS・外部エージェント・常駐プロセスを増やさない。VPS 側は cron と curl だけ。
- `ubuntu`（CI deploy 鍵、rrsync 限定）に権限を足さない。`latest.json` は読めるが、監視スクリプトもトークンも root のもの。
- Actions から VPS に ssh しない（deploy 鍵は rrsync 限定のまま）。VPS → GitHub の outbound のみ。
- Issue に IP・ホスト名・ユーザー名・パスを書かない。VPS のログ（パスを含む）は root だけが読める。
- 閾値（48 時間、14 日、85%、2 回連続）はスクリプトの env で変えられるが、変えるなら先にテスト（`deploy/test/monitor-*.test.sh`）を直す。

## 変えるとき

- 外部 check は `deploy/monitor/probe.sh` と `deploy/test/monitor-probe.test.sh`（curl/openssl/gh は stub）。
- VPS check は `deploy/monitor/health.sh` と `deploy/test/monitor-health.test.sh`（docker/systemctl/df/curl は stub）。
- セットアップは `deploy/monitor/setup.sh` と `deploy/test/monitor-setup.test.sh`（`MONITOR_SETUP_PREFIX`）。
- スケジュールは `monitor.yml`。staging の cron を変えたら job の `if:` の文字列も同じにする。
