# 監視の運用（SaaS なし・自前）

Issue #135。外部 SaaS（UptimeRobot / Datadog / Sentry 等）は使わない。**ダッシュボードは無い。label `monitor` の open Issue 一覧が現在の状態**（0 件 = 正常）。

```
GitHub Actions  monitor.yml ──10分おき(名目)──▶ https://giinrecord.jp          ┐ /, /members/, /assemblies/, 議会ページ, /data/meta.json, TLS 期限
                            ──毎時────▶ https://staging.giinrecord.jp  ┘ deploy/monitor/probe.sh → run.sh → report.sh (gh)
                                                                              │ 2 回連続で失敗 → Issue "[monitor] <env>: <check>"
VPS  root cron 5分  /usr/local/lib/giinrecord-monitor/health.sh                 │ 復旧 → 自動 close
       コンテナ healthy・ディスク・nginx・rsync 先の鮮度                        │
       → /var/log/giinrecord-monitor.log, ~ubuntu/monitor/latest.json           │
       → curl で Issues API（/etc/giinrecord/monitor.token、無ければ通知なし） ──┘ Issue "[monitor] vps: <check>"

GitHub Actions  security-alerts.yml ──毎日 06:53 JST──▶ GitHub 自身の security アラート（#786）
       secret scanning / Dependabot の open アラートを読む                       ┐ deploy/monitor/security-alerts.sh
       **PAT が要る**（GITHUB_TOKEN では 403。下記）                              │  → security-alerts-report.sh → report.sh
                                                                                 │ open あり → "[monitor] repo: security アラート"
                                                                                 ┘ 読めない  → "…security アラートを読めない"
```

> **監視は「見ている」だけでは足りず、「読んでいる」必要がある。**
> secret scanning は 21 日間ずっと正しく警告していた。**読んでいなかったのは我々のほうだった**（#786）。

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

**現在の 9 議会・sample 3 は一巡 30 分**で、上の表のとおり目標内である。`18 議会を超えたら sample を上げる`のが次の判断ポイント。1 run が 20 リクエストを超えるようなら、巡回ではなく別の手段（議会ページのビルド時スモークテストなど）を検討したほうがよい。

> **ただし上の一巡時間は「10 分おきに走る」前提の計算で、実際はそうなっていない**（Issue 373）。
> GitHub Actions の `schedule` は保証されたスケジューラではなく、公式ドキュメントが
> 「高負荷時には遅延またはスキップされる」と明記している。`*/10` のような高頻度 cron ほど間引かれる。
>
> 直近 60 件の実行間隔の実測（2026-08-27 09:27 〜 09-02 14:20）:
>
> | | 値 |
> |---|---|
> | 中央値 | **119 分** |
> | 最大 | **676 分（11 時間 15 分）** |
> | 10 分以内だった割合 | **3%** |
> | 60 分を超えた間隔 | **42 回 / 59 回** |
>
> したがって **`monitor.yml` の側では「60 分以内に一度は見る」を約束できない**。
> 上の表は「間引かれなければこうなる」という上限であって、実効の保証ではない。
> **落ちたことに確実に気づく役目は VPS 側の cron（下）が負う**。`monitor.yml` は
> 「**外から**（GitHub のネットワークから）見えるか」を、間隔の保証なしに確かめるものと位置づける。

### VPS 側（`deploy/monitor/health.sh`、root cron 5 分）

**落ちたことに確実に気づく役目はこちらが負う**（Issue 373）。GitHub Actions の `schedule` と違い、
VPS の cron は自前のマシンなので間引かれない。実測（`/var/log/giinrecord-monitor.log` の更新時刻）:

```
2026-09-03 00:40:01
2026-09-03 00:45:02   ← ちょうど 5 分
```

**間隔の保証はここにある**。`monitor.yml` は「外から見えるか」を間隔の保証なしに確かめる補助。


