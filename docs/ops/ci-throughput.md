# CI の所要時間と、PR が並んだときの実際の増え方（#812 の実測）

**測定日: 2026-09-14。対象は 2026-09-13 の 1 日（CI ワークフローの実行 184 件）。**

## 結論を先に

**1. N² は起きていませんでした。** 実測は **N 本に対して線形**です。
   理由は単純で、**同時に開いている PR が最大 4 本・中央値 1 本しか無かった**からです。
   Issue #812 の想定（14 本並ぶ → 105 回）は、**14 本並んだ日が無かった**ので発生しませんでした。

**2. 同じ commit に対して CI が 2 回走ったことは、1 度もありませんでした。**
   **444 件の pull_request 実行すべてが別々の head_sha** です（重複 0 件）。
   「やり直し」は**同じものを測り直しているのではなく、`main` を取り込んだ新しい commit を測っている**ので、
   **検査としては必要なもの**です。

**3. それでも、`main` の取り込みだけのために走った CI は 1 日で 65 回ありました**（実行 131 件の **49.6%**）。
   これは `strict: true` の値段そのもので、**#521 の守りを外さない限り消えません。**

**4. 「先に全部を最新にしてから 1 本ずつ流す」は速くなりません**（下の「3.」で示します）。
   **数式上も実測上も現行と同じ**です。

**5. 直さないことを勧めます。** 今の規模（**1 時間あたり 3.2 本のマージ**）では、
   **CI 1 回 380 秒 < マージ間隔の中央値 524 秒**なので、**CI は律速になっていません。**
   ただし**測り方を変えるべき点が 1 つ**あります（下の「5.」）。

---

## 1. 本当に N² 走っているのか（Issue の測定項目 1・5）

`gh api .../actions/workflows/339930275/runs`（ページング。`gh run list` の上限 100 に当たらない方法）で
**2026-09-06〜09-13 の 635 件**を取得しました。

```
2026-09-13 の CI 実行        184 件   ← PO の実測「100 件以上」は取得上限だった。実数は 184
  うち pull_request           131 件
  うち push（main）            53 件
  結果の内訳   success 138 / cancelled 37 / failure 8 / 実行中 1
```

### 同じ head_sha に対する重複: **0 件**

```
2026-09-13 の pull_request 実行     131 件 → 相異なる head_sha 131 個（重複 0）
2026-09-06〜13 の pull_request 実行  444 件 → 相異なる head_sha 444 個（重複 0）
再実行（run_attempt > 1）             13 件（7 日で。1 日あたり 2 件弱）
```

**「同じものを何度も測っている」という形の無駄は、実測では存在しませんでした。**

### では 131 件は何だったのか

**131 件の head_sha それぞれについて、親の数を API で数えました**（`.parents | length`）。
`gh pr update-branch` が作るのは**旧 HEAD を親に持つマージコミット**なので、親が 2 つ以上なら
「`main` を取り込んだだけ」と区別できます（`merge-when-green.sh` の `is_our_merge_commit` と同じ判定）。

```
head が マージコミット（親 2 つ以上）   65 件  ← 49.6%。`Merge branch 'main' into ...`
head が 普通のコミット                 66 件  ← 人が書いた変更
```

**つまり、CI の約半分は「`main` に追いつくため」だけに走っています。**

### 増え方は N² ではなく N·k

**各マージの瞬間に、他に何本の PR が開いていたか**を数えました（PR 400 件の作成・マージ・クローズ時刻から）。

```
他に開いていた PR が 0 本のマージ  17 回
                    1 本          17 回
                    2 本          13 回
                    3 本           7 回
                    4 本           3 回   ← 最大
合計（= 強制される再実行の見込み）  76 回
```

**独立な 2 つの数え方が一致しました**: 上のモデルが **76 回**、
実際に数えたマージコミットの CI が **65 回**（モデルがやや多いのは、
マージ時に開いていても `update-branch` されずに終わった PR があるため）。

**N² が出るには N 本が同時に開いている必要がありますが、実際の N は中央値 1・最大 4 でした。**
**14 本を 1 日に出しても、同時に開いていなければ N² にはなりません。**

