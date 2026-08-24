# スクラムボードと PO 定型スクリプト（`scripts/po/`）

Sprint 4 レトロ（`docs/sprints/sprint-4.md`）：PO の手元スクリプトの変数ミス（`gh pr list --head` に main を渡す等）を
繰り返さないため、定型操作をリポジトリに置き、偽の `gh` でテストし、shellcheck を CI で通す（#70）。

## ボードの ID（GitHub Projects v2、project 2「政治記録 スクラムボード」）

| 対象 | ID |
|---|---|
| Project | `PVT_kwHOBy0CLs4BhHqj` |
| Status（single select） | `PVTSSF_lAHOBy0CLs4BhHqjzhgEpXs` |
| Status: Backlog | `569dcc89` |
| Status: Ready | `d2186140` |
| Status: In Progress | `5b5c55b5` |
| Status: In Review | `9e9b8e0c` |
| Status: Done | `e92e5038` |
| Sprint（text） | `PVTF_lAHOBy0CLs4BhHqjzhgEpbE` |
| Points（number） | `PVTF_lAHOBy0CLs4BhHqjzhgEpbI` |

ID は `scripts/po/board-set.sh` にも埋め込んである。ボードのフィールドを作り直したらここと同時に更新する。
再取得：`gh project field-list 2 --owner uonoko1 --format json`。

## スクリプト

すべて `bash`、`set -euo pipefail`、`gh`（認証済み）だけに依存する。JSON は `gh --jq` で読む（jq 本体は不要）。
破壊的な操作は `merge-when-green.sh` の「指定した PR の squash マージ（＋ head ブランチ削除）」だけ。

| コマンド | すること | 終了コード |
|---|---|---|
| `scripts/po/merge-when-green.sh <pr>` | OPEN かつ非 draft を確認 → BEHIND なら `gh pr update-branch` → `gh pr checks` を 20 秒ごと最大 60 回（20 分）見て、全部 pass/skipping になったら `gh pr merge --squash --delete-branch`。fail/cancel が 1 つでもあれば何もせず終了。head が `data/refresh` のときだけ、待っている間に `action_required` の run を承認する（他のブランチでは承認しない） | 0 マージ済 / 1 失敗・タイムアウト / 2 引数エラー |
| `scripts/po/board-set.sh <issue> <Backlog\|Ready\|In Progress\|In Review\|Done>` | Issue のボード上の item を探し（無ければ追加し）、Status を設定 | 0 / 1 / 2 |
| `scripts/po/verify-site.sh [production\|staging\|all]` | `ssh $VPS_SSH_HOST`（既定 `gikaiops`）で VPS 内から主要 URL（`/`, `/about/`, `/terms`, `/privacy`, `/members/`, `/rollcalls/`, `/assemblies/`, `/data/meta.json`, `/sitemap.xml`）の HTTP コードと `<title>` を一覧する（読み取りのみ。PO 手元の curl が 000 を返す問題の回避、#182）。production は `curl --resolve gikailog.jp:443:127.0.0.1`（証明書検証あり）。staging は host nginx が Cloudflare 以外を 403 にする（#163）ので、コンテナのポート `127.0.0.1:8083` に `Host: staging.gikailog.jp` で当てる（デプロイ済みビルドの確認であり、Access の確認ではない） | 0 = 全部 200 / 1 = 200 以外あり（行末に `NG`）/ 2 引数エラー |
| `scripts/po/etl-verify.sh` | 最新の ETL (daily) run の結論、`data/refresh` の最新 PR の番号と state、最新 Deploy run を 3 行で出す（読み取りのみ）。`docs/ops/etl.md` の PO チェックリストに対応 | 0 = ETL success かつ data PR が MERGED（または無し）かつ Deploy success / 1 = どれかが違う |

環境変数：`POLL_INTERVAL`（秒）、`POLL_MAX`（回数）、`PO_REPO`（`owner/name`。未指定ならカレントの checkout から `gh repo view`）、`VPS_SSH_HOST`（verify-site の ssh 先、既定 `gikaiops`）、`STAGING_PORT`（既定 8083）。

## テスト

```
bash scripts/po/test/run.sh          # 全部
bash scripts/po/test/run.sh merge    # 名前でフィルタ
shellcheck -x scripts/po/*.sh scripts/po/test/run.sh scripts/po/test/fake-bin/* scripts/po/test/*.test.sh
```

- `scripts/po/test/fake-bin/gh` を PATH の先頭に置いて本物の `gh` を置き換える。各テストは `handle()` 関数（引数列 `$*` で case 分岐）で API の返答（JSON）を決め、
  `-q/--jq` は本物の `jq -r` で適用する（テストには jq が要る。CI の ubuntu-latest には入っている）。
- `verify-site.sh` は `fake-bin/ssh`（最後の引数を手元で `bash -c` 実行、stdin はそのまま）と `fake-bin/curl`（`curl_handle <url>` が「コード＋本文」を返す）で、
  VPS 側で動くスクリプト本体も含めて手元で検証する。記録は `ssh<TAB>…` / `curl<TAB>…` の行。
- 呼び出しは 1 行 1 呼び出し（タブ区切り）で記録され、「どの gh コマンドをどの引数で何回呼んだか」を assert する。
  マージしていないこと・承認を試みていないことも、この記録で確認する。
- 学び：`IFS=$'\t' read` はタブが連続すると 1 つに潰す（whitespace IFS）。空のフィールドがあると後ろの列がずれるので、
  jq 側で空を `-` に置き換えてから `@tsv` にしている（`gh run list` の in_progress な run は `conclusion` が `""`）。
