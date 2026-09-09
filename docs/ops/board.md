# スクラムボードと PO 定型スクリプト（`scripts/po/`）

Sprint 4 レトロ（`docs/sprints/sprint-4.md`）：PO の手元スクリプトの変数ミス（`gh pr list --head` に main を渡す等）を
繰り返さないため、定型操作をリポジトリに置き、偽の `gh` でテストし、shellcheck を CI で通す（#70）。

## ボードの ID（GitHub Projects v2、project 2「議員レコード スクラムボード」）

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

## ボードを動かすのは PO の仕事（2026-09-08 に一度落とした）

**Issue と PR だけで進めて、ボードを一度も動かさなかったことがある。**
**ユーザーから「カンバンみても今まで何をやってたかと今何をやってるかが分からん」と指摘された。**
**そのとき実際に起きていたこと:**

```
Issue 260 件のうち Project に載っていたのは 103 件（157 件が未登録）
非 Done の 15 件のうち 13 件は既に CLOSED（Backlog / In Progress / In Review のまま放置）
ボードの最新は #260、当日の作業（#632〜#668）は 1 件も載っていない
```

**`scripts/po/board-set.sh` は Sprint 4 から存在していた。使っていなかっただけである。**

**やること**（PBI ごとに、状態が変わった時点で動かす）:

| 出来事 | Status |
|---|---|
| PBI を起票した（まだ着手しない） | `Backlog` |
| リファインメントを終え、着手してよい | `Ready` |
| 担当者を立てた | `In Progress` |
| PR が出た | `In Review` |
| マージした | `Done` |

```sh
scripts/po/board-set.sh <issue> <Backlog|Ready|In Progress|In Review|Done>
```

**「人間の判断・操作待ち」は `Backlog` に置き、`blocked` ラベルで区別する**
（`docs/ops/pending-decisions.md` に理由を書く）。**Ready に置いてはいけない**——
**Ready は「開発者が今すぐ取れる」という意味であり、誰も取れないものを置くと
ボードが「作業があるのに誰も動いていない」ように見える。**

**起票と同時にボードへ載せる。** 後でまとめて載せると、**その間ボードは嘘をつく。**

**Issue の無い PR は載せない。** **ボードに載るのは PBI（Issue）であって PR ではない。**
**「記録の更新」「他の PBI で分かった事実の反映」のような、
それ自体が独立した作業単位でないものは、Issue を作らずに PR だけ出す**
（例: 2026-09-09 の #669 ボードの運用、#675 #537 の対象が増えたことの反映）。
**載せるために Issue を作ると、ボードが PR と 1 対 1 になり、PBI の単位が失われる。**

### マージしたら Issue も閉じる（2026-09-09 に落とした）

**ボードを動かすようになった翌日、今度は「マージと Issue のクローズ」が繋がっていなかった。**

```
#688  PR #690 が 2026-09-08 20:03 にマージ済み → Issue は OPEN のまま
#694  PR #704 が 2026-09-08 22:58 にマージ済み → Issue は OPEN のまま
```

**PO はこの状態で #688 に新しい担当者を立ててしまった。**
担当者が着手前に「同じ Issue のブランチが既にある」と気づいて止めた（`WORKING_AGREEMENT.md` の #512）。
**気づかなければ、自治体のサーバーに 2 度目のリクエストを送っていた。**

**Sprint 26 で落としたものと形が同じである**——道具（`board-set.sh`）は使い始めたが、
**「マージ → Done → Issue クローズ」の 3 つ目が繋がっていなかった。**

**やること**: **`merge-when-green.sh` でマージしたら、その場で 3 つ全部やる。**

```sh
scripts/po/merge-when-green.sh <pr>
scripts/po/board-set.sh <issue> Done
gh issue close <issue> --comment "..."   # 何が入ったか・残る留保を書く
```

**残る留保があるなら、クローズのコメントに書いて別 Issue を起票する。**
**「Issue を開けたままにしておく」で留保を表現しない**——
**開いたままの Issue は「まだ誰もやっていない」に見え、担当者を二重に立てる原因になる。**

