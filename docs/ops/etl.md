# 日次 ETL の運用（`.github/workflows/etl.yml`）

## 流れ

```
06:00 JST schedule / workflow_dispatch(sessions, rebuild)
  0. docker build           packages/etl/Dockerfile → gikailog-etl:ci（GHCR に push しない。レイヤーは type=gha キャッシュ）
  1. actions/cache/restore  packages/etl/.cache（key: etl-cache-YYYY-MM-DD、restore-keys で前日以前から復元）
  1.5 rebuild=yes のときだけ  scripts/ci/etl-rebuild-prepare.sh が国会側の data/ を消す（#284。既定は何もしない。下の「作り直し」の節）
  2. docker run [sessions]  data/ と packages/etl/.cache を bind mount、runner の uid で実行 → data/ を書き、validateDataset が違反を見つけたら非0終了
  3. actions/cache/save     失敗しても保存（if: always）
  4. data PR                git diff に変更があれば data/refresh に force push → open PR が無ければ作成 → `gh pr merge --auto`
  5. Job summary            結果 / データ PR 番号 / 変更ファイル数 / unmatched・unmatched-bills 件数 / ログの警告行
  6. マージ待ち → Deploy    最大 15 分 PR の state を 20 秒ごとに見る。MERGED で `gh workflow run deploy-data.yml --ref main`（staging + production の両方、#127）
  7. failure()              「ETL 日次実行が失敗した（etl.yml）」という Issue を作る（同タイトルの open Issue があればコメントだけ）
```

- `.cache/` のうち回次一覧 `vote_ind.htm`・議員名簿・議案ページ（参院 meisai・衆院 kaiji/keika）・会議録 API は ETL 側が `noCache` で毎回取得する。衆院 議案情報は Shift_JIS で、回次あたり一覧 1 ページ＋経過ページ約 160 枚（1 秒間隔で約 3 分。#231 以前は 0.5 秒で約 1.5 分）。質問主意書（#106）も毎回取得する: 衆院 `itdb_shitsumon.nsf/html/shitsumon/kaiji{回次}_l.htm`（Shift_JIS）→ 経過ページ、参院 `joho1/kousei/syuisyo/{回次}/syuisyo.htm` → 詳細ページ。提出日・答弁書受領日は一覧に無く詳細ページにしかないので1件1ページ（第217回は衆 352＋参 247 枚、5 回次合計で約 1,100 枚 ≒ 20 分。#231 以前は約 10 分）。キャッシュが効くのは各採決の投票結果ページ（不変）だけ。
## 取得間隔（#231）

**待ち時間は `packages/etl/src/fetch.ts` の定数だけで決まる。** 相手は公的機関の公開情報であり、過負荷をかけないことは中立性・信頼性の一部。

| 定数 | 値 | 対象 | 根拠 |
|---|---|---|---|
| `POLITENESS_FLOOR_MS` | 1 秒 | 全取得の下限 | 提供元が 1 秒未満を許可している事実は無い（下記）ので自ら課す下限 |
| `HTML_INTERVAL_MS` | 1 秒 | 衆院・参院・総務省・日本郵便の HTML / PDF / zip（`fetchText`・`sources/districts/fetch.ts`） | 同上 |
| `NDL_API_INTERVAL_MS` | 2 秒 | 国会会議録検索システム 検索用API（`kokkai-speeches.ts`・`kokkai-attendance.ts` の `REQUEST_INTERVAL_MS`） | API の利用条件が「**データを取得し終えてから数秒程度空けて**次のリクエストを行うように」と明示 |
| `MIN_INTERVAL_MS`（`sources/local/polite-fetch.ts`） | `POLITENESS_FLOOR_MS` | 地方議会 | 同上（robots.txt 遵守・host アローリストは従来どおり） |

- #231 以前は国会 HTML が 0.5 秒・地方議会が 1 秒という**二重基準**で、経緯で別々に実装されたもの。1 秒に揃えた。
- 会議録 API だけ 2 秒にしたのは、**提供元自身が明示的に要求している**唯一のケースだから。以前の 1 秒はこの要求を満たしていなかった。
- UA は `gikailog-etl/0.1 (+https://github.com/uonoko1/gikailog)` のまま（GitHub リポジトリが連絡先として機能する）。

### 確認したこと・できなかったこと（2026-08-25）

