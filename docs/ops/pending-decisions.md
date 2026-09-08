# 人間の判断・操作を待っていること

**PO（Claude）が進められない作業の一覧。** セッションをまたいで残るように、ここに集める。
**「なぜ PO ができないか」を必ず書く**——できるのにやっていないなら、それは PO の怠慢である。

**「取り消せないから」は、ここに書く理由にならない**（2026-09-08、#629 で実際に間違えた）。
**取り消せないなら、取り消す必要が出ないところまで確認してから実行する。**
**ここに書いてよいのは 3 つだけ:**

1. **PO に権限が無い**（サーバーの docker、GitHub の設定画面、権限設定で止められた操作）
2. **外部に届いてしまう**（事務局への照会、Sponsors の公開）——取り消せないうえに相手がいる
3. **確認しても答えが出ない**（誰の名前で送るか、広告を入れるかどうか）

**それ以外は、調べて判断して実行する。**
**「確認できることを確認せずに人間へ投げる」のは、判断を押し付けているだけである。**

最終更新: 2026-09-08

## 1. #611 の本番反映（`site.conf` の変更）

**PO ができない理由**: **PO が動いている端末に接続先が定義されていない**（2026-09-08 実測）。

```
$ ssh giinops '...'
ssh: Could not resolve hostname giinops: Name or service not known
$ grep -ci '^Host .*giinops' ~/.ssh/config
0
```

**`docs/ops/deploy.md` が既にこれを警告しています**——
「**`giinops` は `ssh config` の alias ではない**（2026-09-06 に 3 往復した）」。
**定義するには VPS の IP が要り、それはリポジトリに書けません。**

**旧記述「deploy 用ユーザーに docker 権限が無い」は誤りでした**——
**`giinops` は下の 2 コマンドだけ NOPASSWD 許可されています**（#333）。
**問題は権限ではなく、接続手段です。**

**手順は `docs/ops/deploy.md` の「設定を変えるとき」3 番にあります**（`Host giinops` の書き方も含む）:

```sh
ssh giinops@<host> 'sudo -n git -C /opt/giinrecord pull \
  && sudo -n docker compose -f /opt/giinrecord/deploy/docker-compose.yml up -d --force-recreate'
```

**なぜ `up -d` だけでは足りないか**: `site.conf` は bind mount した単一ファイルなので、
**`git pull` では inode が変わるだけでコンテナは古いものを掴んだまま**（`docs/ops/deploy.md`）。

**反映後の確認**（3 つとも見ること）:

```sh
curl -sSL https://giinrecord.jp/no-such-page-12345 | grep -c 見つかりません          # 0 → 2
curl -sSL -o /dev/null -w "%{http_code}\n" https://giinrecord.jp/no-such-page-12345  # 404 のまま
curl -sSL -o /dev/null -w "%{http_code}\n" https://giinrecord.jp/compare             # 200 のまま
```

**3 つ目が大事**——`/compare` は SPA fallback を使う**正常な**ページなので、
**そこが壊れていないことまで見て、はじめて成功と言える。**

**いまの本番**（2026-09-08 に PO が実測。まだ未反映）:

```
1) /no-such-page-12345 の「見つかりません」  0 件   ← 反映後は 2
2) status                                  404     ← 正しい（変わってはいけない）
3) /compare                                200     ← 正しい（変わってはいけない）
```

**status 404 は正しい。壊れているのは JS 無しで見たときの画面だけ**（#610）。

## 2. #537 地方議会 7 県の事前照会

**PO ができない理由**: **外部への連絡は取り消せない。** 誰の名前で送るかも PO には決められない。

**下書きは `docs/ops/assembly-inquiry.md` に用意済み**（`{氏名}` `{連絡先}` を埋めるだけ）。
**7 県の URL は 2026-09-07 に全部 200 を確認済み。**

**決めることは 3 つ**: ①送るか ②文面をこれでよいとするか（とくに「既に掲載している」段落）
③誰の名前・連絡先で送るか

**回答が来たら PO に伝えてください。** 記録の追記・実装の着手・取り下げは PO が行える。

**これが決まるまで止まっているもの**: 未実装 5 県（青森・秋田・群馬・大分・沖縄）の ETL 実装。
**調査は 5 県すべて完了済み**（`docs/research/local-assemblies.md`）。

