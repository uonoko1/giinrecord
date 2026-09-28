# `etl@` trailer を履歴から消す手順（未実施）

**目的**: `github.com/etl`（Sergey D。無関係の実在の個人）が Contributors に出るのを止める。
**`claude` は対象外**（利用者の明示）。`anthropic` の trailer は触らない。

> **この手順書は 1 度「直してから」を受けている。**
> **PO が書いた初版には、`main` の保護を外したまま気づけない誤りが 4 件在った**（下の「初版の誤り」）。
> **貼るときは 1 行ずつ確かめること。まとめて 1 ブロックで貼らないこと。**

## 0. 流す前に必ず数え直す（基点が動く）

```bash
git fetch origin main
git rev-list --count 1e41501f^..origin/main     # 書き換わる件数
git log origin/main --pretty=format:%B \
  | grep -ciE '^[[:space:]]*Co-[Aa]uthored-[Bb]y:.*etl@users\.noreply'   # 消す対象（期待 1）
```

**実測の履歴**: 2026-09-28 に「4 件」→ #1067/#1068 で 7 件 → #1085 で 8 件 → #1070 で **9 件**。
**4 回動いた。** **この数は焼き付けない。上のコマンドで当日に出すこと。**
**#1080 の「基点が動く」罠。当日に数え直すこと。**

## 0b. 流す前提

- **open PR が少ないこと。** **書き換えると base が変わるので open PR は全部 rebase が必要。**
  **レビュー中の PR が在るときは流さない**（レビュアーが測っている head が無効になる。#1080）。
- **作業ツリーが clean であること。** **手順 3 の `reset --hard` は未コミットの変更を黙って捨てる。**
  `git status --short` が空であることを目で見る。

## 1. protection の現設定を保存

```bash
mkdir -p ~/giinrecord-branch-backup-20260928 && umask 077
gh api repos/uonoko1/giinrecord/branches/main/protection \
  > ~/giinrecord-branch-backup-20260928/protection-before.json
test -s ~/giinrecord-branch-backup-20260928/protection-before.json && echo "保存 OK"
```

**`/tmp` に置かない**（再起動で消える唯一の原本になる）。**`umask 077` で他ユーザーから読めなくする。**

## 2. 一時解除（`enforce_admins` の DELETE だけ）

```bash
gh api -X DELETE repos/uonoko1/giinrecord/branches/main/protection/enforce_admins
```

**`enforce_admins` を外すだけでは force push は通らない**（**2026-09-28 に実地で確かめた。
下の「実地でぶつかった壁」を見よ**）。**`allow_force_pushes` も一時的に ON にする必要が在る。**

~~**`allow_force_pushes` は触らない。** **`enforce_admins` を外すだけで force push は通る**~~
（`deploy/monitor/branch-protection.sh:20` と `docs/ops/deploy.md:57` の
`Bypassed rule violations` がその記録）。

**触ってはいけない理由**: `PUT .../protection` は**部分更新ではなく全置換**で、
**書かなかった optional（`check` / `gitleaks` / `forbidden-patterns` / `audit` / `strict`）が
既定値に戻り、差分に何も残らない。**

## 3. ローカルを origin に合わせてから書き換える

```bash
git status --short                      # ← 空であることを目で見る
git checkout main && git fetch origin main && git reset --hard origin/main
git filter-branch -f --msg-filter \
  'grep -viE "^[[:space:]]*Co-[Aa]uthored-[Bb]y:.*<(etl@|(219112946\+)?seiji-kiroku-dev@)users\.noreply\.github\.com>[[:space:]]*$"' \
  1e41501f^..main || { echo "FILTER FAILED — push しないこと"; exit 1; }
```

**`reset` を忘れると古い main を push してマージ済みの PR が消える。**
**`|| exit 1` を必ず付ける**（`msg-filter` が失敗すると filter-branch は
`msg filter failed:` で止まるが、1 ブロックで貼ると次の `push --force` が走る）。

**`1e41501f^..main` の `^` は必要**（trailer を持つのは `1e41501f` 自身）。

### 2 つのアドレスを 1 回で消す（#1101）

**2026-09-28、`#1064` のマージで `219112946+seiji-kiroku-dev@users.noreply.github.com` が
main に入った**（担当者エージェントが**他人の数字 ID を発明した**）。
**`219112946` は `github.com/MLehnus`（無関係の実在の個人）である。**

```
gh api user/219112946   → MLehnus      ← 誤り
gh api user/120390190   → uonoko1      ← 正しい番号（git config に在った）
```

**履歴の数字 ID 付きアドレスを全部逆引きして、誤りは 1 件だけと確かめた**（PO の実測）:

```
120390190+uonoko1@users.noreply.github.com              → uonoko1              ✓
41898282+github-actions[bot]@users.noreply.github.com   → github-actions[bot]  ✓
219112946+seiji-kiroku-dev@users.noreply.github.com     → MLehnus              ★
```

**上の filter は両方を 1 回で落とす。** **force push は 1 回で済むほうが安全である**
（protection を外している時間が短い）。

**`a72611ee` が対象なので、範囲 `1e41501f^..main` に含まれる**（`1e41501f` より新しい）。
**当日に `git log --branches --remotes --pretty=format:%B | grep -c 219112946` で数えること。**

### 消す対象は 2 つではなく 3 つだった（#1101 の担当者が測り直した）

**PO は「誤りは `219112946` の 1 件だけ」と書いたが、誤りだった。**
**`origin/main` の `Co-authored-by:` を全部列挙して分類すると 3 種類在る**（PO が検算）:

```
etl@users.noreply.github.com                        → github.com/etl      （#1059）1e41501f
219112946+seiji-kiroku-dev@users.noreply.github.com → github.com/MLehnus  （#1064）a72611ee
seiji-kiroku-dev@users.noreply.github.com           → 404（いま実在しない）（#1070）c864f750
```

**3 つ目を見落としたのは、PO が「数字 ID 付きアドレス」だけを逆引きしたから**——
**数字 ID の無い形が分類から漏れていた。** **これも範囲の取り方の誤りである。**

**3 つとも範囲 `1e41501f^..main` に含まれることを検算済み。**
**上の filter は 3 つとも落とす**（実測: 散文・`noreply@anthropic.com`・正しい `120390190+` は残る。
`bash -n` で構文も確認）。

**当日は「綴りを決め打ちせず、分類して」数えること**:

```bash
git log origin/main --pretty=format:%B \
  | grep -oiE '^[[:space:]]*Co-[Aa]uthored-[Bb]y:[^<]*<[^>]+>' \
  | grep -oE '<[^>]+>' | tr -d '<>' | sort -u
```

**出てきたアドレスを 1 つずつ `gh api user/<id>` か `gh api users/<name>` で確かめる。**
**`999+dev@…` のような「架空のつもりの数字」も実在する**——**`id=999` は `github.com/maxthelion`**
（#1043 のレビューが架空のつもりで書いた綴りが、実在の個人だった。#1101 の担当者が発見）。

## 3b. `main` だけでは足りない（`1e41501f` は複数の枝の祖先）

**当日に数えること。枝の数は動く**（実測の履歴: 12 本 → **9 本**。#1063 / #1064 / #1088 がマージされ、
`docs/1088-breakdown` / `docs/1092-axes` が新たに生えた）:

```bash
for br in $(gh api repos/uonoko1/giinrecord/branches --jq '.[].name'); do
  git fetch -q origin "refs/heads/$br:refs/remotes/origin/$br"
  git merge-base --is-ancestor 1e41501f "origin/$br" && echo "$br"
done
```

**下の一覧は 2026-09-28 時点のもので、そのまま使わないこと**——**ベタ書きの一覧は denylist なので、
新しく生えた枝を素通りする**（レビューの指摘）。

```
data/districts / data/refresh / docs/1059-correction / docs/1074-rewrite-procedure /
docs/1087-push-immediately / fix/977-pr-closes-literal / fix/1036-released-chain-links /
fix/1052-comparator-allowlist-bypass / fix/1054-skipped-overwrites-failure /
fix/1081-workflow-dir-pollution / main / test/1074-commit-trailer-identity
```

**`main` だけ書き換えると、残りの枝に trailer が残る。**
**そして手順 4 の検算を ref 引数なし（= HEAD のみ）で流すと `0` = 成功と出る。**
**`--branches --remotes` で数えると残っている。**

**「同じクローンで 56 件」という初版の記述は誤りだった**（レビューの実測）——
**`git log` は同じコミットを 1 度しか訪れず、trailer を持つのは `1e41501f` 1 本だけなので
原理的に最大 1。** **56 は死んだ remote-tracking ref を数えた値で、
`refs/remotes` を消すと 1 になる。**

**`_sidebar` は全 ref を集計するので、これでは目的を達しない**
（`dev` を消したときは 17 本すべてを消したから 0 になった）。

**やり方は 2 つ。どちらを選ぶかは open PR の数で決める:**

| | やり方 | いつ選ぶか |
|---|---|---|
| **(a)** | **open PR を全部マージ / 閉じてから、main だけ書き換える** | **推奨。** 枝が無ければ `main` だけで足りる |
| (b) | 該当する枝すべてを書き換えて force push する | 急ぐとき。**ただしレビュー中の PR の head が全部無効になる**（#1080） |

