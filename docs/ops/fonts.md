# Web フォントの自サイト配信（第三者送信ゼロ）

Issue #168。Google Fonts は訪問者の IP を Google に送るため、Shippori Mincho（見出し）と BIZ UDPGothic（本文）を
`apps/web/public/fonts/` から配信する。サイトは外部へ一切リクエストしない（CSP: `font-src 'self'`、`style-src` から
`fonts.googleapis.com` を除去、`preconnect` なし）。

## 構成

| もの | 場所 |
|---|---|
| woff2（unicode-range 分割、**372 ファイル**） | `apps/web/public/fonts/<family>-<weight>.<slice>.woff2` |
| **明朝700 の実測サブセット（1 ファイル）** | `apps/web/public/fonts/shippori-mincho-700.subset.woff2`（#477。下の「明朝700 のサブセット」） |
| **サブセットが収録する字の一覧** | `apps/web/public/fonts/shippori-mincho-700.subset.txt`（コミットする。検査が読む） |
| `@font-face` 一覧（`font-display: swap`） | `apps/web/public/fonts/fonts.css`（`root.tsx` が `<link rel=stylesheet href=/fonts/fonts.css>`） |
| ライセンス（SIL OFL 1.1、両ファミリー分） | `apps/web/public/fonts/OFL.txt` |
| 生成スクリプト（122 面の取得） | `apps/web/scripts/fonts.ts`（`pnpm --filter web fonts`、手動実行。ビルドでは動かない） |
| 生成スクリプト（明朝700 のサブセット） | `apps/web/scripts/font-subset.ts`（`pnpm --filter web font-subset`、手動実行。**`pyftsubset` が要る**） |
| 純粋関数（CSS の解析・生成）とテスト | `apps/web/app/lib/self-hosted-fonts.ts` |
| 純粋関数（明朝700 が描く字を集める） | `apps/web/app/lib/head-font-chars.ts`（HTML から）/ `head-font-data-chars.ts`（`data/` から）/ `head-font-data-source.ts`（`data/` の読み取り） |
| 純粋関数（サブセットの `unicode-range`・字一覧） | `apps/web/app/lib/font-subset.ts` |
| **サブセットが `data/` を覆っているかの検査** | `apps/web/app/lib/font-subset-coverage.test.ts`（`pnpm test` で毎回走る） |
| nginx | `deploy/nginx/site.conf`: `/fonts/` は `Cache-Control: public, max-age=604800`（ファイル名にハッシュが無いので immutable にしない） |

## 分割方式

日本語フォントは 1 ウェイト 3〜4MB あるので、Google Fonts と同じ unicode-range 分割（1 ウェイト約 120 スライス＋
latin / latin-ext / cyrillic / greek-ext）を使う。ブラウザはページに現れる文字を含むスライスだけを取りに来る。
スクリプトは Google Fonts の CSS を woff2 対応ブラウザとして取得し、各スライスをそのままダウンロードして
ローカル名に付け替え、`fonts.css` を書き出す。字形・ヒンティング・分割境界は従来と同一なので見た目は変わらない。

`fonts.css` はスライス番号順（同じ unicode-range を持つ 4 面が隣接）に並べ、gzip が効くようにしている
（407KB → 転送 約 41KB）。

> **この並びは意図的なので崩さないこと。** #452 で 122 面を削ったとき、raw は 20% 減った（508→407KB）のに
> **gzip 後は 4% しか減らなかった**（43,843→42,068 B）。削った面は隣と unicode-range が完全に一致していて、
> **gzip が最も効いていた部分**だったため。転送量を語るときは必ず gzip 後（`encodedBodySize`）を見る。

## サイズ（2026-09 生成時）

| ウェイト | スライス数 | 合計 |
|---|---|---|
| Shippori Mincho 700 | 122 | 3.7MB |
| Shippori Mincho 800 | 122 | 3.7MB |
| BIZ UDPGothic 400 | 124 | 2.7MB |
| BIZ UDPGothic 700 | 124 | 2.7MB |
| 合計（リポジトリに含める） | 492 | 12.8MB |

**Shippori Mincho 500 は #452 で外した**（614 面 16.4MB → 492 面 12.8MB）。
サイト上のどこからも要求されていないことを、全 15 ページ ×3 回 + タブ切替・折りたたみ展開で
実測して確認したうえで削除している（`docs/research/font-transfer.md` §5-5）。

> **ウェイトを増減するときは `docs/research/font-transfer.md` §5-5 と §9 を先に読むこと。**
> 要求したウェイトの face が無いと、ブラウザは**一番近い別のウェイトで描く**（CSS Fonts 4 §5.2）。
> 500 を外した今、`--font-head` に `font-weight: 400` を書くと **700 に落ちて字が太くなる**。
> `apps/web/app/styles/font-weight-match.test.ts` が CSS 側でこれを止めている。

1 ページの初回表示で実際に転送される量は、そのページの文字が当たるスライス分だけ。
これは Google Fonts から読み込んでいた従来と同じ量で、Issue の目標（300KB）には届いていない。さらに減らすには
スライスではなく頻度ベースの独自サブセット（pyftsubset）が必要で、別 Issue とする。

> **ここに「トップページは約 420KB が上限」と書いていたのは誤り。** #449 の調査（`docs/research/font-transfer.md` §2）が
> 本番を 3 回測って **`/` は 65 件 931KB、`/members` は 118 件 1,950KB** であることを確認している。
> 低い値が出るのは `response.allHeaders()["content-length"]` を読んだときの取りこぼしで、
> **`.woff2` は `response.body().length` で測ること。** 最新の数字は §2 を見る。

