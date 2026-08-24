# 日次 ETL の運用（`.github/workflows/etl.yml`）

## 流れ

```
06:00 JST schedule / workflow_dispatch(sessions)
  0. docker build           packages/etl/Dockerfile → gikailog-etl:ci（GHCR に push しない。レイヤーは type=gha キャッシュ）
  1. actions/cache/restore  packages/etl/.cache（key: etl-cache-YYYY-MM-DD、restore-keys で前日以前から復元）
  2. docker run [sessions]  data/ と packages/etl/.cache を bind mount、runner の uid で実行 → data/ を書き、validateDataset が違反を見つけたら非0終了
  3. actions/cache/save     失敗しても保存（if: always）
  4. data PR                git diff に変更があれば data/refresh に force push → open PR が無ければ作成 → `gh pr merge --auto`
  5. Job summary            結果 / データ PR 番号 / 変更ファイル数 / unmatched・unmatched-bills 件数 / ログの警告行
  6. マージ待ち → Deploy    最大 15 分 PR の state を 20 秒ごとに見る。MERGED で `gh workflow run deploy-data.yml --ref main`（staging + production の両方、#127）
  7. failure()              「ETL 日次実行が失敗した（etl.yml）」という Issue を作る（同タイトルの open Issue があればコメントだけ）
```

- `.cache/` のうち回次一覧 `vote_ind.htm`・議員名簿・議案ページ（参院 meisai・衆院 kaiji/keika）・会議録 API は ETL 側が `noCache` で毎回取得する。衆院 議案情報は Shift_JIS で、回次あたり一覧 1 ページ＋経過ページ約 160 枚（0.5 秒間隔で約 1.5 分）。質問主意書（#106）も毎回取得する: 衆院 `itdb_shitsumon.nsf/html/shitsumon/kaiji{回次}_l.htm`（Shift_JIS）→ 経過ページ、参院 `joho1/kousei/syuisyo/{回次}/syuisyo.htm` → 詳細ページ。提出日・答弁書受領日は一覧に無く詳細ページにしかないので1件1ページ（第217回は衆 352＋参 247 枚、5 回次合計で約 1,100 枚 ≒ 10 分）。キャッシュが効くのは各採決の投票結果ページ（不変）だけ。
- 06:30 JST の `deploy-data.yml` schedule は安全網。通常は 6 で起動された Deploy data が先に走る（`deploy-site.yml` の `concurrency: deploy-<dir>` で重複は直列化）。

## 確認の仕方（PO チェックリスト）
`scripts/po/etl-verify.sh` が 1〜3 を 3 行にまとめて出す（`docs/ops/board.md`）。手で見るなら：
1. Actions → ETL (daily) → 最新 run の **Summary** を見る。「データ PR」が `#N` か「なし」か、unmatched 件数が前日から急増していないか。
2. 「deploy-data.yml を起動した」が Summary にあれば Actions → Deploy data に run があるはず。
3. 無ければ `gh workflow run deploy-data.yml --ref main` を手で叩く。

## 失敗モード

