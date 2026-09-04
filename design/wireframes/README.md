# ワイヤーフレーム — どれが採用案か

Issue #462。`design/wireframes/` には **21 個の `.dc.html`** があるが、どれが採用された案かの
記録が `docs/` に無かった。**#453 と #456 は「ワイヤーフレームにこう書いてある」を根拠に
見た目を変えている**ので、根拠にしたファイルが採用案かどうかは判断の土台になる。

**この文書は分類と記録だけを行う。ファイルは 1 つも消していない・動かしていない・変えていない。**
不採用案も「なぜそれを選ばなかったか」の記録として価値がある。

関連: [`docs/research/typography-judgment.md`](../../docs/research/typography-judgment.md)（#453 の判断）

---

## 結論（先に書く）

**`Search.dc.html` と `Votes.dc.html` は、どちらも採用案「A 台帳」である。**
`canvas.json` が両方を採用ページ (`page-design`) に置き、配色が `tokens.css` と一致する。
**#453 / #456 の判断の土台は崩れていない。**（根拠は §2、注意点は §5）

**21 ファイルすべてに根拠がある。「特定できない」は 0 件。**
`canvas.json` が 21 ファイル全部について採用/不採用と画面名を明示していたため。

---

## 1. 判断に使った証拠

分類は推測ではなく、次の 4 つの一次資料から出している。**どれも確かめられる。**

### 証拠 A — `canvas.json`（最も強い。これが実質の決定記録）

`canvas.json` は 4 つの**ページ**を持ち、名前そのものが採用・不採用を言っている:

| ページ id | 名前 |
|---|---|
| `page-design` | **採用：A 台帳 ＋ C ダーク** |
| `page-alt` | **不採用案** |
| `page-wire` | ワイヤーフレーム |
| `page-logo` | ロゴ案 |

そして **21 個の artboard が 21 個のファイルと 1 対 1 で対応している**（過不足なし。
`apps/web/app/lib/wireframe-refs.test.ts` が数の一致を守っている）。各 artboard には
`"title": "A 台帳 ・ 採決タブ"` のように**方向名と画面名が両方入っている。**

`annotations` にも決定が日付つきで残っている:

> **採用（2026-08-22）：A 台帳をライト、C 夜の台帳をダークモードとして採用。**

これは PO の記憶（2026-08-22 ユーザー承認）と**日付・文言ともに一致する。**

### 証拠 B — `gen_variants.py`（A〜E が何を指すかの定義）

`HomeA`〜`HomeE` と `MemberC`〜`MemberE` は**手書きではなく生成物**である。
`gen_variants.py` の `STYLES` 辞書が A〜E を定義している:

```python
STYLES = {
 'A': dict(name='台帳',       bg='#f5f2ec', fg='#1b1a18', acc='#d8b86a', ...),
 'B': dict(name='大胆な色面', bg='#ffffff', brand='#0e6b66', ...),
 'C': dict(name='夜の台帳',   bg='#1c1d21', fg='#ece8df', acc='#d8b86a', ...),
 'D': dict(name='ポスター',   bg='#fbf7ef', brand='#5c2a52', acc='#e0a62b', ...),
 'E': dict(name='計器盤',     bg='#f3f4f6', acc='#4f46e5', ...),
}
```

そして末尾で、こう書き出している:

```python
for k,s in STYLES.items():
    open(f'Home{k}.dc.html','w',...).write(home(s))
for k in ('C','D','E'):
    open(f'Member{k}.dc.html','w',...).write(member_page(STYLES[k]))
```

**つまり `Home{A..E}` / `Member{C,D,E}` の末尾文字は、確実に方向 A〜E に対応する。**
名前の見た目からの推測ではなく、生成コードによる対応である。
5 つの名前（台帳・大胆な色面・夜の台帳・ポスター・計器盤）は
PO の記憶にある A〜E の名前と**完全に一致する。**

> **注意: `DirectionB` / `DirectionC` の末尾文字は方向 B / C **ではない**。** §4 を見ること。

### 証拠 C — `apps/web/app/styles/tokens.css`（実装された色）

実装のトークンは**冒頭のコメントで方向を名指ししている**:

```css
/* Design tokens — direction A「台帳」(light) and C「夜の台帳」(dark). */
```

そして値が `gen_variants.py` の `STYLES['A']` / `STYLES['C']` と一致する:

