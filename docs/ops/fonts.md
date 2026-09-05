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
| **Shippori Mincho 700（サブセット）** | **1** | **186.5KB**（943 字。#477） |
| Shippori Mincho 800 | 122 | 3.7MB |
| BIZ UDPGothic 400 | 124 | 2.7MB |
| BIZ UDPGothic 700 | 124 | 2.7MB |
| 合計（リポジトリに含める） | **371** | **11MB** |

**Shippori Mincho 700 は #477 で 122 面 3.7MB → 1 面 186.5KB にした**（下の「明朝700 のサブセット」）。
**800 は据え置き**なので、議員ページの大きな氏名（`.member-name` は 800）のぶんは減らない。

**Shippori Mincho 500 は #452 で外した**（614 面 16.4MB → 492 面 12.8MB）。
サイト上のどこからも要求されていないことを、全 15 ページ ×3 回 + タブ切替・折りたたみ展開で
実測して確認したうえで削除している（`docs/research/font-transfer.md` §5-5）。

> **ウェイトを増減するときは `docs/research/font-transfer.md` §5-5 と §9 を先に読むこと。**
> 要求したウェイトの face が無いと、ブラウザは**一番近い別のウェイトで描く**（CSS Fonts 4 §5.2）。
> 500 を外した今、`--font-head` に `font-weight: 400` を書くと **700 に落ちて字が太くなる**。
> `apps/web/app/styles/font-weight-match.test.ts` が CSS 側でこれを止めている。

1 ページの初回表示で実際に転送される量は、そのページの文字が当たるスライス分だけ。
**明朝700 だけは分割をやめて 1 面にした**（#477。下の「明朝700 のサブセット」）ので、
明朝700 はページによらず 1 面 186.5KB を引く。**残り 3 ウェイトは従来どおりの分割**である。

> **`--font-body`（BIZ UDPGothic）は手つかず。** `/rollcalls` の 888KB は本文家族の議案名で、
> 明朝700 のサブセットは**この数字に一切効かない**（実測 ±0）。減らすなら別 Issue になる
> （`docs/research/font-transfer.md` §5-2 の案 A）。

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

### 実測（2026-09-06、13 ページ × 3 回 × 2 ビルド、全 26 回とも 3 回一致・フォールバック 0）

390px・ページごとに新しいコンテキスト・`getPlatformFontsForNode` のフォールバックが 0 になるまで待ってから記録。

| ページ | 現状 | サブセット | 差 |
|---|---:|---:|---:|
| **`/members` 展開後** | 3,017.0 KB | **1,047.0 KB** | **−1,970.0** |
| `/members` 初期 | 1,950.1 KB | 1,047.0 KB | **−903.1** |
| `/assemblies/pref-04` | 1,333.6 KB | 755.3 KB | −578.3 |
| `/coverage` | 1,153.7 KB | 1,104.4 KB | −49.3 |
| `/assemblies` | 1,173.9 KB | 1,157.0 KB | −16.9 |
| `/rollcalls` | 887.9 KB | 887.9 KB | **±0**（明朝700 を使わない） |
| `/rollcalls/217`（一覧） | 1,084.4 KB | 1,084.4 KB | **±0**（同上） |
| `/rollcalls/221/221-0323-v001`（採決**詳細**） | 1,471.8 KB | 1,347.5 KB | −124.3 |
| `/members/m_003005` | 970.0 KB | 1,083.4 KB | +113.4 |
| `/members/m_014002` | 968.8 KB | 1,056.3 KB | +87.5 |
| **`/`** | 930.6 KB | 1,003.5 KB | **+72.9** |
| `/about` | 822.4 KB | 888.1 KB | +65.7 |
| `/privacy` | 553.3 KB | 592.1 KB | +38.8 |
| `/terms` | 579.0 KB | 604.1 KB | +25.1 |

**増えたページ 6 / 減ったページ 6 / 変わらない 2。増加 +403.4 KB に対し減少 −3,641.9 KB で、差引 −3,238.5 KB。**

> **`/rollcalls/:session?` は一覧ルート**なので、`/rollcalls` も `/rollcalls/217` も**同じ種別**である。
> **採決詳細 `/rollcalls/:session/:id` は別種別**で、当初これを 1 ページも測っていなかった（#520 のレビュー指摘）。
> 測ると **−124.3 KB で減る側**だった（明朝700 を 69 字使い、現状 310.9 KB を引いているため）。

**この表は `apps/web/scripts/font-transfer-bench.mjs` で出したもので、手元で再現できる**:

```
pnpm --filter web build
node apps/web/scripts/font-transfer-bench.mjs <buildDir> <ラベル> > out.json
```

差し替え前・後の 2 ビルドをそれぞれ測って突き合わせる。**2 本同時に走らせない**
（並行実行は CPU の取り合いと出力の混ざりで測定を壊す。スクリプトは lock で **exit 3** して拒否する）。

**明朝700 は、使うページなら必ず 1 面 186.5 KB を引く**（現状は 5〜83 面で 63〜2,157 KB と振れる）。
だから **たくさん使うページほど減り、少ししか使わないページは増える**。
`/rollcalls` のように**明朝700 を 1 文字も使わないページは 1 バイトも変わらない**（全ページに課すわけではない）。

**「さらに表示」を押しても増えない**（`/members` は展開前後とも 1,047.0 KB）。
現状は押した瞬間に +1,067 KB 増えるので、**997 名を展開する利用者にこの案がいちばん効く。**

> **議員ページの大きな氏名は減らない。** `.member-name` は**明朝 800**で、この置き換えの対象外
> （#453 の判断に従い 800 は分割のまま）。議員ページが増える側なのはそのためで、
> 明朝700 を 5〜7 字しか使わないのに 186.5 KB を引くことになる。

### 足りなくなったときにどうなるか

**名前は消えない。書体がシステムの明朝に落ちるだけ**（#468 §4-1 の実測。箱の幅も変わらない）。
「記録が出ない」ではないので許容している。**許容していないのは「気づけないこと」**で、
転送量も箱も変わらないため、**検査が無ければ誰も気づかない**。

`apps/web/app/lib/font-subset-coverage.test.ts` が `pnpm test` で毎回、
**いまの `data/` に出る字が 1 字残らずサブセットに入っているか**を検査する。
新しい議員が入って字が増えたら**ここで落ちる**。落ちたら下の手順で作り直す。

> **この検査が見るのは `data/` 側だけ**である。
> **静的な語（`.tag` の「事実」、`/terms` の見出しなど）が増える経路は、何も守っていない。**
> ソースに新しい語を書いても `pnpm test` は緑のままで（実測: `terms.tsx` の「準拠法と変更」を
> 「準據法と變更」に変えて **1,164 件すべて緑**）、**サブセットを作り直すまで本番で静かに
> システム書体になる**。「`font-subset.ts` の再実行が守る」とは書けない——
> **再実行を忘れたら何も守らない**、が正確である。
> **`--font-head` + 700 の要素に新しい語を書いたら、B の手順でサブセットを作り直すこと。**

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