| 症状 | 原因 | 対応 |
|---|---|---|
| `Run ETL` で非0終了、`data contract violations` | 上流 HTML の構造変化・表記ゆれで不変条件違反 | data/ は触られない。ログの違反行をもとにパーサー／フィクスチャを修正 |
| `docker/build-push-action` で失敗 | `pnpm install --frozen-lockfile` が lockfile と不一致、または Docker Hub 障害 | `docker build -f packages/etl/Dockerfile .` を手元で再現。lockfile を更新した PR は必ずイメージもビルドされる（etl.yml は毎回ビルド） |
| `Run ETL` 後に `git add data` が permission denied | コンテナが runner と別の uid で書いた | `docker run --user "$(id -u):$(id -g)"` が外れていないか確認。`.cache` の mkdir が先に走っているか |
| `Run ETL` で `HTTP 5xx` / timeout | 参議院・国会会議録の障害 | 翌日の schedule で自動再試行。急ぐなら手動 dispatch（取得済みページはキャッシュから復元される） |
| データ PR が作られない／Summary で「なし」 | 本当に差分が無い（ETL は `fetchedAt` を meta.json に書くので通常は毎回差分が出る） | `meta.json` まで変わらないなら ETL が data/ を書いていない。ログの `done` を確認 |
| `test -n "$NUMBER"` で失敗 | `gh pr create` 失敗（label `etl` が無い、権限不足） | 手元で `gh pr list --head data/refresh`。label が無ければ作る |
| 15 分待っても MERGED にならない | ブランチ保護の required check が走らない。`GITHUB_TOKEN` の push は `pull_request` イベントを起こさないため、CI を required にすると auto-merge が永遠に待つ | required check を外すか、push に PAT / GitHub App token を使う（`secrets.GITHUB_TOKEN` から差し替える）。手動で PR をマージすれば staging は `push: main` で走るが production は走らない点に注意 → `gh workflow run deploy-data.yml` |
| `action_required` の run が出る | fork 由来ではないので通常は出ない。出た場合はワークフローが `actions/runs/{id}/approve` を試みる | 承認できない（権限）なら Actions UI で承認 |
| Deploy が `waiting` のまま | `environment: production` に required reviewers が設定されている | 環境の保護ルールを確認。ETL 側からは承認しない（人が判断する） |
| 失敗 Issue が作られない | `issues: write` 権限・`etl`/`infra` label の欠落 | run ログの `Open failure Issue` ステップを見る。label は存在しないと API が 422 を返すので事前に作っておく |
| 同じ失敗で Issue が増える | タイトルが変わった／前の Issue を close していた | タイトルは `FAILURE_ISSUE_TITLE` で固定。直したら close、直るまで open のままにする |

## 手動実行
```
gh workflow run etl.yml                       # 現行回次
gh workflow run etl.yml -f sessions="217 221" # 複数回次
gh run watch                                   # 進捗
```
ローカルでは `pnpm etl 221` → `git diff --stat data/` で同じものが再現できる。

## 過去回次（第200〜216回）を足す（#103）
- 日次 ETL（schedule / 引数なし）が**取得する**のは既定の直近 5 回次だけ（`etl.yml` の `SESSIONS` 既定値と `DEFAULT_SESSIONS`。変えない）。`data/` に既にある他の回次は前回出力から引き継ぐ（採決は今回の名簿で再突合、審議結果は `rollcalls/index.json` から、議案は `bills/` から、発言・質問主意書・委員会出席・参法の提出は `members/{id}.json` の `session` 付きの行から。`docs/DATA_CONTRACT.md`「回次」）。毎日全回次を取り直すことはない。
- 過去回次は `workflow_dispatch` で 1 回だけ走らせ、データ PR として取り込む:
  ```
  gh workflow run etl.yml -f sessions="200 201 202 203 204 205 206 207 208 209 210 211 212 213 214 215 216"
  ```
  このとき直近 5 回次は引き継ぎになり、衆院本会議の発言（名簿が覆う最新回次の分）も取得せず前回出力から引き継ぐ（取得すると引き継ぎと重複するため。ログに `shugiin speeches not fetched (session is carried …)`）。**注意**: #103 より前の出力には `session` の無い timeline 行があり（ログに `carried: N timeline entries without session … cannot be carried`）、その分の発言・質問主意書・委員会出席は引き継げない。過去回次の手動実行のあと、翌日の日次実行（直近 5 回次を取り直す）で復元されるので、手動実行の PR と翌日の PR をセットで見る。先に日次実行を一度通して（全行に `session` が付く）から過去回次を足せば欠けは出ない。