### `In Review` を飛ばしている（2026-09-09 に落とした。3 つ目）

**「マージしたら Issue も閉じる」を書いた同じ日に、今度は `In Review` を一度も使っていなかった。**

**実測**（Sprint 27 の PBI 5 件。PR が出た時刻は `gh pr list --json createdAt`）:

```
#707  PR #712 が 2026-09-08 23:59 に出た → In Progress のまま
#705  PR #713 が 2026-09-09 00:01 に出た → In Progress のまま
#711  PR #716 が 2026-09-09 00:14 に出た → PO が気づいたのは 00:40 頃
#710  PR #719 が 2026-09-09 00:18 に出た → 同上
```

**5 件中 2 件しか `In Review` を通らず、その 2 件も PR から 20 分以上あとだった。**

**なぜ落ちるか**: **PR が出たことを PO が知るのは、担当者の完了報告か Monitor の通知である。**
**担当者は「PR を出して CI が緑になるまで見届けてから報告」するので、報告が来た時点で既にマージできる。**
**つまり `In Review` に置ける時間が短く、置く動機が働かない。**

**それでも置く理由**: **ボードが「今どこまで」を答えるためである。**
**`In Progress` が 8 件並んでいると、着手したばかりのものと PR が出て緑のものが区別できない。**
**ユーザーの指摘（「カンバンみても今まで何をやってたかと今何をやってるかが分からん」）は、まさにこれである。**

**やること**: **担当者の完了報告を受けたら、マージの前に `In Review` に動かす。**

```sh
scripts/po/board-set.sh <issue> "In Review"   # 報告を受けたら（＝マージの前に）
scripts/po/merge-when-green.sh <pr>            # マージは非同期に走る
scripts/po/board-set.sh <issue> Done           # マージ後
gh issue close <issue> --comment "..."         # Closes #N で自動なら不要
```

**`merge-when-green.sh` は `update-branch` から CI 再実行まで待つので数分かかる。**
**その間ボードが `In Review` であることに意味がある**——**「緑で、マージ待ち」という状態が実在する。**

**同じ形が 3 回続いていることに注意**（Sprint 26: ボードを動かさない → Sprint 27: 閉じ忘れ → これ）。
**道具（`board-set.sh`）はあり、書いてもある。実行の側が抜ける。**

**`board-set.sh` に渡すのは Issue 番号である。PR 番号を渡すと失敗する**（実測）:

```
$ scripts/po/board-set.sh 719 "In Review"
gh: Could not resolve to an Issue with the number of 719.
```

**ボードに載るのは PBI（Issue）なので、これは正しい挙動である**（上の「Issue の無い PR は載せない」）。
**Issue と PR は番号を共有するので、取り違えやすい。**

**確かめ方**（PO が定期的に走らせる）:

```sh
# open な Issue のうち、タイトルに #N を含むマージ済み PR があるもの
for n in $(gh issue list --state open --limit 60 --json number --jq '.[].number'); do
  gh pr list --state merged --search "$n in:title" --limit 5 \
    --json number,title --jq ".[] | select(.title | test(\"#$n\\\\b\")) | \"issue #$n ← PR#\(.number)\""
done
```

**引っかかっても、それだけでは閉じてよいとは限らない**——
#537 / #610 / #654 / #543 は「文書だけ進んで人間の作業が残っている」ので **open が正しい**。
**PR が何をマージしたのかを読んでから判断すること。**

**迷ったら「これは誰かに渡せる仕事か」で決める。** **渡せるなら PBI、渡せないなら PR だけ。**

## 一度に大量に登録するとレート制限に当たる（2026-09-09 に実際に当たった）

**Issue 261 件をボードに登録し直したあと、`board-set.sh` が
`GraphQL: API rate limit already exceeded` で止まった。**

```
$ gh api rate_limit
  core:    4999/5000    ← 余裕がある
  graphql: 5000/5000    ← 余裕がある
```

**通常のレート制限には余裕があるのに止まる。**
**GitHub Projects の書き込みには別枠の制限があり、`rate_limit` API には出てこない。**