## 3. #543 stash 2 件の drop 可否

**PO ができない理由**: **`git stash drop` が権限設定で止められている**（2026-09-08 に実際に試みて拒否された）。
**「取り消せないから」ではない**——**取り消せないことは、確認せずに人間へ投げる理由にならない**（#629 の教訓）。

**PO は消してよいと判断しています。** 根拠は以下のとおり全部確認済みです。
**人間が `git stash drop` を 2 回打つだけです**（先に `stash@{1}`、次に `stash@{0}`）。

**両方とも当てられません**（2026-09-08 実測。`git stash show -p | git apply --check`）:

```
stash@{0}: apps/web/app/styles/target-size.test.ts:138  patch does not apply
stash@{1}: data/members/index.json:106                  patch does not apply
           data/members/m_001007.json:1302              patch does not apply
```

- `stash@{0}`（#424）— **適用不能。** 中身は main により良い形で入っており、
  **適用すると revert 済みの実装の説明に戻る**
- `stash@{1}`（#24）— **17 ファイル全部が `data/`（生成物）で、適用不能。**
  **members ファイル 16 件すべてが `assemblyId` を持っていません**——
  **地方議会が入る前（#111 以前）の生成物**です。
  **現在 `data/members/` は 307 ファイルあり、そのうち 16 件だけを古い形に戻すことになります。**
  **`data/` は ETL が再生成するものなので、そもそも stash に置く意味がありません。**

**消す前に SHA を控えれば復旧できます**（dangling commit として残る。#411 で実績あり）:

```sh
git rev-parse 'stash@{0}' 'stash@{1}'   # 控えてから
git stash drop 'stash@{1}' && git stash drop 'stash@{0}'
git stash apply <控えた sha>            # 直後なら戻せる
```

**なお 2026-09-08 の調査で、`pending-decisions.md` の旧記述に誤りが 1 つありました**——
「`counts.bills` キーが現在のファイルに無い」と書いていましたが、
**`counts` はどちらにも無く、実際の差は `assemblyId` の有無でした。**

## 4. ~~#629 worktree 73 本の整理~~ → **PO が実行しました（2026-09-08）**

**これは人間待ちにすべきではありませんでした。** **PO の判断ミスです。**
**「取り消せないから」を理由に、確認できることを確認せずに投げていました。**

**84 本 → 3 本にしました**（残りは main・作業中 1 本・#642 の取り込み待ち 1 本）。

**削除可否の正しい判定法**（squash マージでも効く。`origin/main..HEAD` も `git cherry` も効かない）:

```sh
sha=$(gh pr view <PR番号> --json mergeCommit --jq .mergeCommit.oid)
git merge-base --is-ancestor "$sha" origin/main   # → 0 なら安全
```

**判断の基準**（これに当てはまらないものは人間に聞く、ではなく **調べる**）:

| 状態 | 判定 |
|---|---|
| PR が MERGED で、その squash コミットが main の祖先で、作業ツリーが clean | 消してよい |
| **HEAD 自体が main の祖先** | 消してよい（最も強い証明） |
| PR が CLOSED | **代わりにマージされた PR を探す**（#590 は #586 が上位互換だった） |
| PR が無い | **中身を読む**（`gikailog-505` はテストの見本 5 件を持っていたので #642 として残した） |

**詳細は [#629](https://github.com/uonoko1/giinrecord/issues/629) のクローズコメント。**

## 5. #550 / #155 fine-grained PAT の設置

**PO ができない理由**: **PAT の発行は GitHub の設定画面での操作。**

**`GITHUB_TOKEN` では branch protection を読めない。**
`permissions:` に `administration: read` と書くのは**誤り**で、
**GitHub が workflow を構文として拒否し（HTTP 422）、検査ごと動かなくなる。**

**PAT が無い間も守りは効いている**（#547 のコメント参照）:
設定は `enforce_admins=true` / 必須 4 件 / `strict=true` で正しい。

## 6. #53 Sponsors / #48 広告 / #250 NDL 照会

**いずれも人間の作業**（アカウント設定・外部への問い合わせ）。急ぎではない。