- 名簿は取得回次 ∪ 引き継ぐ回次と、連続するブロックごとの1つ前の回次の分を毎回取る（回次が飛んでいても第217回の再突合には第216回の名簿が要る）。引き継いだ採決の再突合で memberId の付いた票が前回より減ったら（ログに `carried roll calls lost matched votes …`）名簿の取り漏れなので、ETL は書き出さずに非0終了する。
- 第215回以前は回次ごとの参院名簿が公開されていない（`giin/{N}/giin.htm` が 404。ログに `no roster published (404)`）。その回次の採決は第216回以降の名簿で突合するので、2024年以前に退任した議員の票は `unmatched.json` に載る（上限なし。件数は Summary で見る）。氏名だけから議員を作ることはしない。
- 投票結果一覧には**起立採決**（個人票なし）のページも載る。ログの `session N: X roll calls (Y with individual votes, Z standing votes skipped)` の Z がそれで、`rollcalls/` には入らない。第210回・第216回は全件が起立採決。
- ローカルで再現: `pnpm etl 200 … 216`（初回は投票結果ページを全部取るので回次あたり数分。2 回目以降はキャッシュ）。

### 計測（2026-08-24、手元。第200〜221回）
| 項目 | 第217〜221回（main） | 第200〜221回 |
|---|---|---|
| `pnpm etl 200 … 216`（手動、初回） | — | 77 分（4,596 秒。投票結果・議案・質問主意書の取得待ちがほぼ全部。2 回目以降は投票結果ページがキャッシュされる） |
| 投票結果一覧の件数 / うち押しボタン投票 | 287 / 287 | 1,062 / 380（第200〜216回の 775 件中 93 件だけが押しボタン、682 件は起立採決） |
| `data/` | 1,743 ファイル | 3,326 ファイル・106 MB（members 828・rollcalls 380・bills 1,941） |
| `unmatched.json` | 数件 | 4,846 行（vote 4,726: 第200回 2,006・第201回 1,829・第204回 283 …。名簿の無い回次の退任議員） |
| `group-mismatch.json` | 211 行 | 10,639 行（第200〜201回の会派名が今の名簿と違う: 「自由民主党・国民の声」「立憲・国民．新緑風会・社民」など） |
| `pnpm build`（prerender 1,229 ページ） | — | 38 秒 |
| `sitemap.xml` | — | 1,229 URL・94 KB |
| `data-archive.zip` | — | 11.6 MB（上限 50 MiB） |
| `build/client` | — | 439 MB（members 247 MB・rollcalls 82 MB・data 92 MB） |
| `pnpm --filter web smoke` | — | 5 秒（1,230 ページ・119,121 内部リンク） |

- 日次実行（引数なし。直近 5 回次を取得し、第200〜216回は引き継ぎ）: 27 分（1,593 秒。第200〜216回を足す前とほぼ同じ。引き継ぎは 93 採決・6,451 行で数秒）。名簿の 404（第199〜215回、17 回）は 1 回 0.5 秒。
- 引き継ぎで落ちるもの: 引き継ぐ回次の質問主意書・議案の**未突合行**（`unmatched.json` の `kind: "question"` / `"bill"`）はその回次を取得した実行にしか載らない（採決の未突合は再突合するので毎回載る）。第200〜216回の未突合質問（119 行）を見たいときは手動実行の Summary を見る。
- 手動実行の直後は第217〜221回の発言・質問主意書・委員会出席が（`session` の無い旧出力から引き継げず）一時的に減り、翌日の日次実行で戻る（上の注意）。2 回目以降の手動実行ではこの欠けは出ない。

## コンテナで実行する（#86）
CI と同じイメージ（`packages/etl/Dockerfile`、node:24-alpine、非 root の `node` ユーザー、secrets なし）をローカルでも使える。
`data/` と `packages/etl/.cache` は bind mount なので、`pnpm etl` と同じ場所に同じファイルを書く。

```
# 単体（deploy/docker-compose.etl.yml だけ）
ETL_UID=$(id -u) ETL_GID=$(id -g) docker compose -f deploy/docker-compose.etl.yml run --rm --build etl 221
# サイト側の compose（#85）と重ねる場合
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.etl.yml run --rm etl 221
# compose を使わない場合
docker build -f packages/etl/Dockerfile -t gikailog-etl .
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/data:/app/data" -v "$PWD/packages/etl/.cache:/app/packages/etl/.cache" gikailog-etl 221
```