---

## 2. 6.5 分の内訳（Issue の測定項目 2）

**成功した 40 実行の job / step を API から取り、中央値を出しました。**

```
ワークフロー全体の wall（created→updated, n=138）  min 284 / 中央値 380 / p90 425 / max 518 秒
キュー待ち（created→run_started, n=138）           中央値 0 秒 / max 18 秒   ← ランナー待ちではない
```

### job（成功のみ、n=40）

```
check        中央値 300 秒   ← 長辺
docker-web   中央値  90 秒   ← `needs: check` なので check の *後* に直列で走る
stale-base   中央値   9 秒   ← check と並列
pr-closes    中央値   7 秒   ← check と並列
```

**臨界パスは check(300) + docker-web(90) = 390 秒**で、実測のワークフロー全体 380 秒とほぼ一致します。
**stale-base と pr-closes は並列なので、全体の時間に 1 秒も足していません**（#812 の想定どおり）。

### check の step（中央値、n=40）

```
144 秒  pnpm test                                   ← 48%
 53 秒  shellcheck + bash tests
 35 秒  pnpm build
 17 秒  upload-artifact
 13 秒  Install Chromium for Playwright
  9 秒  pnpm typecheck
  4 秒  smoke
  以下すべて 3 秒以下（install 3s / setup-node 3s / checkout 3s / cache 3s /
  lint 1s / actionlint 1s / shellcheck 導入 0s / テスト本数の下限 0s …）
```

### pnpm test の中身は CI のログのタイムスタンプから直接読めます

`pnpm -r test` は **web と etl を並列に**起動します（ログの接頭辞つき出力。同じ秒に両方が開始）。

```
17:45:46  apps/web test$ vitest run
17:45:46  packages/etl test$ node --test --import tsx test/*.test.ts
17:47:11  apps/web   終了   1355 tests / 96 files   … 85 秒
17:48:10  packages/etl 終了 1569 tests / 132 files  … 144 秒（duration_ms 143574）
```

**最後の 59 秒は etl だけが走っています。** **web のテスト 1,355 件は長辺ではありません。**

**etl のテストは全部ローカルの fixture で、ネットワークに出ません**（確認済み）。
上位を占めるのは PDF の解析（`*-votes-pdf.test.ts`, `dataset.test.ts`, `tottori-run.test.ts`）で、
**素の CPU 時間**です。キャッシュで消える種類のものではありません。

> **ここは確かめていません**: 「etl を 2 つの job に割れば何秒縮むか」を**実測していません。**
> ローカルで測ろうとしましたが、**この開発機は他の worktree の並行作業で load average が 43 まで上がっており**
> （16 コア）、同一内容の etl 実行が **80 秒 → 180 秒 → 286 秒**とばらついて、比較に使えませんでした。
> **CI 側の n=40 の測定（min 97 / 中央値 148 / max 161 秒、標準偏差 22 秒）だけが信頼できる数字です。**
> **縮む見込みを数字で書くには、CI 上で実際に分割して測る必要があります。**

---

## 3. `merge-when-green.sh` の待ち方は最適か（Issue の測定項目 3）

### 「先に全部を最新にしてから 1 本ずつ流す」は**速くなりません**

N 本がすべて緑・最新の状態から始めるとします。

| | 現行（1 本ずつ update → 待つ → マージ） | 「先に全部 update してから」 |
|---|---|---|
| 必要な CI 実行 | N−1 回 | N−1 回 |
| 所要（CI 380 秒） | (N−1)×380 秒 | (N−1)×380 秒 |

**同じです。** 理由は **`strict: true` が「毎回のマージの後に」BEHIND を作り直す**からです。
先にまとめて最新にしても、**1 本目をマージした瞬間に残り全部がまた古くなります。**
**まとめて更新した分の CI は、丸ごと捨てられます**（むしろランナー時間を増やします）。

**順番を変えて減らせるものではありません。** 減らせるのは
**「1 回のマージごとに 1 回の CI」という対応そのものを壊す方法**＝ merge queue だけです（下の 4.）。

### cancelled 37 件の正体