確認できた:
- `www.shugiin.go.jp` / `www.sangiin.go.jp` の robots.txt は **404**（ファイルが無い）。
- `www.soumu.go.jp` の robots.txt は `User-agent: ia_archiver` / `Disallow: /` のみ。**Crawl-delay の記述は無い**。
- `kokkai.ndl.go.jp/robots.txt` は 302 でアプリのシェル HTML に飛ぶ（SPA。robots ルールは無い）。
- `https://kokkai.ndl.go.jp/api.html`「4. 利用条件・免責事項」に上記の明示要求と、「このシステムの運用に影響のあるような負荷のかかる利用（短時間での大量アクセス等）はご遠慮ください」がある。

確認できなかった:
- **「数秒程度」が何秒を指すかは書かれていない。** 2 秒はその下限としての解釈であって、提供元が 2 秒と言った事実は無い。
- 衆院・参院・総務省に**クロール間隔についての明文の指針は見つけられなかった**（robots.txt が無い／該当記述が無い、というだけで、「1 秒未満でよい」という意味ではない）。
- 各サイトの利用規約ページ本文は網羅的に読んでいない（外部アクセスを最小限にしたため、robots.txt と NDL の API ページのみ確認）。
- 現状が実際に負荷を与えていた証拠は無い。**この変更は事故への対応ではなく、基準を揃えて根拠を明示するもの。**

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
  このとき直近 5 回次は引き継ぎになるが、衆院本会議の発言（名簿が覆う最新回次の分）は**毎回取得する**（#236。取得は約 15 秒で、日次 27 分にはほぼ影響しない）。引き継ぎとの二重行は取得した `speechId` の引き継ぎ行を落として防ぐ（ログの `carried: N timeline entries from sessions … (M dropped: re-fetched shugiin speeches)`）。**注意**: #103 より前の出力には `session` の無い timeline 行があり（ログに `carried: N timeline entries without session … cannot be carried`）、その分の発言・質問主意書・委員会出席は引き継げない。過去回次の手動実行のあと、翌日の日次実行（直近 5 回次を取り直す）で復元されるので、手動実行の PR と翌日の PR をセットで見る。先に日次実行を一度通して（全行に `session` が付く）から過去回次を足せば欠けは出ない。
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

- 日次実行（引数なし。直近 5 回次を取得し、第200〜216回は引き継ぎ）: 27 分（1,593 秒。第200〜216回を足す前とほぼ同じ。引き継ぎは 93 採決・6,451 行で数秒）。名簿の 404（第199〜215回、17 回）は 1 回 1 秒（#231 以前は 0.5 秒）。**この 27 分は #231 の前の計測**で、間隔を 1 秒に揃えた後は 45〜50 分程度になる見込み（HTML 約 1,900 ページ ＋ 会議録 API ページぶんの増分。実測は次の日次実行で置き換える）。
- 引き継ぎで落ちるもの: 引き継ぐ回次の質問主意書・議案の**未突合行**（`unmatched/{回次}.json` の `kind: "question"` / `"bill"`。#219 の分割前は `unmatched.json`）はその回次を取得した実行にしか載らない（採決の未突合は再突合するので毎回載る）。第200〜216回の未突合質問（119 行）を見たいときは手動実行の Summary を見る。
- 手動実行の直後は第217〜221回の発言・質問主意書・委員会出席が（`session` の無い旧出力から引き継げず）一時的に減り、翌日の日次実行で戻る（上の注意）。2 回目以降の手動実行ではこの欠けは出ない。

## 名寄せを厳格化したあとの作り直し（#230）
> **【現在この状態です・2026-08-25】** #230（在職未確認の紐づけを解消）と #242（委員会の発言）が
> main にマージ済みで、**`data/` はまだ作り直していない**。したがって:
>
> - **日次 ETL（21:00 UTC / 06:00 JST）は設計どおり失敗する。** 3 つの消失検出が #230 の減少
>   （24,610 行）を正しく捕まえ、`data/` を書かずに非0終了する。**これは異常ではない。**
> - 失敗時のエラーは `Re-run with the affected sessions (pnpm etl <session>...)` と案内するが、
>   **今回はその案内に従ってはいけない**（意図的な減少なので、回次を指定して再実行しても同じ検出で止まる）。
>   下記の作り直し（`gh workflow run etl.yml -f rebuild=yes -f sessions="…全22回次…"`、または
>   ローカルで `scripts/ci/etl-rebuild-prepare.sh` → `pnpm etl …`）を使う。
> - **公開中のサイトは作り直しまで古い紐づけを表示し続ける。** コードは紐づけを拒否するようになったが、
>   配信しているのは前回の出力である。
>
> **#230 と #242 の作り直しは分けられない。** `SPEECH_SCOPE = "all"`（`cli.ts`）は定数で実行時に
> 切り替えられないので、`data/` を消して作り直した時点で #230 の減少と #242 の増加が同じ実行で入る。
> 差分は ETL のログ（種別ごとの件数）と、#230 で外れるはずの内訳（票 18,401 / 発言 4,790 /
> 質問主意書 1,305 / 参法 114 = 24,610）との突き合わせで切り分ける。


