# WCAG 2.5.8（Target Size (Minimum)）— #413 の4段階の索引

Issue #439。#413「押せる範囲が 24×24 px に満たない箇所が110ある」は4段階に分かれ、
判断の記録が 2 ファイルに分かれた。**どこに何があるかを引く**ためのページ。

**2 つの記録は統合していない。** 役割が違う（基準の引用は `inline`、49箇所の実測は `rows`）。
測り方の落とし穴も**それぞれ別の失敗**なので、まとめると片方が薄まる（#430 の担当者の判断）。

---

## 結論（先に）

> **「24×24 未満の数」は「違反の数」ではない。**
>
> #413 は「110箇所」として起票されたが、WCAG 2.5.8 には **Spacing 例外**がある——
> **小さくても隣と 24px 以上離れていれば合格する**。
> 適用して実測した結果、**違反は 0 件**だった。

**起票そのものが誤っていた。** 数えたのは「24×24 CSS px より小さい要素の数」であって、
達成基準を満たすかどうかは**数えた時点では判定されていなかった**。
PO（起票者）が Understanding 文書の例外を読まずに数えた、というのがこの記録の主題である。

Spacing 例外の原文と、なぜ「小さい = 違反」ではないのかは
[`target-size-inline.md` §1](./target-size-inline.md) にある。

---

## 4段階