| check | 条件 | 失敗時に疑うもの |
|---|---|---|
| `container-web` / `container-web-staging` | `docker inspect` の Health が `healthy` | `docker compose ps`、`docker compose logs web`、`site.conf` の構文（`docs/ops/deploy.md` 失敗モード） |
| `nginx` | `systemctl is-active nginx` が `active` | `systemctl status nginx`、`nginx -t` |
| `disk` | web root のあるファイルシステム使用率 ≤ 85% | `journalctl --vacuum`、docker の `json-file` ログ、他サイトの増分（共用 VPS） |
| `site-production` / `site-staging` | `/var/www/giinrecord/{site,staging}/data/meta.json` が存在し更新 48 時間以内 | `deploy-data.yml` / Release / Deploy (staging) の失敗、rrsync の鍵 |

- 結果は毎回 `/var/log/giinrecord-monitor.log`（root 600）に 1 行（`<UTC> OK` / `<UTC> FAIL <check>: <理由>; …`）。このログは `/etc/logrotate.d/giinrecord-monitor`（monthly・12 世代・`maxsize 32M`、#288）で回る。肥大の確認手順は `docs/ops/log-rotation.md`。最新の結果は `~ubuntu/monitor/latest.json`（owner ubuntu、600）にも置く（`{"checkedAt","ok","failures":[…]}`）。
- 2 回連続（10 分）で失敗した check は Issue `[monitor] vps: <check>`。Issue 番号は `/var/lib/giinrecord-monitor/issue.<check>`（root）に覚え、消えていても同名の open Issue を採用して重複させない。復旧でコメント＋close。
- **トークンが無い・API が失敗しても監視は止まらない**（ログに `note:` を 1 行書くだけ。終了コードは check の結果のみ）。
- Issue 本文は check 名と時刻のみ。ホスト名・IP・ユーザー名・パスは書かない。

### GitHub の security アラート（`.github/workflows/security-alerts.yml`、毎日 06:53 JST）

**GitHub 自身が出しているアラートを、毎日誰かが読むようにしたもの**（#786）。

**なぜ要るか（実測）**: secret scanning のアラート #1 は **2026-08-23T16:51:24Z に立ち、21 日間、誰も見ていなかった**。中身は本物の漏洩だった（#785）。**その間 CI は全部緑で、gitleaks はこの形を検出しない**（実測: `no leaks found`）。**唯一これを見つけていた検出器の出力を、我々は読んでいなかった。見ていない検出器は、無い検出器と同じである。**

| 見るもの | API | Issue |
|---|---|---|
| secret scanning の open アラート | `repos/{owner}/{repo}/secret-scanning/alerts` | `[monitor] repo: security アラート` |
| Dependabot の open アラート | `repos/{owner}/{repo}/dependabot/alerts` | 同上（1 本にまとめる） |
| **どちらかが読めなかった** | — | `[monitor] repo: security アラートを読めない` |

- 検査は `deploy/monitor/security-alerts.sh`（exit 0 = 全部読めて 0 件 / 1 = open あり / 2 = **読めなかった**）。Issue の開閉は `deploy/monitor/security-alerts-report.sh` が `report.sh` 経由で行う（`monitor.yml` と同じ作法。タイトルが同一性なので溜まらない）。
- **「読めなかった」と「0 件」は別の Issue** にしてある。読めていないのを緑にすると **21 日がそのまま戻る**（#757 の母数）。rc=2 のときは「アラート」Issue に**触らない**——そのとき判定していないものを閉じるのは嘘になる。
- **Issue 本文に書くのは「種類・件数・GitHub 上の URL」だけ。** 秘密の値・該当ファイル・行・commit は**書かない**。実測（2026-09-13）した本物の応答は **`.secret` に平文の鍵そのもの**を持っており、そのまま本文に入れれば**警告そのものが漏洩になる**。実装は**許可リスト**（`.secret_type_display_name` と severity だけを取り出す）。denylist（「`.secret` を消す」）にしないこと——API はフィールドが増え続けており、denylist は常に 1 つ後ろを走る。