紐づけの規則を厳しくする変更は、**正しく動くほど前回出力より行が減る**ので、3 つの消失検出（`lostVoteMatches` / `lostTimelineEntries` / `lostSessionEntries`）に必ず引っかかり、ETL は `data/` を書かずに非0終了する。これは検出の誤りではなく、設計どおりの動作である。**検出を緩めるフラグは足さない**（同じ緩めが後日の本当の事故の見落としになる）。

意図的な減少を通すときは、既存の escape hatch（国会側の `data/` を消してから作り直す。前回出力が無いので 3 つとも引っかからない）を使う。**ワークフローから流す方法（下）と、ローカルで流す方法（その下）のどちらでもよい。消す範囲は同じで、`scripts/ci/etl-rebuild-prepare.sh` が唯一の実装。**

### ワークフローから流す（#284）

`etl.yml` の `workflow_dispatch` に `rebuild` 入力がある。**`rebuild` に `yes` と入れたときだけ**、ETL の前に国会側の `data/` を消す:

```
gh workflow run etl.yml \
  -f rebuild=yes \
  -f sessions="200 201 202 203 204 205 206 207 208 209 210 211 212 213 214 215 216 217 218 219 220 221"
```

- **既定では発火しない。** cron 実行と、`sessions` だけを指定した通常の手動実行では `rebuild` が空になり、`Wipe Diet data (rebuild only)` ステップは何も消さずに終わる。発火する値は `yes` だけで、`true` / `YES` / ` yes` などは発火しない（`scripts/ci/test/etl-rebuild-prepare.test.sh` が固定している）。
- **回次が全 22 回次に足りなければ、消す前に非0終了する。** `data/` を消してから既定の 5 回次だけ流すと、残り 17 回次を引き継ぐ元が無くなり永久に失われるため。
- 消した内訳（パスと件数）はステップのログと Job Summary に出る。データ PR は通常どおり `data/refresh` に作られ、削除もその PR に含まれる（`git add data` は削除を stage する）。

### ローカルで流す

```
DATA_DIR=data scripts/ci/etl-rebuild-prepare.sh yes "200 201 202 203 204 205 206 207 208 209 210 211 212 213 214 215 216 217 218 219 220 221"
pnpm etl 200 201 202 203 204 205 206 207 208 209 210 211 212 213 214 215 216 217 218 219 220 221
```

- **`rm -rf data/members` としてはいけない**（2026-08-25 の修正前まで、この節はそう書いていた）。`data/members/` は国会（`m_*` 参院 / `h_*` 衆院）と地方議会（`p_*`）が**同じディレクトリを共有している**（#157）。`writeDataset` は地方の行を「消す前に読んで書き戻す」ことで守っているので、ディレクトリごと先に消すとその読み取りが空振りし、地方議員の detail（2026-08-25 の `data/` で 285 件）と `members/index.json` の地方の行が復元されないまま失われる。
- 消すのは国会側だけ: `data/rollcalls` `data/bills` `data/unmatched` `data/unmatched.json` `data/meta.json` と、`data/members/` のうち `m_*` `h_*`（detail と `#242` の発言ディレクトリ）、および `members/index.json` の国会の行（`isDietMemberRow`＝`assemblyId` が無いか `diet-` で始まる行）。**地方議会（`data/assemblies/`・`data/members/p_*`・`members/index.json` の地方の行）は日次 ETL が書かないので消さない。**
- **1 回の dispatch で全 22 回次を渡す。chunk に分けてはいけない。**
  `planSessions` の `carried` は前回出力から作るので、`data/` を消すと指定しなかった回次を
  引き継ぐ元が無い。分けて流すと 2 回目以降で前の chunk が消え、しかも**最初の実行には
  前回出力が無いので消失検出も止められない**（前回出力との比較が成り立たない）。
