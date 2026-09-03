# 散文の中のリンクと WCAG 2.5.8（Target Size (Minimum)）

Issue #425（#413 の第4段階）の判断の記録。
**次に測る人が同じ判断を繰り返さないために残している。**

結論を先に書く: **対象の 46 箇所は 1 箇所も直していない。全部が例外に当たる。**

---

## 1. 判断の基準（Understanding 文書から）

[Understanding SC 2.5.8: Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
には**5つの例外**がある。このうち今回関係するのは 2 つ。

### Inline 例外（原文）

> The success criterion does not apply to inline targets in sentences, or where the size of
> the target is constrained by the line-height of non-target text.

**「文の中にある」か「非対象テキストの行の高さに大きさが制約されている」なら対象外**、という
**2つの条件の or** である。片方だけで足りる。

Understanding 文書はこう説明している:

> text reflow based on viewport size makes it impossible for authors to anticipate where links
> may be positioned relative to one another. It is more important to set the line height to a
> value that improves readability.

> Links within paragraphs of text do not need to meet the 24 by 24 CSS pixels requirements,
> so the success criterion passes.

つまり **「読みやすい行の高さのほうが優先」** と明言されている。
散文のリンクに padding を足して行間を崩すのは、この達成基準が求めていることの**逆**である。

### Spacing 例外（原文）

> Undersized targets (those less than 24 by 24 CSS pixels) are positioned so that if a 24 CSS
> pixel diameter circle is centered on the bounding box of each, the circles do not intersect
> another target or the circle for another undersized target.

**24px 直径の円を各ターゲットの中心に置いて、円同士が重ならなければ合格。**
言い換えると **隣のターゲットの中心までの距離が 24px 以上あればよい。**
これは大きさではなく**間隔**の話なので、**行間を一切変えずに満たせる**。

> ### 「小さい = 違反」ではない
> 2.5.8 は「24×24 未満を全部大きくしろ」ではない。
> **小さくても、隣と十分離れていれば合格する**（Spacing 例外）。
> 押し間違いが起きるのは「小さい」からではなく「小さくて**密集している**」からである。
> #413 が数えた 110 箇所は「24×24 未満の数」であって、**違反の数ではない**。

---

## 2. 測り方

`pnpm build` した成果物を静的に配信し、Playwright の Chromium を **390px 幅**で開いて、
`a[href]` の `getBoundingClientRect()` を読んだ。判定に使った値は 3 つ。

1. **大きさ** — 24×24 CSS px 未満か
2. **同じ行に非対象テキストがあるか** — リンクの行ボックスと、同じブロック内の
   テキストノードの矩形が**縦に半分以上重なる**かで判定した（`Range.getClientRects()`）。
   親クラス名では判定していない。**実際に描画された行を見ている。**
3. **最も近いターゲットの中心までの距離** — Spacing 例外の判定

### 測るときの落とし穴（実際に踏んだ）

- **`vite preview` は使えない。** `/coverage` と `/rollcalls` は SPA フォールバックが返り、
  `Application Error: No result found for routeId` になって**リンクが 0 個**になる。
  `build/client` を静的に配信すること（`index.html` の解決と `.data` を返す必要がある）。
- **フォント読み込みを待たないと数が変わる。** `document.fonts.ready` だけでは足りず、
  待たずに測った回は `/coverage` の議会名 `h3` 7 箇所を「13px で違反」と誤って数えた。
  **実際は 25px で最初から合格している。** 追加で 1.5 秒待つと 3 回とも同じ数になった。
  #413 の「本文中 31」も、この誤差を含んだ数字である可能性が高い。

再現に使ったスクリプトはこの PR には入れていない（一時ファイル）。
上の 3 つの値さえ取れば同じ判断ができる。

---

## 3. 対象 46 箇所の分類表

#413 が「散文の中のリンク 41 箇所」としていた範囲を測り直した結果は **46 箇所**。
（`.card__body` 6 / `.note` 4 / 親要素なし 36。`.links` `.row` `.rollcalls-item` `.list__item`
は #423 #424 の担当なので除いている。）

「間隔」= 最も近いターゲットの中心までの距離。**24 以上なら Spacing 例外に当たる。**

| ページ | 要素 | 件数 | 大きさ | 間隔 | 文の中か | リンクのテキスト | 判断 |
|---|---|---:|---|---:|---|---|---|
| `/` | `section.section` | 1 | 350×13 | 75 | 行内に単独 | 第221回国会の採決 120件すべて | 例外（Spacing） |
| `/about` | `p.note` | 1 | 48×12 | 92 | 文の中 | 収録範囲 | 例外（Inline + Spacing） |
| `/about` | `p.note` | 1 | 273×12 | 92 | 文の中 | 収録範囲「衆議院の記録が…」 | 例外（Inline + Spacing） |
| `/about` | `p.note` | 1 | 48×12 | 126 | 文の中 | 利用規約 | 例外（Inline + Spacing） |
| `/assemblies` | `th` | 7 | 26×13 | 82〜233 | 行内に単独 | 宮城・三重・奈良・鳥取・島根・徳島・高知 | 例外（Spacing） |
| `/assemblies/pref-31` | `dd` | 1 | 86×13 | 158 | 文の中 | 確認したページ | 例外（Inline + Spacing） |
| `/assemblies/pref-31` | `p.note` | 1 | 84×12 | 118 | 行内に単独 | 議員名簿（公式） | 例外（Spacing） |
| `/assemblies/pref-31` | `td` | 2 | 92×13 | 52 | 行内に単独 | 表決結果（公式） | 例外（Spacing） |
| `/compare` | `p.compare-cover-top` | 1 | 83×12 | 218 | 行内に単独 | ← 議員レコード | 例外（Spacing） |
| `/compare` | `p.compare-empty` | 1 | 70×14 | 184 | 文の中 | 議員一覧へ | 例外（Inline + Spacing） |
| `/coverage` | `th` | 2 | 39×13 | 206 | 行内に単独 | 参議院・衆議院 | 例外（Spacing） |
| `/coverage` | `dd` | 7 | 92×13 | 111 | 行内に単独 | 議員名簿（公式） | 例外（Spacing） |
| `/coverage` | `td` | 10 | 92×13 | 52 | 行内に単独 | 表決結果（公式） | 例外（Spacing） |
| `/coverage` | `p.card__body` | 1 | 207×13 | 174 | 文の中 | 国会会議録検索システム 検索用API | 例外（Inline + Spacing） |
| `/coverage` | `p.card__body` | 1 | 64×13 | 382 | 文の中 | 検索用API | 例外（Inline + Spacing） |
| `/coverage` | `p.card__body` | 1 | 85×13 | 280 | 文の中 | Issue #230 | 例外（Inline + Spacing） |
| `/coverage` | `p.card__body` | 1 | 85×13 | 280 | 文の中 | Issue #274 | 例外（Inline + Spacing） |
| `/coverage` | `p.card__body` | 1 | 52×13 | 457 | 文の中 | 議員一覧 | 例外（Inline + Spacing） |
| `/coverage` | `p.card__body` | 1 | 311×13 | 442 | 文の中 | docs/research/shugiin-tenure-sessions.md | 例外（Inline + Spacing） |
| `/privacy` | `p.body` | 1 | 101×13 | 155 | 文の中 | GitHub Issues | 例外（Inline + Spacing） |
| `/rollcalls` | `div.rollcall-cover-top` | 1 | 83×12 | 108 | 行内に単独 | ← 議員レコード | 例外（Spacing） |
| `/terms` | `li` | 1 | 71×13 | 114 | 文の中 | CC BY 4.0 | 例外（Inline + Spacing） |
| `/terms` | `li` | 1 | 124×13 | 114 | 文の中 | GitHub のリポジトリ | 例外（Inline + Spacing） |

**合計 46 箇所。直したものは 0 件。**

- **文の中: 14 箇所** — Inline 例外に当たる。同じ行に非対象テキストがあることを実測した
  （例: 「入っている議会・回次・会期と件数は〈収録範囲〉にあります。」）。
  padding を足すと行間が崩れるので**触らない**。
- **行内に単独: 32 箇所** — 表のセル・`dd` の値・表紙の注記など、
  行に他の文字が無いので **Inline 例外の前半（in sentences）には当たらない**。
  ただし **32 箇所すべてが Spacing 例外を満たす**（最小 52px）。

### 間隔の最小値

対象 46 箇所の**最も近いターゲットまでの距離は、最小で 52px**（`/coverage` と
`/assemblies/pref-31` の表の「表決結果（公式）」が縦に並ぶところ）。**最大 457px。**
必要な 24px に対して**最小でも 2 倍以上の余裕**がある。**1 箇所も 24px を下回らない。**

---

## 4. なぜ「行内に単独」の 32 箇所も直さないのか

ここが判断の分かれ目なので理由を書く。

「表のセルにリンクだけが入っている」ものは、見た目には独立した操作要素に見える。
前任の作業（このブランチの `f0c842af`、revert 済み）は**そう見えることを理由に**
`padding-block: 6px; margin-block: -6px` を足して 24px にしようとしていた。

**これは不要である。** 2.5.8 は「独立した操作要素は 24px でなければならない」とは書いていない。
**Spacing 例外を満たせばそれで合格**であり、**この 32 箇所は最小 52px で満たしている。**

不要な変更を入れないほうがよい理由:

- `padding` を負の `margin` で相殺する手は、**当たり判定と見た目がずれる**。
  隣の行の文字の上に不可視の当たり判定が 6px かぶさるので、
  「文字を押したのに上の行のリンクが開く」が起きうる。**今より悪くなる方向。**
- 表のセルは**行の高さがそのまま表の詰まり具合**なので、あとで
  `overflow` や `vertical-align` の指定と噛み合わなくなる。
- 達成基準を満たすためではなく「数字を 24 にするため」の変更は、
  次に触る人に「これは必要な指定だ」と誤解させる。

**「24×24 未満だから直す」ではなく「例外に当たらないから直す」で判断すること。**

---

## 5. この判断が変わる条件

次のどれかが起きたら測り直すこと。

- **表の行間を詰めた**とき。`/coverage` `/assemblies/pref-31` の「表決結果（公式）」は
  縦の間隔が **52px** で、ここが**一番余裕が無い**。行の padding を今より 14px 以上詰めると
  24px を割って Spacing 例外を外れる。
- **散文の中にリンクを 2 つ隣り合わせで置いた**とき（「〈A〉・〈B〉」のような並べ方）。
  横に密に並ぶと円が重なる。#413 が問題にした `.row` `.links` がまさにこれ。
- **フォントサイズを小さくした**とき。行の高さが縮むと縦の間隔も縮む。

## 6. 対象外にしたもの

- `.links` 14 箇所 → **#423**
- `.row` 27 / `.rollcalls-item` 13 / `.list__item` 9 = 49 箇所 → **#424**
- `input`（議員一覧のチェックボックス等）28 箇所 → #413 の第1段階で対応済みの範囲
- `/coverage` の議会名 `h3` 7 箇所 → **25px で最初から合格**。
  フォント読み込みを待たずに測ると 13px に見えるだけ（上の「落とし穴」を参照）。