**止まるのは GraphQL を使うものだけ**（2026-09-09 に実測）:

```
gh api repos/uonoko1/giinrecord     → 動く（REST）
gh project item-edit                 → 止まる（GraphQL）
gh pr create                         → 止まる（GraphQL）
git push                             → 動く（git プロトコル）
```

**`gh pr create` も止まるので、PR を作れなくなる。**
**push は通るので、枝は残る**——**待ってから PR を作ればよい。**

**やること**:
- **一度に大量に登録するときは、途中で止まる前提で進める**（**どこまで登録できたかを
  毎回確かめる**——`gh project item-list` で数える）
- **止まったら待つ。** **通常のレート制限のリセット時刻（`gh api rate_limit` の `reset`）は
  当てにならない**——別枠なので
- **急ぎでないなら、その日のうちに全部やらない。** **PBI ごとに起票と同時に載せていれば、
  一度に大量に登録する必要は起きない**（これが本来の運用）

## スクリプト

すべて `bash`、`set -euo pipefail`、`gh`（認証済み）だけに依存する。JSON は `gh --jq` で読む（jq 本体は不要）。
破壊的な操作は `merge-when-green.sh` の「指定した PR の squash マージ（＋ head ブランチ削除）」だけ。

| コマンド | すること | 終了コード |
|---|---|---|
| `scripts/po/merge-when-green.sh <pr>` | OPEN かつ非 draft を確認 → BEHIND なら `gh pr update-branch` → `gh pr checks` を 20 秒ごと最大 60 回（20 分）見て、全部 pass/skipping になったら `gh pr merge --squash --delete-branch`。fail/cancel が 1 つでもあれば何もせず終了。head が `data/refresh` のときだけ、待っている間に `action_required` の run を承認する（他のブランチでは承認しない）。`gh pr merge` が非ゼロで返っても PR の state を読み直し、検査した HEAD がそのまま MERGED なら成功として終わる（#434。UNKNOWN のときマージ成功でも非ゼロが返る／`--delete-branch` のローカル削除が worktree に阻まれる） | 0 マージ済 / 1 失敗・タイムアウト / 2 引数エラー |
| `scripts/po/board-set.sh <issue> <Backlog\|Ready\|In Progress\|In Review\|Done>` | Issue のボード上の item を探し（無ければ追加し）、Status を設定 | 0 / 1 / 2 |
| `scripts/po/verify-site.sh [production\|staging\|all]` | `ssh $VPS_SSH_HOST`（既定 `giinops`）で VPS 内から主要 URL（`/`, `/about/`, `/terms`, `/privacy`, `/members/`, `/rollcalls/`, `/assemblies/`, `/data/meta.json`, `/sitemap.xml`）の HTTP コードと `<title>` を一覧する（読み取りのみ。PO 手元の curl が 000 を返す問題の回避、#182）。production は `curl --resolve giinrecord.jp:443:127.0.0.1`（証明書検証あり）。staging は host nginx が Cloudflare 以外を 403 にする（#163）ので、コンテナのポート `127.0.0.1:8083` に `Host: staging.giinrecord.jp` で当てる（デプロイ済みビルドの確認であり、Access の確認ではない） | 0 = 全部 200 / 1 = 200 以外あり（行末に `NG`）/ 2 引数エラー |
| `scripts/po/etl-verify.sh` | 最新の ETL (daily) run の結論、`data/refresh` の最新 PR の番号と state、最新 Deploy run を 3 行で出す（読み取りのみ）。`docs/ops/etl.md` の PO チェックリストに対応 | 0 = ETL success かつ data PR が MERGED（または無し）かつ Deploy success / 1 = どれかが違う |

環境変数：`POLL_INTERVAL`（秒）、`POLL_MAX`（回数）、`PO_REPO`（`owner/name`。未指定ならカレントの checkout から `gh repo view`）、`VPS_SSH_HOST`（verify-site の ssh 先、既定 `giinops`）、`STAGING_PORT`（既定 8083）。

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