| 段階 | Issue | PR | 結果 | 記録の場所 |
|---|---|---|---|---|
| 第1段階 フッター・テーマ切替・議員一覧のチェックボックス | [#413](https://github.com/uonoko1/giinrecord/issues/413)（OPEN） | [#416](https://github.com/uonoko1/giinrecord/pull/416)（マージ済み） | 直した（フッター 12→24px、「元職も含める」13→25px、テーマ切替 20→24px） | PR #416 の本文 |
| 第2段階 `.links`（ページ下部の移動リンク） | [#423](https://github.com/uonoko1/giinrecord/issues/423)（CLOSED） | [#428](https://github.com/uonoko1/giinrecord/pull/428)（マージ済み） | 直した（15箇所 13→25px）**が、直す必要は無かった** | PR #428 の本文（下記の注も） |
| 第3段階 一覧の行の中のリンク 49箇所 | [#424](https://github.com/uonoko1/giinrecord/issues/424)（CLOSED） | [#437](https://github.com/uonoko1/giinrecord/pull/437)（マージ済み・CSS 差分 0） | **直さない**と判断 | [`target-size-rows.md`](./target-size-rows.md) |
| 第4段階 散文の中のリンク 46箇所 | [#425](https://github.com/uonoko1/giinrecord/issues/425)（CLOSED） | [#430](https://github.com/uonoko1/giinrecord/pull/430)（マージ済み・CSS 差分 0） | **直さない**と判断 | [`target-size-inline.md`](./target-size-inline.md) |

第4段階は #425 の題名では「41箇所」だが、測り直した結果は **46箇所**
（`.card__body` 6 / `.note` 4 / 親要素なし 36。出どころは
[`target-size-inline.md` §3](./target-size-inline.md)）。
第2段階も #423 の「14箇所」に対し、`assembly.tsx` の NotFound 分岐が同じ `.links` を使うため
実際は **15箇所**だった（出どころは PR #428 の計測表）。
**起票時に数えた数と、測った数は一致しない。**

### 第2段階（#423 / PR #428）は「直したが不要だった」

`.links` は当時 13px で、確かに 24×24 を割っていた。PR #428 は
`padding-block: 6px` を足し、縦の `gap` を 16px → 4px に減らして
**行間を変えずに** 15箇所を 25px にした。計測も変異テストも揃っている。

**しかし、それは達成基準のために必要な変更ではなかった。**
`.links` は `gap: 16px` で並ぶので、Spacing 例外（隣のターゲットの中心まで 24px 以上）を
最初から満たしていた可能性が高い。第3・第4段階と同じ判断を当てれば「直さない」になっていた。

**戻していない。** 理由は 2 つ。

- `.links` の変更は **`padding` だけで、負の `margin` を使っていない**。
  第3段階で問題になった「当たり判定が隣にかぶる」副作用が無く、**害が無い**。
- 押せる範囲が広がること自体は利用者にとって不利益ではない。
  revert には revert のリスク（`gap` を戻し忘れて行間が変わる）がある。

ただし **`.links` の間隔は実測していない**。「不要だった可能性が高い」までが言える範囲で、
「不要だった」と断定するには `.links` の最近接ターゲット中心間距離を測る必要がある。

---

## 直すと押し間違いが増える（第3段階の実測）

「数字を 24 にする」ためによく使う手が
`padding-block: 6px` + 同量の負の `margin-block`（押せる範囲を広げ、行の高さは戻す）である。
第3段階ではこれを実装し、**revert した**。
出どころは [`target-size-rows.md` §4](./target-size-rows.md) と PR #437 の計測。

- 達成基準は**入れる前から満たしていた**。`/` の `.row`（出典と更新）の
  最近接ターゲット中心間距離は **30px**（必要な 24px に対し余裕 6px）。
- 実装を入れると、負の `margin` で押し戻したぶん**隣の行の文字の上に不可視の当たり判定が 6px かぶさる**。
  実測で `.rows` の**隣り合うリンクの箱のすき間が 17px → 5px に縮んだ**。
- つまり **達成基準は満たすのに、実際は押し間違いが増える**。
  「文字を押したのに上の行のリンクが開く」は、入れる前より悪い。

**「24×24 未満だから直す」ではなく「例外に当たらないから直す」で判断すること。**

---

## 測り方の落とし穴

いずれも**実際に踏んで、嘘の数字が出た**もの。詳細は各ファイルにある。

| 落とし穴 | 何が起きたか | 詳細 |
|---|---|---|
| `vite preview` は使えない | `/coverage` と `/rollcalls` が SPA フォールバックを返し `Application Error: No result found for routeId` になる。**リンクが 0 個**になる。`build/client` を静的配信すること | [`target-size-inline.md` §2](./target-size-inline.md) |
| フォント読み込みを待たないと数が変わる | `document.fonts.ready` だけでは足りない。待たずに測った回は `/coverage` の議会名 `h3` 7箇所を「13px で違反」と誤って数えた（**実際は 25px で最初から合格**）。読み込み中フォントが無くなるまで待ち、さらに 1.5 秒 | [`target-size-inline.md` §2](./target-size-inline.md) |
| セレクタのカンマ結合 | `` `${".a, .b"} a` `` は `.a, .b a` になり**最後の項にしか掛からない**。この書き方をした最初の計測は「24px 未満 0 箇所」という**嘘の合格**を出した。各項に配ってから `join(", ")` すること | [`target-size-rows.md` §2](./target-size-rows.md) |

共通の測り方: `pnpm build` の成果物を静的配信し、Playwright の Chromium を **390px 幅**で開いて
`getBoundingClientRect()` を読む。判定に使うのは「大きさ」「最近接ターゲットの中心までの距離」、
散文ではさらに「同じ行に非対象テキストがあるか」（`Range.getClientRects()` で実測。クラス名では判定しない）。

---

## この判断が変わる条件

**違反 0 件は今の CSS での結論であって、恒久的な保証ではない。**
次のどれかをしたら測り直すこと。余裕が一番少ないのは `/` の `.row` の **30px**（残り 6px）。

- **レイアウトを詰めたとき。**
  - `.row` の `padding: 8px 0` を上下あわせて 6px 以上詰めると中心間が 24px を割り、**本当に違反になる**
    （PR #437 は `padding: 4px` の変異を実ブラウザでも確認し、**22px** になることを見ている）
  - `/coverage` `/assemblies/pref-31` の表の「表決結果（公式）」は縦の間隔 **52px**。
    行の padding を 14px 以上詰めると外れる
  - `.rollcalls-item`（12px）/ `.list__item`（10px）の padding を半分以下にしたとき（間隔 58〜62.75px）
- **`line-height` を変えたとき → [#431](https://github.com/uonoko1/giinrecord/issues/431)（OPEN）。**
  このサイトのフォント（BIZ UDPGothic）は `line-height: normal` の実測が **1.0** で、
  文字の高さがそのまま箱になる。`target-size.test.ts` のヘルパは **1.2** で見積もるため、
  **テストが緑でも実物は違反**という状態を作れる（`padding: 5px` + `font-size: 12px` で
  見積り 22.4px に対し実測 22px 等）。ヘルパは `padding-block: 6px 0` のような
  2 値記法も片方しか見ない。**ヘルパの値を根拠にしないこと。**
- **リンクを 2 つ隣り合わせに置いたとき**（「〈A〉・〈B〉」のような並べ方、`.row` の中に `a` を 2 つ、など）。
  横に密に並ぶと 24px の円が横方向で重なる。#413 が最初に心配した配置がこれ。
- **フォントサイズを小さくしたとき。** 行の高さが縮むと縦の間隔も縮む。

---

## 出どころ

この索引の数字はすべて次から引いた。**この索引では新しく測っていない。**

- 表の Issue / PR の番号・題名・状態: `gh issue view` / `gh pr view`（2026-09-04 時点）
- 110 / 段階ごとの内訳・第1段階の前後: [#413](https://github.com/uonoko1/giinrecord/issues/413) 本文、PR [#416](https://github.com/uonoko1/giinrecord/pull/416) 本文
- 第2段階の 15箇所・13→25px・`gap` 16→4px: PR [#428](https://github.com/uonoko1/giinrecord/pull/428) 本文の計測表
- 30px / 17px→5px / 22px / 58〜62.75px: [`target-size-rows.md`](./target-size-rows.md)、PR [#437](https://github.com/uonoko1/giinrecord/pull/437) 本文
- 46箇所 / 52px / 457px / `h3` 7箇所の 25px: [`target-size-inline.md`](./target-size-inline.md)
- `line-height` 1.0 / ヘルパの 1.2 / 22.4px vs 22px: [#431](https://github.com/uonoko1/giinrecord/issues/431) 本文