#### **PAT が要る（人間の作業）**

**既定の `GITHUB_TOKEN` では両方とも読めない。** CI 上で実測した（2026-09-13, run 34753557512）:

```
RESULT secret-scanning/alerts: NOT READABLE   HTTP 403 Resource not accessible
RESULT dependabot/alerts:      NOT READABLE   HTTP 403 Resource not accessible
```

**`permissions:` に `secret-scanning` や `dependabot-alerts` と書くのは誤り。** そんなキーは存在せず、書くと **#540 と同じく workflow が構文として拒否されて検査ごと動かなくなる**。GitHub が受け付けるスコープの全部（actionlint で実測）は `actions` / `artifact-metadata` / `attestations` / `checks` / `contents` / `deployments` / `discussions` / `id-token` / `issues` / `models` / `packages` / `pages` / `pull-requests` / `repository-projects` / `security-events` / `statuses` で、**唯一それらしい `security-events` は code scanning のスコープ**であって、この 2 つの API は対象外。

作り方（`docs/ops/deploy.md`「main の保護設定」の PAT と同じ流儀）:

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token
2. **Repository access**: このリポジトリのみ
3. **Repository permissions**: `Secret scanning alerts: Read-only` と `Dependabot alerts: Read-only` **だけ**（それ以外は No access。**書き込みを与えない**）
4. 有効期限を設定し、期限を `docs/ops/board.md` に控える
5. **置くのはスクリプトでできる**（ブラウザが要るのは上の 1〜3 だけ）:

```
bash scripts/human-tasks.sh --yes --set-security-alerts-token
# ↑ を打ってから、**トークンを貼って Enter**
```

  **トークンは引数では渡せない**（`--security-alerts-token <PAT>` は usage で弾かれる）。シェルの履歴と `ps` に残るため——`gh secret set` に `--body -` で渡していても、**その前段で argv に載っていれば同じこと**。受け取り口は**標準入力か環境変数 `SECURITY_ALERTS_TOKEN` の 2 つだけ**（`docs/ops/deploy.md` の `BRANCH_PROTECTION_TOKEN` と同じ流儀。#790 / #798）。

  これは secret `SECURITY_ALERTS_TOKEN` を置いたうえで、**そのトークンで実際に 2 つのフィードを読めるか**まで確かめる（**置けただけでは成功と言わない**。権限の足りない PAT も secret としては置けてしまうため）。トークンは**出力にもログにも出さない**（長さだけ出す）。

**ワークフロー側の変更は要らない。** `security-alerts.yml` は `${{ secrets.SECURITY_ALERTS_TOKEN || secrets.GITHUB_TOKEN }}` を使っており、secret を置いた次の実行から自動的にそちらを使う。**置くまでは `GITHUB_TOKEN` に落ちて exit 2（読めない）を報告し続ける。**

**PAT を置くまでの間も、ワークフローを消さないこと。** 「読めない」ことを検出して別の Issue で報告する状態のほうが、**何も見ていない状態より良い**。

#### アラートの Issue が開いたときにやること

1. Issue 本文の `https://github.com/<owner>/<repo>/security` を開く（**push 権限が要る**）。**中身は Issue には書かれていない。**
2. secret scanning なら: **まず鍵を失効させる**（リポジトリから消すだけでは、履歴に残るし既に漏れている）。そのうえでリポジトリ側の発生源を消す（#785 の徳島のフィクスチャがこの形）。
3. Dependabot なら: Dependabot が出している PR を取り込む。取り込めない事情があるなら `scripts/ci/audit-ignore.txt` に**期限と理由を付けて**書く（`scripts/ci/audit.sh`）。
4. アラートが 0 件になれば、**次の実行で Issue は自動で閉じる**。手で閉じなくてよい。

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