> **【重要・2026-08-25 の実測】GitHub ホステッドランナーのジョブ上限は 6 時間（360分）で、
> `timeout-minutes` では超えられない。** 480 を指定した run 32890265206 は**きっかり 360 分**で
> `cancelled` になった。作り直しは実測 359 分でこの上限に張り付くため、**1 回では完走できない**。
>
> **運用**: `Run ETL` のステップ timeout（330分）で先に打ち切り、`.cache` を保存してから終わる。
> **同じ dispatch をもう一度流せば、取得済みページはキャッシュから読むので続きから進む。**
> 2 回目以降は `Wipe Diet data` が再び `data/` を消すが、**キャッシュは消さない**ので取得はやり直さない。
>
> 実績: 1 回目（run 32853869643）はステップ timeout が無く、キャッシュも保存されずに全損。
> 2 回目（run 32890265206）は 360 分で打ち切られ、キャッシュ 93MB を保存。
> 3 回目（run 32919656778）も 360 分で打ち切られたが、**キャッシュが 93MB のまま増えなかった**。
>
> **原因**: `actions/cache/save` は**同じ key が既にあると黙ってスキップし、ステップは success と表示される**。
> key が `etl-cache-<日付>` だったので、同じ日の 2 回目以降は保存されない。
> 3 回目の 6 時間ぶんの取得はこれで失われた。**`success` は保存された証拠にならない。**
>
> 対策: save の key に `${{ github.run_id }}-${{ github.run_attempt }}` を足して run ごとに一意にした。
> restore は `restore-keys: etl-cache-` の前方一致なので、次の run は最新のキャッシュから始まる。
> **キャッシュが実際に育っているかは `gh api repos/<owner>/<repo>/actions/caches` のサイズで確認する。**

> **【2026-08-25〜26 の実測】1 回の dispatch では完走できない。**
>
> - **GitHub ホステッドランナーのジョブ上限は 6 時間（360分）**で、`timeout-minutes` では超えられない
>   （480 を指定した run 32890265206 が**きっかり 360 分**で `cancelled`）。作り直しは実測 359 分で張り付く。
> - **`actions/cache/save` は同じ key が既にあると黙ってスキップし、ステップは `success` と表示される。**
>   key が `etl-cache-<日付>` だったため同じ日の 2 回目以降は保存されず、
>   run 32919656778 の 6 時間ぶんが失われた（キャッシュは 93MB のまま増えなかった）。
>   → save の key に `run_id`・`run_attempt` を足して一意にした。
>
> **運用**: `Run ETL` を 330 分で先に打ち切り、残り 30 分で `.cache` を保存して終わる。
> **同じ dispatch を繰り返し流せば、取得済みページはキャッシュから読むので少しずつ進む。**
> `Wipe Diet data` は毎回 `data/` を消すが**キャッシュは消さない**ので取得はやり直さない。
>
> **確認**: 進んでいるかは `gh api repos/<owner>/<repo>/actions/caches` の**サイズの増加**で見る。
> ステップの `success` は保存された証拠にならない。

- **所要は実測で 5 時間超**（2026-08-25 の run 32853869643。**`timeout-minutes: 360` にほぼ張り付く**）。
  当初「約 3 時間 53 分」と見積もったが、**応答時間を 0.7 秒/req と置いたのが楽観的**だった（実測は 1.2〜1.5 秒相当）。
  `.cache/` が残っていれば短くなるが、**タイムアウトするとキャッシュ保存ステップに到達しないので次回もゼロから**になる。
  - **`data/` を消してからの作り直しは chunk に分けられない**（上記）ので、**タイムアウト＝その回の作業が全損**する。
  - 実行前に `timeout-minutes` の引き上げを検討する。**本番の `data/`（`main`）は無傷**なので、
    失敗しても壊れるのは `data/refresh` ブランチだけ（そこにも書かれずに終わる）。
- 走らせたあと `git diff --stat data/` で減った件数を確認し、**PR に数字を書く**（何がどれだけ減ったか。「意図した減少」であることを事実として残す）。
- 作り直しの後は、次の日次実行から通常どおり引き継ぎが効く。引き継ぎ行にも在職の確認がかかる（`carriedTenureVerified`）ので、古い紐づけが引き継ぎ経由で戻ってくることはない。

### #230 で外れた件数（2026-08-24 時点のデータで測定）
| 種別 | 外れた行 |
|---|---|
| 票（vote） | 18,401 |
| 発言（speech） | 4,790 |
| 質問主意書（question） | 1,305 |
| 参法の提出（bill） | 114 |
| **計** | **24,610** |

第200〜215回に分布し、第216回以降は 0（会期中に名簿から消えた議員は任期満了日で在職を確認できるため）。影響を受けた議員は 772 人中 304 人で、timeline が空になった議員はいない。外れた行は消えるのではなく `unmatched/{回次}.json` に氏名と当時の会派つきで載り、採決ページ・議案ページ・会議録への一次資料リンクは残る。