**(a) を推す。** **`etl@` trailer 1 件は 2 時間で消えるものではないので、急ぐ理由が無い。**

## 4. push の前に検算する

```bash
git log --branches --remotes --pretty=format:%B | grep -ciE '^[[:space:]]*Co-[Aa]uthored-[Bb]y:.*etl@users\.noreply'
#   期待 0
#   **`--branches --remotes` であって `--all` ではない。**
#   **`--all` は `refs/original/` も歩く。** `filter-branch` は書き換え前の状態を
#   `refs/original/refs/heads/main` に残すので、**成功した run でも `--all` は 1 を返す**
#   （実測 2026-09-28: 完璧な書き換えの後でも `--all` → 1 / `--branches --remotes` → 0）。
#   **「1 が出たから失敗した」と読んで止まると、protection が外れたまま残る。**
#   **HEAD だけ（ref 引数なし）でも駄目**——他の枝に残っていても 0 と出る（上の 3b）。
git log --pretty=format:%B | grep -ciE 'etl@users\.noreply\.github\.com'
#   期待: 書き換え前の「散文含む件数」から 1 引いた数（trailer 1 件だけ消えて散文は残る）。
#   書き換え前に上の 0 節で数えておくこと。**この数も焼き付けない**（#1043 の説明文が増減する）。
git rev-list --count main
#   期待: 書き換え前と同じ（コミットは消えない）
git rev-parse main^{tree}
#   期待: 書き換え前と同じ（コードは 1 バイトも変わらない）
```

**8 = trailer 1 + 散文 7 で、書き換え後が 7。** **算術が閉じていれば消し過ぎ / 消し漏れが無い。**

```bash
git push --force-with-lease origin main
```

**`--force` ではなく `--force-with-lease`。** **ETL の cron が 06:00 JST に main へ auto-merge する**
（`etl.yml:4` の `cron: "0 21 * * *"`）。**素の `--force` はその間に入ったデータコミットを黙って消す。**
**`--force-with-lease` なら、他人が push していたら拒否される。**

**06:00 JST の前後は流さないこと。**

## 5. protection を即座に復元して、復元できたことを確かめる

```bash
gh api -X POST repos/uonoko1/giinrecord/branches/main/protection/enforce_admins
bash deploy/monitor/branch-protection.sh uonoko1/giinrecord main
```

**`-X POST` である**（`/protection/enforce_admins` は GET/POST/DELETE のみ。**PUT は存在しない**）。
`docs/ops/deploy.md:101` が同じ形。

**検算は自前 grep ではなく `branch-protection.sh` を使う**——**期待値をハードコードしていて、
`enforce_admins` / `strict` / 必須チェック 4 件の名前まで見る**（#499 を満たしている）。
**自前 grep だと `allow_force_pushes` しか見ず、`enforce_admins` が false のままでも緑に見える。**

## 6. 流した後

- **docs の SHA 参照を貼り替える。** **`0f734507` が 3 ファイル 9 行から「測った基点」として引かれている**
  （`shimane-nearest-tie.test.ts` 5 行 / `workflow-timeout.test.ts` 3 行 / `votes-pdf.ts` 1 行）。
  新 SHA に直す。**他の 7 本は 0 件だった。**
- **open PR を rebase する。** **`update-branch` を使わないこと**——
  **あれは rebase ではなく「base を PR 枝にマージする」**（公式の逐語）ので、
  **旧 `1e41501f`（trailer 持ち）が squash メッセージに連結されて trailer が main に戻る**（#1059 と同じ機構）。
  **`git rebase origin/main` で枝を作り直して force push する。**
- **`_sidebar` を確認する**（`graphs/contributors` ではなく**`_sidebar` が利用者の見る計器**。#1076）:

```bash
curl -s https://github.com/uonoko1/giinrecord/_sidebar \
  -H 'Accept: application/json' -H 'X-Requested-With: XMLHttpRequest' \
  -H 'github-verified-fetch: true' -H 'User-Agent: Mozilla/5.0' \
  | grep -oE '"contributorCount":[0-9]+|"login":"[^"]+"'
```

- **すぐには消えない見込み。** `dev@` を 742 → 0 にしても `_sidebar` は 2 時間以上 `dev` を返し続けた
  （GitHub 側のサーバサイド事前計算キャッシュ）。**消えなければ、どの ref にも存在しないのに
  Contributors に出続けるという実測を持って GitHub Support に出す。**

## 実地でぶつかった壁（2026-09-28、本番で流した記録）

**この手順書は 6 回レビューを受けたが、実地で 2 つ壁にぶつかった。**
**どちらも「読んで分かる」形ではなく「流して初めて分かる」形だった。**

