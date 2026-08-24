# 議会識別子を人間が読める形にすべきか 調査（Issue #240）

調査日: 2026-08-24。**調査のみ**（コード・データの変更なし）。数値はこのリポジトリを実際に `git grep` / `find` / `python3` で数えたもの。**基準コミットは `93425d3`**（初稿は `b5aced6` 時点で書き、レビュー指摘を受けて再計測した）。

> **初稿からの訂正**: 初稿の執筆（2026-08-24 22:03 JST）の 46 分後に **#248（`eae072e`、22:49 JST）がマージされ、議会ページの監視が実装された**。§2.5 と §8.4 はその実装後の状態に書き直してある。あわせて、`assemblyPath()` が URL 生成の唯一の入口だという記述（誤り。列挙側は別経路）、引用行番号 2 件、リテラル計数の範囲指定を訂正した。**影響範囲の実測値と結論（案 C・301 は 9 本・着手は次スプリント以降）は変わっていない。**

外部サイトは実際に `curl`（UA は `packages/etl/src/fetch.ts` の `gikailog-etl/0.1 (+https://github.com/uonoko1/gikailog)`、間隔 ≥ 1 秒）で確認できた挙動だけを書く。

## 結論（先に）

**推奨は (C) の変種 —「スラッグを別に持ち、URL だけ読みやすくする」。ただし着手は次スプリント以降でよい。**

- 内部識別子（`data/` の `AssemblyId`、議員 `MemberId`、表決 id）は **今のまま `pref-32` / `diet-sangiin` / `p_32_…` を維持**する。JIS X 0401 の都道府県コードは総務省が定める公式コードで、名称変更・市町村合併の影響を受けない。ローマ字表記には正解が 1 つに定まらない（`shimane` は揺れないが、`hyogo` / `hyougo`、`kochi` / `kouchi`、政令市の `yokohama` はよくても `kokubunji` のような同名自治体問題がある）。**識別子をローマ字にすると「安定した機械可読キー」という唯一の利点を失う**。
- 一方で **URL に出す顔だけは読める形にする価値がある**。`/assemblies/shimane/` が正、`/assemblies/pref-32/` は 301 で正へ寄せる。`Assembly` に `slug` フィールドを 1 本足すだけで済み、URL を組み立てる箇所は **`assemblies.ts:29`（リンク）と `data-files.ts:78`（prerender / sitemap 列挙）の 2 箇所・各 1 行**なので、Web 側の変更は極小。**両方同時に直すこと**（片方だけだと 9 ページ全部 404）。
- **議員 ID は対象外**。議員は所属議会が変わりうる（地方議員 → 国会議員）ため、ID に議会を埋めた `p_32_…` を URL の顔にすると、その人が国会に行った瞬間に URL を動かす羽目になる。`m_` / `h_` / `p_` は**内部 ID のまま**にし、URL も現状維持でよい（1,057 本の 301 を張る価値がない）。
- **`diet-` は残す**。`sangiin` / `shugiin` に単純化しても読みやすさはほぼ変わらず（どちらも日本語話者にはローマ字として同程度に読める）、`diet-` は「国会である」という階層情報を持っている。`diet` は `The National Diet of Japan` の正式英語名で誤訳ではない（下記「`diet-` の扱い」）。
- **タイミング**: 本日 2026-08-24 17:48 JST に `gikailog.jp → giinrecord.jp` の改名 301 を投入したばかり（コミット `e899088`、Issue #192 / PR #214）。**同じ週に 2 度 URL を動かすのは避ける**。Google が新ドメインの再インデックスを終えるまで待つ。PO 判断（急がない）と一致する。

---

## 1. 現在の識別子と、その由来（事実確認）

| 識別子 | 例 | 由来 | 機械的な妥当性 |
|---|---|---|---|
| 議会 id（国会） | `diet-sangiin`, `diet-shugiin` | `diet` = 日本の国会の正式英語名 `The National Diet of Japan`。語源はラテン語 `dieta`（集会の日）で、食事の diet（ギリシャ語 `diaita`）とは**同綴異義語** | 正しい。誤訳ではない |
| 議会 id（都道府県） | `pref-32`（島根）, `pref-36`（徳島）, `pref-39`（高知） | `pref` = prefecture、数字 = **JIS X 0401 都道府県コード**（＝総務省 全国地方公共団体コードの上 2 桁） | 正しく安定。`data/districts/municipalities.json` の `code` と同じ体系 |
| 議会 id（市区町村、未使用） | `city-33100`（岡山市） | 全国地方公共団体コード 5 桁 | 型定義のみ存在。`data/assemblies/` にはまだ 1 件も無い |
| 議員 id | `m_014002`（参）, `h_41f223ac28`（衆）, `p_32_giin01_nakamurajun`（地方） | 参は名簿のプロフィール id、衆は `h_` 接頭辞、地方は `p_{prefCode}_{名簿ページの slug}` | 名前から作っていないので改姓に強い。ただし地方だけ**議会コードを ID に埋めている** |

型定義: `packages/shared/src/index.ts:18-25`（`DietAssemblyId` / `AssemblyId`）、`:43`（`MemberId`）。

