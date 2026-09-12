# 人間の判断・操作を待っていること

**PO（Claude）が進められない作業の一覧。** セッションをまたいで残るように、ここに集める。
**「なぜ PO ができないか」を必ず書く**——できるのにやっていないなら、それは PO の怠慢である。

**「取り消せないから」は、ここに書く理由にならない**（2026-09-08、#629 で実際に間違えた）。
**取り消せないなら、取り消す必要が出ないところまで確認してから実行する。**
**ここに書いてよいのは 3 つだけ:**

1. **PO に権限が無い**（サーバーの docker、GitHub の設定画面、権限設定で止められた操作）
   - **Release（`release.yml`）はここに入りません。** **PO ができます**（2026-09-08 に実行済み）。
     **承認（required reviewers）は 3 つの environment とも置いていません**
     （`gh api repos/uonoko1/giinrecord/environments` で `protection_rules` が 3 つとも `[]`）。
     **CI が緑の main を本番に出すのは通常運用なので、PO が判断して実行します:**
     ```sh
     git fetch origin && gh workflow run release.yml --ref main -f ref=$(git rev-parse origin/main)
     ```
     **#659 で文書側を実態に合わせました**（`deploy.md` / `README.md` / `deploy/README.md` /
     `etl.md` / 3 つの workflow が「承認待ちになる」と書いていたのを直した）。
     **reviewers を置く判断をしたなら、それは GitHub の設定画面での操作なので、
     ここに新しい項目として足すこと。**
2. **外部に届いてしまう**（事務局への照会、Sponsors の公開）——取り消せないうえに相手がいる
3. **確認しても答えが出ない**（誰の名前で送るか、広告を入れるかどうか）

**それ以外は、調べて判断して実行する。**
**「確認できることを確認せずに人間へ投げる」のは、判断を押し付けているだけである。**

最終更新: 2026-09-08

## 1. #611 の本番反映（`site.conf` の変更）— **#610 / #654**

**Release（コード側）は 2026-09-08 に PO が済ませました。残っているのは `site.conf` だけです。**

```
released: 567c09df（2026-09-06） → 044f42af（2026-09-08、69 コミット分）
```

**PR #611 は 2 つを同時に変えており、片方だけが反映された中間状態です:**

| 変更 | 反映のしかた | 状態 |
|---|---|---|
| web のコード（`/__not-found` のプリレンダー） | **Release**（PO ができる） | **済** |
| **`deploy/nginx/site.conf`** | **ssh でコンテナ再作成** | **未** |

**中間状態のあいだ、`/__not-found/index.html` が 200 で直接開けます**（#654）——
**`internal` がまだ効いていないためで、`site.conf` の反映で同時に解消します。**

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

**反映後の確認**（4 つとも見ること）:

```sh
curl -sSL https://giinrecord.jp/no-such-page-12345 | grep -c ページが見つかりません        # 0 → 1 以上
curl -sSL -o /dev/null -w "%{http_code}\n" https://giinrecord.jp/no-such-page-12345        # 404 のまま
curl -sSL -o /dev/null -w "%{http_code}\n" https://giinrecord.jp/compare                   # 200 のまま
curl -sSL -o /dev/null -w "%{http_code}\n" https://giinrecord.jp/__not-found/index.html    # 200 → 404
```

**3 つ目が大事**——`/compare` は SPA fallback を使う**正常な**ページなので、
**そこが壊れていないことまで見て、はじめて成功と言える。**
**4 つ目は #654 の分**——`internal` が効けば直接は開けなくなる。

**`curl` の 4 項目より強い確認があります**（`browser-check.ts` の docblock が PO 宛に書いていたもの）:

```sh
pnpm --filter web browser-check -- --url https://giinrecord.jp
# exit 0 になれば #610 と #654 の両方が解消している
```

**実際に headless Chromium で JS を切って開き、本文とリンクを見ます。**
**2026-09-08（Release 後・`site.conf` 未反映）に PO が実行したときは、次の 2 件だけが失敗しました:**

```
- no-js: 404 ページ: JS 無効で本文に「ページが見つかりません」が出ていない（本文 16 文字）
- no-js: 404 ページ: JS 無効で /coverage への内部リンクが無い（内部リンク 1 本）
```

**2 回走らせて、両方に出るものだけを見ること**——
**1 回目は `ERR_NETWORK_CHANGED` が 20 件出ましたが、2 回目は 0 件でした**
（PO の実行環境の一時的なネットワーク変動で、本番の欠陥ではありません）。

**いまの本番**（2026-09-08、Release 後に PO が実測）:

```
1) /no-such-page-12345 の本文              「読み込んでいます」のまま   ← 反映後は「ページが見つかりません」
2) status                                  404     ← 正しい（変わってはいけない）
3) /compare                                200     ← 正しい（変わってはいけない）
4) /__not-found/index.html                 200     ← #654。反映後は 404
主要 9 ページ（/ /members /rollcalls /assemblies /coverage /about /terms /privacy /compare）すべて 200
```

**status 404 は正しい。壊れているのは JS 無しで見たときの画面だけ**（#610）。

## 2. ~~#537 地方議会 7 県の事前照会~~ — **2026-09-13 に決まった（照会はしない）**

**人間の判断で「案 3: データの性質で切り分ける」を採った。**
**事務局への事前照会はしない。** **この項目は人間待ちではなくなった。**

**根拠は `docs/DATA_CONTRACT.md` の「一次資料の取得と再公開（#537）」:**

- **採決の賛否は著作物ではない**（著作権法 2 条 1 項 1 号の「思想又は感情を創作的に表現したもの」に当たらない）
- **公開しているのは抽出した事実だけで、PDF の表現を再現していない**
- **取得も 30 条の 4（情報解析。表現の享受を目的としない利用）で適法**
- **実測でも禁止されていない**（robots.txt 18 件で賛否ページの `Disallow` 0 件、利用規約 4 件に禁止文言なし）

**取得の作法は緩めない**（`robots.txt` を読む・1 秒以上空ける・UA を名乗る・直列）。
**新しい議会を足すときのチェックリストを `DATA_CONTRACT.md` に置いた。**

**下書き `docs/ops/assembly-inquiry.md` は残す**——**送らないという判断であって、
「送ってはいけない」ではない。** 事務局から問い合わせが来た場合や、
**賛否以外（議事録の本文など）に手を広げるとき**は、この整理の範囲外なので改めて評価する。

**これで未実装 9 県の ETL が解禁された**（青森・秋田・群馬・大分・沖縄・熊本・山梨・滋賀・佐賀）。

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