## 明朝700 のサブセット（#477）

**Shippori Mincho 700 だけは unicode-range 分割を使わず、実際に出る字だけの 1 面に置き換えている。**

Google の分割は「1 字のために 66 KB」を実在させる。`/members` を展開すると
**1 字しか使わないスライスが 20 件・1,033 KB** で、明朝700 の転送量のほぼ半分だった
（#468 の実測、`docs/research/font-subset-member-names.md` §2）。粒度を動かしても総量は減らないので、
**効くのは収録字数そのものを減らすことだけ**である。

**書体もウェイトも変えていない**（#453 の判断に触らない）。**800 は差し替えていない。**
議員ページの大きな氏名 `.member-name` は **800** なので、**そのぶんは減らない**
（一覧の氏名 `.members-item__name` と `.assembly-member__name` は 700 で、そちらが減る）。

### 収録する字は「HTML 全ページ ∪ `data/` の該当欄」

**片方だけでは必ず足りない。実測（2026-09-05、1,466 ページ / 1,057 名）:**

| 集め方 | 字数 | 氏名に欠けの出る議員 |
|---|---:|---:|
| ビルド済み HTML だけ | 644 | **204 / 1,057** |
| `data/` だけ | 877 | 0 / 1,057 |
| **和集合（採用）** | **943** | **0 / 1,057** |

- **HTML だけでは足りない**: `/members` は 200 件で折りたたまれ（#340）、議員ページのタブも折りたたまれるので、
  **HTML には 229 名ぶんしか入らない**。会議録の役職 `.member-position` は #242 により
  **HTML に一切焼き込まれない**（実測 137 字、うち 68 字は氏名・会派・選挙区のどれにも出てこない）。
- **`data/` だけでも足りない**: `.tag` の「事実」「推定」など**静的な語が 66 字**あり、`data/` には無い。
  これを落とすと `/` `/coverage` `/assemblies` がシステムフォントに落ちる（#468 の失敗1）。

### 足りなくなったときにどうなるか

**名前は消えない。書体がシステムの明朝に落ちるだけ**（#468 §4-1 の実測。箱の幅も変わらない）。
「記録が出ない」ではないので許容している。**許容していないのは「気づけないこと」**で、
転送量も箱も変わらないため、**検査が無ければ誰も気づかない**。

`apps/web/app/lib/font-subset-coverage.test.ts` が `pnpm test` で毎回、
**いまの `data/` に出る字が 1 字残らずサブセットに入っているか**を検査する。
新しい議員が入って字が増えたら**ここで落ちる**。落ちたら下の手順で作り直す。

> **この検査が見るのは `data/` 側だけ**である。静的な語が増える経路はビルドが要るので見ていない。
> **実態より強い主張をしないこと。**

### `pyftsubset` を使う（`text=` は使わない）

Google Fonts の `text=` は **URL 引数が約 7.2 KB を超えると、エラーにならず 122 スライスの CSS を返す**
（#468 の実測: 800 字は通り **810 字で戻る**）。**静かに全量に戻るのが最悪**で、しかも対象は既に上限超え。
**回避策ありきの道具は選ばない。**

`pyftsubset` はローカルで完結し、上限も分割制約もない。**生成物はコミットする**ので、
**CI もリリースも外部サービスにも `pyftsubset` にも依存しない**（fork した人のビルドに Google アクセスは要らない）。

**手元にだけ入れる:**

```
python3 -m venv .venv && .venv/bin/pip install 'fonttools[woff]'
```

字形は上流の TTF（`raw.githubusercontent.com` の `ShipporiMincho-Bold.ttf`）から作る。
**Google が配るスライスと同じ v3.110 で、字形・送り幅・OS/2・hhea が完全一致することを実測で確認済み**
（`fpgm`/`prep`/`cvt` は上流にも無い。ttfautohint の指示は `glyf` に入っている）。

## 更新手順

**A. 122 面を取り直す（Google のフォントが更新されたとき）**

1. `pnpm --filter web fonts`（`fonts.googleapis.com` / `fonts.gstatic.com` / `raw.githubusercontent.com` 以外には接続しない）
2. 出力されたサイズを上の表に反映し、`public/fonts/` の差分をコミットする
3. **B に進む**（`fonts.ts` は明朝700 の 122 面を書き戻すので、サブセットを作り直さないと元に戻ってしまう）

**B. 明朝700 のサブセットを作り直す（`font-subset-coverage.test.ts` が落ちたとき、または A のあと）**

1. `pnpm --filter web build` — **先にビルドする**（HTML 全ページから静的な語を集めるため）
2. `PYFTSUBSET=.venv/bin/pyftsubset pnpm --filter web font-subset`
   （1,466 ページの走査に数十分かかる。`public/fonts/` の woff2・字一覧・`fonts.css` を書き換える）
3. `pnpm --filter web test` — 覆えているか、消し忘れが無いかを検査する
4. `public/fonts/` と `fonts.css` の差分をコミットする

**C. どちらの場合も最後に**

`pnpm build && pnpm --filter web smoke` — smoke が全 HTML と `fonts/fonts.css` に外部 URL が無いこと、
`fonts.css` が参照する woff2 がすべてビルドに含まれることを確認する（URL モードでは配信中の HTML も検査）

> **再生成は冪等である。** 同じ `data/` と同じビルドからは同じ woff2・同じ字一覧が出る
> （字はコードポイント順に並べて書くので、集める順序が変わっても本文は変わらない）。
> md5 で確かめられる。