## 第142〜199回を足す（#219、バックフィル）
spike の結論は `docs/research/backfill-142-199.md`、契約は `docs/DATA_CONTRACT.md`「回次」。**日次 ETL には載せない**（`DEFAULT_SESSIONS` は変えない。変えると毎日 58 回次を取り直す）。`etl.yml` の `workflow_dispatch` で**回次を分けて複数回**流す。

- **1 回の dispatch に全 58 回次を渡さない**。第200〜216回（17 回次）の実測が 77 分なので、58 回次はおおよそ 4〜5 時間で、`timeout-minutes: 360`（6 時間）に収まる保証が無い（政府サイトの応答は日によって遅い）。**10〜15 回次ずつ**に分けると 1 回あたり 1 時間前後で、失敗したときのやり直しもその chunk だけで済む。
  ```
  gh workflow run etl.yml -f sessions="142 143 144 145 146 147 148 149 150 151"
  # 前の run のデータ PR がマージされてから次を流す（同じ data/refresh ブランチを使うため）
  gh workflow run etl.yml -f sessions="152 153 154 155 156 157 158 159 160 161"
  #  … 199 まで繰り返す
  ```
- **chunk をまたいでも前の回次は消えない**: 指定しなかった回次は `data/`（`meta.sessions`）から引き継がれる（`planSessions`。`packages/etl/test/sessions.test.ts` が固定している）。`concurrency: etl-daily` で直列化されるので、日次実行と重なっても待つだけ。
- **取れない回次は飛ばしてログに残す**（全 58 回次の構造は事前確認していない）。ログの見どころ:
  - `session N: roll call list not published, skipped (HTTP 404 …)` — 一覧ページが 404（第141回以前は押しボタン投票の導入前でページ自体が無い）。**404 以外（5xx・タイムアウト）は飛ばさず ETL を落とす**（取りこぼしを「無かった」と記録しないため）
  - `session N: X roll calls (Y with individual votes, Z standing votes skipped, W parse errors skipped)` — W が 0 でなければ個票の未知のレイアウト
  - 最後に `sessions skipped (roll call list not published, 404): …` と `roll call pages skipped (parse error): N in sessions …` を URL つきで再掲する。**推定で埋めないので、ここに出た回次は「まだ取れていない」という事実**。直すときはその URL を実 HTML のフィクスチャにしてテストから直す
- **未突合が大量に出るのは正常**。第142〜199回は回次別の参院名簿が公開されていない（第216回以降しか無い）ので、その期間の票は `memberId` が空のまま `unmatched/{session}.json` に載る（契約が「上限を設けない」と定めている既定の振る舞い。ETL は止まらない）。**氏名だけから議員を作ることも、氏名一致だけで現職に紐づけることもしない。**
- 未突合は回次別ファイルに分かれる（#219）。`data/unmatched.json` に残るのは回次の引けない行（発言・委員会出席）だけなので、日次のサマリの `unmatched` の数字は分割後は小さくなる。全体の件数は ETL ログの `unmatched: N (see data/unmatched/{session}.json and data/unmatched.json)` と、その次の行の `by session: 142:2431 143:889 …` で見る。
- 衆院の経過ページは古い回次で「衆議院審議時会派態度」の項目自体が無い（第142回で確認）。その議案は `shugiinGroupStance` を持たない ＝ 議員ページの `stance` 行にもならない。**「無い」を「全会派賛成」等に読み替えない。**
- ローカルで先に試す: `pnpm etl 142 143`（初回は個票を全部取るので回次あたり数分。2 回目以降はキャッシュ）。

## 委員会の発言を足す（#242）

#242 で発言の取得範囲が**本会議だけ → 本会議＋委員会**（分科会・審査会・連合審査会・公聴会・調査会を含む）になった。
`packages/etl/src/cli.ts` の `SPEECH_SCOPE = "all"` がそれで、API の `nameOfMeeting` を付けないことで実現している。

**取得範囲（`docs/DATA_CONTRACT.md` の `TimelineEntry(speech)`）**:

- **参院**: 指定した回次（`targets`）ぜんぶ。回次ごとの参院名簿があるので広げられる。
- **衆院**: `meta.sessions` の最大の 1 回次だけ。衆院名簿が「現在」の 1 枚しか公開されていない（#71 / #245）ためで、
  **サイズの都合ではなく原則**（名簿に無い旧議員を同名の現職に紐づけない）。#71 が入るまで広がらない。

### 1 回の dispatch に全回次を渡さない