| tokens.css | 値 | 出どころ |
|---|---|---|
| `--paper` | `#f5f2ec` | `STYLES['A']['bg']` |
| `--ink` | `#1b1a18` | `STYLES['A']['fg']` |
| `--muted` | `#6b6860` | `STYLES['A']['muted']` |
| `--rule` | `#d8d4cc` | `STYLES['A']['rule']` |
| `--cover` | `#26364a` | `STYLES['A']['brand']` |
| `--brass-on-cover` | `#d8b86a` | `STYLES['A']['acc']` |
| `--link` | `#3a4a5e` | `STYLES['A']['link']` |
| `--yes-bg/fg/line` | `#d9ebe8` / `#1e5552` / `#b6d6d2` | `STYLES['A']['yes']` |
| `--no-bg/fg/line` | `#efe0ea` / `#663a5c` / `#d9bdd0` | `STYLES['A']['no']` |
| ダークの `--paper` | `#1c1d21` | `STYLES['C']['bg']` |
| ダークの `--ink` | `#ece8df` | `STYLES['C']['fg']` |
| ダークの `--brass` / `--link` | `#d8b86a` | `STYLES['C']['acc']` |

**確かめ方**（この 12 色が A 系のワイヤーフレームに実際に出ることを見る）:

```
grep -c '#f5f2ec\|#1b1a18\|#26364a\|#d8b86a' design/wireframes/Search.dc.html
grep -c '#d9ebe8\|#1e5552\|#b6d6d2' design/wireframes/Votes.dc.html
```

### 証拠 D — git log

```
$ git log --diff-filter=A --format='%h %ad %s' --date=short -- design/wireframes/
01d0bd13 2026-08-22 chore: sprint 0 scaffold — ...
```

**21 ファイルすべてが 2026-08-22 の 1 コミットで同時に入っている。**
つまり「後から採用案だけ足された」形跡は無い。**コミットメッセージに採用/不採用の記述は無く、
git log 単独では分類できない。** 分類は証拠 A〜C による。

---

## 2. 採用案（`page-design` — 5 + 2 = 7 ファイル）

**方向 A「台帳」をライト、方向 C「夜の台帳」をダークとして採用。**

### A 台帳（ライト。実装されている案）

| ファイル | 画面 | 判断 | 根拠 |
|---|---|---|---|
| `HomeA.dc.html` | Home（トップ） | **採用** | `canvas.json`: page-design / title「A 台帳 ・ Home」。`gen_variants.py` が `STYLES['A']` から生成。配色が `tokens.css` のライトと一致 |
| `Main.dc.html` | 議員ページ（時系列がデフォルト） | **採用** | `canvas.json`: page-design / title「A 台帳 ・ 議員ページ」。`#f5f2ec` `#1b1a18` `#26364a` `#d8b86a` が `tokens.css` と一致 |
| **`Votes.dc.html`** | **議員ページの「採決」タブ** | **採用** | `canvas.json`: page-design / title「**A 台帳 ・ 採決タブ**」。賛否の判の色 `#d9ebe8`/`#1e5552`/`#b6d6d2`（賛成）と `#efe0ea`/`#663a5c`（反対）が `tokens.css` の `--yes-*` / `--no-*` と**完全に一致**。**→ #453 / #456 の根拠として有効** |
| **`Search.dc.html`** | **議員をさがす（`/members`）** | **採用** | `canvas.json`: page-design / title「**A 台帳 ・ 議員をさがす**」。`.m`（Shippori Mincho）＋ 本文 BIZ UDPGothic の組は `tokens.css` の `--font-head` / `--font-body` と一致。**→ #453 の根拠として有効** |
| `About.dc.html` | データについて（`/about`） | **採用** | `canvas.json`: page-design / title「A 台帳 ・ データについて」。配色・書体が A |

### C 夜の台帳（ダークモード。A の構造そのままを墨色に反転）

| ファイル | 画面 | 判断 | 根拠 |
|---|---|---|---|
| `HomeC.dc.html` | Home（ダーク） | **採用** | `canvas.json`: page-design / title「C 夜の台帳 ・ Home」。地 `#1c1d21`・真鍮 `#d8b86a` が `tokens.css` のダークと一致 |
| `MemberC.dc.html` | 議員ページ（ダーク） | **採用** | `canvas.json`: page-design / title「C 夜の台帳 ・ 議員ページ」。同上 |