**問題は「間違っている」ことではなく「共有されたときに何のページか伝わらない」こと。** `https://giinrecord.jp/assemblies/pref-32/` を SNS に貼っても島根県議会だと分からない。

---

## 2. 影響範囲の実測

### 2.1 URL の数

`apps/web/app/lib/prerender.ts` → `apps/web/app/lib/data-files.ts` の列挙を、現在の `data/` に対して再現した結果:

| 種別 | 本数 | URL の形 | 議会 id を含むか |
|---|---:|---|---|
| 静的ページ | 5 | `/`, `/about`, `/coverage`, `/terms`, `/privacy` | — |
| 議員一覧 + 議員詳細 | 1 + 1,057 | `/members/{memberId}` | 地方議員 285 本が `p_{prefCode}_…` を含む |
| 議会一覧 + 議会詳細 | 1 + **9** | `/assemblies/{assemblyId}` | **9 本すべて** |
| 表決一覧 + 会期 + 表決詳細 | 1 + 11 + 380 | `/rollcalls/{session}/{id}` | 含まない（国会の表決のみ） |
| **合計** | **1,465** | | |

- **議会 id を URL に含むページは 9 本だけ**（`diet-sangiin`, `diet-shugiin`, `pref-04/24/29/31/32/36/39`）。Issue 本文の「約 1,351 ページ」は当時の値で、現在は 1,465 本。
- **「9」と「10」はどちらも正しい。混同しないこと**（レビューで実際に食い違いが出た）:
  - **10** = `/assemblies` で始まる URL の総数。`assemblyPaths()`（`data-files.ts:78`）は `["/assemblies", ...9 本]` を返すので、**議会一覧ページ自身を含む**。prerender と sitemap の本数はこちら。
  - **9** = URL に議会 id を**埋め込んでいる**ページ。`/assemblies`（一覧）には id が無いのでスラッグ移行で動かず、**301 は不要**。
  - → **301 の本数は 9 で確定**。prerender / sitemap に載る `/assemblies` 系 URL は 10。
- 地方議会の表決（`data/assemblies/{id}/rollcalls/…`、1,096 ファイル）は **Web のルートを持たない**（`apps/web/app/routes.ts` に `/assemblies/:id` の下位ルートは無い）。表決 id `pref-32-2026-02-20260312-議案-第1号` は **URL に出ない**。
- 議員ページ 285 本の URL に `p_04_` 〜 `p_39_` が出る。

### 2.2 必要な 301 の数

| 案 | 301 の本数 | 内訳 |
|---|---:|---|
| 議会 id だけ読みやすく（推奨） | **9** | `/assemblies/pref-32/` → `/assemblies/shimane/` など 9 本。nginx の `location =` か `map` で 1 ブロック |
| 議員 id も変える | **+285**（`p_*` のみ）〜 **+1,057**（全議員） | 議員ページはすべて `/members/{id}` |
| 表決 id も変える | +0（URL に出ない） | ただし `/data/data-archive.zip` の中身と `data/` のファイル名は変わる |

**議会 id だけなら 301 は 9 本。** これはドメイン改名（全 1,465 URL が動いた）と比べて桁が 2 つ小さい。

### 2.3 `data/` の変更範囲

`find data -type f -name '*.json'` = **4,507 ファイル**。うち議会 id / 議員 id をファイル名に含むもの:

| 対象 | ファイル数 | 備考 |
|---|---:|---|
| ディレクトリ `data/assemblies/pref-NN/` | 7 ディレクトリ | ディレクトリ名の rename |
| ファイル名に `pref-NN` を含む（表決） | **1,089** | `data/assemblies/*/rollcalls/*/pref-NN-….json`。表決 id の接頭辞 |
| ファイル名が `p_NN_…`（地方議員） | **285** | `data/members/p_04_…json` 〜 `p_39_…json` |
| `data/assemblies/index.json` | 1 | 9 行の `id` |
| `data/members/index.json` | 1 | 1,057 行のうち 1,057 行が `assemblyId` を持つ |
| 各 `assemblies/{id}/meta.json` / `sessions.json` / `rollcalls/index.json` / `unmatched.json` | 7 × 4 | 中の `assemblyId` |

議員の所属内訳（`data/members/index.json` 実測）: `diet-shugiin` 465、`diet-sangiin` 307、`pref-04` 56、`pref-24` 47、`pref-29` 40、`pref-36` 36、`pref-39` 36、`pref-31` 35、`pref-32` 35。

**(A) 識別子ごと変更なら、rename されるデータファイルは 1,089 + 285 + 7 ディレクトリ = 約 1,381、書き換わる JSON 本文は実質 4,507 全部の再生成に近い。**
**(C) スラッグ追加なら、変わるのは `data/assemblies/index.json` の 9 行に `slug` を足すだけ（＋ 0 ファイルの rename）。**

### 2.4 コードの変更箇所

