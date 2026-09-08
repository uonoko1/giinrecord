# 人間の判断・操作を待っていること

**PO（Claude）が進められない作業の一覧。** セッションをまたいで残るように、ここに集める。
**「なぜ PO ができないか」を必ず書く**——できるのにやっていないなら、それは PO の怠慢である。

最終更新: 2026-09-08

## 1. #611 の本番反映（`site.conf` の変更）

**PO ができない理由**: **deploy 用ユーザーに docker 権限が無い**（設計上そうしてある）。
`site.conf` は bind mount した単一ファイルで、**`git pull` では inode が変わるだけで
コンテナは古いものを掴んだまま**（`docs/ops/deploy.md`）。

```sh
ssh giinops 'sudo -n git -C /opt/giinrecord pull \
  && sudo -n docker compose -f /opt/giinrecord/deploy/docker-compose.yml up -d --force-recreate'
```

**反映後の確認**（3 つとも見ること）:

```sh
curl -sSL https://giinrecord.jp/no-such-page-12345 | grep -c 見つかりません          # 0 → 2
curl -sSL -o /dev/null -w "%{http_code}\n" https://giinrecord.jp/no-such-page-12345  # 404 のまま
curl -sSL -o /dev/null -w "%{http_code}\n" https://giinrecord.jp/compare             # 200 のまま
```

**3 つ目が大事**——`/compare` は SPA fallback を使う**正常な**ページなので、
**そこが壊れていないことまで見て、はじめて成功と言える。**

**いまの本番**: status 404 は正しい。**壊れているのは JS 無しで見たときの画面だけ**（#610）。

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

**PO ができない理由**: **`git stash drop` は取り消せない。**

**中身は確認済みで、どちらも現在の main では意味を失っている**（[#543 のコメント](https://github.com/uonoko1/giinrecord/issues/543)）:

- `stash@{0}`（#424）— **当てられない**（`git apply --check` が失敗）。
  中身は main により良い形で入っており、**適用すると revert 済みの実装の説明に戻る**
- `stash@{1}`（#24）— **18 ファイル全部が `data/`（生成物）**。
  **データの形が変わっており**（`counts.bills` キーが現在のファイルに無い）、適用すれば壊す

**drop 直後なら `git stash apply <sha>` で復旧できる**（dangling commit として残る。#411 で実績あり）。

## 4. #629 worktree 73 本の整理

**PO ができない理由**: **`git worktree remove` は取り消せない。**
**枝は remote に無い**（マージ時に削除済み）ので、**消すと復元できない。**

**70 本は PR が MERGED**、**PR 無しの 3 本も中身は main にある**ことを確認済み。
**容量は一部だけ測って 12 GB。**

## 5. #550 / #155 fine-grained PAT の設置

**PO ができない理由**: **PAT の発行は GitHub の設定画面での操作。**

**`GITHUB_TOKEN` では branch protection を読めない。**
`permissions:` に `administration: read` と書くのは**誤り**で、
**GitHub が workflow を構文として拒否し（HTTP 422）、検査ごと動かなくなる。**

**PAT が無い間も守りは効いている**（#547 のコメント参照）:
設定は `enforce_admins=true` / 必須 4 件 / `strict=true` で正しい。

## 6. #53 Sponsors / #48 広告 / #250 NDL 照会

**いずれも人間の作業**（アカウント設定・外部への問い合わせ）。急ぎではない。