`canvas.json` の注記より:

> **C 夜の台帳**：Aの構造そのまま、全面を墨色に反転。真鍮の見出し、紙色の文字。
> ライト／ダーク切替の「ダーク側」として持つ手もある。

---

## 3. 不採用案（`page-alt` — 9 ファイル）

**消さないこと。**「なぜ選ばなかったか」の記録である。
`canvas.json` の注記に、各案の長所と**選ばなかった理由**が残っている。

### B 大胆な色面（不採用）

青緑 `#0e6b66` 一色の大面積、白地、極太ゴシック（Zen Kaku Gothic New）。

| ファイル | 画面 | 判断 | 根拠 |
|---|---|---|---|
| `HomeB.dc.html` | Home | **不採用** | `canvas.json`: **page-alt（不採用案）** / title「B 大胆な色面 ・ Home」 |
| `BoldMain.dc.html` | 議員ページ | **不採用** | `canvas.json`: page-alt / title「B 大胆な色面 ・ 議員ページ」。`#0e6b66` は `STYLES['B']['brand']` で、`tokens.css` に**存在しない** |
| `BoldSearch.dc.html` | 議員をさがす | **不採用** | `canvas.json`: page-alt / title「B 大胆な色面 ・ 議員をさがす」。同上 |

> **`BoldSearch.dc.html` は `Search.dc.html` の不採用版である。** 取り違えないこと。

### D ポスター（不採用）

選挙ポスターの文法。極太明朝の氏名を 2 行、葡萄 `#5c2a52` と山吹 `#e0a62b`、丸い判。

| ファイル | 画面 | 判断 | 根拠 |
|---|---|---|---|
| `HomeD.dc.html` | Home | **不採用** | `canvas.json`: page-alt / title「D ポスター ・ Home」 |
| `MemberD.dc.html` | 議員ページ | **不採用** | `canvas.json`: page-alt / title「D ポスター ・ 議員ページ」 |

不採用の理由（`canvas.json` の注記）:

> 「誰かの陣営」に見える危険が最も高い。**山吹は国民民主の黄に近く、ここが中立性との最大の
> トレードオフ。**

これは `docs/WORKING_AGREEMENT.md` の中立性原則に直接ぶつかる。

### E 計器盤（不採用）

薄灰 `#f3f4f6` の地に白カード、等幅数字、藍紫 `#4f46e5`。**書体は IBM Plex Sans JP 一本
（見出しも本文もゴシック）。**

| ファイル | 画面 | 判断 | 根拠 |
|---|---|---|---|
| `HomeE.dc.html` | Home | **不採用** | `canvas.json`: page-alt / title「E 計器盤 ・ Home」。`grep font-family HomeE.dc.html` は IBM Plex しか返さない＝ `tokens.css` の明朝/ゴシック 2 家族と**別方向** |
| `MemberE.dc.html` | 議員ページ | **不採用** | `canvas.json`: page-alt / title「E 計器盤 ・ 議員ページ」。同上 |

> **#456 が懸念した「本文もゴシック太字で組む別方向」は、この E である。**
> **E は不採用**なので、A（明朝の見出し＋ゴシックの本文）を根拠にした判断と競合しない。

### 初期の別案（不採用。A〜E より前の探索）

| ファイル | 画面 | 判断 | 根拠 |
|---|---|---|---|
| `AltNewspaper.dc.html` | 議員ページの断片（新聞風） | **不採用** | `canvas.json`: page-alt / title「**初期別案：新聞（不採用）**」。ファイル本文にも「短所：新聞社サイトに見え、『誰かの論調』を連想させる」と書かれている |
| `AltWhitePaper.dc.html` | 議員ページの断片（白書／SaaS 風） | **不採用** | `canvas.json`: page-alt / title「**初期別案：白書（不採用）**」。本文に「短所：無難で記憶に残らない。どこにでもある」 |

この 2 つは A の書体（Shippori Mincho ＋ BIZ UDPGothic）を使っているが、
**採用されたのは A 本体であって、この 2 案ではない。** レイアウトの探索段階の記録である。

---

## 4. 低忠実度ワイヤーフレーム（`page-wire` — 4 ファイル）

