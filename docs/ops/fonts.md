# Web フォントの自サイト配信（第三者送信ゼロ）

Issue #168。Google Fonts は訪問者の IP を Google に送るため、Shippori Mincho（見出し）と BIZ UDPGothic（本文）を
`apps/web/public/fonts/` から配信する。サイトは外部へ一切リクエストしない（CSP: `font-src 'self'`、`style-src` から
`fonts.googleapis.com` を除去、`preconnect` なし）。

## 構成

| もの | 場所 |
|---|---|
| woff2（unicode-range 分割、614 ファイル） | `apps/web/public/fonts/<family>-<weight>.<slice>.woff2` |
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

`fonts.css` はスライス番号順（同じ unicode-range を持つ 5 面が隣接）に並べ、gzip が効くようにしている
（508KB → 転送 約 44KB）。

## サイズ（2026-08 生成時）

| ウェイト | スライス数 | 合計 |
|---|---|---|
| Shippori Mincho 500 | 122 | 3.7MB |
| Shippori Mincho 700 | 122 | 3.7MB |
| Shippori Mincho 800 | 122 | 3.7MB |
| BIZ UDPGothic 400 | 124 | 2.8MB |
| BIZ UDPGothic 700 | 124 | 2.8MB |
| 合計（リポジトリに含める） | 614 | 16.4MB |

1 ページの初回表示で実際に転送される量は、そのページの文字が当たるスライス分だけ。トップページの文字集合で
本文ウェイト 1 面あたり 30 スライス・約 420KB が上限（太字・見出しは現れる文字が少ないので数スライス）。
これは Google Fonts から読み込んでいた従来と同じ量で、Issue の目標（300KB）には届いていない。さらに減らすには
スライスではなく頻度ベースの独自サブセット（pyftsubset）が必要で、別 Issue とする。

## 更新手順

1. `pnpm --filter web fonts`（`fonts.googleapis.com` / `fonts.gstatic.com` / `raw.githubusercontent.com` 以外には接続しない）
2. 出力されたサイズを上の表に反映し、`public/fonts/` の差分をコミットする
3. `pnpm build && pnpm --filter web smoke` — smoke が全 HTML と `fonts/fonts.css` に外部 URL が無いこと、
   `fonts.css` が参照する woff2 がすべてビルドに含まれることを確認する（URL モードでは配信中の HTML も検査）