- `ETL_UID`/`ETL_GID` を省くと 1000:1000（イメージ内の `node`）で動く。ホストの uid が 1000 でないなら必ず渡す（root や別 uid のファイルが data/ に残ると `git add` と次の `pnpm etl` で困る）。CI は `--user "$(id -u):$(id -g)"` で runner の uid に合わせている。
- `.cache` ディレクトリは先に作っておく（`mkdir -p packages/etl/.cache`）。無いと docker が root 所有で作る。
- イメージには pnpm workspace（`package.json`・lockfile・`packages/etl`・`packages/shared`）しか入らない（`.dockerignore`）。`.env`・`data/`・`.cache` は入らない。ETL は公開サイトしか読まないので secrets は不要。
- **byte-identical の確認**: `scripts/etl-docker-diff.sh 221` が `pnpm etl 221` → コンテナ実行 の順に走らせ、`data/` のスナップショットを `diff -r` する。`meta.json` の `fetchedAt`（実行時刻）だけは固定値に置換して比べる。`OK: byte-identical` で終了コード 0。回次一覧・名簿・議案・会議録 API は毎回取得するので、2 回の実行の間に上流が更新されれば差分が出る（もう一度流す）。
- `packages/etl/test/docker-etl.test.ts` が Dockerfile（非 root USER・secrets なし）、`.dockerignore`、compose の mount、etl.yml の `docker run --user … -v …` を回帰テストとして固定している。

## このワークフローを変えるとき
- `actionlint` を通す（`curl -sL https://github.com/rhysd/actionlint/releases/download/v1.7.7/actionlint_1.7.7_linux_amd64.tar.gz | tar xz actionlint && ./actionlint .github/workflows/*.yml`）。
- シェル断片はローカルで一度実行して確かめる（`${PR:+...}${PR:-...}` の二重展開のような罠がある）。
- `run` でパイプ（`... | tee`）を使うステップには `shell: bash` を付ける。`shell:` 未指定の既定は `bash -e {0}` で pipefail が無く、`bash -e -c 'false | tee /dev/null; echo $?'` → `0` のように左側の失敗が握りつぶされる。`shell: bash` なら `bash --noprofile --norc -eo pipefail {0}` になる（`packages/etl/test/workflow-etl.test.ts` が回帰テスト）。
- 本番で試すには `workflow_dispatch` で流し、Summary と data PR、Deploy run の 3 つを確認する。

## データ一括アーカイブ（`/data/data-archive.zip`、#49）
- `pnpm --filter web build` の最後に `apps/web/scripts/build-archive.ts` が `data/` 全体（`LICENSE` 含む）＋ `README.txt`（ライセンス・帰属表示・出典・取得時刻）を `build/client/data/data-archive.zip` に書く。Deploy は `build/client/` を rsync するので自動で配布される。
- 再現可能：エントリはパスのバイト順、mtime は 1980-01-01 固定、deflate level 9。同じ `data/` からは同じバイト列（sha256 一致）。
- `pnpm --filter web smoke` が、zip の存在・エントリ数（data/ のファイル数 + README）・`LICENSE`/`README.txt` の同梱・サイズ上限（既定 50 MiB、`ARCHIVE_MAX_BYTES` で上書き）を検査する。上限を超えたら意図して上げる（回次が増えたとき）。