**数え方（明記）**: 追跡ファイルのみ（`git grep`。`node_modules` / `build` / 未追跡ファイルは対象外）、`data/` を除く全パス、検索語は 16 個のリテラル `diet-sangiin` `diet-shugiin` `pref-04` `pref-24` `pref-29` `pref-31` `pref-32` `pref-36` `pref-39` `p_04_` `p_24_` `p_29_` `p_31_` `p_36_` `p_39_` `p_32_`、**行単位ではなく出現単位**（`git grep -o … | wc -l`）。

```
git grep -o -e diet-sangiin -e diet-shugiin -e pref-04 … -e p_39_ -- . ':!data' | wc -l
```

→ **574 箇所**（`93425d3` 時点）。初稿では 510 と書いたが、これは執筆時点（`b5aced6`）の値で、その後 main が進んだぶん増えている。**範囲を書いていなかったのが誤りで、数値自体はどちらもその時点では正しい。** 以下の内訳は 574 に対するもの。

**本番コード（テスト・フィクスチャ・ドキュメントを除く）は 14 箇所しかない**:

| ファイル | 箇所 | 内容 |
|---|---|---|
| `packages/shared/src/index.ts` | `:18` `:21` `:25` `:43` | `DietAssemblyId` / `AssemblyId` / `MemberId` の型と doc |
| `packages/etl/src/assemblies.ts` | `:4` `:7` | `DIET_ASSEMBLY_IDS`、`assemblyIdOf()` |
| `packages/etl/src/cli.ts` | `:270` | 国会 2 行の生成 |
| `packages/etl/src/local-assemblies.ts` | `:88` | `isDietMemberRow()` = `assemblyId.startsWith("diet-")` |
| `packages/etl/src/sources/local/*/roster.ts` | miyagi `:122`, kochi `:74`, nara `:56`, ほか | 議員 id 生成 `` `p_${PREF.prefCode}_${slug}` `` |
| `apps/web/app/lib/data-contract.ts` | `:11` `:18` `:19` | `DIET_ASSEMBLY_IDS`、`DIET_ASSEMBLIES` フォールバック |
| `apps/web/app/lib/assemblies.ts` | `:11` `:28-30` | `isDietAssemblyId()`、**`assemblyPath()`** |
| `apps/web/app/lib/coverage.ts` | `:153` `:175` | `HOUSE_OF` マップ、参院だけ個人票 |
| `apps/web/app/routes/assembly.tsx` | `:94` | 参院分岐 |
| `apps/web/app/lib/member-search.ts` | `:75` | フィルタの doc コメント |

**重要（訂正）**: 議会 URL を組み立てる箇所は **2 つあり、片方はもう片方を呼んでいない**。

| 箇所 | 役割 | 呼び出し元 |
|---|---|---|
| `apps/web/app/lib/assemblies.ts:29` `assemblyPath(id)` | **ページ内リンク** | `assemblies.tsx:59`（議会一覧の本体リンク）、`assemblies.tsx:113`（公開状況表）、`coverage.tsx:239`、`coverage.tsx:286`、`member.tsx:234` の **5 箇所** |
| `apps/web/app/lib/data-files.ts:78` `assemblyPaths()` | **prerender / sitemap の列挙** | `prerender.ts:12` 経由で `react-router.config.ts` と `scripts/sitemap.ts` |

`data-files.ts:78` は `` return ["/assemblies", ...assemblies.map((a) => `/assemblies/${a.id}`)]; `` と **独自に文字列連結していて `assemblyPath()` を呼ばない**（Node 専用モジュールとブラウザ安全モジュールで分かれているため）。

→ **片方だけ直すと 9 ページ全部 404 になる**（リンクは slug を指すのに、prerender は id で出力する、あるいはその逆）。§8.2 の手順は両方に触れているので結論は変わらないが、「1 関数に集約されている」という表現は誤りだった。正しくは **「2 箇所だけ。どちらも 1 行」** で、変更量が小さいという結論自体は維持される。

残り約 560 箇所の内訳: ETL のテスト（`packages/etl/test/*.test.ts` が最多、`local-assemblies.test.ts` だけで 45）、Web のテストとフィクスチャ（`apps/web/app/test-fixtures/assemblies/`）、`docs/DATA_CONTRACT.md`（21）、`docs/research/local-assemblies.md`、スプリント記録。**(A) を採ると、この 560 箇所のテスト・フィクスチャがまとめて壊れる**。

`apps/web/app/data/vote-disclosure.json` は **67 行**（`pref-*` 47 + `city-*` 20）が `assemblyId` を持つ。ここは `data/` に議会が無くても表示する調査表なので、(A) では **将来分 67 件すべてに slug を先に決めておく**必要が出る。

### 2.5 ビルド・デプロイ側

