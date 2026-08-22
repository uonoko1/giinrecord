# 日次 ETL の運用（`.github/workflows/etl.yml`）

## 流れ

```
06:00 JST schedule / workflow_dispatch(sessions)
  1. actions/cache/restore  packages/etl/.cache（key: etl-cache-YYYY-MM-DD、restore-keys で前日以前から復元）
  2. pnpm etl [sessions]    → data/ を書き、validateDataset が違反を見つけたら非0終了（data/ はコミットされない）
  3. actions/cache/save     失敗しても保存（if: always）
  4. data PR                git diff に変更があれば data/refresh に force push → open PR が無ければ作成 → `gh pr merge --auto`
  5. Job summary            結果 / データ PR 番号 / 変更ファイル数 / unmatched・unmatched-bills 件数 / ログの警告行
  6. マージ待ち → Deploy    最大 15 分 PR の state を 20 秒ごとに見る。MERGED で `gh workflow run deploy.yml --ref main`
  7. failure()              「ETL 日次実行が失敗した（etl.yml）」という Issue を作る（同タイトルの open Issue があればコメントだけ）
```

- `.cache/` のうち回次一覧 `vote_ind.htm`・議員名簿・議案ページ（参院 meisai・衆院 kaiji/keika）・会議録 API は ETL 側が `noCache` で毎回取得する。衆院 議案情報は Shift_JIS で、回次あたり一覧 1 ページ＋経過ページ約 160 枚（0.5 秒間隔で約 1.5 分）。キャッシュが効くのは各採決の投票結果ページ（不変）だけ。
- 06:30 JST の `deploy.yml` schedule は安全網。通常は 6 で起動された Deploy が先に走る（`concurrency: deploy` で重複は直列化）。

## 確認の仕方（PO チェックリスト）
1. Actions → ETL (daily) → 最新 run の **Summary** を見る。「データ PR」が `#N` か「なし」か、unmatched 件数が前日から急増していないか。
2. 「deploy.yml を起動した」が Summary にあれば Actions → Deploy に run があるはず。
3. 無ければ `gh workflow run deploy.yml --ref main` を手で叩く。

## 失敗モード

| 症状 | 原因 | 対応 |
|---|---|---|
| `Run ETL` で非0終了、`data contract violations` | 上流 HTML の構造変化・表記ゆれで不変条件違反 | data/ は触られない。ログの違反行をもとにパーサー／フィクスチャを修正 |
| `Run ETL` で `HTTP 5xx` / timeout | 参議院・国会会議録の障害 | 翌日の schedule で自動再試行。急ぐなら手動 dispatch（取得済みページはキャッシュから復元される） |
| データ PR が作られない／Summary で「なし」 | 本当に差分が無い（ETL は `fetchedAt` を meta.json に書くので通常は毎回差分が出る） | `meta.json` まで変わらないなら ETL が data/ を書いていない。ログの `done` を確認 |
| `test -n "$NUMBER"` で失敗 | `gh pr create` 失敗（label `etl` が無い、権限不足） | 手元で `gh pr list --head data/refresh`。label が無ければ作る |
| 15 分待っても MERGED にならない | ブランチ保護の required check が走らない。`GITHUB_TOKEN` の push は `pull_request` イベントを起こさないため、CI を required にすると auto-merge が永遠に待つ | required check を外すか、push に PAT / GitHub App token を使う（`secrets.GITHUB_TOKEN` から差し替える）。手動で PR をマージすれば Deploy は `push: main` で走らない点に注意 → `gh workflow run deploy.yml` |
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

## このワークフローを変えるとき
- `actionlint` を通す（`curl -sL https://github.com/rhysd/actionlint/releases/download/v1.7.7/actionlint_1.7.7_linux_amd64.tar.gz | tar xz actionlint && ./actionlint .github/workflows/*.yml`）。
- シェル断片はローカルで一度実行して確かめる（`${PR:+...}${PR:-...}` の二重展開のような罠がある）。
- `run` でパイプ（`... | tee`）を使うステップには `shell: bash` を付ける。`shell:` 未指定の既定は `bash -e {0}` で pipefail が無く、`bash -e -c 'false | tee /dev/null; echo $?'` → `0` のように左側の失敗が握りつぶされる。`shell: bash` なら `bash --noprofile --norc -eo pipefail {0}` になる（`packages/etl/test/workflow-etl.test.ts` が回帰テスト）。
- 本番で試すには `workflow_dispatch` で流し、Summary と data PR、Deploy run の 3 つを確認する。

## データ一括アーカイブ（`/data/data-archive.zip`、#49）
- `pnpm --filter web build` の最後に `apps/web/scripts/build-archive.ts` が `data/` 全体（`LICENSE` 含む）＋ `README.txt`（ライセンス・帰属表示・出典・取得時刻）を `build/client/data/data-archive.zip` に書く。Deploy は `build/client/` を rsync するので自動で配布される。
- 再現可能：エントリはパスのバイト順、mtime は 1980-01-01 固定、deflate level 9。同じ `data/` からは同じバイト列（sha256 一致）。
- `pnpm --filter web smoke` が、zip の存在・エントリ数（data/ のファイル数 + README）・`LICENSE`/`README.txt` の同梱・サイズ上限（既定 50 MiB、`ARCHIVE_MAX_BYTES` で上書き）を検査する。上限を超えたら意図して上げる（回次が増えたとき）。
