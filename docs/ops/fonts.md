# Web フォントの自サイト配信（第三者送信ゼロ）

Issue #168。Google Fonts は訪問者の IP を Google に送るため、Shippori Mincho（見出し）と BIZ UDPGothic（本文）を
`apps/web/public/fonts/` から配信する。サイトは外部へ一切リクエストしない（CSP: `font-src 'self'`、`style-src` から
`fonts.googleapis.com` を除去、`preconnect` なし）。

## 構成

| もの | 場所 |
|---|---|
| woff2（unicode-range 分割、492 ファイル） | `apps/web/public/fonts/<family>-<weight>.<slice>.woff2` |
| `@font-face` 一覧（`font-display: swap`） | `apps/web/public/fonts/fonts.css`（`root.tsx` が `<link rel=stylesheet href=/fonts/fonts.css>`） |
| ライセンス（SIL OFL 1.1、両ファミリー分） | `apps/web/public/fonts/OFL.txt` |
| 生成スクリプト | `apps/web/scripts/fonts.ts`（`pnpm --filter web fonts`、手動実行。ビルドでは動かない） |
| 純粋関数（CSS の解析・生成）とテスト | `apps/web/app/lib/self-hosted-fonts.ts` |
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

## 更新手順

1. `pnpm --filter web fonts`（`fonts.googleapis.com` / `fonts.gstatic.com` / `raw.githubusercontent.com` 以外には接続しない）
2. 出力されたサイズを上の表に反映し、`public/fonts/` の差分をコミットする
3. `pnpm build && pnpm --filter web smoke` — smoke が全 HTML と `fonts/fonts.css` に外部 URL が無いこと、
   `fonts.css` が参照する woff2 がすべてビルドに含まれることを確認する（URL モードでは配信中の HTML も検査）