- **prerender / sitemap**: 両方 `prerenderPaths()` を通る（`apps/web/scripts/sitemap.ts` が `prerenderPaths` を直接呼ぶ）ので、**列挙元が 1 つ**。ここが変われば sitemap.xml も自動で追随する。
- **smoke**: `apps/web/app/lib/smoke.ts:63`（`expectedPages`）が `assemblies/{id}/index.html` を期待。`REQUIRED_PAGES` は `assemblies/index.html` を含む。
- **nginx**: `deploy/nginx/site.conf`。現在の 301 は `www.giinrecord.jp` → apex、`gikailog.jp` / `www.gikailog.jp` → `giinrecord.jp`、`staging.gikailog.jp` → `staging.giinrecord.jp` の 3 本（`:19-35`）。パス単位の 301 はまだ 1 本も無い。`location /` は `try_files $uri $uri/index.html /__spa-fallback.html`。
- **監視**: `.github/workflows/monitor.yml` → `deploy/monitor/run.sh` → `deploy/monitor/probe.sh`。**#248（`eae072e`）で議会ページの監視が入った**ので、プローブ先は `/`、`/members/`、`/data/meta.json` に加えて **`/assemblies/` と、そこから列挙した議会ページ**（`ASSEMBLY_SAMPLE` 件ずつローテーション）。
  - 議会 id を**ハードコードせず、`/assemblies/` の `href="/assemblies/{id}"` から抜き出す**方式（`probe.sh` の `grep -o 'href="/assemblies/[A-Za-z0-9._-]\+"'`）。**スラッグ移行後は自動でスラッグを拾う**ので、プローブ先リストの更新は不要。
  - 各議会ページに対し「本文に自分の id がリテラルで含まれること」も検査する（`probe.sh` の `grep -q -F -- "$id" "$f"`）。**この検査とスラッグ移行の噛み合いは §8.4 に別項を立てた。**

---

## 3. SEO リスク（短期間に 2 度 URL を動かす）

事実:

- `gikailog.jp → giinrecord.jp` の改名は **2026-08-24 17:48 JST**（コミット `e899088`、`feat: 改名 議会ログ → 議員レコード（giinrecord.jp）、旧ドメインは 301`）。**本日**。
- 旧ドメインからの 301 は現役（`deploy/nginx/site.conf:28-29`）。Google が旧ドメインのシグナルを新ドメインへ移し終えるまで、一般に**数週間〜数か月**かかる（サイト移転の一般則。本件で実測はしていない）。
- 対象サイトは**新規で、被リンクも履歴も薄い**（2026 年に立ち上がったばかり）。失うものは大きくない一方、**新ドメインのインデックスがまだ固まっていない**のも事実。

評価:

- **301 の連鎖が最大のリスク**。今 URL を動かすと `gikailog.jp/assemblies/pref-32/` → `giinrecord.jp/assemblies/pref-32/` → `giinrecord.jp/assemblies/shimane/` の **2 段 301** ができる。クローラは追うが、評価の受け渡しが減る・クロール予算を食う・監視やログの読み解きが面倒になる。
- ただし **対象はたった 9 URL**。しかも議会ページはサイトの主要導線ではない（議員 1,057 本・表決 380 本が本体）。**実害の絶対量は小さい**。
- **結論**: 「危険だからやらない」ではなく **「急ぐ理由が無いので、新ドメインのインデックスが落ち着いてからやる」**。目安として、Search Console で `giinrecord.jp` のインデックス数が旧ドメインぶんを吸収したことを確認してから着手する。#239（見出し・URL の日本語表示）で当面の「何のページか分からない」は解消するので、待つコストはほぼゼロ。
- 動かすときは **2 段 301 を作らない**。旧ドメイン側の 301 は `$request_uri` をそのまま渡すので、新ドメイン側で `pref-32 → shimane` を受ければ結果的に 2 段になる。避けるには旧ドメインの block でもパス書き換えを先に当てるか、**2 段を許容して短期間で旧ドメイン 301 を畳む**か。前者は設定が二重管理になるので、実務的には後者（旧ドメイン 301 の役目が終わってから議会 URL を動かす）が素直。これも「待つ」を支持する。

---

## 4. 代替案の比較

### (A) 識別子ごと変更 ＋ 301

`data/` の ID を `shimane` / `sangiin` に置き換える。

| | |
|---|---|
| 実装量 | **大**。データ rename 約 1,381 ファイル、テスト・フィクスチャ約 560 箇所、`vote-disclosure.json` 67 行の slug 先決め、ETL の id 生成 4 箇所、型 4 箇所 |
| 301 | 9 本（＋ 議員も変えるなら +285）|
| 利点 | URL・データ・ログ・アーカイブ zip がすべて同じ読める名前になる。`data/` を直接使う人にも親切 |
| 欠点 | **公式コードという安定性を捨てる**。ローマ字の正書法を自分で決める責任が発生（`kochi`/`kouchi`、政令市の同名問題）。県名変更や新設は起きないが、**表記の議論が将来ずっと残る**。過去データとの互換のために結局マッピング表を持つことになり、(C) と同じものを、より高いコストで作ることになる |
| リスク | 表決 id 1,089 本の rename は ETL の再生成で吸収できるが、**過去のデータ zip をダウンロード済みの利用者との互換が切れる**（`data/data-archive.zip`）|

### (B) 現行 ID 維持 ＋ 表示名だけ改善

URL は `pref-32` のまま、ページ内の見出し・`<title>`・OGP を「島根県議会」にする。

