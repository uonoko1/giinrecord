# `etl@` trailer を履歴から消す手順（未実施。明日流す）

**目的**: `github.com/etl`（Sergey D。無関係の実在の個人）が Contributors に出るのを止める。
**`claude` は対象外**（利用者の明示）。`anthropic` の trailer 1643 行は触らない。

## 流す前に必ず数え直す（基点が動く）

```bash
git fetch origin main
git rev-list --count 1e41501f^..origin/main     # 書き換わる件数。2026-09-28 時点で 7
git log origin/main --pretty=format:%B | grep -ciE '^[[:space:]]*Co-[Aa]uthored-[Bb]y:.*etl@users\.noreply'
                                                 # 消す対象。1 件
```

**2026-09-28 に「4 件」と書いたが、#1067 / #1068 をマージして 7 件になった。**
**#1080 の「基点が動く」罠。流す当日に数え直すこと。**

## 前提: open PR が無いか、少ないこと

**書き換えると base が変わるので open PR は全部 rebase が必要になる。**
**レビュー中の PR が在るときは流さない**——レビュアーが測っている head が無効になる（#1080）。

## 手順

```bash
# 1. protection を保存
gh api repos/uonoko1/giinrecord/branches/main/protection > /tmp/prot.json

# 2. 一時解除（-X は 1 個ずつ。2 個書くと壊れる）
gh api -X DELETE repos/uonoko1/giinrecord/branches/main/protection/enforce_admins
gh api -X PATCH  repos/uonoko1/giinrecord/branches/main/protection -F allow_force_pushes=true

# 3. ローカルを origin に合わせてから書き換える
#    （reset を忘れると古い main を push して、マージ済みの PR が消える）
git checkout main && git fetch origin main && git reset --hard origin/main
git filter-branch -f --msg-filter \
  'grep -viE "^[[:space:]]*Co-[Aa]uthored-[Bb]y:.*<etl@users\.noreply\.github\.com>[[:space:]]*$"' \
  1e41501f^..main

# 4. push の前に検算する
git log --pretty=format:%B | grep -ciE '^[[:space:]]*Co-[Aa]uthored-[Bb]y:.*etl@users\.noreply'
#   期待 0
git log --pretty=format:%B | grep -ciE 'etl@users\.noreply\.github\.com'
#   期待 7（#1043 の説明文。trailer 1 件だけ消えて散文は残る = 消し過ぎていない）
git rev-list --count main
#   期待: 書き換え前と同じ（コミットは消えない）

git push --force origin main

# 5. protection を即座に復元して、復元できたことを確かめる
gh api -X PATCH repos/uonoko1/giinrecord/branches/main/protection -F allow_force_pushes=false
gh api -X PUT   repos/uonoko1/giinrecord/branches/main/protection/enforce_admins
gh api repos/uonoko1/giinrecord/branches/main/protection \
  | grep -oE '"allow_force_pushes":\{"enabled":(true|false)\}'
#   期待 false
```

## 使い捨てクローンで検証済み（2026-09-28。本番未実施）

```
所要          11.1 秒
コミット数    696 → 696（消えない）
tree          f35e2ee4... → f35e2ee4... 完全同一（コードは 1 バイトも変わらない）
etl@ trailer  1 → 0
anthropic     1643 → 1643（触らない）
散文の etl@   8 → 7（trailer 1 件だけ消える）
正しい帰属    uonoko1 518 / github-actions[bot] 66 / 本人 2 ← 壊れない
docs の SHA   書き換え対象を指す参照 0 ファイル
```

## 流した後

- **open PR を rebase する**（`gh api -X PUT repos/.../pulls/<N>/update-branch`）。
- **`_sidebar` を確認する**（`graphs/contributors` ではなく `_sidebar` が利用者の見る計器。
  [[github-contributors-five-instruments]] 参照）:
```bash
curl -s https://github.com/uonoko1/giinrecord/_sidebar \
  -H 'Accept: application/json' -H 'X-Requested-With: XMLHttpRequest' \
  -H 'github-verified-fetch: true' -H 'User-Agent: Mozilla/5.0' \
  | grep -oE '"contributorCount":[0-9]+|"login":"[^"]+"'
```
- **すぐには消えない見込み**。`dev@` を 742 → 0 にしても `_sidebar` は 2 時間以上 `dev` を返し続けた
  （GitHub 側のサーバサイド事前計算キャッシュ）。**消えなければ、どの ref にも存在しないのに
  Contributors に出続けるという実測を持って GitHub Support に出す。**

## 復元（万一のとき）

`dev` の 17 本を消したときの bundle と手順は
`/tmp` の scratchpad にあるが**セッションが消えると失われる**。
**恒久的に要るなら repo 外の安全な場所に移すこと**（bundle 86MB）。