委員会を含めると 1 回次で衆参あわせて 700 ページ規模になる（#263 の実測: 第221回は 706 ページ）。
`NDL_API_INTERVAL_MS = 2` 秒（#231。NDL の利用条件「数秒程度空けて」に基づく。**縮めない**）で:

| 範囲 | ページ数（#263 の実測 / 実測からの外挿） | 2 秒間隔の待ちだけ | 応答 0.7 秒/req を足した実時間 |
|---|---|---|---|
| 第221回だけ | 706（実測） | 約 24 分 | 約 32 分 |
| 22 回次（第200〜221回） | **約 4,085**（下の訂正を見よ） | 約 2 時間 16 分 | **約 3 時間 6 分** |

> **【訂正 2026-08-25】** この表は当初「約 8,000 ページ・約 6 時間・timeout を超える」と書いていたが、
> **衆参の全回次を取る前提で数えた誤り**だった。実際には **衆院は `memberSession` の 1 回次だけ**しか
> 取らない（`DATA_CONTRACT.md` の `TimelineEntry(speech)`。衆院名簿が「現在」の 1 枚しか無いため。#71）。
> 参院 22 回次＋衆院 1 回次で数え直すと **4,085 ページ**。
>
> **【再訂正 2026-08-25】** 上の「約 3 時間 6 分」「全体で約 3 時間 53 分」も**まだ楽観的だった**。
> 応答時間を 0.7 秒/req と置いていたが、実測（run 32853869643）では **5 時間を超えた**。
> ページ数（4,085）は正しいので、**待ち時間ではなく応答時間の見積りが外れた**。
> 実運用の目安は **1 ページあたり 2 秒（間隔）＋ 1.2〜1.5 秒（応答）**。

**通常の追加なら回次を分ける**（#219 のバックフィルと同じ）。間隔は縮めない。

ただし **`data/` を消してからの作り直し（下の #230 の節）は chunk に分けられない**。
`planSessions` の `carried` は前回出力（`onDisk`）から作るので、`data/` を消すと
**指定しなかった回次を引き継ぐ元が無い**。分けて流すと 2 回目以降で前の chunk が消え、
しかも最初の実行には前回出力が無いので消失検出も止められない。
**作り直しは 1 回の dispatch で全 22 回次を渡す**（上の実測で timeout に収まる）。

```
# 参院の委員会発言を第200回から入れる。回次あたり 700 ページ規模なので 2〜3 回次ずつ
gh workflow run etl.yml -f sessions="200 201"
# 前の run のデータ PR がマージされてから次を流す（同じ data/refresh ブランチを使うため）
gh workflow run etl.yml -f sessions="202 203 204"
#  … 221 まで繰り返す
```

- **通常国会（201・204・208・211・213・217）は 1 回次で 5 万件級**（#263 の実測。臨時会・特別会は数百〜数万件）。
  この 6 回次は**1 回の dispatch に 1 回次だけ**にする。
- **chunk をまたいでも前の回次は消えない**: 指定しなかった回次は `data/`（`meta.sessions`）から引き継がれる
  （`planSessions` / `readCarried`。`packages/etl/test/sessions.test.ts` が固定している）。
- **最初の chunk には通常国会（201 か 204）を入れる**。分科会が立つのは通常国会だけで、
  #263 が全量取得した第221回（特別会）には分科会が 1 件も無かった。形が違わないことは #242 が
  第201・204回で実データ確認済み（フィクスチャ `packages/etl/test/fixtures/kokkai-speech-shugiin-204-bunkakai-p1.json`）だが、
  本番でも最初に通しておくと未知の回次で落ちたときに切り分けやすい。

### ログの見どころ

`session N: X sangiin speeches (Y matched, Z with position)` の X が本会議だけのときより 2 桁増える。
`Y / X`（名簿に突合できた割合）は 8 割弱が目安（#263 の実測で `speakerGroup` を持つのは 77.87%）。
残りは政府参考人・局長・参考人・公述人など**議員でない発言者**で、会派を持たないので突合できないのが正常。
`unmatched` に載るのは「会派はあるが名簿にいない」発言者だけ（第221回の実測で参院 246 件・衆院 0 件）。

### 発言は `members/{id}/speeches.json` に書かれる（#242）

`data/members/{id}.json` の `timeline` に `speech` 行は入らない。`validateDataset` が
「timeline に speech 行があれば違反」「`counts.speeches` と `speeches.json` の行数が一致」を検査する。
**発言 0 件の議員のファイルは作らない**（無い＝0 件）。