| | |
|---|---|
| 実装量 | **極小**。**これは #239 で既に着手されている**（本 Issue の PO 判断がそう言っている）|
| 301 | 0 本 |
| 利点 | SEO リスクゼロ。今すぐ効く |
| 欠点 | **URL 単体を共有されたときは依然として無意味**。SNS カード（OGP）が展開されない文脈（プレーンテキスト、メール、口頭）では伝わらない。`/assemblies/pref-32/` は「共有しづらい URL」のまま |

### (C) スラッグを別に持ち、URL だけ読みやすく（**推奨**）

`Assembly` に `slug` を追加。URL は `/assemblies/{slug}/`、内部 id は `pref-32` のまま。

| | |
|---|---|
| 実装量 | **小**。`Assembly` に `slug: string` を 1 本追加（型 1、`data/assemblies/index.json` の 9 行、ETL の議会定義 9 箇所）。Web は `assemblyPath()` に slug 解決を挟む + ルートの `:id` を slug で引く（`findAssembly` を slug 対応にする）。prerender / sitemap / smoke は `assemblyPaths()` が slug を返せば自動追随 |
| 301 | **9 本**（旧 `pref-*` → 新 slug）。nginx の `map` 1 ブロック |
| 利点 | **安定した機械キーと読める URL の両方を持てる**。`data/` は 1 ファイル 9 行しか変わらないので、表決 id・議員 id・アーカイブ zip・過去データとの互換が**完全に保たれる**。ローマ字表記を後から直しても、直すのは slug だけ（データの再生成が要らない）。将来 `city-*` を足すときも slug を 1 個決めるだけ |
| 欠点 | id と slug の 2 系統を持つ分、`findAssembly` の呼び分けを間違えると 404 を出す。→ **slug を URL の唯一の入口にし、id での参照は 301 でしか受けない**と決めれば混乱しない。GovTrack / TheyWorkForYou も同じ二層構造（§6）|

**(C) が (A) の利点をほぼ全部持ち、コストは (B) に近い。**

---

## 5. `diet-` の扱い

**残す。`sangiin` / `shugiin` への単純化は推奨しない。**

- **読みやすさの改善がほぼ無い**。`pref-32 → shimane` は「意味不明 → 意味明快」だが、`diet-sangiin → sangiin` は「読める → 読める」。日本語話者にとって `sangiin` はどちらでも同じだけ読める。
- **`diet-` は階層情報を運んでいる**。コード上、国会／地方の判定は **接頭辞 1 本**で行われている:
  - `packages/etl/src/local-assemblies.ts:88` — `isDietMemberRow = (m) => m.assemblyId === undefined || m.assemblyId.startsWith("diet-")`
  - `apps/web/app/lib/assemblies.ts:11` — `isDietAssemblyId = (id) => id.startsWith("diet-")`
  - `apps/web/app/lib/assemblies.ts:15` — `isLocalMember` はこれの否定
  `diet-` を落とすと、この 3 箇所が「`sangiin` か `shugiin` に等しいか」の列挙比較になる。

  さらに **`diet-{house}` を文字列として組み立てている生成側が 3 箇所**ある（判定側とは別に壊れる）:
  - `packages/etl/src/sessions.ts:91` — `` m.assemblyId ?? (m.house ? `diet-${m.house}` : "diet-unknown") ``
  - `apps/web/app/lib/data-contract.ts:27` / `apps/web/app/lib/dataset.ts:12` — doc 上の契約「`assemblyId` が無ければ `house` から `diet-{house}`」。実装は `member-search.ts:10` の `DIET_ASSEMBLY_IDS[m.house]`

  動きはするが、**接頭辞で名前空間を切る設計が崩れる**（`pref-` / `city-` だけが接頭辞を持ち、国会だけ持たない、という非対称になる）。`diet-{house}` という**機械的な組み立て規則が成立しなくなる**のも痛い。**`diet-` を残す結論なので、これらはいずれも変更不要。**
- **名前空間の衝突は無い**。`diet-` / `pref-` / `city-` は互いに素で、`pref-{2桁}` と `city-{5桁}` も桁数で分かれる。`sangiin` に単純化しても偶然衝突はしないが、**将来「議会名を裸のローマ字にする」方針だと `shimane`（島根県議会）と、もし政令市を裸名にしたときの衝突リスクが出る**（例: 静岡県議会 `shizuoka` と 静岡市議会 `shizuoka`）。→ **裸のローマ字は id ではなく slug でだけ使い、slug には階層を明示する**のが安全（下記）。
- **`diet` は誤訳ではない**。日本国憲法の公式英訳・両院の公式サイトが `The National Diet` / `House of Councillors` / `House of Representatives` を使う。語源はラテン語 `dieta`（集会の日）で、食事の diet（ギリシャ語 `diaita`「生活様式」）とは同綴異義語。**この点はドキュメントに書いて残す価値がある**（同じ疑問が繰り返し出るため）。

### slug の案（実装 PBI で確定させること）

id は変えず、slug だけ決める。**衝突を避けるため、都道府県議会は裸の県名ローマ字、市議会は `{市名}-shi` を提案する**（`shizuoka` と `shizuoka-shi` で分かれる）。