## 選挙区 ETL（月次、`.github/workflows/districts.yml`、#111）
- 毎月 2 日 05:00 JST（KEN_ALL は月末更新）と `workflow_dispatch`。日次と同じイメージで `--entrypoint node … src/districts-cli.ts` を走らせ、`data/districts/` だけを書く。data PR の流れ（ブランチ再作成 → `gh pr create` → auto-merge → マージ待ち → deploy-data.yml 起動 → 失敗 Issue）は日次と同じで、ブランチは `data/districts`、失敗 Issue のタイトルは「選挙区 ETL 月次実行が失敗した（districts.yml）」。`concurrency: etl` で日次と直列化する。
- Summary に KEN_ALL 更新日・郵便番号／市区町村／小選挙区の件数・**分割市区町村の件数**（候補を並べただけで推定していない数。2026-08 時点で 33）を出す。件数が急に変わったら総務省の PDF か KEN_ALL の変化を疑う。
- 手動: `gh workflow run districts.yml`。ローカル: `pnpm etl:districts`（約 40 秒。総務省 PDF 47 本は `.cache/` にキャッシュ、KEN_ALL と HTML は毎回取得）。
- 失敗モード: 「matches no municipality」＝別表の単位が KEN_ALL に無い（市町村合併・区の再編 → `static-areas.ts` の `RENAMED_MUNICIPALITIES` に出典付きで追記）、「expected 47 prefecture PDFs」「not found on the download page」「expected 14 bureaus」＝ページのレイアウト変化（`docs/research/districts.md` の URL を確認してパーサーとフィクスチャを直す）、「district numbers not consecutive」「unbalanced parentheses」＝PDF のレイアウト変化。いずれも data/ は書かれない（書いた後の不変条件違反も PR にならない）。