**#242 を入れた最初の 1 回**は前回出力（`members/{id}.json` の timeline に speech 行がある旧形式）からの移行になる。
`readCarried` / `readSessionCounts` は旧形式も読むので引き継ぎは落ちない（`packages/etl/test/sessions.test.ts` が
旧形式・新形式・両方あるときの 3 通りを固定している）。移行の実行後に
`timeline entries lost for a specific session …` が出たら**それは本物の消失**なので、出力せずに止まる。

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
- 毎月 5 日 05:00 JST（議会は定例会ごとに更新されるので月 1 回で足りる）と `workflow_dispatch`。日次と同じイメージで `--entrypoint node … src/local-cli.ts <name>` を `ASSEMBLIES`（`miyagi=pref-04 tokushima=pref-36 tottori=pref-31 mie=pref-24 nara=pref-29 kochi=pref-39`。議会を足すときはここと `packages/etl/src/local-assemblies.ts` の `LOCAL_SOURCES` に 1 行）の順に走らせ、議会ごとに `data/assemblies/{id}/`（meta・sessions・rollcalls・unmatched）、`data/members/` のその議会の議員（index の行と `p_{prefCode}_*.json`）、`data/assemblies/index.json` のその議会の行だけを書く（国会の行も他の議会の行も触らない。日次 ETL も地方の行を残す）。data PR の流れは選挙区 ETL と同じで、ブランチは `data/local-assemblies`、失敗 Issue のタイトルは「地方議会 ETL 月次実行が失敗した（local-assemblies.yml）」。`concurrency: etl` で日次・選挙区と直列化する。
- 宮城県議会（`docs/DATA_CONTRACT.md`「地方議会」）: 名簿 3 ページ＋会期 index＋直近 2 会期の会期ページ（HTML、毎回取得）と表決 PDF（実行中だけ `.cache/`）。取得は `www.pref.miyagi.jp` だけ・UA `gikailog-etl/0.1`・1 秒以上間隔・robots.txt 遵守（`packages/etl/src/sources/local/polite-fetch.ts`。2026-08 時点で robots.txt は 404）。
- 徳島県議会（#183）: 議員紹介 2 ページ（会派別・選挙区別）＋定例会の概要（今年。足りなければ前年の年ページ）＋直近 2 会期の会期ページと、採決日ごとの表決 PDF（2月定例会は 3 本）。取得は `www.pref.tokushima.lg.jp` だけ（robots.txt は `/system` などを Disallow。`/gikai/` と `/file/attachment/` は対象外）。名簿に掲載日が無いので as-of は取得日（JST）。表決方法・人数の欄が無いので `method` / `counts` は書かない。PDF の表復元は宮城と同じ罫線方式（共通部は `sources/local/pdf-table.ts`）。
- 鳥取県議会（#184）: 取得は `www.pref.tottori.lg.jp` だけ（robots.txt は `/secure/221685/` などを Disallow。議決結果ページと賛否 PDF `/secure/{番号}/…` は対象外。毎回読んで従う）。名簿 1 ページ＋会期 index＋会期ページ（議決結果の無い会期も見て飛ばす）＋議決結果ページ（HTML、毎回取得）と賛否 PDF（会期に 4 本ほど。同じ内容の複製も URL が違えば取る。実行中だけ `.cache/`）。2026-08 時点で 118 件（6月定例会 30・2月定例会 88）、不明セル 0、unmatched 0。鳥取の PDF は姓だけなので、名簿に同姓が増えると unmatched が増える（候補は `unmatched.json` の `candidates` に列挙され、ETL は選ばない）。
- 奈良県議会（#202）: 取得は `www.pref.nara.lg.jp` だけ（robots.txt は `/documents/22137/*` を Disallow。名簿・会期ページ・表決 PDF は対象外。毎回読んで従う）。名簿（五十音順、1 ページ。as-of はページの「（令和8年4月24日現在）」）＋会期 index `/n161/18579.html`＋会期ページ（表決 PDF の無い会期＝会期中は飛ばす。HTML は毎回取得）と「議員別の議案等に対する表決結果」PDF（議決日ごとに 1 本。実行中だけ `.cache/`）。2026-08 時点で 125 件（6月定例会 37・2月定例会 88）、不明セル 0、unmatched 0。奈良の PDF は文字層で一部の字が落ちる（「芦髙清友」の外字「芦」、「西川均」の「均」）ので、完全一致 → 部分列一致（1 人に決まるときだけ）で寄せる（`docs/DATA_CONTRACT.md`）。
- Summary に議会ごとの名簿の as-of（宮城は掲載日、徳島は取得日、鳥取は各議員の項目の掲載日の最新）・議員数・表決（議案）数・セル数（議員数×議案数）・**不明セル数**（置けなかったセルを推定せず「不明」にした数。2026-08 時点で 0）・**名簿に寄せられなかった氏名の数**（2026-08 時点で宮城 3: 第398回の PDF にだけ出る、その後に名簿から消えた人。徳島 0、鳥取 0）を出す。不明セルが 0 でなくなったら PDF のレイアウト変化（列幅・フォント）を疑い、`unmatched.json` が増えたら辞職・補選を疑う（どちらも事実として公開され、推定はしない）。
- 高知県議会（#220）: 取得は `gikai.pref.kochi.lg.jp` だけ（robots.txt は `/search.html` `/reiki/` `/*.html.r` を Disallow。名簿・index・表決 PDF は対象外。毎回読んで従う。「ご利用案内」`/use/` は操作案内だけで機械取得を禁じる文言は無い）。名簿（会派別、1 ページ。as-of はページの「令和８年７月30日現在」）＋「議員別賛否の状況」`/activity/decision.html`（1 ページに全会期。HTML は毎回取得）から会期ごとの議決結果一覧 PDF（会期に 1 本。実行中だけ `.cache/`）。会期ごとの中間ページが無いぶん取得は 3 リクエスト（名簿・index・PDF×会期数）で済む。2026-08 時点で 6月定例会 23 件・令和7年6月定例会 24 件、不明セル 0、unmatched は令和7年6月分の 3 名（武石利彦・田所裕介・橋本敏男。今の名簿に居ない＝改選前の議員という事実）。復元した ○ / × の数は PDF 自身の賛成者数・反対者数と全行一致する（セルの脱落・余剰の検算）。員数は並べ替えに不変で列のずれを捕まえないので、「どの議員がどう投じたか」を固定したゴールデンテストを別に置いている（レイアウト変更で列がずれたらこちらが落ちる）。
- 手動: `gh workflow run local-assemblies.yml`。ローカル: `pnpm etl:local miyagi` / `pnpm etl:local tokushima`（各 20 秒前後）、`pnpm etl:local tottori`（約 40 秒）、`pnpm etl:local nara`（20 秒前後）、`pnpm etl:local kochi`（10 秒前後）。`--sessions N` で会期数。既定 2。
- 失敗モード: 「is not in the legend」＝凡例に無い値（PDF の凡例が増えた → `mapLegend` の対応を確認して `docs/DATA_CONTRACT.md` に追記。凡例の意味が「票を投じていない」と読めなければ mapped は付けない）、「member columns differ from page 1」「column N header … does not match」「header rules not found」＝PDF のレイアウト変化、「is in 会派別 but not in …」「do not add up to 定数」＝名簿 3 ページの食い違い（サイトの更新途中なら翌日に再実行）、「expected at most one 各議員の表決状況 link」「expected exactly one PDF link」＝会期 index／会期ページの変化、徳島は「expected one year heading」「no 各議員の表決態度 PDF」「PDF title says … but the link says …」（会期 index・会期ページ・PDF 表題の変化）、「legend (※ 「○」…) not found」「ditto … has no matching phrase」「section headings above the table」（PDF の節・凡例の形の変化）、「所属会派 … in 選挙区別 but … in 会派別」（名簿 2 ページの食い違い）、「fetch refused」＝許可ホスト外か robots.txt の Disallow。いずれも data/ は書かれない。
- 失敗モード（鳥取）: 「no 議決結果 link yet (skip)」は会期中で正常。「has no vote PDF links」＝議決結果ページはあるが PDF がまだ無い、「content differs between PDFs」＝同じ議案の複製 PDF の内容が食い違う（どちらが正しいか推定しないので止める。県に確認）、「does not end with 議員」「expected N columns left/right of the vote area」「group headings are not contiguous」＝PDF のレイアウト変化、「会派 … must be exactly one」＝名簿のカテゴリ変化、「PDF says … session index says …」＝会期 index と PDF 見出しの不一致。
- 失敗モード（奈良）: 「no 議員別の議案等に対する表決結果 PDF yet (skip)」は会期中で正常。「expected exactly one 議決結果 header cell」「does not start with 議第/報第/第N号」「種別 rules do not start at the body top」＝PDF のレイアウト変化、「h1 … does not match the index link」＝会期 index と会期ページの不一致、「名簿の掲載日（（令和N年M月D日現在））not found」「roster table header is not …」＝名簿ページの変化。いずれも data/ は書かれない。