| id | slug 案 | 備考 |
|---|---|---|
| `diet-sangiin` | `sangiin` | |
| `diet-shugiin` | `shugiin` | |
| `pref-04` | `miyagi` | |
| `pref-24` | `mie` | |
| `pref-29` | `nara` | |
| `pref-31` | `tottori` | |
| `pref-32` | `shimane` | |
| `pref-36` | `tokushima` | |
| `pref-39` | `kochi` | 長音。`kouchi` ではなく訓令式・ヘボン式の慣用に合わせ `kochi`（県公式英名 `Kochi Prefecture`）|
| （将来）`city-14100` | `yokohama-shi` | |

長音の扱い（`hyogo` / `osaka` / `kochi` / `oita`）は**県の公式英語名に合わせる**と決めれば議論が閉じる。これも実装 PBI の受け入れ条件に入れる。

---

## 6. 議員 ID は対象にすべきか → **対象外**

`m_014002`（参）/ `h_41f223ac28`（衆）/ `p_32_giin01_nakamurajun`（島根）。

**理由 1: 議会が変わると URL が動く。** 地方議員が国会議員になると、`p_32_…` を維持するのは嘘（島根県議会の議員ではない）だが、`m_…` に変えると URL が動く。**ID に議会を埋めた時点で、この人の URL は将来必ず 1 回動く。**
- 現在の `data/members/index.json` で、**同姓同名が両院にまたがる例が 7 名**ある（`青山 繁晴`, `鬼木 誠`, `河野 義博`, `白坂 亜紀`, `田中 昌史` ほか）。これは別人の可能性が高く「同一人物の移動」の実例ではないが、**院をまたぐ ID 設計が既に必要**であることは示している。参→衆・衆→参の移動は日本の政治では普通に起きる。
- 名前ベースの slug（`nakamura-jun`）にすると **改姓で動く**うえ、同姓同名で衝突する。`packages/shared/src/index.ts:398` が明示的に「**氏名からは作らない**」と定めているのは正しい判断で、これは維持すべき。

**理由 2: 費用対効果が悪い。** 議員ページは 1,057 本。全部読める slug にすると 1,057 本の 301 が要る。議会ページ 9 本の 117 倍のコストで、**得られる可読性は議会ほど大きくない**（`/members/m_014002/` は不透明だが、`/members/nakamura-jun/` にしたところで同姓同名の誰なのか分からない）。

**理由 3: 外部の実例が「ID は不透明のまま、slug は飾り」を支持している**（§6）。GovTrack も TheyWorkForYou も **数値 ID を URL に残したまま**、名前を装飾として並べている。

**ただし、`p_{prefCode}_…` の `prefCode` 部分だけは将来の懸念として記録しておく。** 今すぐ動かす必要は無い（URL に出ても実害は小さく、地方議員が国会に行く事例が出た時点で個別に扱えばよい）。もし将来手を入れるなら、**議会コードを ID から抜き、`p_` + 不透明キーにする**方向（`h_41f223ac28` と同じ設計）が正しい。これは別 Issue にする価値がある。

---

## 7. 他サイトの事例（実際に確認した URL のみ）

2026-08-24 に `curl`（UA は ETL のもの、間隔 ≥ 1 秒）で確認。**確認できた挙動だけを書く**。

### GovTrack (govtrack.us) — 数値 ID が正、名前は装飾

| 実行した URL | 結果 |
|---|---|
| `/congress/members/sherrod_brown/400050` | `200` |
| `/congress/members/400050` | `200` → `.../sherrod_brown/400050` へ（`curl -L` の最終 URL）|
| `/congress/members/zzz_wrong/400050` | `200` → `.../sherrod_brown/400050` へ |

**数値 ID `400050` だけが意味を持ち、名前部分は任意。間違った名前でも正しい URL に矯正される。**

### TheyWorkForYou (theyworkforyou.com) — 同じ構造、選挙区名まで装飾

| 実行した URL | 結果 |
|---|---|
| `/mp/10001/diane_abbott/uxbridge_and_south_ruislip`（**選挙区名が誤り**）| `200` → `.../10001/diane_abbott/hackney_north_and_stoke_newington` へ矯正 |
| `/mp/10001/zzz_wrong/zzz` | `200` → 同上へ矯正 |
| `/constituency/Hackney_North_and_Stoke_Newington/` | **`404`** |

**`10001` が正で、名前と選挙区は両方とも装飾。誤った slug は正しい slug へ矯正される。** 一方、slug だけの `/constituency/…` は 404 で、**slug 単独を第一級の URL にはしていない**。

### OpenStates / Plural (openstates.org → pluralpolicy.com) — 州は読める短縮形

| 実行した URL | 結果 |
|---|---|
| `https://openstates.org/ca/legislators/` | `200` → `https://pluralpolicy.com/app/jurisdictions/ca/legislators` |
| `https://openstates.org/sd/` | `200` → `https://pluralpolicy.com/app/jurisdictions/sd` |

**州（＝管轄）は FIPS 数値コードではなく `ca` / `sd` という読める短縮形が URL に出る。** 議員個別ページの ID 体系は API キーが必要で未確認のため、ここには書かない。

### 本件への含意