**PO の訂正どおり、`concurrency` は効いています。** ただし**何に殺されたのか**まで数えると、
「守りが働いた」だけではない形が見えます。

```
pull_request の cancelled          34 件
  後継が「Merge branch 'main'」    31 件  ← update-branch が、走行中の CI を殺した
  後継が作者自身の新しいコミット      3 件  ← これは純粋に「守り」。連打を止めている
捨てられた実行時間                  中央値 248 秒 / 合計 132 分
  うち 300 秒（check の中央値）を超えていたもの  10 件
```

**31 件は `merge-when-green.sh` の `wait_for_green` が原因です。**
チェックが pending の枝でも `update_if_behind || true` を毎ポーリング呼ぶので、
**`main` が動いた瞬間に、走行中の CI を捨てて新しい CI を始めます。**

**ただしこれは直すべき欠陥とは限りません。** 殺された実行は**古い base の上**にあり、
`strict: true` の下では**どのみちマージには使えません。** 最後まで走らせても、
**その後にもう 1 回走らせる必要があり、PO の待ち時間はむしろ伸びます。**
**早く殺すのは wall clock としては正しい判断です。**
**節約できるのはランナー時間（1 日 132 分、その日の総実行時間 1,023 分の 13%）だけで、PO の時間ではありません。**

> **ここは確かめていません**: **この 132 分に金銭的な費用が出ているかは確かめていません。**
> GitHub の公開ドキュメントでは **public リポジトリの標準ランナーは無料**とされていますが、
> **課金 API は `gh` の現在のスコープでは読めませんでした**（`/users/.../settings/billing/actions` が
> `user` スコープを要求して 404）。**「費用ゼロ」と断定はできません。**

### PR #818 が 30 分止まって見えた件の内訳

```
13:48:48  wall 562 秒  cancelled  e882ccd
13:53:09  wall 557 秒  cancelled  0969e68
14:02:10  wall 414 秒  success    ff0c9b3
```

**3 本が数珠つなぎで、合計 13:48→14:09 の約 21 分。** `POLL_MAX=60 × POLL_INTERVAL=20 秒 = 20 分`
なので、**`merge-when-green.sh` は設計どおりの上限で諦めています。**
**「必須チェックが報告されない」のではなく、前の実行がまだ走っていただけでした。**

---

## 4. GitHub の merge queue は使えるか（Issue の測定項目 4）

### 使えます（このリポジトリは public）

**実測**:

```
リポジトリ    visibility: public / owner type: User / plan: (API からは読めない)
GraphQL  repository.mergeQueue  →  null
```

**`null` はフィールドが解決した上での「まだ設定されていない」です。**
対照として存在しないフィールドを聞くと `Field 'noSuchFieldXyz' doesn't exist` とエラーになるので、
**`null` が返ったこと自体は「スキーマに在る」までしか示しません**（スキーマは全リポジトリ共通です）。

> **ここは確かめていません**: **「このリポジトリのプランで実際に有効化できるか」は実測していません。**
> 有効化は branch protection の変更なので、**PO の権限では試せません**（#547 / #550 / #790）。
> GitHub の公開ドキュメントでは **merge queue は public リポジトリおよび Team / Enterprise Cloud** が対象と
> されていますが、**この記述は一次資料として当たっただけで、このリポジトリで動かして確かめてはいません。**

`rulesets` は `[]`（空）で、**現在の保護は古い branch protection API 側にあります**:

```
required_status_checks.strict: true
contexts: check, gitleaks, forbidden-patterns, audit
enforce_admins: true
allow_squash_merge: true / allow_merge_commit: false / delete_branch_on_merge: true
allow_auto_merge: true
```

### merge queue にすると何が変わるか（**これは見積もりです。実測していません**）

merge queue は **N 本をまとめて 1 本の候補ブランチに積んで、1 回だけ検査**します。
バッチサイズ B なら、必要な CI は **N−1 回 → ceil((N−1)/B) 回**になります。

```
                         現行 (N-1)         merge queue B=5
  N=4  （実測の最大）    3 回 = 19.0 分      1 回 =  6.3 分
  N=14 （Issue の想定）  13 回 = 82.3 分     3 回 = 19.0 分
```