**この 4 つは色の方向 A〜E ではない。**「画面に何を載せるか」を決めるための、
色を持たない（`_style.txt` の Zen Kurenaido / `#fbfaf7` 共通）ラフである。
**採用/不採用の軸が A〜E とは別**なので、そのつもりで読むこと。

| ファイル | 何の案か | 判断 | 根拠 |
|---|---|---|---|
| `Journey.dc.html` | 利用者の動線図（選挙 2 週間前〜投票日） | **採用**（前提として生きている） | `canvas.json`: page-wire / title「0. ユーザーの動線」。「Google 検索から議員ページに直接着地が最多」等、現行の設計前提 |
| `DirectionB.dc.html` | 議員ページの**レイアウト案：テーマ別**（付託委員会で束ねる） | **保留（不採用ではない）** | `canvas.json`: title「**1B. テーマ別（保留）**」＋ 注記「**テーマ別は法案側の分類が整うまで保留**」 |
| `DirectionC.dc.html` | 議員ページの**レイアウト案：採決一覧表**（本人票と会派票を並べる） | **採用**（「採決」タブとして） | `canvas.json`: title「**1C. 採決表（採決タブに採用）**」＋ 注記「議員ページは時系列をデフォルト、採決表は『採決』タブ」 |
| `Compare.dc.html` | S3 比較画面（同一選挙区の候補を並べる） | **採用**（将来スプリント向けの先出し） | `canvas.json`: title「**S3. 比較（先出し）**」。「一致／不一致の集計は出さない（『何％一致』は評価になる）」と中立性の制約つき |

> **ここが名前の罠である。** `DirectionB` / `DirectionC` の **B / C は色の方向 B「大胆な色面」/
> C「夜の台帳」ではない。** `canvas.json` の title が `1B.` `1C.` と**連番**を振っており、
> 中身も配色ではなく**情報レイアウトの選択肢**である（テーマ別 vs 採決表）。
> `gen_variants.py` もこの 2 ファイルを生成していない（生成対象は `Home*` と `Member*` だけ）。
> **`DirectionA` が存在しないのは、1A が「時系列」＝ `Main.dc.html` に採用されて
> 高忠実度に進んだためと読めるが、これは断定できない。** §5 を見ること。

---

## 5. ロゴ（`page-logo` — 1 ファイル）

| ファイル | 何の案か | 判断 | 根拠 |
|---|---|---|---|
| `Logo.dc.html` | ロゴ案 4 案（マーク＋ワードマーク、表紙色、ファビコン実寸） | **D 案「時系列」が採用**（他 3 案は不採用） | 下記 |

`Logo.dc.html` は 4 案を並べている:

| 案 | 内容 | 判断 |
|---|---|---|
| A | 判（はん）— 角印の「議」 | 不採用 |
| B | 台帳 — 罫線と記帳の点 | 不採用 |
| C | ワードマーク — 明朝の四文字と真鍮の下線 | 不採用 |
| **D** | **時系列 — 縦の軸と記録の点** | **採用** |

**根拠は実装そのもの。** `apps/web/public/logo.svg` の 2 行目に、こう書かれている:

```svg
<!-- 案 D「時系列」: 縦の軸に記録の点、最新（最下）の点だけ真鍮 -->
```

さらに `apps/web/app/lib/brand-assets.test.ts` が
「**軸1本＋横線3本、点3つ**」「**最新（最下）の点だけ真鍮**」を固定しており、
これは D 案「縦の軸と記録の点」の記述と一致する（A 案の角印なら `<text>` か
「議」の字形が要るが、テストは `expect(src).not.toContain("<text")` を課している）。

> **注意 1: この「ロゴ案 A〜D」の A〜D は、色の方向 A〜E とも `DirectionB/C` とも無関係である。**
> 同じ文字を 3 通りの別の意味で使っているので、読むときに取り違えやすい。
> **色の方向は A が採用だが、ロゴは A が不採用で D が採用**という、紛らわしい組み合わせになっている。

> **注意 2: `Logo.dc.html` にはロゴ案の名前が「議会ログ」と書かれているが、
> 現行のブランド名は「議員レコード」である**（`logo.svg` の `aria-label`）。
> ワイヤーフレーム作成時からサイト名が変わっている。**改名の経緯はこの PBI の範囲外。**

---

## 6. 確度と、確かめきれていないこと