- **管轄（＝議会）レベルは読める名前が定石**（OpenStates の `ca` / `sd`）。→ `/assemblies/shimane/` は妥当。
- **人物レベルは不透明 ID が定石**（GovTrack `400050`、TWFY `10001`）。名前は付いていても矯正対象の装飾。→ **議員 ID を読める形にする必要は無い**という §6 の結論を支持する。
- どちらのサイトも **内部 ID を URL から消していない**。「読める URL にする」＝「ID を捨てる」ではない。

---

## 8. 実装 PBI 案（推奨案 (C) を起票する場合の手順）

**着手条件**: `giinrecord.jp` のインデックスが安定したことを Search Console で確認してから。#239 完了後。ポイント目安 3。

### 8.1 データとスキーマ

1. `packages/shared/src/index.ts` の `Assembly` に `slug: string` を追加（必須。省略可にすると slug 無し議会が 404 を生む）。
   - doc コメントに **「slug は URL 専用の表示名。`id` が正で、slug は変更しうる」** と明記。
   - あわせて `diet` の語源（正式英語名 `The National Diet of Japan`、ラテン語 `dieta`。食事の diet とは同綴異義語）を `AssemblyId` の doc に 1 行残す。同じ疑問の再発を防ぐ。
2. ETL の議会定義（`packages/etl/src/sources/local/*/site.ts` の `*_ASSEMBLY` 7 件、`packages/etl/src/cli.ts:270` の国会 2 行）に slug を追加 → `data/assemblies/index.json` の 9 行に `slug` が出る。
3. `apps/web/app/lib/data-contract.ts:18-19` の `DIET_ASSEMBLIES` フォールバックにも slug を足す。
4. `apps/web/app/data/vote-disclosure.json`（67 行）は **今回は触らない**。`data/` に議会が存在する 9 件だけリンクされるので、slug は `data/assemblies/index.json` から引ける。将来 47+20 を収録するときに slug を追加する。
5. **バリデーション**: `packages/etl/src/local-assemblies.ts` の `validateDataset` に「slug が一意」「slug が `/^[a-z0-9-]+$/`」「slug が既存の別議会の id と衝突しない」を追加。

### 8.2 Web

6. `apps/web/app/lib/assemblies.ts:29`（**リンク側**）
   - `assemblyPath()` を **slug を返す**ように変更。**呼び出し元は 5 箇所**で、id しか手元に無いものが多いので、`assemblies/index.json` から id→slug を引くヘルパを用意する:
     - `assemblies.tsx:59` — 議会一覧の本体リンク（`a.id`）
     - `assemblies.tsx:113` — 公開状況表（`r.assemblyId`）
     - `coverage.tsx:239` / `coverage.tsx:286` — 収録範囲（`d.assemblyId` / `a.assemblyId`）
     - `member.tsx:234` — 議員ページの「議会ページ」リンク（`detail.assemblyId`）
   - `findAssembly(assemblies, key)` を **slug 優先・id フォールバック**にする（フォールバックは 8.3 の 301 が漏れたときの保険。`id` で当たった場合は canonical を slug 側に向ける）。
7. `apps/web/app/lib/data-files.ts:78`（**列挙側**）の `assemblyPaths()` を `/assemblies/${a.slug}` にする。→ prerender・sitemap の両方が追随する（`scripts/sitemap.ts` は `prerenderPaths()` を呼ぶ）。
   - **6 と 7 は必ずセットで行うこと。** `data-files.ts:78` は `assemblyPath()` を呼ばず独自に連結しているので、**片方だけ直すと 9 ページ全部 404 になる**（§2.4）。片方だけの変更が CI を通らないよう、`data-files.ts` 側にも `assemblyPath` と同じ結果を期待するテストを置く。
8. `apps/web/app/routes/assembly.tsx` の `:id` パラメータを slug として解決。`assembly.id === "diet-sangiin"`（`:94`）の分岐は **id で判定したまま**にする（slug で判定しない）。
9. `apps/web/app/lib/seo.ts` の canonical が新 URL を指すことを確認。
10. `apps/web/app/lib/smoke.ts:63` の `expectedPages` を slug ベースに。`ExpectedData.assemblyIds` は `assemblySlugs` に改名するか、両方持つ。

### 8.3 nginx（301）

11. `deploy/nginx/site.conf` の `location /` の**前**に、9 本の恒久リダイレクトを 1 ブロックで置く:

    ```
    # 旧議会 URL（#240）。id は data/ の正、slug は URL の顔。
    map $uri $assembly_slug_redirect {
        default              "";
        ~^/assemblies/pref-04/?$  /assemblies/miyagi/;
        ...（9 本）
    }
    ```
    と `if ($assembly_slug_redirect) { return 301 $assembly_slug_redirect; }`、あるいは `location = /assemblies/pref-04/ { return 301 /assemblies/miyagi/; }` を 9 本。**`location =` を 9 本並べるほうが nginx 的に素直で、`if` を使わずに済む**（`if is evil`）。末尾スラッシュ有無の両方を受けること。