## 地方議会 ETL（月次、`.github/workflows/local-assemblies.yml`、#157 宮城・#183 徳島・#184 鳥取・#203 三重）
- 毎月 5 日 05:00 JST（議会は定例会ごとに更新されるので月 1 回で足りる）と `workflow_dispatch`。日次と同じイメージで `--entrypoint node … src/local-cli.ts <name>` を `ASSEMBLIES`（`miyagi=pref-04 tokushima=pref-36 tottori=pref-31 mie=pref-24`。議会を足すときはここと `packages/etl/src/local-assemblies.ts` の `LOCAL_SOURCES` に 1 行）の順に走らせ、議会ごとに `data/assemblies/{id}/`（meta・sessions・rollcalls・unmatched）、`data/members/` のその議会の議員（index の行と `p_{prefCode}_*.json`）、`data/assemblies/index.json` のその議会の行だけを書く（国会の行も他の議会の行も触らない。日次 ETL も地方の行を残す）。data PR の流れは選挙区 ETL と同じで、ブランチは `data/local-assemblies`、失敗 Issue のタイトルは「地方議会 ETL 月次実行が失敗した（local-assemblies.yml）」。`concurrency: etl` で日次・選挙区と直列化する。
- 宮城県議会（`docs/DATA_CONTRACT.md`「地方議会」）: 名簿 3 ページ＋会期 index＋直近 2 会期の会期ページ（HTML、毎回取得）と表決 PDF（実行中だけ `.cache/`）。取得は `www.pref.miyagi.jp` だけ・UA `gikailog-etl/0.1`・1 秒以上間隔・robots.txt 遵守（`packages/etl/src/sources/local/polite-fetch.ts`。2026-08 時点で robots.txt は 404）。
- 徳島県議会（#183）: 議員紹介 2 ページ（会派別・選挙区別）＋定例会の概要（今年。足りなければ前年の年ページ）＋直近 2 会期の会期ページと、採決日ごとの表決 PDF（2月定例会は 3 本）。取得は `www.pref.tokushima.lg.jp` だけ（robots.txt は `/system` などを Disallow。`/gikai/` と `/file/attachment/` は対象外）。名簿に掲載日が無いので as-of は取得日（JST）。表決方法・人数の欄が無いので `method` / `counts` は書かない。PDF の表復元は宮城と同じ罫線方式（共通部は `sources/local/pdf-table.ts`）。
- 鳥取県議会（#184）: 取得は `www.pref.tottori.lg.jp` だけ（robots.txt は `/secure/221685/` などを Disallow。議決結果ページと賛否 PDF `/secure/{番号}/…` は対象外。毎回読んで従う）。名簿 1 ページ＋会期 index＋会期ページ（議決結果の無い会期も見て飛ばす）＋議決結果ページ（HTML、毎回取得）と賛否 PDF（会期に 4 本ほど。同じ内容の複製も URL が違えば取る。実行中だけ `.cache/`）。2026-08 時点で 118 件（6月定例会 30・2月定例会 88）、不明セル 0、unmatched 0。鳥取の PDF は姓だけなので、名簿に同姓が増えると unmatched が増える（候補は `unmatched.json` の `candidates` に列挙され、ETL は選ばない）。
- 三重県議会（#203）: 取得は `www.pref.mie.lg.jp` だけ（robots.txt の Disallow は 1 つの PDF のみで名簿・賛否は対象外。毎回読んで従う）。名簿は 選挙区別５０音順 1 ページ＋選挙区別名簿 → 15 選挙区ページ（`a name` の slug が id の元）、会期は「議案審議結果一覧」1 ページ → 月別の賛否 PDF（通年議会なので 1 会期＝1 年分。--sessions 2 の既定で令和8年・令和7年の 13 本）。PDF は 1 ページに全議案×全議員（47 列、列幅 約15pt）の高密度の表で、文字はオペレータ列から 1 命令 1 アイテムで読む（`mie/glyphs.ts`。getTextContent は令和8年5月分で隣の列の「辻󠄀」を前の氏名に結合して位置を失う）。表決方法の欄が無いので `method` は書かない。
- Summary に議会ごとの名簿の as-of（宮城は掲載日、徳島は取得日、鳥取は各議員の項目の掲載日の最新）・議員数・表決（議案）数・セル数（議員数×議案数）・**不明セル数**（置けなかったセルを推定せず「不明」にした数。2026-08 時点で 0）・**名簿に寄せられなかった氏名の数**（2026-08 時点で宮城 3: 第398回の PDF にだけ出る、その後に名簿から消えた人。徳島 0、鳥取 0）を出す。不明セルが 0 でなくなったら PDF のレイアウト変化（列幅・フォント）を疑い、`unmatched.json` が増えたら辞職・補選を疑う（どちらも事実として公開され、推定はしない）。
- 手動: `gh workflow run local-assemblies.yml`。ローカル: `pnpm etl:local miyagi` / `pnpm etl:local tokushima`（各 20 秒前後）、`pnpm etl:local tottori`（約 40 秒）、`pnpm etl:local mie`（約 40 秒。名簿 17 ページ＋PDF 13 本）。`--sessions N` で会期数。既定 2。
- 失敗モード: 「is not in the legend」＝凡例に無い値（PDF の凡例が増えた → `mapLegend` の対応を確認して `docs/DATA_CONTRACT.md` に追記。凡例の意味が「票を投じていない」と読めなければ mapped は付けない）、「member columns differ from page 1」「column N header … does not match」「header rules not found」＝PDF のレイアウト変化、「is in 会派別 but not in …」「do not add up to 定数」＝名簿 3 ページの食い違い（サイトの更新途中なら翌日に再実行）、「expected at most one 各議員の表決状況 link」「expected exactly one PDF link」＝会期 index／会期ページの変化、徳島は「expected one year heading」「no 各議員の表決態度 PDF」「PDF title says … but the link says …」（会期 index・会期ページ・PDF 表題の変化）、「legend (※ 「○」…) not found」「ditto … has no matching phrase」「section headings above the table」（PDF の節・凡例の形の変化）、「所属会派 … in 選挙区別 but … in 会派別」（名簿 2 ページの食い違い）、「fetch refused」＝許可ホスト外か robots.txt の Disallow。いずれも data/ は書かれない。
- 失敗モード（鳥取）: 「no 議決結果 link yet (skip)」は会期中で正常。「has no vote PDF links」＝議決結果ページはあるが PDF がまだ無い、「content differs between PDFs」＝同じ議案の複製 PDF の内容が食い違う（どちらが正しいか推定しないので止める。県に確認）、「does not end with 議員」「expected N columns left/right of the vote area」「group headings are not contiguous」＝PDF のレイアウト変化、「会派 … must be exactly one」＝名簿のカテゴリ変化、「PDF says … session index says …」＝会期 index と PDF 見出しの不一致。
- 失敗モード（三重）: 「選挙区ページで N 人」「ふりがな/所属会派 missing」「定数の合計 … !== ５０音順の定数」＝名簿 2 系統の食い違い（サイトの更新途中なら翌日に再実行）、「賛否 link … is not 令和N年M月」「PDF title says … but the link says …」＝会期 index と PDF の不一致、「column N header … !==」「expected one group-bottom rule」「member columns differ from page 1」「議案等番号 … is not {種別}第N号」＝PDF のレイアウト変化、「unsupported text-positioning op」「rotated/scaled text matrix」＝PDF の作り（描画命令）の変化（`mie/glyphs.ts` の前提が崩れた）。いずれも data/ は書かれない。
## 地方議会 ETL（月次、`.github/workflows/local-assemblies.yml`、#157 宮城・#183 徳島・#184 鳥取・#202 奈良）
- 毎月 5 日 05:00 JST（議会は定例会ごとに更新されるので月 1 回で足りる）と `workflow_dispatch`。日次と同じイメージで `--entrypoint node … src/local-cli.ts <name>` を `ASSEMBLIES`（`miyagi=pref-04 tokushima=pref-36 tottori=pref-31 nara=pref-29`。議会を足すときはここと `packages/etl/src/local-assemblies.ts` の `LOCAL_SOURCES` に 1 行）の順に走らせ、議会ごとに `data/assemblies/{id}/`（meta・sessions・rollcalls・unmatched）、`data/members/` のその議会の議員（index の行と `p_{prefCode}_*.json`）、`data/assemblies/index.json` のその議会の行だけを書く（国会の行も他の議会の行も触らない。日次 ETL も地方の行を残す）。data PR の流れは選挙区 ETL と同じで、ブランチは `data/local-assemblies`、失敗 Issue のタイトルは「地方議会 ETL 月次実行が失敗した（local-assemblies.yml）」。`concurrency: etl` で日次・選挙区と直列化する。
- 宮城県議会（`docs/DATA_CONTRACT.md`「地方議会」）: 名簿 3 ページ＋会期 index＋直近 2 会期の会期ページ（HTML、毎回取得）と表決 PDF（実行中だけ `.cache/`）。取得は `www.pref.miyagi.jp` だけ・UA `gikailog-etl/0.1`・1 秒以上間隔・robots.txt 遵守（`packages/etl/src/sources/local/polite-fetch.ts`。2026-08 時点で robots.txt は 404）。
- 徳島県議会（#183）: 議員紹介 2 ページ（会派別・選挙区別）＋定例会の概要（今年。足りなければ前年の年ページ）＋直近 2 会期の会期ページと、採決日ごとの表決 PDF（2月定例会は 3 本）。取得は `www.pref.tokushima.lg.jp` だけ（robots.txt は `/system` などを Disallow。`/gikai/` と `/file/attachment/` は対象外）。名簿に掲載日が無いので as-of は取得日（JST）。表決方法・人数の欄が無いので `method` / `counts` は書かない。PDF の表復元は宮城と同じ罫線方式（共通部は `sources/local/pdf-table.ts`）。
- 鳥取県議会（#184）: 取得は `www.pref.tottori.lg.jp` だけ（robots.txt は `/secure/221685/` などを Disallow。議決結果ページと賛否 PDF `/secure/{番号}/…` は対象外。毎回読んで従う）。名簿 1 ページ＋会期 index＋会期ページ（議決結果の無い会期も見て飛ばす）＋議決結果ページ（HTML、毎回取得）と賛否 PDF（会期に 4 本ほど。同じ内容の複製も URL が違えば取る。実行中だけ `.cache/`）。2026-08 時点で 118 件（6月定例会 30・2月定例会 88）、不明セル 0、unmatched 0。鳥取の PDF は姓だけなので、名簿に同姓が増えると unmatched が増える（候補は `unmatched.json` の `candidates` に列挙され、ETL は選ばない）。
- 奈良県議会（#202）: 取得は `www.pref.nara.lg.jp` だけ（robots.txt は `/documents/22137/*` を Disallow。名簿・会期ページ・表決 PDF は対象外。毎回読んで従う）。名簿（五十音順、1 ページ。as-of はページの「（令和8年4月24日現在）」）＋会期 index `/n161/18579.html`＋会期ページ（表決 PDF の無い会期＝会期中は飛ばす。HTML は毎回取得）と「議員別の議案等に対する表決結果」PDF（議決日ごとに 1 本。実行中だけ `.cache/`）。2026-08 時点で 125 件（6月定例会 37・2月定例会 88）、不明セル 0、unmatched 0。奈良の PDF は文字層で一部の字が落ちる（「芦髙清友」の外字「芦」、「西川均」の「均」）ので、完全一致 → 部分列一致（1 人に決まるときだけ）で寄せる（`docs/DATA_CONTRACT.md`）。
- Summary に議会ごとの名簿の as-of（宮城は掲載日、徳島は取得日、鳥取は各議員の項目の掲載日の最新）・議員数・表決（議案）数・セル数（議員数×議案数）・**不明セル数**（置けなかったセルを推定せず「不明」にした数。2026-08 時点で 0）・**名簿に寄せられなかった氏名の数**（2026-08 時点で宮城 3: 第398回の PDF にだけ出る、その後に名簿から消えた人。徳島 0、鳥取 0）を出す。不明セルが 0 でなくなったら PDF のレイアウト変化（列幅・フォント）を疑い、`unmatched.json` が増えたら辞職・補選を疑う（どちらも事実として公開され、推定はしない）。
- 手動: `gh workflow run local-assemblies.yml`。ローカル: `pnpm etl:local miyagi` / `pnpm etl:local tokushima`（各 20 秒前後）、`pnpm etl:local tottori`（約 40 秒）、`pnpm etl:local nara`（20 秒前後）。`--sessions N` で会期数。既定 2。
- 失敗モード: 「is not in the legend」＝凡例に無い値（PDF の凡例が増えた → `mapLegend` の対応を確認して `docs/DATA_CONTRACT.md` に追記。凡例の意味が「票を投じていない」と読めなければ mapped は付けない）、「member columns differ from page 1」「column N header … does not match」「header rules not found」＝PDF のレイアウト変化、「is in 会派別 but not in …」「do not add up to 定数」＝名簿 3 ページの食い違い（サイトの更新途中なら翌日に再実行）、「expected at most one 各議員の表決状況 link」「expected exactly one PDF link」＝会期 index／会期ページの変化、徳島は「expected one year heading」「no 各議員の表決態度 PDF」「PDF title says … but the link says …」（会期 index・会期ページ・PDF 表題の変化）、「legend (※ 「○」…) not found」「ditto … has no matching phrase」「section headings above the table」（PDF の節・凡例の形の変化）、「所属会派 … in 選挙区別 but … in 会派別」（名簿 2 ページの食い違い）、「fetch refused」＝許可ホスト外か robots.txt の Disallow。いずれも data/ は書かれない。
- 失敗モード（鳥取）: 「no 議決結果 link yet (skip)」は会期中で正常。「has no vote PDF links」＝議決結果ページはあるが PDF がまだ無い、「content differs between PDFs」＝同じ議案の複製 PDF の内容が食い違う（どちらが正しいか推定しないので止める。県に確認）、「does not end with 議員」「expected N columns left/right of the vote area」「group headings are not contiguous」＝PDF のレイアウト変化、「会派 … must be exactly one」＝名簿のカテゴリ変化、「PDF says … session index says …」＝会期 index と PDF 見出しの不一致。
- 失敗モード（奈良）: 「no 議員別の議案等に対する表決結果 PDF yet (skip)」は会期中で正常。「expected exactly one 議決結果 header cell」「does not start with 議第/報第/第N号」「種別 rules do not start at the body top」＝PDF のレイアウト変化、「h1 … does not match the index link」＝会期 index と会期ページの不一致、「名簿の掲載日（（令和N年M月D日現在））not found」「roster table header is not …」＝名簿ページの変化。いずれも data/ は書かれない。