**隠さずに書く。**

### 確実（複数の独立した証拠が一致）

- **A＝台帳、C＝夜の台帳が採用**。`canvas.json` のページ名・注記、`gen_variants.py` の
  `STYLES`、`tokens.css` のコメントと 12 色の値が、**3 つとも独立に同じことを言っている。**
- **B / D / E が不採用**。`canvas.json` が page-alt に置き、それぞれの特徴色
  （`#0e6b66` / `#5c2a52` / `#4f46e5`）が `tokens.css` に**1 つも現れない。**
- **`Search.dc.html` と `Votes.dc.html` は採用案**。`canvas.json` の title が
  「A 台帳 ・ 議員をさがす」「A 台帳 ・ 採決タブ」と方向名を明示し、
  賛否の判の 5 色が `tokens.css` の `--yes-*` / `--no-*` と一致する。

### たぶん（証拠が 1 つしかない／解釈が入る）

- **`DirectionA` が存在しない理由**。`1B.` `1C.` の連番から「1A があったはず」とは読めるが、
  **1A が何だったかを示すファイルも記録も無い。** 「時系列案が `Main.dc.html` になった」は
  自然な読みだが、**リポジトリの中に裏付けは無い。**
- **`DirectionB`（テーマ別）の「保留」がいつ解けるか**。`canvas.json` は
  「法案側の分類が整うまで」としか書いていない。期限も条件の詳細も無い。
- **`AltNewspaper` / `AltWhitePaper` が A〜E の**前**の探索か、並行の探索か**。
  git は 21 ファイル同時追加なので**時系列では区別できない。**
  「初期別案」という title を根拠に「前」としたが、これは title の語だけが根拠である。

### 分からない

- **`canvas.json` の注記を誰がいつ書いたか。** 内容は 2026-08-22 の決定と一致するが、
  ファイル自体は他の 20 ファイルと同じ 1 コミットで入っており、**注記だけの履歴は追えない。**
- **ロゴ案 D を選んだ「決定」の記録**。実装 (`logo.svg` のコメント) が D と名乗っており
  採用そのものは確実だが、**「なぜ D にしたか」を書いた文書は `canvas.json` にも `docs/` にも無い。**
  A/B/C を落とした理由は分からない（B/D/E の色の方向と違い、`canvas.json` に注記が無い）。
- **サイト名が「議会ログ」から「議員レコード」に変わった経緯**。
  `Logo.dc.html` は「議会ログ」、実装は「議員レコード」。**この README では扱わない。**

---

## 7. #453 / #456 への影響

**無い。判断を見直す必要は無い。**

#453 / #456 が根拠にした `Search.dc.html` と `Votes.dc.html` は**どちらも採用案 A 台帳**であり、
不採用案ではなかった。#456 の担当者が懸念した「本文もゴシック太字で組む別方向」は
`HomeE` / `MemberE`（方向 E 計器盤）で、**これは不採用**なので競合しない。

### ただし、`typography-judgment.md` に 1 箇所の軽微な誤りがある

同文書は議案名の引用に `design/wireframes/Votes.dc.html:52` と付けているが、
**引用された行は実際には 51 行目である**（52 行目は賛成の判の `div`）。

```
$ grep -n "日本国憲法の改正手続に関する法律の一部を改正する法律案" design/wireframes/Votes.dc.html
51:        <div style="flex: 1; ..."><div style="font-size: 13px; line-height: 1.45;">日本国憲法の...
```

**引用の中身と主張（議案名はゴシックで `font-weight` の指定が無い＝400）は正しい。**
行番号が 1 つずれているだけで、結論には影響しない。
（`Search.dc.html:43` のほうは行番号も一致している。）

---

## 8. 機械で守っていること

`apps/web/app/lib/wireframe-refs.test.ts` が 3 つだけ守る:

1. `docs/` から参照されている `design/wireframes/*.dc.html` のパスが**実在する**
   （ファイルを消す／改名すると落ちる）
2. その参照先が**この README に載っている**（記録の無いファイルを根拠にすると落ちる）
3. **README がディスク上の `.dc.html` 全件に言及している**（ファイルが増減したら落ちる）

**「採用/不採用」の文言まではテストしない。** 判断は人がするもので、
文字列一致で縛っても README の文面を固定するだけで、正しさは何も守れないため。
