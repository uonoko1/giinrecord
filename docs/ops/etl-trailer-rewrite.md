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

**実測の履歴**: 2026-09-28 に「4 件」→ #1067/#1068 で **7 件** → #1085 で **8 件**。
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

**`allow_force_pushes` は触らない。** **`enforce_admins` を外すだけで force push は通る**
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
  'grep -viE "^[[:space:]]*Co-[Aa]uthored-[Bb]y:.*<etl@users\.noreply\.github\.com>[[:space:]]*$"' \
  1e41501f^..main || { echo "FILTER FAILED — push しないこと"; exit 1; }
```

**`reset` を忘れると古い main を push してマージ済みの PR が消える。**
**`|| exit 1` を必ず付ける**（`msg-filter` が失敗すると filter-branch は
`msg filter failed:` で止まるが、1 ブロックで貼ると次の `push --force` が走る）。

**`1e41501f^..main` の `^` は必要**（trailer を持つのは `1e41501f` 自身）。

## 4. push の前に検算する

```bash
git log --pretty=format:%B | grep -ciE '^[[:space:]]*Co-[Aa]uthored-[Bb]y:.*etl@users\.noreply'
#   期待 0
git log --pretty=format:%B | grep -ciE 'etl@users\.noreply\.github\.com'
#   期待 7（#1043 の説明文。trailer 1 件だけ消えて散文は残る = 消し過ぎていない）
git rev-list --count main
#   期待: 書き換え前と同じ（コミットは消えない）
git rev-parse main^{tree}
#   期待: 書き換え前と同じ（コードは 1 バイトも変わらない）
```

**8 = trailer 1 + 散文 7 で、書き換え後が 7。** **算術が閉じていれば消し過ぎ / 消し漏れが無い。**

```bash
git push --force origin main
```

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

## 初版の誤り（同じ轍を踏まないために残す）

| # | 誤り | なぜ危険か |
|---|---|---|
| A | `-X PUT .../enforce_admins` | **PUT は存在しない**（GET/POST/DELETE のみ）。**404 で落ちても、自前 grep は `allow_force_pushes` しか見ないので緑に見える。** 気づけるのは翌朝の cron（06:23 JST）だけで、**最長 24 時間、必須チェック 0 件で main に push できる。** |
| B | `-X PATCH .../protection` | **PATCH は存在しない**（GET/PUT/DELETE のみ）。**`PUT` に直すと全置換で必須チェック 4 件が消える。** |
| C | `allow_force_pushes` を触っていた | **触る必要が無い**（`enforce_admins` の DELETE だけで通る）。**触ったせいで B の危険を自分で作っていた。** |
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