12. **301 は恒久的に残す**。`packages/etl/test/deploy-docker.test.ts` が site.conf の値をピンしているので、テストも更新する。
13. `deploy/test/` に、9 本の 301 が期待どおり返ることを確かめるケースを足す（既存の `nginx-reload.test.sh` / `monitor-*.test.sh` と同じ形）。

### 8.4 監視

14. **`/assemblies/` の追加は不要**（#248 で実装済み）。`deploy/monitor/probe.sh` はすでに `/assemblies/` を叩き、そのページの `href="/assemblies/{id}"` から議会を列挙してローテーション probe する。**議会 id をハードコードしていないので、スラッグ移行後は自動でスラッグを拾う。プローブ先リストの更新は要らない。**
15. **#248 の「本文に id が含まれる」検査との噛み合い（検証済み・移行は安全）**

    `probe.sh` は各議会ページについて `grep -q -F -- "$id" "$f"`（本文に自分の id がリテラルで出ること）を要求する。**これはスラッグ移行後も素通りする**が、その理由は「偶然」なので受け入れ条件で固定する必要がある。

    - 実ビルドの `assemblies/pref-32/index.html` を開くと **`pref-32` の出現は 2 回だけで、どちらも URL 由来**（`<link rel=canonical>` と `<meta property="og:url">`）。
    - `seoMeta()`（`apps/web/app/lib/seo.ts:60`）は `canonicalUrl(origin, pathname)` を canonical と og:url の両方に入れる。`assembly.tsx:20` の `meta()` が渡すのは `location.pathname`。**つまり canonical は「今の URL」をそのまま反射する。**
    - ページ本体（`LocalSections`）は `assembly.id` を本文に出さず、議員リンクは `p_32_…` なので `pref-32` を含まない。
    - → **この検査は実質「URL エコー検査」**。URL が `/assemblies/shimane/` になれば canonical も `shimane` になり、`grep -F -- "shimane"` は当たる。**移行によって壊れない。**
    - ただし **canonical が URL を反射しなくなった瞬間に壊れる**（例: canonical を「id で組み立てた正規 URL」に変える最適化を入れると、本文に slug が 1 度も出なくなり probe が落ちる）。→ **受け入れ条件に「canonical と og:url が slug URL を指すこと」を明記する**（下記）。
16. **旧 URL の 301 が生きていることを確かめるプローブ**を 1 本足す: `/assemblies/pref-32/` が `301` を返し、`Location` が `/assemblies/shimane/` であること。curl は `-o /dev/null -w '%{http_code} %{redirect_url}'` で確認できる。失敗時は既存の仕組みどおり `[monitor] production: …` Issue が開く。これは #248 のローテーションとは別枠（旧 URL は `/assemblies/` からリンクされないので自動列挙には乗らない）。
17. `docs/ops/monitoring.md` にチェック項目を追記。

### 8.5 sitemap / インデックス

18. sitemap.xml は 7 の変更で自動追随（新 slug URL だけが載る）。**旧 URL は sitemap に載せない**（301 先だけを申告するのが正しい）。載る `/assemblies` 系 URL は **10 本**（一覧 1 + 議会 9。§2.1 の「9 対 10」）。
19. デプロイ後、Search Console で `giinrecord.jp` の sitemap を再送信し、旧 9 URL が「リダイレクト」として認識されることを確認する。
20. 内部リンクに旧 URL が残っていないことは、既存の smoke（`checkBuild` の broken-link チェック）が自動で検出する。

### 8.6 ドキュメント

21. `docs/DATA_CONTRACT.md` に `slug` を追加（`id` が正・`slug` は URL 用、という関係を明記）。
22. 本ファイル（`docs/research/identifiers.md`）から実装 PBI へリンクする。

### 受け入れ条件（PBI 側）

- `/assemblies/shimane/` 他 **9 本**が 200 を返し、`/assemblies/pref-32/` 他 **9 本**が 301 で対応する slug へ飛ぶ（`/assemblies` 一覧には id が無いので 301 の対象外）
- sitemap.xml に slug URL だけが載る（旧 URL は載らない）。`/assemblies` 系は 10 本
- **リンク側（`assemblies.ts:29`）と列挙側（`data-files.ts:78`）の両方が slug になっている**。片方だけの変更が CI で落ちること
- **canonical と og:url が slug URL を指す**（#248 の probe が本文中の id リテラルを見るため。§8.4 の 15）
- `data/` のファイル名・議員 id・表決 id が **1 つも変わっていない**（`git diff --stat data/` が `assemblies/index.json` の 1 ファイルのみ）
- 旧 URL の 301 を確かめる監視プローブが入っている（`/assemblies/` 自体の監視は #248 で済み。追加不要）

---

## 9. やらないこと（明示）

- **議員 ID / 議員 URL は変えない**（§6）。`p_{prefCode}_…` の議会コード埋め込みは懸念として記録するに留め、別 Issue にする。
- **表決 id は変えない**（URL に出ない。§2.1）。
- **`diet-` は残す**（§5）。
- **`data/` の ID を rename しない**（案 A を採らない。§4）。
- **今スプリントでは実装しない**（§3。ドメイン改名当日のため）。