**ただし実測の N は中央値 1・最大 4 です。** **N=1 のとき merge queue の節約はゼロ**で、
**N=2 でも 380 秒（6.3 分）です。** **1 日 57 本のマージのうち 17 本は他に 1 本も開いていませんでした。**

**今の運用規模では、merge queue が節約する時間より、
「キューという新しい壊れ方」を覚える費用の方が大きいと判断します。**

### それでも入れるなら、人間が何をすればよいか

**PO は branch protection を変えられません**（#547 / #550 / #790 で PAT が要ると判明済み）。
**以下はリポジトリの管理者（人間）の作業です。**

1. **Settings → Branches → `main` の保護規則**で **Require merge queue** を有効にする。
2. **merge queue の設定**で:
   - **Merge method: Squash**（現行と揃える。`allow_merge_commit` は false のまま）
   - **Maximum pull requests to build: 5**（上の見積もりの B）
   - **Only merge non-failing pull requests** を有効
3. **`.github/workflows/ci.yml` に `merge_group:` トリガを足す。**
   **これを忘れると、キューに入った候補で CI が 1 度も走らず、必須チェックが永久に報告されません**
   （キューが止まります）。**gitleaks / forbidden-patterns / audit の 3 つも同じ**なので、
   **必須 4 件すべてのワークフローに `merge_group:` が要ります。**
4. **`concurrency` の group を見直す。** 現行は `ci-${{ github.ref }}` で、
   **merge_group の ref は候補ごとに別**なので衝突はしませんが、
   **キューの候補を `cancel-in-progress` で殺すとキューが詰まります。** 要検討。
5. **`scripts/po/merge-when-green.sh` を変える必要があります。**
   キューに入れるのは `gh pr merge --squash --auto` で、**マージは即座には起きません。**
   **現行スクリプトの「緑を確かめた HEAD だけがマージされる」不変条件（#389/#392/#414/#434/#446）は、
   キューが候補ブランチを作る以上、そのままの形では成り立ちません。**
   **この書き換えは、この Issue の範囲では設計していません。**

**結論: 今は入れないことを勧めます。** **入れるとしても、5. の書き換えを先に設計してからです。**

---

## 5. 変えるべき点（1 つだけ）

**`merge-when-green.sh` を変えることは勧めません**（上のとおり、早く殺すのは wall clock としては正しい）。

**変えるべきなのは測り方です。**

**PO は `gh run list --limit 100` で「100 件以上」と書きましたが、実数は 184 件でした。**
**`gh run list` の `--limit` は取得の上限であって、その日の実行回数ではありません。**
**この Issue は、その 100 という数字を「N² の証拠」として読みかけていました。**

**回数を数えるときは `gh api --paginate` を使うこと**——
それだけで、**「重複 0 件」という、この Issue の前提をひっくり返す事実**に届きます。

---

## 数字の出どころ

| 数字 | 出どころ |
|---|---|
| CI 実行 184 件 / 635 件 | `gh api --paginate /repos/{owner}/{repo}/actions/workflows/339930275/runs?created=>=2026-09-06` |
| 重複 0 件 | 上の `head_sha` を集計（444 実行 → 444 個） |
| マージコミット 65 件 | head_sha ごとに `gh api .../commits/<sha> --jq '.parents|length'`（131 件を全数） |
| 同時に開いた PR 中央値 1 / 最大 4 | `gh pr list --state all --limit 400 --json createdAt,mergedAt,closedAt` |
| job / step の中央値 | `gh api .../actions/runs/<id>/jobs`（成功 40 実行） |
| web 85 秒 / etl 144 秒 | `gh api .../actions/jobs/<id>/logs` のタイムスタンプ（1 実行） |
| マージ間隔 中央値 524 秒 | 09-13 の push イベント 53 件の `created_at` の差分 |
| merge queue が使えること | `gh api graphql` の `repository.mergeQueue` が `null` を返す（エラーではない） |

**取得したデータは `.measure/` に置いたので、リポジトリには入っていません**（#787）。
**再現するには上のコマンドを流し直してください。**