### 壁 1: `enforce_admins` を外すだけでは push が拒否される

```
enforce_admins=false / allow_force_pushes=false で push
  → ! [remote rejected]  main -> main (protected branch hook declined)
```

**手順書は「`allow_force_pushes` は触らない。`enforce_admins` を外すだけで通る」と書いていたが、誤り。**
**#1084 のレビューが「必須 3」として警告していたとおりだった**——
**根拠にしていた `Bypassed rule violations` は必須チェック迂回の記録で、force push の記録ではない。**

### 壁 2: `allow_force_pushes` だけ ON にしても通らない

```
enforce_admins=true / allow_force_pushes=true で push
  → 同じく rejected
```

**`enforce_admins=true` だと、force push の許可が管理者にも適用されない。**
**両方を同時に緩める必要が在る。**

```
enforce_admins=false / allow_force_pushes=true
  → + 4696f048...1460b189 main -> main (forced update)   ← 通った
```

### だから手順はこうなる

**`enforce_admins` の DELETE に加えて、`allow_force_pushes` を ON にする。**
**ただし `PUT .../protection` は全置換で必須チェックが消えるので、
API では触らず Web UI（Settings → Branches → main の Edit）で操作するほうが安全である。**

```
Settings → Branches → main → Edit
  □ Do not allow bypassing the above settings   ← OFF（= enforce_admins=false）
  ☑ Allow force pushes                          ← ON
```

**終わったら両方を元に戻す**（`enforce_admins` は `gh api --method POST .../enforce_admins` で戻せる。
**`allow_force_pushes` は Web UI で戻す**）。

**保護が外れていた時間: 約 3 分**（2 回に分けて、その都度 `branch-protection.sh` で復元を確認した）。

### 流した結果（実測）

```
誤帰属 3 種   0 件   （etl / MLehnus / seiji-kiroku-dev@）
219112946     0 件
散文 etl@     7 件   （#1043 の説明文は残った = 消し過ぎていない）
anthropic     1708 件（不変）
コミット数    709   （不変）
tree          完全同一（コードは 1 バイトも変わっていない）
```

## 初版の誤り（同じ轍を踏まないために残す）

| # | 誤り | なぜ危険か |
|---|---|---|
| A | `-X PUT .../enforce_admins` | **PUT は存在しない**（GET/POST/DELETE のみ）。**404 で落ちても、自前 grep は `allow_force_pushes` しか見ないので緑に見える。** **私は当初「翌朝の cron（06:23 JST）が気づくので最長 24 時間」と書いたが、それも誤りだった**——**その cron は 23 回連続 failure で死んでいる（実測 2026-09-28。私は 6 回、前回のレビューは 8 回と書いたが、どちらも少なく見積もっていた）**（`BRANCH_PROTECTION_TOKEN` が無く HTTP 403 → exit 2。`branch-protection.sh` は exit 2 で return するので判定行に届かない。**#547 が開いたまま**）。**つまり検出手段はゼロで、期間は無期限だった。** |
| B | `-X PATCH .../protection` | **PATCH は存在しない**（GET/PUT/DELETE のみ）。**`PUT` に直すと全置換で必須チェック 4 件が消える。** |
| C | ~~`allow_force_pushes` を触っていた~~ | **この「誤り」の指摘自体が誤りだった**（2026-09-28 の実地で判明）。**`enforce_admins` の DELETE だけでは push は拒否される。** 下の「実地でぶつかった壁」を見よ |
| D | `update-branch` で rebase するつもりだった | **あれはマージなので、消した trailer が main に戻る。** |
| E | `reset --hard` が無かった | **古い main を push してマージ済みの PR が消える。** |
| F | 「docs の SHA 参照 0 ファイル」 | **誤り。3 ファイル 9 行在った。** |
| G | 数が 3 回古くなった（4 → 7 → 8） | **#1080 の「基点が動く」。当日に数え直す規則を 0 節に置いた。** |

**A と C は「実行して初めて分かる」形だった**——**`gh api` のメソッドが存在するかを、
リポジトリ内の既存の手順（`docs/ops/deploy.md`）と突き合わせていれば防げた。**

## 復元（万一のとき）

削除した 17 本のブランチの bundle と手順は `~/giinrecord-branch-backup-20260928/` に在る
（`RESTORE.md` / `dev-etl-branches.bundle` / `open-pbi-branches.bundle` / `tips.txt`、
どちらも `git bundle verify` 済み）。

**protection は `protection-before.json` に保存してある**が、
**`PUT` で戻すと全置換になるので、中身を見て `branch-protection.sh` の期待値と突き合わせること。**
