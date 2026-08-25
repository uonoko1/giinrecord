# データ契約（`data/` のファイル仕様）

ETL（書く側）と Web（読む側）はこのファイル群だけで結合する。型は `packages/shared/src/index.ts` が正。
すべて UTF-8 の JSON。キーはソート済み、末尾改行あり（差分を小さくするため）。

```
data/
  meta.json                         DatasetMeta（取得日時・出典・対象回次）
  assemblies/
    index.json                      Assembly[]       議会の一覧（国会2件: diet-sangiin / diet-shugiin ＋ 地方議会の行。#156 / #157）
    {assemblyId}/                   地方議会のデータ（#157 / #158。最初は pref-04 宮城県議会。議員は下の members/ に載る）
      meta.json                     LocalAssemblyMeta（取得日時・出典・名簿の掲載日・対象会期・件数。不明セル数を含む）
      sessions.json                 AssemblySession[] 会期一覧（新しい順）。Web の議会ページが読む
      rollcalls/index.json          LocalRollCallSummary[] 表決一覧用（新しい順。votes 無し）
      rollcalls/{sessionId}/{id}.json LocalRollCall   議案 1 件の表決（全議員の LocalVote）
      unmatched.json                LocalUnmatchedName[] 表決 PDF の氏名のうち名簿に寄せられなかったもの（運用者が確認する）
  members/
    index.json                      MemberSummary[]  検索・一覧用（軽量）。assemblyId で議会を引く。地方議員の行（LocalMember、p_… id）も同じファイル
    {memberId}.json                 MemberDetail     議員ページ用（その人の全記録）。地方議員は LocalMemberDetail（timeline は localVote）
  rollcalls/
    index.json                      RollCallSummary[] 採決一覧用
    {session}/{rollCallId}.json     RollCall          採決ページ用（全議員の票）
  bills/
    index.json                      BillSummary[]    議案一覧用（軽量）。提出回次の降順・id 昇順
    {session}/{billId}.json         Bill             議案ページ用（提出者・賛成者・各院の結果・衆院の会派態度）。{session} は提出回次
  unmatched.json                    名寄せできなかった氏名表記のうち**回次が引けない行**（発言: speechId / 委員会出席の発議者: meetingId（kind: "attendance"）/ 委員会の役職: meetingId（kind: "committee"）。NDL の会議録 id は回次を含まない）
  unmatched/
    {session}.json                  名寄せできなかった氏名表記のうち**回次が引ける行**（票: rollCallId / 参法の発議者・衆院議案の提出者と賛成者: billId（後者は kind: "bill" 付き）/ 質問主意書の提出者: questionId（kind: "question"））。回次別に分ける（#219）
  unmatched-bills.json              議案情報の審議結果と紐づかなかった採決の一覧（人事案件・決議など。得票のみの result になる）
  unmatched-groups.json             名簿の会派略称のうち対応表（sangiin-groups.ts）に無いものの一覧（group は原文のまま公開され、運用者が対応表に追記する）
  group-mismatch.json               氏名で1人に紐づいたが、投票結果ページの会派がその議員のどの回次の名簿の会派とも一致しなかった票の一覧 {memberId, nameText, voteGroup, rosterGroup, rollCallId}（運用者が確認する）
  districts/
    by-zip.json                     Record<郵便番号7桁, { sangiin: string[]; shugiin: string[]; municipalities: string[] }>  郵便番号 → 選挙区の候補と市区町村名（Issue #111 / #120、月次）
    municipalities.json             { code, pref, city, shugiin: string[], split: boolean }[]   市区町村 → 小選挙区の候補（団体コード順）
    meta.json                       DistrictsMeta（出典 URL・取得日時・基準日・件数・分割市区町村の一覧）。日次の meta.json とは別
```

## 型（shared に追加する）

```ts
interface MemberSummary { id: MemberId; name: string; kana: string; house: House; assemblyId: AssemblyId; group: string; district: string; termEnd?: string; current: boolean; counts: { rollcalls: number; bills: number; speeches: number; questions: number } }
interface MemberDetail extends Member { timeline: TimelineEntry[] }
type TimelineEntry =
  | { kind: "vote"; session: number; date: string; rollCallId: string; title: string; value: VoteValue; result: string; groupValue?: VoteValue; sourceUrl: string }
  | { kind: "bill"; session: number; date: string; billId: string; title: string; role: "提出者" | "賛成者"; submitterText?: string; status?: string; sourceUrl: string }
  | { kind: "speech"; session: number; date: string; speechId: string; meeting: string; excerpt: string; chars: number; position?: string; sourceUrl: string }
  | { kind: "stance"; estimated: true; session: number; date: string; billId: string; title: string; group: string; stance: "賛成" | "反対"; stanceText: string; status?: string; sourceUrl: string } // 推定（衆院の会派態度）
  | { kind: "question"; session: number; date: string; questionId: string; title: string; submitterText?: string; status?: string; answerDate?: string; answerUrl?: string; sourceUrl: string } // 質問主意書（事実）
  | { kind: "attendance"; estimated: false; session: number; date: string; meetingId: string; meeting: string; role: "発議者"; bills: { billId: string; title: string }[]; sourceUrl: string } // 委員会に発議者として出席（事実。提出者ではない）
  | { kind: "committeeRole"; estimated: false; session: number; date: string; committee: string; role: string; meetings: number; firstDate: string; lastDate: string; meetingId: string; sourceUrl: string }; // 委員会の委員長・理事・委員として出席（事実。在任期間ではない）
interface RollCallSummary { id: string; session: number; date: string; title: string; totals: { total: number; yes: number; no: number }; result: string }
```

## 議会（`assemblies/`、Issue #156。`docs/research/local-assemblies.md`「DATA_CONTRACT 拡張の素案」を正式化）

国会と地方議会を同じ契約で扱うための土台。**この Issue では地方議会の ETL は実装しない**（型・ファイル・検証・URL 設計だけ）。

```ts
type AssemblyKind = "national" | "prefectural" | "municipal";
type DietAssemblyId = "diet-sangiin" | "diet-shugiin";
type AssemblyId = DietAssemblyId | `pref-${string}` | `city-${string}`;
interface Assembly { id: AssemblyId; kind: AssemblyKind; name: string; prefCode?: string; sourceUrl: string }
interface LocalVote { raw: string; legend: string; mapped?: VoteValue }   // 地方議会の表決値（原文保持）
```

- `house` は**国会の院**の意味のまま残す（`"sangiin" | "shugiin"`。既存 JSON の後方互換）。階層は `Assembly.kind`、所属は `Member.assemblyId` / `MemberSummary.assemblyId` で表す。国会議員の `assemblyId` は `diet-{house}`（`diet-sangiin` / `diet-shugiin`）。
- `Assembly.id`: 国会は `diet-sangiin` / `diet-shugiin`。都道府県は `pref-{団体コード上2桁}`（例 `pref-04` 宮城、`pref-36` 徳島）、市区町村は `city-{団体コード5桁}`（例 `city-33100` 岡山市）。団体コードは `districts/municipalities.json` の `code` と同じ体系なので、郵便番号 → 市区町村 → 議会 の結合がそのまま効く（#111）。`prefCode` は都道府県の団体コード上2桁で、`prefectural` / `municipal` に必須、`national` には無い。
- `Assembly.name` は公式表記（「参議院」「宮城県議会」）、`sourceUrl` は名簿（議員一覧）の入口。国会の2行は衆参のドメイン。地方議会の行は https。地方議会のレコード（名簿・会議結果）の `sourceUrl` はその議会の `Assembly.sourceUrl` のホストに限る（「衆参・NDL のドメイン」の不変条件を議会ごとの許可ホストに一般化する。地方 ETL 以降）。
- **URL**: 議会は `/assemblies/{assemblyId}/`、議員は既存の `/members/{id}` のまま。`MemberId` の空間は接頭辞で分ける: 参院 `m_…`、衆院 `h_…`、地方議会は `p_{prefCode}_…`（例 `p_04_…`）。国会の既存 URL は変えない。
- **表決値（地方）**: 国会の `VoteValue`（賛成／反対／投票なし）には触れない。地方議会の凡例（○×議欠－棄白、簡易／起立 …）は `LocalVote` で**原文のまま**保持する: `raw` はセルの原文（「○」「×」「欠」「－」「議」）、`legend` はその議会の凡例での意味の原文（「賛成」「反対」「欠席」「議場に不在」「議長」「棄権」「白票」）、`mapped` は凡例から機械的に国会の値へ対応づけられるときだけ（○→賛成、×→反対、欠席・退席・除斥・議長など「票を投じていない」と凡例が言うとき→投票なし）。凡例から読めなければ `mapped` は省略し、推定しない。Web は必ず `raw` と `legend` を添えて表示し、`mapped` だけを出さない（欠席と棄権を区別している事実を消さない。国会の「欠席と棄権を区別しない」は国会の公表形式に従った結果で、地方の公表形式まで丸めない）。
- 国会の既存データへの差分は `assemblies/index.json` の新設と `members/index.json` / `members/{id}.json` の `assemblyId` の追加だけ（それ以外は byte-identical）。
- 不変条件（`validateDataset`）: `assemblies/index.json` が存在し、`id` は空でなく一意、`kind` は3値、`name` は空でない、`national` は `prefCode` を持たず `sourceUrl` は衆参・NDL のドメイン、`prefectural` / `municipal` は `prefCode` が 01〜47 で `sourceUrl` は https。`members/index.json` の各行の `assemblyId` は `assemblies/index.json` に存在し、`house` が `sangiin` / `shugiin` なら `diet-{house}` と一致する。`members/{id}.json` の `assemblyId` は index と同じ。
- Web（`/members`）: 「院」の select（両院／参議院／衆議院）を「議会」の select（すべて＋`assemblies/index.json` の並び）に一般化する。既定はすべて。すべてを表示しているとき各行に議会名（`Assembly.name` の原文）を添える。`assemblies/index.json` が無い・`assemblyId` が無い古いデータは国会の2議会として読む（`house` から `diet-{house}`）。

### 地方議会の Web 表示が読む形（Issue #158。地方 ETL #157 はこの形で書く）

地方議会の議員は国会と同じ `members/index.json`（`assemblyId` が `pref-…` / `city-…`）と `members/{id}.json` に載る。`/members/{id}` は `assemblyId` が `diet-` で始まらなければ地方議員として描画する（`house` は見ない）。
地方議員の行は `LocalMember`（`packages/shared/src/index.ts`）: 国会の `MemberSummary` と違い **`house` を持たず**（`house` は国会の院の意味のままなので地方議員に付けない。トップの参院／衆院の人数にも数えない）、`counts` は `{ rollcalls }` だけ（議案・発言・質問主意書は取得していない）。名簿の `profileUrl` / `asOf`（掲載日）/ `sourceUrl` を持つ。detail（`LocalMemberDetail`）は `terms: [{ group, district, asOf }]`（名簿の掲載日時点の会派・選挙区。Web の議員ページは最後の行の `group` / `district` を出す）と `timeline`（`LocalVoteEntry` だけ、新しい順）。

```ts
// members/{id}.json の timeline に足す行（事実）。国会の VoteEntry（value: VoteValue）とは kind で分ける。
type LocalVoteEntry = { kind: "localVote"; date: string; rollCallId: string; title: string; vote: LocalVote; sessionLabel: string; method?: string; result?: string; sourceUrl: string }
// assemblies/{assemblyId}/sessions.json  AssemblySession[]  その議会の会期一覧（新しい順）。無ければ Web は「会期の一覧は未取得」と出す
interface AssemblySession { id: string; label: string; date: string; rollcalls: number; sourceUrl: string; fetchedAt: string }
```

- `LocalVoteEntry.vote` は `LocalVote`（`raw` / `legend` / `mapped?`）。`sessionLabel` は会期の原文（例「令和8年2月定例会（第399回）」。宮城は会期 index の h2 の表記）、`method` は表決方法の原文（例「起立」「簡易」）、`result` は議決結果の原文（例「可決」）。`sourceUrl` は表決結果の PDF／HTML（その議会の `Assembly.sourceUrl` のホスト）。
- Web の判（Stamp）は `mapped` がある行だけ賛成／反対／投票なしの色を使い、無い行は中立の判にする。どちらも判の文字は `raw`、隣に `legend` を必ず添える。
- `AssemblySession.id` は議会内で一意（例 `399`、`2026-06`）、`label` は原文（例「令和8年2月定例会（第399回）」）、`date` はその会期の最終議決日（ISO）、`rollcalls` はその会期の表決件数、`sourceUrl` は会期の表決結果ページ、`fetchedAt` は取得日時（ISO）。
- 議員ページはビルド時に `assemblies/{assemblyId}/rollcalls/index.json` も読み、`voteSubject` / `committeeReport`（あれば）を rollCallId で timeline に結合して採決行に注記する（#204。下の「賛否の対象」）。ファイルが無い議会（結合できない場合）は従来どおり表示する。
- 個人別表決の公開状況（公開／会派別／総数のみ／不明）は `data/` ではなく `apps/web/app/data/vote-disclosure.json`（#128 の調査表 `docs/research/local-assemblies.md` から機械的に起こしたもの。調査日付き）。`/assemblies/` が事実として表示する。

### 地方議会の ETL が書く原本（`assemblies/{assemblyId}/`、Issue #157。最初の議会は宮城県議会 `pref-04`、2 つ目は徳島県議会 `pref-36` #183、3 つ目は鳥取県議会 `pref-31` #184、4 つ目は三重県議会 `pref-24` #203）
### 地方議会の ETL が書く原本（`assemblies/{assemblyId}/`、Issue #157。最初の議会は宮城県議会 `pref-04`、2 つ目は徳島県議会 `pref-36` #183、3 つ目は鳥取県議会 `pref-31` #184、4 つ目は三重県議会 `pref-24` #203、5 つ目は奈良県議会 `pref-29` #202、6 つ目は島根県議会 `pref-32` #221）

上の「Web が読む形」（`members/` と `sessions.json`）は、この節の `rollcalls/` から機械的に起こす。型は `packages/shared/src/index.ts` の `LocalMember` / `LocalMemberDetail` / `LocalVoteEntry` / `AssemblySession` / `LocalRollCall` / `LocalRollCallSummary` / `LocalAssemblyMeta` / `LocalUnmatchedName`。国会の型には触れない。

- **id**: 議員は `p_{prefCode}_{名簿のプロフィールページの slug}`（例 `p_04_meibo_yuzuki`。氏名からは作らない）。表決は `{assemblyId}-{sessionId}-{議決日 yyyymmdd}-{議案種別}-{議案等番号}`（例 `pref-04-398-20251217-発議案-8`）。同じ会期に議決日が複数あっても一意。番号の無い行（決議案）は `無番号{その議決日・種別での通し番号}`。`sessionId` は議会内で一意（宮城は通算回次「398」）、`sessionLabel` は原文（「令和7年11月定例会（第398回）」）。
- **表決値**: `LocalVote { raw, legend, mapped? }`。`raw` は PDF のセルの原文、`legend` はその PDF の凡例の意味の原文（PDF ごとに凡例を読む。第398回は「○賛成 ×反対 議議長 除除斥 欠欠席 －議場に不在」、第399回は 除 が無く「棄棄権 白白票」がある）。`mapped` は ○→賛成、×→反対、凡例が「議長・欠席・議場に不在・除斥・退席」のとき→投票なし。棄権・白票・不明には付けない。
- **不明セル**: PDF の表を罫線（細い矩形）から復元し、文字の中心が入るセルにだけ置く。1 セルに 1 文字が入らない（空・2 つ以上・境界上）セルは `raw: "不明"`, `legend: "抽出不能"` として残し、`meta.counts.unknownCells` とワークフローの Summary に件数を出す。推定して埋めない。凡例に無い値が出たら ETL は失敗する。
- **表決方法・結果**: `method { raw, legend }`（「起立」/「起立採決」、「簡易」/「簡易表決(異議の有無を諮る)」）。簡易表決の個人票は PDF に書かれている値そのまま（「全員賛成」と推定しない）。`result` は議決結果の原文（「可決」「承認」…）、`counts` は PDF の出席者数・表決者数・賛成者数・反対者数（votes から数え直さない）。timeline（`LocalVoteEntry`）の `method` は `method.raw`（「起立」「簡易」）、`result` は `result` の原文（「可決」）。人数は `rollcalls/` の `counts` にだけある。
- **名寄せ**: 表決 PDF の氏名（縦書き 1 文字ずつを上から結合。空きマスは半角空白 1 つ）と名簿の氏名を、空白を除いた完全一致だけで寄せる。名簿に同じ氏名が 2 人いれば寄せない。寄せられない氏名（辞職・失職で名簿から消えた人など）は `memberId: ""` で `unmatched.json` に載せる。`members/` には名簿の人だけ（PDF にだけ出る人は作らない）。`sessions.json` の `date` は `rollcalls/` のその会期の最終議決日（表決の無い会期は書けない＝推定しない）。会派は PDF の凡例の正式名称（表決時点の事実）、名簿の会派は `LocalMember.group`。
- **日付**: 議決月日（M/D）は PDF 見出しの和暦年（令和N年）で西暦にする。会期の月より 6 か月以上前の月は翌年（11月定例会の 1月）。名簿の as-of はページの「掲載日」（`LocalMember.asOf`, `meta.rosterAsOf`）。
- **宮城県議会の取得先**（すべて `https://www.pref.miyagi.jp`）: 名簿は `/site/kengikai/18meibo-kaiha.html`（会派別）・`18meibo-kubetu.html`（選挙区別）・`18meibo-gojuuon.html`（五十音順）の 3 ページを突合（1 人でも食い違えば失敗）。会期は `/site/kengikai/kakohonkaigi.html` の h2「令和N年M月定例会／臨時会（第N回）」と、その下の「各議員の表決状況」リンク（2013-10 以降は会期ページ → PDF、それ以前は PDF 直リンク、2008 年以前はリンク無し）。直近 2 会期から（`--sessions N`）。
- **徳島県議会の取得先**（`pref-36`、Issue #183。すべて `https://www.pref.tokushima.lg.jp`）: 名簿は `/gikai/giin/kaihabetu/`（会派別。h3「会派名（N人）」）と `/gikai/giin/senkyoku/`（選挙区別。「氏名（ふりがな）」と「所属会派：…」）の 2 ページを突合（人・所属会派・人数が 1 つでも食い違えば失敗）。id は `p_36_{プロフィールページの slug}`（例 `p_36_kami`）。名簿に掲載日が無いので `asOf` / `meta.rosterAsOf` は**取得日（JST）**。会期は `/gikai/honkaigi/gaiyou/`（今年。figcaption「M月 定例会」＋「各議員の表決態度（審議の結果）」リンク）→ 足りなければ左ナビの前年ページ（`gaiyou/r07/` …）。会期ページの h1「令和8年6月定例会 …」が `sessionLabel`、`sessionId` は `{西暦}-{月2桁}`（`2026-06`）。会期ページには**採決日ごとに**「各議員の表決態度（M月D日採決）」PDF が並ぶ（請願審査報告書は読まない）。`meta.sessions[].pdfUrl` は最初の 1 本、`pdfUrls` に全部。各 `LocalRollCall.sourceUrl` はその行の PDF。
- **徳島の表決 PDF**: 表題「議案審査結果（令和８年７月３日）」の日付が `date`（PDF 側の日付とリンク文言の月日が違えば失敗）。節見出し「○ 知事提出議案」「○ 議員提出議案」「○ 請願」「○ 動議」が `kind`。行は 議案番号・案名・委員会審査結果（`committeeResult`、原文「可決」「－」「-」）・議員の列・議決結果（`result`）。表決方法と人数の欄は無いので `method` / `counts` は付けない（推定しない。timeline の `method` も無い）。節ごとに表の下の「※」行が凡例で、節ごとに違う（「退」退席・「除」除斥・「欠」欠席は出る節だけ）。凡例の 2 行目「「●」〃 に起立しなかった者」の「〃」は 1 行目の同じ位置の語（「委員会審査結果又は議長宣告」）に機械的に展開する（対応する語が無ければ失敗）。`mapped` は凡例の文面が完全一致するときだけ: 「議長」「退席」「欠席」「除斥」→ 投票なし。「○」（委員会審査結果又は議長宣告に起立（賛成）した者）は議案への賛成ではなく**委員会審査結果／議長宣告への起立**（請願の委員会審査結果が不採択なら ○ は請願を退けた側）なので、「賛成」に `mapped` しない。「●」（起立しなかった者）も凡例が反対と言っていないので `mapped` を付けない。どちらも `raw` と `legend` だけ（Web は中立の判で原文＋凡例を出す）。セルの「〇」（U+3007）は原文のまま `raw` に残し、凡例の「○」（U+25CB）として読む（同じ記号の字形違い）。
- **徳島の id**: `pref-36-{sessionId}-{採決日 yyyymmdd}-{節見出し}-{議案番号（NFKC。「第１号」→「第1号」）}`。同じ採決日・節で同じ番号の行が複数（第１号の原案と修正案、第77号 監査委員の選任 2 人）なら全部に `-1`, `-2` … を足す。番号欄に数字が無い行（動議の「-」）は `無番号{n}`。`number` は原文のまま（「第１号」「-」）。
- **鳥取県議会の取得先**（Issue #184。すべて `https://www.pref.tottori.lg.jp`。assembly id `pref-31`、`pnpm etl:local tottori`）: 名簿は `/75928.htm`（五十音順、1 ページ。各議員の h2 リンク「姓　名（かな）」とカテゴリのリンク＝選挙区「…選挙区」・委員会「…委員会」・会派（それ以外。ちょうど 1 つでなければ失敗））。議員 id は `p_31_item_{プロフィール /item/{番号}.htm の番号}`。名簿ページに掲載日が無いので `asOf` は各議員の項目の掲載日のうち最新（2023-04-30）。会期は `/87621.htm`「定例会・臨時会の概要」の年見出し「◆令和８年」と「6月定例会」等のリンク → 会期ページ（日程）のサブメニュー「議案等の議決結果」→ 議決結果ページ。議決結果ページの無い会期（会期中）は飛ばし、議決結果のある会期を新しい順に `--sessions N`（既定 2）。通算回次の表記が無いので `sessionId` は `{西暦}-{月2桁}`（臨時会は `-rinji`）、`sessionLabel` は「令和8年6月定例会」（見出しとリンク文言を NFKC で寄せたもの）。
  - **PDF**: 議決結果ページの、議決日付きの結果リンク（「6月29日可決」「3月9日可決」）と「議員別の賛否の状況」のリンク先（同じ会期に複数。全体版と部分集合版、同じファイルの複製がある）。陳情ごとの「不採択(pdf)」は陳情の文書で賛否表ではないので取らない。表は列＝議員（会派見出しの下に縦書き「○○議員」。同姓は「浜田一議員」「浜田妙議員」のように名の 1 文字付き）、行＝議案等（種別「知事提案」「議員提案」「陳情」「請願」＋番号「第1号」「7年-11」「附帯意見」（NFKC）、件名、賛成者数・反対者数・表決者数、議決結果、表決方法「起立」）。議決日は PDF 見出し「議決結果（令和8年6月29日議決分）」（議決日ごとに PDF が分かれる。id は `pref-31-2026-02-20260309-知事提案-第22号` のように議決日で分かれる）。出席者数は公表されないので `counts.present` は無い。表決方法の凡例は無いので `method.legend` は原文と同じ。件名は「件名」列の左端に揃った行だけ（陳情の本文の引用は 1 文字分インデントされているので含めない）。同じ議案が複数の PDF に出たら内容（票・人数・結果・方法・委員長報告・件名）の一致を確かめて 1 件にし、食い違えば失敗（どちらが正しいか推定しない）。`sourceUrl` は最初に出た PDF。
  - **賛否の対象**（`LocalRollCall.voteSubject` / `committeeReport`、任意項目）: 表の節見出しの行に「議案に対する賛否」「委員長報告に対する賛否」とある。請願・陳情の ○ は**委員長報告（例「不採択」「研究留保」）への賛成**であって請願そのものへの賛成ではないので、節見出しの原文を `voteSubject`、「委員長報告」列の原文を `committeeReport` に残す（節見出しの無い PDF（議員提出議案だけの版）では `voteSubject` を付けない）。Web は議員ページがビルド時に `rollcalls/index.json` を rollCallId で timeline に結合し、採決行と表決タブに「賛否の対象：委員長報告（不採択）」と表示する（#204。「議案に対する賛否」＝既定の読み方は注記しない。知らない原文は言い換えずそのまま出す）。
  - **凡例**（表の最終ページの下）: 「○」賛成 「×」反対 「議」議長 「副」副議長が議長の職務を代理 「棄」棄権 「除」除斥 「欠」欠席 「－」議場に不在であり、表決しなかった議員。`mapped` は ○→賛成、×→反対、議長・副議長が議長の職務を代理・除斥・欠席・議場に不在であり、表決しなかった議員→投票なし（凡例の文言がこのとおりのときだけ）。棄権には付けない。凡例より後ろの「別紙」（陳情の本文）のページは読まない。
  - **名寄せ（姓のみ）**: 名簿の氏名（空白を除く）が PDF の「議員」を除いた文字列で始まる議員が**ちょうど 1 人**のときだけ寄せる。0 人・2 人以上は `memberId: ""` で `unmatched.json` に載せ、候補を `candidates[{id, name}]` に**全員列挙する（選ばない）**。2026-08 時点の名簿（浜田 一哉・浜田 妙子）では PDF 側が名の 1 文字を添えているので unmatched は 0。
  - 既知の原文の揺れ（そのまま記録する）: 令和8年6月定例会の議案第2号は HTML の議決結果が「可決」で PDF の議決結果欄が「決定」。議員の列の並びは会期で変わる（2月と 6月で無所属の 2 人の順が違う）ので PDF ごとに読む。陳情だけの版の PDF では、ページをまたぐ長い陳情の行が 1 ページ目の最後の横罫線より下（縦線の下端まで）に置かれ、2 ページ目では表の上端より上（罫線の外）に繰り返される。前者は縦線の下端までを行として読み、後者は置けないので読まない。
- **三重県議会の取得先**（Issue #203。すべて `https://www.pref.mie.lg.jp`。assembly id `pref-24`、`pnpm etl:local mie`）: 名簿は 選挙区別５０音順（`/KENGIKAI/08089011294.htm`。選挙区・氏名・ふりがな・会派の表。h2 の「（令和７年１１月１８日現在）」が `asOf` / `meta.rosterAsOf`。鈴鹿市の欠員は空行）と、選挙区別名簿（`08096011310.htm`）→ 15 選挙区ページ（議員ごとに `a name` の slug・ふりがな・氏名・所属会派。人数＝h1 の定数−欠員）を突合する（1 人でも欠ければ・ふりがな か 会派が食い違えば失敗）。議員 id は `p_24_{a name の slug}`（例 `p_24_aoki_kenjyun15`）、`profileUrl` は選挙区ページ＋`#slug`。会期は「議案審議結果一覧」（`07976009017.htm`。1 ページに全会期）: h2「令和８年定例会」（通年議会。年 1 会期が基本。令和5年は第1回・第2回に分かれ、臨時会の年もある）ごとに h3「議員別の賛否等の状況」の下に月別の賛否 PDF（リンク文言「令和８年２月」。リンクの年が会期の年と違えば失敗）。`sessionId` は和暦から機械的に（`r08` / `r05-2` / `h21-1-rinji`。平成31年と令和元年がどちらも 2019 年なので西暦では一意にならない）、`sessionLabel` は h2 の原文。賛否 PDF の無い会期（平成19年以前）は読まない（公表されていない事実）。
- **三重の表決 PDF**: 表題「令和８年定例会（２月）」の会期名は h2 と、月はリンク文言と一致しなければ失敗。左 8 列（議案等番号・件名・議決月日・出席者数・表決者数・賛成・反対・議決結果）＋議員の列（上段に会派の**正式名称**の結合セル（略称の凡例は無い）、下に縦書き氏名。1 ページに全議案×全議員の高密度の表で、議案が多い月は同じ形のページが増える＝ヘッダは毎ページ繰り返し、議員の列が一致しなければ失敗）。凡例は「○：賛成 ×：反対 議：議長 除：除斥 －：不在 欠：欠席」。`mapped` は ○→賛成、×→反対、凡例が「議長・除斥・不在・欠席」→投票なし。表決方法の欄は無いので `method` は付けない。`counts` は 出席者数・表決者数・賛成・反対（present / voting / yes / no）。`kind` / `number` は議案等番号の接頭辞と「第N号」（「意見書案第８号」→ kind `意見書案`・number 原文 `第８号`。分けられなければ失敗）。id は `pref-24-{sessionId}-{議決日 yyyymmdd}-{kind}-{number の NFKC}`（例 `pref-24-r08-20260630-意見書案-第8号`）。議決月日（M/D）の月は表題の月と一致しなければ失敗（月ごとの PDF なので年またぎは無い。年は表題の和暦年）。文字は getTextContent でなく**オペレータ列**（setTextMatrix ＋ showText。1 命令 1 アイテム）から読む（`mie/glyphs.ts`。令和8年5月分では pdfjs の getTextContent が隣の列の先頭の「辻󠄀」（異体字セレクタ付き）を前の氏名の末尾に結合して位置を失うため。位置の前提が崩れる命令（moveText 等）が出たら失敗）。名寄せは氏名の空白と**異体字セレクタ**（IVS。PDF の「辻󠄀」と名簿の「辻」）を除いた完全一致（字そのもの（髙/高）は寄せない）。
- **奈良県議会の取得先**（Issue #202。すべて `https://www.pref.nara.lg.jp`。assembly id `pref-29`、`pnpm etl:local nara`）: 名簿は `/n161/52534.html`（五十音順、1 ページ。table.datatable の行 = 議員名（プロフィール `/n161/{番号}.html` へのリンク）・ふりがな・選挙区・当選回数・所属会派）。議員 id は `p_29_{プロフィールページの番号}`（例 `p_29_52536`）。`asOf` は表の直後の「（令和8年4月24日現在）」（無ければ失敗。取得日で代用しない）。会期は `/n161/18579.html`「定例（臨時）県議会の概要」の「令和8年6月定例会の概要」リンク（新しい順）→ 会期ページ（`/n161/p114029.html` など。h1 がリンク文言と食い違えば失敗）の「議員別の議案等に対する表決結果」PDF（議決日ごとに 1 本。無い会期＝会期中は飛ばす）。通算回次の表記が無いので `sessionId` は `{西暦}-{月2桁}`（臨時会は `-rinji`）、`sessionLabel` は「令和8年6月定例会」。
  - **表決 PDF**: 見出し「議員別の議案等に対する表決結果（令和8年6月定例会 7月2日議決分）」の議決日が `date`（和暦年は会期の年。議決月が会期の月より 6 か月以上前なら翌年）。表は 種別（縦書きの結合セル「知事提出議案」「議員提出議案」「決議」「意見書」）・議案等名（「議第56号 …」「報第1号 …」「第4号 …」。専決処分の報告の行は内訳の小行ごと 1 行で、件名はつなげて 1 つ）・議決結果（「原案可決」「原案同意」「原案承認」「報告受理」。2 段組もつなげる）・議員の列（上段に会派の結合セル、下に縦書きの氏名）。「＜令和8年度議案＞」の行は年度の区切りで表決の行ではない。表決方法・人数の欄は無いので `method` / `counts` は書かない（推定しない）。id は `pref-29-{sessionId}-{議決日 yyyymmdd}-{種別}-{議案等番号（NFKC）}`（例 `pref-29-2026-02-20260325-決議-第1号`。同じ議決日・種別で同じ番号の行が複数なら全部に `-1`, `-2` … を足す（徳島と同じ））。
  - **凡例**（最終ページの表の下の 1 行「賛否等欄：…」）: 「○」賛成 「×」反対（起立採決において、起立しなかった議員） 「議」議長 「副」副議長が議長職務を代行した場合 「除」除斥 「欠」欠席 「退」表決を棄権 「―」不在（除斥、欠席及び表決を棄権した場合を除く）。`mapped` は ○→賛成、×→反対、議長・副議長が議長職務を代行した場合・除斥・欠席・不在（…を除く）→ 投票なし（凡例の文言がこのとおりのときだけ）。退（表決を棄権）には付けない。会派見出しは表決時点の原文（2026-03 の PDF には 立憲民主党 があり 改新なら が無い。名簿と食い違ってもそのまま）。
  - **名寄せ（文字層の欠け）**: PDF の文字層は一部の字が落ちる（「芦髙清友」の外字「芦」が 6月分に無い、「西川均」の「均」が両方に無い。異体字セレクタ付きの字（芦󠄀）や 髙/高 の字形違いもある）。空白・異体字セレクタを除き 髙/高・﨑/崎・𠮷/吉 を寄せた完全一致 → 無ければ「名簿の氏名に PDF の氏名が順序どおり部分列として含まれる」議員が 1 人に決まるときだけ寄せる。2 人以上は `unmatched.json` に候補を全員列挙して選ばない。欠けた氏名も `nameText` は PDF の原文のまま残す（推定で補わない）。
- **島根県議会の取得先**（Issue #221。すべて `https://www.pref.shimane.lg.jp`。assembly id `pref-32`、`pnpm etl:local shimane`）: 名簿は選挙区別（`/gikai/gaido/meibo/tiku.html` の 12 選挙区リンク → 各選挙区ページ。議員 1 人ぶんが 1 セル（表の td / th。1 人区は表が無く `<p>` だけ）で、ふりがな・氏名（プロフィール `/gikai/gaido/meibo/simeibetu/{slug}.html` へのリンク）・所属会派が並ぶ）。議員 id は `p_32_{slug}`（例 `p_32_giin33_fukuda`）。`asOf` は選挙区ページの「（令和5年5月17日現在）」のうち最新（どのページにも無ければ失敗。取得日で代用しない）。会期 index は 2 つに分かれていて、`/gikai/ugoki/saikin/`「最近の定例会の概要」（会期中〜直近の 1 会期。リンク文言に通算回次「（第４９９回）」がある）と `/gikai/ugoki/gikai_kako/`「過去の定例会の概要」（年見出しごと。回次は無い）を合わせて新しい順にする（同じ会期ページは 1 つに）。`sessionId` は回次があれば回次（「499」。宮城と同じ）、無ければ `{西暦}-{月2桁}`（臨時会は `-rinji`）。`sessionLabel` はリンク文言（「令和8年6月定例会（第499回）」）。会期ページ（`/gikai/ugoki/saikin/r0806/` など。h1 は回次を含まないので、index の文言から回次を除いて突き合わせる）の「議決結果」の節にある「議員別採決結果一覧」PDF（`index.data/r0806_giinbetu_kekka.pdf`）を読む（無い会期＝会期中は飛ばす）。
  - **表決 PDF**（4 ページ、文字層あり。罫線はページ全体の格子だけで 1 議案 1 行の高さと一致しないので、罫線ではなく文字の位置で表を復元する）: 列は 議案番号 / 件名 / 付託委員会 / 採決結果 / 賛成 / 反対 と、等間隔（約 11.9pt）に並ぶ議員の欄（縦書きの氏名。上が姓・下が名）。行の基準は議案番号の欄（1 議案に 1 つ、行の中心）。件名が複数行の議案・付託委員会が複数の議案は行が高い。**付託委員会は 1 議案に複数あることがある**（一般会計補正予算は 4 常任委員会すべて）ので、等間隔に積まれたブロックごとにまとめてブロックの中心が最も近い行に入れ、`referredCommittees` に PDF の並び順のまま**全部**残す（1 つに丸めない）。委員会付託を省略した議案はその欄の原文「ー」だけ。節見出し「（議案）」「（請願）」「（その他表決）」が `kind`。`counts` は PDF の賛成者数・反対者数（`votes` から数え直さない。表決者数・出席者数は公表されていないので付けない）。表決方法の欄は無いので `method` は書かない（推定しない）。id は `pref-32-{sessionId}-{議決日 yyyymmdd}-{種別}-{議案等番号}`（例 `pref-32-499-20260702-議案-第77号`）。
  - **表決 PDF は会期ごとに作りが違う**（#232。令和8年6月と令和8年2月で確認。テストは 2 会期ぶんのフィクスチャで行う）。決め打ちにせず、その PDF から毎回引き直す:
    - **列の x**: 会期によって表の幅・位置が違う（6月は 議案番号 の中心が x=62.9、2月は x=66.2）。ヘッダの文字（議案番号／件 名／付託委員会／採決結果／賛 成／反 対）の位置から引く。議案番号｜件名 と 件名｜付託委員会 の境目はヘッダの中心の中点では足りない（どちらも欄の左端に寄せて書かれ、ヘッダはセルの中心にある）ので、本文の文字が実際に書き出される x から引く（前者は 2 つのヘッダの間の一番広い隙間の真ん中、後者は「同じ x に一番多く並んでいる書き出し」＝付託委員会の欄の左端の手前まで）。見分けられなければ失敗する（黙って通さない）。
    - **節見出しは無いことがある**。令和8年2月の PDF には「（議案）」等が 1 つも無く、全部が「議案番号」という 1 つの表になっている。その場合の `kind` は、議案番号の欄のヘッダの語（「議案番号」→ `議案`。請願だけの節のページでは「番号」）と、番号自身が別の種別を名乗っている行（「請願第28号」→ `請願`）の接頭辞から取る。どちらも PDF に書かれている語で、推定で足した語ではない。
    - **隣り合う 2 つの欄の中身が 1 つの文字列で書かれている行がある**（「議 員 提 出 第 2 号 島根県議会委員会条例の一部を改正する条例」＝議案番号＋件名、「非常勤の職員等の…条例 総務委員会」＝件名＋付託委員会）。欄の変わり目には空白が入っているので、右の欄の書き出しまで届いている文字列だけを「右側に空白がもう出てこない最後の空白」で切り分ける（議案番号は字間に空白を入れて書かれるので、一番近い空白ではなく最後の空白で切る）。空白が無ければ切らない（推定で切らない）。
    - **議決結果一覧との突き合わせは NFKC で寄せる**。同じ会期でも 2 本の PDF で数字の全角・半角が違うことがある（令和8年2月は議員別が「承認第１号」、議決結果一覧が「承認第1号」）。
  - **議決日**: 議員別採決結果一覧に議決日が書かれていないので、同じ会期ページの「議決結果一覧」PDF（`r0806_giketu_kekka.pdf`）から議案番号ごとに読む（「第77号議案 … （７月２日 原案可決）」。年は「知事提出議案（令和８年６月９日提出）」の和暦から）。議決結果がこの 2 つの PDF で食い違えば失敗する（別の会期の PDF を組み合わせない）。請願・その他表決は議決結果一覧に載らないので、その会期の最終議決日を使う。
  - **凡例**（1 ページ目）: 「○」賛成 「●」反対 「棄権」棄権 「－」欠席等による不在 「除斥」議案と一定の利害関係を有する議員。`mapped` は ○→賛成、●→反対、議長・欠席等による不在・議案と一定の利害関係を有する議員→投票なし。棄権には付けない（欠席と区別している事実を消さない）。議長の欄の「議⾧」（長は異体字 U+2FE7）は記号の凡例一覧には無いが、注記「議⾧の職務を行う者は採決に加わりません」がその意味を書いているので、それを凡例として `legend` に入れる（注記が無いのに「議⾧」が出たら失敗）。「議⾧」「除斥」は 1 セルの中の縦書き 2 文字で、○ ● の無い行をまとめて覆う結合セル（議長は複数の議案にわたって議長のまま。会期途中で議長が交代する回（その他表決）では列が変わる）なので、その列で ○ ● の無い行にそのラベルを入れる。凡例に無い値が出たら失敗し、置けないセルは `不明`（凡例「抽出不能」）として数える。付託委員会欄の「－」の意味・請願の※注記も `notes` に原文で残す。
  - **請願の賛否の対象**: PDF の※注記のとおり、請願の「賛成・反対」は請願そのものではなく**付託先委員会の報告**（採択／不採択）に対するもの。○ を請願への賛成と読ませないため `voteSubject` に「付託先委員会の報告に対する賛否」、`committeeReport` に委員会の報告（＝採決結果の原文）を入れる（鳥取 #184 と同じ扱い）。
  - **名寄せ**: PDF の氏名はフルネーム（縦書きを上から結合）なので、空白・異体字セレクタを除き字形違い（德/徳・髙/高・﨑/崎・𠮷/吉）を寄せた完全一致で 1 人に決まるときだけ寄せる（名簿の「絲原徳康」と PDF の「絲原德康」）。決まらなければ `memberId` は空のままで `unmatched.json` に候補を列挙する（選ばない）。
- **高知県議会の取得先**（Issue #220。すべて `https://gikai.pref.kochi.lg.jp`。assembly id `pref-39`、`pnpm etl:local kochi`）: 名簿は 議員名簿（会派別）`/member/categories/`（1 ページ。会派の見出し行「自由民主党（20人）」ごとに 議席番号・氏名・ふりがな・常任委員会・選挙区 の行が並ぶ。見出しの「（N人）」と読めた行数が合わなければ失敗）。議員ごとのプロフィールページは**無い**（リンクが張られていない）ので `profileUrl` は名簿ページ自身。議員 id は `p_39_{議席番号}`（例 `p_39_1`）で、欠員の議席は行が無いので飛ぶ（令和8年7月30日現在は 定数37・現員36、議席 23 が欠員）。`asOf` は名簿の「令和８年７月30日現在」（無ければ失敗。取得日で代用しない）。会期は「議員別賛否の状況」`/activity/decision.html`（1 ページに全会期。リンク文言「令和８年６月定例会議決結果一覧[PDF：146KB]」）から会期ごとの PDF を新しい順に。奈良・三重と違い会期ごとの中間ページは無い。`sessionId` は `{西暦}-{月2桁}`（臨時会は `-rinji`）、`sessionLabel` はリンク文言の会期部分の原文（「令和８年６月定例会」。全角数字のまま）。
  - **表決 PDF**（会期ごとに 1 本）: 表題「令和８年６月定例会議決結果一覧表」の会期が index のリンク文言と食い違えば失敗（index は「議決結果一覧」、PDF 内は「議決結果一覧表」で末尾の「表」の有無が違う）。表は 議案種別（縦書きの結合セル「知事提出議案」「議員提出議案」）・番号（「第１号」「報第１号」「議発第12号」）・件名・議決年月日（「R8.7.10」）・議決結果（「原案可決」「同意」「承認」「否決」）・議員の列（上段に会派の結合セル、下に縦書きの氏名）・賛成者数・反対者数。`counts` は `LocalRollCall` に無いので書かないが、**復元した ○ / × の「数」が PDF 自身の賛成者数・反対者数と一致するかを検算**する（原文どうしの突き合わせ。cells は議員の列 `voteCols`、人数は別列 `countCols` から読むので独立）。この検算が保証するのは**セルの脱落・余剰の検出**であって、**列のずれ（off-by-one）は検出しない**（員数は並べ替えに対して不変なので、全議員の賛否が 1 列ずれても数は変わらない）。列のずれは「どの議員がどう投じたか」を原文どおりに固定した**ゴールデンテスト**が受け持つ（`packages/etl/test/kochi-votes-pdf.test.ts`。実 PDF 2 本とも全会一致の行が 0 なので、1 列ずれれば必ずどこかの議員の値が変わる。「1 列シフトを員数の検算は捕まえず・ゴールデンは全行で捕まえる」ことを回帰テストにしてある）。表決方法の欄は無いので `method` は書かない。id は `pref-39-{sessionId}-{議決日 yyyymmdd}-{議案種別}-{番号}`（例 `pref-39-2026-06-20260710-知事提出議案-第1号`。同じ議決日・種別で同じ番号の行が複数なら全部に `-1`, `-2` … を足す（徳島・奈良と同じ））。
  - **「〃」（同上）**: 議決年月日・議決結果の欄は上の行と同じとき「〃」になる。`date`（ISO が要る）は上の行から継ぐが、`result` は**原文の「〃」のまま**残す（前の行の値で埋めない）。先頭行が「〃」なら継ぐ先が無いので失敗。
  - **凡例**（最終ページの表の下「・議決結果の見方」）: 「○・・賛成、×・・反対、議・・議長、副・・副議長が議長の職務を代理、欠・・欠席、除・・除斥、－・・議場に不在であった議員」。`mapped` は ○→賛成、×→反対、議長・副議長が議長の職務を代理・欠席・除斥・議場に不在であった議員→ 投票なし（凡例の文言がこのとおりのときだけ）。凡例の但し書き（「※過半数議決の場合、議長に議決に加わる権利（表決権）はなく…」「特別多数議決で法定されたものは議長にも表決権があります。」）も原文のまま残す。会派見出しは表決時点の原文（令和7年6月の PDF には 武石利彦・田所裕介・橋本敏男 が居て今の名簿に無い → `unmatched.json`）。
  - **文字の読み方**: 賛否の 1 行ぶん（議員 36 人）が 1 つのテキストにまとまる回がある（令和7年6月分。`getTextContent` では列と値の対応が失われる）ので、三重と同じくオペレータ列から 1 文字ずつ位置を読む（`kochi/glyphs.ts`。こちらの PDF は行送りに `moveText`（Td）も使うので Td/TD/T* を仕様どおり畳み込む。等間隔での割り付け＝推定はしない）。縦線は横罫線で区切られた帯ごとに分けて描かれるので x でまとめてから帯を跨いで繋がりを見る。会派/氏名の境の横罫線は議員の列のぶんしか無く表の右端まで届かない。結合セル（議案種別）の縦書きはセルの外へはみ出して描かれるので、中心のいちばん近いセルに入れる。
- **不変条件（`validateLocalAssemblies`、`validateDataset` から呼ぶ）**: `assemblies/index.json` の地方議会の行ごとに `assemblies/{id}/` があれば検査する（無くて `members/index.json` にその議会の行があれば違反）。全ファイルが stableJson。全レコードの `sourceUrl`（と `profileUrl`）のホストはその議会の `Assembly.sourceUrl` のホストに一致し https。`members/index.json` のその議会の行は id が一意で `p_{prefCode}_…`、`house` を持たず、`assemblyId` は index の id、`asOf` は ISO 日付。`members/{id}.json` は `terms[{group, district, asOf}]` を持ち、timeline は `localVote` だけ・新しい順・`counts.rollcalls` と一致。`sessions.json` は新しい順・id 一意で、各行の `rollcalls` と `date` は `rollcalls/index.json` のその会期の件数・最終議決日に一致（会期の集合も一致）。`rollcalls/index.json` は新しい順で votes を持たない。各 `LocalRollCall` の `votes[].value` は `raw`・`legend` が空でなく `mapped` は 3 値だけ（不明には付けない）。`method` はあれば `raw` と空でない `legend` を持つ（無い議会＝徳島は省略）。`referredCommittees` はあれば空でない文字列の空でない配列（付託委員会の欄がある議会＝島根だけ）。`counts` はあれば `yes` / `no` が数値で、`present`（宮城）・`voting`（宮城・鳥取）は公表する議会だけ。`memberId` は index にあるか、空なら `unmatched.json` に載っている。議員ごとの timeline の件数＝rollcalls/ にあるその人の票の数。`meta.counts` の members / rollcalls / cells（議員数×議案数、不明を含む）/ unknownCells / unmatchedNames が実ファイルと一致。
- `assemblies/index.json` と `members/index.json` は国会の日次 ETL と共有する: 日次 ETL は国会の行を書き、既にある地方議会の行（`assemblies/index.json` の `pref-…` / `city-…`、`members/index.json` の `assemblyId` が `diet-` 以外の行とその `members/{id}.json`）を残す（地方の行が無ければ従来どおり＝byte-identical）。地方 ETL は自分の議会の行だけ入れ替え（名簿から消えた人の `members/{id}.json` も消す）、国会の 2 行がまだ無ければ補う。並びは国会の行 → 地方の行（`assemblies/index.json` は id 順、`members/index.json` は assemblyId 順 → id 順）。

## 不変条件
- `RollCall.votes[].memberId` は `members/index.json` に存在する id、または名寄せ失敗時は `""`（その場合 `unmatched.json` に載る）。
- `Σ groups[].size === votes.length`（会派人数と個人票の件数は一致する）。
- `MemberSummary.group` は会派の正式名称（投票結果ページと同じ表記。名簿の略称「自民」「い党」等は ETL が解決する）。解決できなかった略称は原文のまま入り `unmatched-groups.json` に載る。
- `MemberSummary.current` は最新回次（`meta.sessions` の最大）の名簿に載っているか。辞職・任期満了・補選で入れ替わった議員も `false` のまま残り、票の事実は消えない。Web の `/members` は既定で現職のみを出し、トグルで元職も出す。
- `Member.terms` は回次ごとの名簿の (会派, 選挙区, 任期満了) を新しい順に並べ、隣接する回次で同じなら1つに畳む（`sessionFrom`〜`sessionTo`）。氏名・かなは最新回次の表記。
- 採決時点の会派は回次で引く（`groupAt(member, session)`）。名簿は会期後のスナップショットなので、第 N 回の採決には第 N 回の名簿の term、無ければ（会期中の辞職・任期満了）手元で最も新しい過去の回次の term を使う。後の回次の名簿しか無ければ「不明」とし、会派移動の時期を推定しない。
- 名寄せは「氏名＋採決時点の会派」。氏名で1人に絞れるときは会派が食い違っても紐づけるが、投票結果ページの会派がその議員のどの回次の名簿の会派（略称・旧称を含む）とも一致しなければ `group-mismatch.json` に載る（`voteGroup` は投票ページの原文、`rosterGroup` は採決時点の名簿の会派。採決時点の名簿が無ければ手元の全会派を `/` で連結）。同姓同名は採決時点の会派で分け、分けられなければ `unmatched.json` に載る（別の回次の会派では推定しない）。`memberId` は `members/index.json` に、`rollCallId` は `rollcalls/index.json` に存在する。
- `timeline` は日付降順（回次をまたいでも一つの timeline）。
- `timeline` の全行が `session`（国会の回次）を持つ（#103）。vote は採決の回次（`rollCallId` の先頭 `{回次}-` と一致。`validateDataset` が検査する）、bill は議案の提出回次（`billId` の先頭）、speech は会議録の回次（API の `session`）、stance は議案の提出回次、question は質問の回次、attendance は会議の回次、committeeRole は会議の回次。Web の議員ページは `session` で回次ごとに折りたたむ（直近 2 回次を展開、それ以前は「第N回国会・件数」の見出しだけ）。`session` の無い行は #103 以前の出力で、Web は「回次不明」として最後にまとめる（推定しない）。
  - **引き継ぎ（carried）での回次の復元（#235）**: `readCarried` は `session` の無い古い行を捨てず、id の先頭から回次を引いて引き継ぐ（`sessionOfEntry`）。引けるのは `questionId` = `{回次}-{house}-{番号}` と `billId` = `{提出回次}-{種別}-{番号}` の行（未突合の置き場所と同じ規約）。`speechId` / `meetingId` は NDL の会議録 id で回次を含まないので引けず、件数だけ警告に出す。2026-08-24 に、`session` を持たない question 行 524 件が carried で落ち、`writeDataset` の `members/` 全消しで**黙って消えた**（#235）。
  - **消失の検出（#235）**: ETL は書き出す前に、前回出力の `members/index.json` と今回組み立てた index の `counts`（rollcalls / bills / speeches / questions）の合計を突き合わせ、**どれかが減っていたら `data/` を書かずに非0終了する**（`lostTimelineEntries`。採決に対する `lostVoteMatches` と同じ扱い）。増える・同じは正常。回次を減らす意図的な再構築は `data/` を消してから実行する（前回出力が無いので引っかからない）。
  - **回次粒度の消失の検出（#256）**: 上の合計（議会 × 種別）は、**同じ院・同じ種別の中の入れ替わり**を素通りさせる（第221回の衆院発言 851 件が消え、第200回のバックフィルが同数入れば合計は変わらない）。そこで ETL は同じ場所で、前回出力の `members/{id}.json` の timeline を **議会 × 回次 × 種別**でも数え、この粒度で減っていたら同じく `data/` を書かずに非0終了する（`lostSessionEntries`）。回次は行の `session` だけを見る（`sessionOfEntry` のような id からの復元はしない。引ける行と引けない行で粒度が混ざると偽陽性になる）。`session` の無い #103 以前の行は数えず、合計側の `lostTimelineEntries` だけが覆う。**この検出が保証しないこと**: (a) 同じ議会・回次・種別の中で行が別のものに**すり替わる**こと（`speechId` / `questionId` の同一性は見ていない）、(b) 行の**中身**の劣化（`date` / `title` / `sourceUrl` / 紐づけ先議員の入れ替わり）。どちらも件数が変わらないので、これは**件数だけの検算**であることを忘れないこと。偽陽性の範囲は #235 と同じ（回次を減らす再構築は `data/` を消してから実行する。改選で名簿から消えた議員の行が落ちる分は回次を鍵に足しても増えない）。データ提供元の訂正で正当に減るときも止まるので、その場合は差分を確認したうえで `data/` を消して作り直す。
  - **名寄せの厳格化で意図的に減るとき（#230）**: 紐づけの規則を厳しくする変更は、正しく動くほど前回出力より行が減るので、この 3 つの検出（`lostVoteMatches` / `lostTimelineEntries` / `lostSessionEntries`）に必ず引っかかる。**検出を緩めるフラグは足さない**（同じ緩めが後日の事故の見落としになる）。既存の escape hatch をそのまま使う: `data/` を消してから全回次を取り直す（前回出力が無いので 3 つとも引っかからない）。手順は `docs/ops/etl.md`。減った件数は PR と `DATA_CONTRACT.md` に数字で残し、「意図した減少」であることを事実として書く。
- どのレコードも `sourceUrl` を持ち、衆参・NDL のドメインを指す。
- `RollCallSummary.result` / `TimelineEntry(vote).result` は必ず得票「賛成 N・反対 N」を含む。参院 議案情報の審議結果（原文: 可決・否決・同意・是認 など）と紐づいた採決は「可決（賛成 N・反対 N）」の形。可否を多数決から推論しない。
- 「投票なし」は欠席と棄権を区別しない。区別した表現を作らない。
- `TimelineEntry(bill)` は参院 議案情報の議案詳細ページ（meisai）から作る。`sourceUrl` は必ずその議案ページ（`https://www.sangiin.go.jp/japanese/joho1/kousei/gian/{回次}/meisai/m….htm`）。`date` は議案ページの「提出日」（参法の参議院への提出＝受理の日）。`billId` は `{回次}-{種別}-{提出番号}`（例 `221-参法-16`）。`counts.bills` は timeline の bill 行の数。
- 参法の「発議者」欄に載る氏名は筆頭者だけ（原文「打越さく良君 外9名」）で、「外N名」と賛成者の氏名は議案ページにも提出法律案 PDF にも公表されていない。載っている氏名だけを `role: "提出者"` にし、人数の事実は `submitterText` に原文のまま残す。誰が「外N名」かを推測しない。`role: "賛成者"` は型として残すが、現在の一次資料からは生成されない。参議院公報（Web 版）・参議院法制局・国会会議録（委員会の出席者欄に載るのは出席した発議者だけ）・衆院の経過ページにも全員の氏名は無いことを #63 で確認した（`docs/research/sangiin-cosponsors.md`）。
- 委員会提出の参法（議案ページの「提出者区分」が「委員会発議」。例 217/meisai/m217100217005.htm「提出者 厚生労働委員長」）には発議者欄が無く、「提出者」欄に委員長の役職名だけが載る。役職名は個人の氏名ではないので名寄せせず、bill 行（timeline）にも `unmatched.json` にも載らない。ETL はこれを黙って落とさず件数と id・提出者の原文（例「厚生労働委員長」）をログに出す（Issue #64）。一覧の参法件数と timeline の bill 行の差はここから生じる。
- 閣法に発議者は無く、衆法の発議者は衆議院議員（参院名簿に無いのが正常）なので、bill 行は参法だけから作る。議案ページに会派が無いので同姓同名は絞れず `unmatched.json`（billId 付き）に載る。
- `TimelineEntry(bill).status` は議案ページの経過ブロック（参議院委員会・参議院本会議・衆議院委員会・衆議院本会議・公布）のうち日付が最新のものを「段階名 議決の原文」で（例「参議院本会議 可決」「参議院 環境委員会 未了」「公布（法律第13号）」）。成立・廃案などへの言い換えはしない。経過が無ければ省略。
- `TimelineEntry(speech)` は国会会議録検索システムの発言。**本会議に加えて委員会も収録する**（#242）。API は `nameOfMeeting` を付けないだけで委員会・分科会・審査会・連合審査会・公聴会・調査会を同じ形で返す（#263 が第221回 70,544 件の全量で、#242 が第201・204回の分科会でキーセットが同一であることを確認。パーサは無改造）。両院協議会は確認した3回次（衆参 204・208・213）では `numberOfRecords: 0` だった（全回次では確認していない）。会議名は原文（`meeting` は「本会議 第19号」「予算委員会第一分科会 第2号」）なので、本会議か委員会かは表示で区別できる。委員会には議員でない発言者（政府参考人・局長・参考人・公述人）が混ざるが、`speakerGroup`（会派）を持たないので名簿に突合できず、`speakerPosition` を持つので `unmatched.json` にも載らない（既存の規則がそのまま効く。#263 の実測で会派を持つのは 77.87%）。
- 発言の**取得範囲**は院で違う。参院は取得回次（`targets`）を回次ごとの参院名簿に突合する。衆院（#73 / #242）は衆院名簿が「現在」の1回次分しか無いので、議案の名寄せと同じく名簿が覆う回次（`meta.sessions` の最大）だけ取得・突合し、過去回次の衆院の発言は取得しない（名簿に無い旧議員を同名の現職に紐づけない。#71 で回次ごとの名簿が入れば広がる）。**これはサイズの都合ではなく原則**なので、委員会を足しても変わらない。その回次が引き継ぎ（carried）のとき（過去回次だけの手動実行・バックフィルの chunk）でも**取得する**（#236）。取得をやめると衆院の発言が前回出力の引き継ぎ頼みになり、引き継ぎが1度でも欠ければ（#103 以前の `session` の無い行、名簿から消えた memberId）0 のまま自力では戻らないため。引き継ぎとの二重行は「取得した `speechId` の引き継ぎ行を落とす」ことで防ぐ（`dropCarriedSpeeches`。残すのは今回の名簿で名寄せし直した取得分。取得が空なら何も落とさない）。
- 委員会を含めると1回次で衆参 700 ページ規模になる（#263 の実測: 第221回は 706 ページ）ので、**全回次を1回の実行で流さない**。#219 と同じく回次を分けて `etl.yml` を手動実行する（手順と chunk の切り方は `docs/ops/etl.md`）。
- **発言は `members/{id}.json` の timeline には入らず、`members/{id}/speeches.json`（`MemberSpeeches`）に書く**（#242）。分けたのはファイルを分けるためではなく、**議員ページの発言を実行時 fetch にしてプリレンダーから外す**ため。`ssr: false` のプリレンダーは折りたたんだ回次も含め timeline を全件 HTML に焼き込むので（#263 の実測: HTML は元 JSON の 2.15 倍）、timeline に置いたままファイルだけ分けても転送量は減らない。`excerpt`（原文の冒頭200字）は捨てない: 議員ページが実際に読ませている唯一の発言内容で、消すと「発言した」という事実だけが残る。並びは timeline と同じ日付降順（同日は `speechId` の降順）。**発言 0 件の議員のファイルは作らない**（無い＝0 件）。
- **Web の見え方が変わる（#242 で利用者から見える挙動の変更）**: 発言が timeline から外れたので、議員ページの既定タブ「すべて」（timeline から作る）に**発言は出ない**。発言は「発言」タブにだけ出る。委員会を収録すると発言は記録の大半を占めうるので、「すべて」に出ないことを黙って変えないよう、**発言のある議員の「すべて」タブに件数つきで 1 文出す**（「発言は「発言」タブにあります（N 件）」）。発言 0 件の議員には出さない（無い記録の案内はしない）。件数帯とタブの件数は `counts.speeches`（＝`speeches.json` の行数）なので、発言タブを開く前でも正しい。
- 不変条件（`validateDataset`）: 1人の `speeches.json` に同じ `speechId` の行は1つ。`speeches.json` の `id` は `members/index.json` の id と一致する。全行 `kind: "speech"`・`session` は整数・日付降順・`sourceUrl` は会議録の該当発言（`https://kokkai.ndl.go.jp/txt/{会議録ID}/{speechOrder}`）。`counts.speeches` は `speeches.json` の行数と一致する（`/coverage` の `linkedRecordCounts` がこの `counts` を数えている。#251）。ファイルが無ければ `counts.speeches` は 0。timeline に `speech` 行があれば違反。発言の院（会議録の `nameOfHouse`）と紐づけ先議員の院は一致する（ETL が不一致を拒否する。#107）。
- `TimelineEntry(speech).position` は会議録の `speakerPosition` の原文（例: 「議長」「国土交通大臣」「財政金融委員長」「主査」相当の肩書き）。役職として行った発言（議事進行・政府答弁・委員長報告）も事実として記録し、`counts.speeches` に含める（内訳は持たない）。Web は `position` と会議名をそのまま表示して区別する。

## 質問主意書（timeline の `question` 行、Issue #106）
- **事実**。出典は衆議院 質問答弁情報（一覧 `https://www.shugiin.go.jp/internet/itdb_shitsumon.nsf/html/shitsumon/kaiji{回次}_l.htm` → 経過ページ `…/shitsumon/{回次}{番号3桁}.htm`、どちらも Shift_JIS）と参議院 質問主意書（一覧 `https://www.sangiin.go.jp/japanese/joho1/kousei/syuisyo/{回次}/syuisyo.htm` → 詳細ページ `…/syuisyo/{回次}/meisai/m{回次}{番号3桁}.htm`、UTF-8）。`sourceUrl` は必ず経過ページ／詳細ページ（提出日・提出者の一次資料。一覧には提出日が無い）。
- `questionId` は `{回次}-{house}-{番号}`（例 `221-shugiin-1`、`221-sangiin-12`。衆参で番号が独立なので院を含める）。`date` は提出日（衆院「質問主意書提出年月日」／参院「提出日」）。提出日の無いページは例外（日付を推定しない）。
- `title` は件名、`submitterText` は提出者欄の原文（「緒方 林太郎君」。全角空白は半角1つ）、`status` は衆院の「経過状況」の原文（答弁受理・転送に至らず など。参院のページには無いので省略）、`answerDate` は答弁書受領日（衆院「答弁書受領年月日」／参院「答弁書受領日」）、`answerUrl` は答弁本文（HTML）。受領日が空欄なら `answerDate` も `answerUrl` も付けない（空欄は「未定または無し」で、未受領と言い切らない）。
- 提出者は両院とも1人（第217〜221回に「外N名」の形は無い）。名寄せは `resolveMember`: 参院の質問は回次ごとの参院名簿に（その回次に効いている名簿の会派で同姓同名を分ける。詳細ページに会派は無いので分けられなければ `unmatched.json` に `kind: "question"`、`questionId` 付きで載る）。衆院の質問は衆院名簿に、経過ページの「会派名」で同姓同名を分ける。衆院名簿は「現在」の1回次分しか無い（#71）ので、議案と同じく名簿が覆う回次（`meta.sessions` の最大）の質問だけ名寄せし、過去回次は紐づけず `unmatched.json` にも出さない。
- **衆院は名簿が覆う1回次分しか議員ページに出ない（既知の限界、#235）**: 上のとおり衆院の質問は全回次を取得していても、議員ページに紐づくのは名簿が覆う 1 回次だけ。取得済みだが出ない質問があるという事実は `/coverage`（`shugiinQuestionCoverage`）に明記して隠さない。全期間を覆うには回次別の衆院名簿（#71）が要る。参院は回次ごとの名簿があるのでこの制約は無い。
- 質問はファイル（`questions/`）には書かず、名寄せ済みの提出者の timeline の `question` 行にだけなる。`counts.questions` はその数。未突合の質問はどこにも数えない。同日の並びは vote → bill → stance → question → speech。
- 不変条件（`validateDataset`）: `question` 行の `sourceUrl` は衆院 経過ページ（`itdb_shitsumon.nsf/html/shitsumon/{数字}.htm`）か参院 詳細ページ（`kousei/syuisyo/{回次}/meisai/m….htm`）、`answerUrl` があれば衆参・NDL のドメイン、`counts.questions === timeline の question 行の数`。
- Web は「質問主意書」タブ（日付／件名／答弁書／出典）と件数帯に出す。判は「質問」（提出・賛同・発言と同じ act 色。色で評価しない）。

## 委員会出席（timeline の `attendance` 行、Issue #109）
- **事実**だが**提出者の記録ではない**。出典は国会会議録検索システム 検索用API（`https://kokkai.ndl.go.jp/api/speech?nameOfHouse=参議院&speaker=会議録情報&any=発議者&sessionFrom={回次}&sessionTo={回次}`）の speechOrder 0（会議録情報）。委員会会議録の冒頭「出席者は左のとおり。」欄に「発議者　氏名君」の肩書きで載る氏名を採る。`sourceUrl` は会議録の冒頭情報（`https://kokkai.ndl.go.jp/txt/{会議録ID}/0`）、`date` は会議の日付、`meeting` は「会議名 第N号」、`meetingId` は会議録情報の speechID。
- 載るのは**その日に出席した発議者**であり、参法の発議者全員ではない（217 参法 7 は「外2名」＝3 人に対し出席 2 人。`docs/research/sangiin-cosponsors.md` §5）。よって **`Bill.submitters` / `bill` 行（提出者）には絶対に入れない**。`role` は常に `"発議者"`（会議録の肩書きの原文）だが、Web は「委員会に発議者として出席」と明示し、「提出」の判とは別の「出席」の判で出す。人数が「外N名」と一致する日があっても全員と断定しない（推定しない）。
- 採るのは参議院側の発議者だけ: 出席者欄の「衆議院議員」見出しの下（衆法の発議者）は採らない。「本日の会議に付した案件」に（参第N号）が無い会議録（衆法・憲法審査会など）は採らない。`bills` はその日の案件にあった参法の `{billId: "{回次}-参法-{番号}", title: 原文}` を全部（複数ならどの参法の発議者として出席したかは出席者欄からは分からないので選ばない）。議案番号の漢数字は位取りなし（一一＝11）で読み、十・百が現れたら例外。
- 名寄せは `resolveMember`（会議の回次に効いている参院名簿）。出席者欄に会派は無いので同姓同名は絞れず `unmatched.json` に `kind: "attendance"`、`meetingId` 付きで載る。会議録の公開は約 1 か月遅れる（本会議発言と同じ。`meta.sources[]` の fetchedAt が時点）。
- `counts` には数えない（`counts.bills` は `bill` 行だけ）。同日の並びは vote → bill → stance → question → attendance → speech。
- 不変条件（`validateDataset`）: `attendance` 行は `house === "sangiin"` の議員にだけ付く、`estimated === false`、`role === "発議者"`、`sourceUrl` は `https://kokkai.ndl.go.jp/txt/{id}/{n}`。

## 委員会の役職（timeline の `committeeRole` 行、Issue #244）
- **事実**だが**在任期間ではない**。出典は国会会議録検索システム 検索用API（`https://kokkai.ndl.go.jp/api/speech?nameOfHouse={院}&speaker=会議録情報&sessionFrom={回次}&sessionTo={回次}`）の speechOrder 0（会議録情報）。会議録の冒頭「出席委員」（衆）「出席者は左のとおり。」（参）欄に載る**委員長・理事・委員などの役職と氏名**を採る。`sourceUrl` は会議録の冒頭情報（`https://kokkai.ndl.go.jp/txt/{会議録ID}/0`）。
- **会議録に在任期間は書かれていない。** 書かれているのは「その日、この役職で出席した」という事実だけで、就任日・退任日は無く、欠席した日は載らない。したがって `firstDate` から `lastDate` の間ずっとその役職だったとは言えないし、その外側に在任していなかったとも言えない。**期間を作らない**（#244 の PO 判断。issue の受け入れ条件にあった「期間を原文で」は一次資料に無いので満たしていない）。
  - 持つのは出席の事実だけ: `meetings`（その回次・その委員会・その役職で出席した会議の回数）、`firstDate` / `lastDate`（出席した最初 / 最新の会議の日）、`date` は `firstDate` と同じ値（timeline の並びに使う）。
  - Web は「◯◯委員会 委員長として出席」「出席 N 回・最初の出席 …・最新の出席 …」と出す。**範囲を意味する表記（「〜」「期間」「在任」「就任」）は使わない。**
- 1 行 = 1 人 × 1 回次 × 1 委員会 × 1 役職。役職が変われば（委員 → 理事）別の行にする（役職の変化は事実なので丸めない）。`committee` は会議名から号を落とした原文（「内閣委員会 第25号」→「内閣委員会」）、`role` は出席委員欄の原文（`委員長` `理事` `委員` `幹事` `会長` `小委員長` `小委員` `委員長代理理事`）。**丸めない**（審査会・調査会は「委員長」ではなく `会長`、その理事は `幹事`。#243 調査 PR #278）。
- 院で書式が違う（`docs/research/individual-records.md` §4-A）:
  - **衆**: `　出席委員` から氏名行（末尾が `君`）が続き、氏名行でない行で終わる。**1 行 2 名の 2 段組**で役職は氏名の前に付く。全角空白は姓名の区切りにも段組の区切りにも使われ、**空白の数では切れない**（第204・217回の実測: `君` 直後の空白 run は 1/2/3/4 個、姓名の区切りは 1/2/3 個で重なる）。「1 名は必ず `君` で終わり、その `君` の次は行末か全角空白」で切る（氏名に `君` を含む `畑野　君枝君` を 2 名に割らないため）。役職と氏名の間に空白が無い行もある（`理事おおつき紅葉君`）。
  - **参**: `出席者は左のとおり。` から `本日の会議に付した案件` まで。1 行 1 名。**インデント（全角空白の数）で切る**: 4 が委員の役職見出し（`委　員` `理　事` `幹　事` `小委員`）と行内役職（`委員長` `会　長` `小委員長`）、3 が委員以外の見出し（国務大臣・事務局側・政府参考人・**衆議院議員**…）。委員の氏名行は 15 か 16、委員以外は 7（第204・217回の実測 13,525 行で重ならない）。`委　員` の並びの後に区切りを挟んで議長・副議長が続く会議録（議院運営委員会）があるのでインデントでも切る。
- **本会議の会議録情報からは作らない**（出席委員欄が無い）。本会議の本文に出る「予算委員長坂本哲志君解任決議案」のような案件名から役職を作ってはいけない（#243 調査 PR #278 §7）。出席委員欄の中だけを読む。
- 名寄せは `resolveMember`（**会議の院の名簿**、`{ session, date }` を渡す。#230）。会議録に会派は書かれていないので**同姓同名は絞れず**、`unmatched.json` に `kind: "committee"`、`meetingId` 付きで載る（推測で紐づけない。`match-shugiin-bills.ts` / `attendance` と同じ条件）。会議録の公開は約 1 か月遅れる。
- `counts` には数えない（`counts` は採決・議案・発言・質問主意書の 4 つのまま）。同日の並びは vote → bill → stance → question → attendance → committeeRole → speech。
- 不変条件（`validateDataset`）: `estimated === false`、`committee` は空でなく号を含まない、`role` は空でない、`meetings >= 1` の整数、`firstDate <= lastDate`、`date === firstDate`、`sourceUrl` は `https://kokkai.ndl.go.jp/txt/{id}/{n}`。

## 議案（`bills/`、Issue #72）
- 出典は衆議院 議案情報。一覧 `https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian/kaiji{審議回次}.htm` から各議案の経過ページ `…/gian/keika/{id}.htm` を辿る（どちらも Shift_JIS）。`sourceUrl` は必ず経過ページ。`house` は `"shugiin"`。
- `Bill.id` は `{提出回次}-{種別原文}-{議案番号}`（例 `221-衆法-1`、`221-閣法-3`）。番号を持たない種別（決算・国有財産・ＮＨＫ決算・承諾）は番号の代わりに経過ページの id（例 `219-決算-1DE115E`）。ファイルは提出回次の下に置く（一覧は審議回次のページなので、継続審議の議案は対象回次より前の `bills/{提出回次}/` に入る）。同じ議案が複数回次の一覧に載るときは、後の回次の一覧（新しい状態）を採る。
- `kind` は shared の `BillKind`。対応の無い種別は `その他` にし、原文を `kindText` に残す。
- **事実**（経過ページの原文をそのまま）: `submitterText`（「議案提出者」欄。「落合 貴之君外四名」「内閣」「国土交通委員長」）、`submitterNames` / `supporterNames`（「議案提出者一覧」「議案提出の賛成者」の氏名。「君」だけ除く。衆院の経過ページには参院と違い全員の氏名が載る）、`submitterGroups`（議案提出会派）、`received`（各院の議案受理年月日）、`status`（一覧の審議状況）、`result`（各院の審議結果・公布日・法律番号の原文）。氏名の欄が無い議案（閣法・参法）は省略、欄はあるが空なら `[]`。
- `submitters` / `supporters`（memberId）は衆院の名簿に名寄せできた人だけ。名寄せするのは名簿が覆う回次（衆院議員の term の `sessionFrom`..`sessionTo`）に提出された議案だけで、衆院は「現在」の名簿しか無い（#71）ので実際には最新回次（`meta.sessions` の最大）の議案に限られる。それ以外の回次の議案・名簿が無い間は付かず、氏名は `submitterNames` / `supporterNames` に残る（unmatched.json にも流さない。名簿が覆う回次で紐づかない氏名だけ `kind: "bill"` で unmatched.json に載る）。経過ページに個人の会派は無いので同姓同名は絞れず unmatched に載せる。
- **推定**: `shugiinGroupStance: { stanceText, yes, no, unanimous? }` は経過ページ「衆議院審議時会派態度／賛成会派／反対会派」の原文（会派名の配列）。衆議院は個人別の投票を公開していないため、**会派の態度から個人の賛否を読み取るのは推定であり、事実（参院の個人票 `RollCall.votes`）とは型で分ける。`RollCall` には入れない。** Web で出すときは「推定（会派の態度）」と明記し、個人の「賛成／反対」とは別の表現にする（色で善悪を示さない）。`unanimous` はページが「全会一致」と書いているときだけ `true`。「多数」で反対会派が空欄のものは全会一致とみなさない（推論しない）。欄が空（未審議・閉会中審査）なら `shugiinGroupStance` は無い。
- 不変条件（`validateDataset`）: `bills/index.json` の id は一意、各行に対応する `bills/{session}/{id}.json` があり id・session・house が一致する、`sourceUrl` は衆参・NDL のドメイン、`submitters`/`supporters` の memberId は `members/index.json` に存在する、`unanimous` は `stanceText === "全会一致"` のときだけ、index に無いファイル（前回の残骸）は違反。`bills/` は毎回全部書き直す。
- timeline の `bill` 行は参法（参院 議案情報）に加え、衆院の Bill の `submitters` / `supporters`（名簿に名寄せできた衆院議員）からも作る（#73）。`role` は 提出者 / 賛成者、`date` は衆議院の議案受理年月日（`received.shugiin`）、`sourceUrl` は経過ページ、`submitterText` は「議案提出者」欄の原文。受理日の無い議案は行にしない（日付を推定しない）。

## 会派の態度（timeline の `stance` 行、Issue #73）
- **推定**。衆議院は個人の投票記録を公開していないので、衆院議員の timeline には `vote` 行が無い。代わりに `Bill.shugiinGroupStance` の賛成会派／反対会派に、その議員の**提出回次の所属会派**（`groupAt(member, bill.session)` の `group`。名簿の正式名称＝経過ページの会派名と同じ表記）が載っている議案だけを `stance` 行にする。
- 行に記録するのは会派（`group`）とその会派が載っていた側（`stance`）、「衆議院審議時会派態度」の原文（`stanceText`: 多数・少数・全会一致）。**本人の賛否は記録しない**。`estimated: true` を常に持ち、Web は `vote`（事実）とは別の判（tokens の `est-*`：破線＋薄地、賛成・反対で色を変えない）と「会派の態度（推定）」ラベルで出す。
- 会派がどちらにも載らない・`shugiinGroupStance` が無い・`received.shugiin` が無い・提出回次の名簿に term が無い（後の回次の名簿しか無い）議案は行にしない（推論しない）。参院議員には付けない。
- `date` は衆議院の議案受理年月日、`sourceUrl` は経過ページ。`counts` には数えない（`counts.bills` は `bill` 行だけ）。同日の並びは vote → bill → stance → speech。
- **回次ずれ（既知の限界、#88）**: 会派は**提出回次**（`bill.session`）の名簿で引いているが、「衆議院審議時会派態度」は**審議回次**（一覧 `kaiji{審議回次}.htm` の回次）の態度である。継続審議の議案では提出回次と審議回次が異なり、その間に会派が変わった議員は、審議時に所属していなかった会派の態度が載り得る。現状は衆院名簿が「現在」の1回次分しか無い（#71）ので実害は最新回次に限られるが、回次別の衆院名簿が入ったら `groupAt(member, 審議回次)` で引くように改める（審議回次は一覧ページ `kaiji{回次}.htm` の回次で、ETL は取得時にだけ知っている。`Bill` には保存していないので、改めるときは保存も併せて要る）。それまでは推定の推定を重ねず、提出回次の会派をそのまま使う。
- 不変条件（`validateDataset`）: `stance` 行は `house === "shugiin"` の議員にだけ付く（参院議員の timeline にあれば違反）、`estimated === true`、`stance` は 賛成/反対、`sourceUrl` は衆院 経過ページ（`gian/keika/`）。`bill` 行の `sourceUrl` は参院 議案ページまたは衆院 経過ページ。

## 選挙区（`districts/`、Issue #111）
- 出典は 日本郵便 KEN_ALL（郵便番号 → 市区町村）と 総務省「衆議院小選挙区の区割りの改定等について」（令和4年改定）の都道府県別 PDF（公職選挙法 別表第一: 市区町村 → 小選挙区）、北海道の振興局所管市町村、東京都支庁設置条例、浜松市の区の再編。調査と as-of は `docs/research/districts.md`。ETL は `pnpm etl:districts`（`.github/workflows/districts.yml`、月 1 回。日次 ETL とは独立で、`data/districts/` だけを書く）。
- 型（`packages/shared/src/index.ts` の `ZipDistricts` / `DistrictMunicipality` / `DistrictsMeta`、#112）:

```ts
interface ZipDistricts { sangiin: string[]; shugiin: string[]; municipalities?: string[] }   // by-zip.json の値。名簿の district と同じ表記（"東京" / "鳥取・島根"、"東京4" / "北海道12"）。municipalities は KEN_ALL の都道府県＋市区町村（"東京都千代田区"、団体コード順。#120）
interface DistrictMunicipality { code: string; pref: string; city: string; shugiin: string[]; split: boolean }
interface DistrictsMeta {
  fetchedAt: string;
  asOf: { kenAll: string; shugiinDistricts: string };   // KEN_ALL の更新日（ダウンロードページの「YYYY年M月D日更新」）／区割り改定法の施行日（2022-12-28）
  sources: { name: string; url: string; fetchedAt: string }[];
  counts: { zips: number; municipalities: number; shugiinDistricts: number; splitMunicipalities: number };
  splitMunicipalities: { code: string; pref: string; city: string; shugiin: string[] }[];
}
```

- **事実のみ・推定しない**: 解決は市区町村の粒度。別表で市区町村の一部区域だけが指定されている（分割）ときは、その市区町村の全郵便番号に候補の区を**全部**並べる（`shugiin` が 2 つ以上、`municipalities.json` の `split: true`、`meta.splitMunicipalities` に一覧）。町丁目・番地で絞り込まない（KEN_ALL の町域と別表の区域の対応は一次資料に無い）。Web は候補が複数のとき「○○市は複数の小選挙区にまたがる」と事実として出し、どれかを選ばない。
- 同じ郵便番号が複数の市区町村にまたがる行（KEN_ALL に 134 件）・都道府県をまたぐ行（3 件: 4980000, 6180000, 8710000）は和集合。そのため `sangiin` も配列（通常 1 要素）。
- `municipalities`（#120）は KEN_ALL の `都道府県 + 市区町村` の原文（政令市は「北海道札幌市厚別区」、郡部は「北海道虻田郡倶知安町」）を団体コード順に並べたもので、複数にまたがる郵便番号は全部載せる（どれかを選ばない）。ETL の出力では必須（`validateDistricts` が空を拒否する）。Web の型では省略可にしてあり、#120 より前の月次 ETL が書いた `by-zip.json` も読める（その場合 Web は市区町村の行を出さず、分割市区町村の名前は `meta.splitMunicipalities` との集合一致だけから出す）。
- `sangiin` は都道府県（参院名簿の表記: 都府県を除く。北海道はそのまま）。合区は「鳥取・島根」「徳島・高知」。`shugiin` は `{都道府県}{区番号}`（衆院名簿の表記）。どちらも `members/index.json` の `district` と結合できる。
- 別表の単位の解決: 市・区（政令市は「札幌市中央区」）は名前の完全一致、郡は前方一致で全町村、「郡（町村、…）」は町村の列挙（分割ではない）、「北海道○○振興局管内」は北海道のページの所管市町村のうち町村（市は別表に名指し）、「東京都○○支庁管内」は条例の固定表、再編で別表の旧区名が KEN_ALL に無い市（浜松市）は出典付きの固定表で現在の区に展開（旧区が複数の小選挙区にまたがって合流した区は分割扱い）。外字（釜石市の「釜」など PDF のフォントに Unicode が無い字）は 〓 として任意の 1 文字に照合し、県内で 1 件に絞れるときだけ紐づける。
- 不変条件（`validateDistricts`、違反なら ETL は非 0 終了し data/ は PR にならない）: 郵便番号は 7 桁、`sangiin`/`shugiin` は空でない、`shugiin` の名称は `municipalities.json` に存在し `{非数字}{数字}` の形、`split === shugiin.length > 1`、`meta.counts` は実数と一致、`meta.asOf` は ISO 日付、`sources` はすべて https と `fetchedAt` を持つ。解決時の失敗（別表の単位が KEN_ALL に 1 件で紐づかない、KEN_ALL の市区町村に区が付かない、一部区域として載る市区が 1 つの区にしか現れない、区番号が連続しない、47 都道府県そろわない）はすべて例外で止まる（黙って落とさない）。
- `data/districts/` は日次 ETL（`validateDataset`）の対象外で、日次 ETL は触らない。アーカイブ（`data-archive.zip`）には含まれる。
- **git 管理**: `data/districts/` は `data/` の他のファイルと同じくリポジトリにコミットする（`.gitignore` で除外しない）。書くのは月次の `.github/workflows/districts.yml`（`pnpm etl:districts` → `validateDistricts` が通った出力を PR にする）だけで、手元で `pnpm etl:districts` を実行した結果は原則コミットしない（差分は月次 PR でレビューする）。Web のビルド（`shard-districts.ts`）はコミット済みの `by-zip.json` / `meta.json` を読むので、無ければ Home の郵便番号入力は常に「該当する郵便番号が見つかりません」になる。
- Web（#112）: `by-zip.json` はバンドルせず、ビルドが上3桁ごとに `build/client/data/districts/zip/{上3桁}.json`（最大 1,000 ファイル）へ分割し `meta.json` を同じ場所へコピーする（`apps/web/scripts/shard-districts.ts`）。Home の郵便番号入力はその分割ファイルだけを fetch し、市区町村名（`municipalities`）と候補の選挙区を出し、選挙区を `/members?district=<名簿の表記>` にリンクする。fetch が 404 か、200 でも JSON でない応答（SPA フォールバックの HTML など）なら「該当する郵便番号が見つかりません」、5xx は「取得に失敗しました」（#120）。

## 回次
- ETL がネットワークから取得するのは**指定された回次**（無ければ既定の直近 5 回次）だけ（#103、`packages/etl/src/sessions.ts`）。`meta.sessions` に既にある他の回次（carried）は前回出力から引き継ぐ: 採決は `rollcalls/{session}/` を読み、票の氏名・会派を今回の名簿で**再突合**する（名簿は取得回次 ∪ 引き継ぐ回次の全回次分に加え、連続するブロックごとにその1つ前の回次の分も毎回取る（`rosterSessionsFor`）。回次が飛んでいても第217回の再突合に第216回の名簿が要る。再突合で memberId の付いた票が前回出力より減ったら名簿の取り漏れなので、ETL は書き出さずに非0終了する（`lostVoteMatches`））。審議結果は `rollcalls/index.json` の `result`（「可決（賛成 N・反対 N）」）から原文を戻す。議案は `bills/` の全部を先に入れ取得分で上書きする。speech / question / attendance / 参法の bill 行は `members/{id}.json` の `session` が引き継ぐ回次の行を戻す（名簿から消えた memberId の行と、今の名簿でその回次の在職を確認できない行（#230 の `carriedTenureVerified`）は落とし件数をログに出す）。`meta.sessions` は 取得 ∪ 引き継ぎ。部分実行で他回次の出力は消えず、日次実行（既定 5 回次）は第200〜216回を毎日取り直さない。回次を減らすときは `data/` を消してから実行する。
- 第215回以前は回次ごとの参院名簿（`giin/{N}/giin.htm`）が公開されていない（404）。ETL は「名簿が無い」事実として飛ばし（`fetchMembers` → undefined）、その回次の採決も手元の名簿で突合を**試みる**が、氏名が一致しても在職を確認できなければ紐づけない（下の #230）。結果としてこれらの回次の票はほとんどが未突合として載る（上限を設けない。古い回次ほど多い）。氏名だけから Member を作ることはしない（同名の別人を 1 人にしない）。
- **未突合の置き場所（#219）**: 行から回次が引ければ `unmatched/{session}.json`、引けなければ `unmatched.json`（発言の `speechId`・委員会出席の `meetingId` は NDL の会議録 id で回次を含まない）。回次は id の先頭（`rollCallId` = `{回次}-MMDD-vNNN`、`billId` = `{提出回次}-{種別}-{番号}`、`questionId` = `{回次}-{house}-{番号}`）から引き、読めなければ回次なしとして `unmatched.json` に残す（推定して分けない）。第142〜199回は全票が未突合になるので単一ファイルだと百万行規模になり、差分のレビューもリポジトリの肥大も実務上つらい。分けるのは**ファイルの持ち方だけ**で、「上限を設けない」「氏名だけから Member を作らない」は変えない。`validateDataset` は両方を読んで突き合わせるので、#219 より前の出力（`unmatched.json` に票が入っている）もそのまま検証できる。未突合が 1 件も無い回次のファイルは書かない（前回の残骸は毎回消す）。`unmatched.json` は 0 件でも空配列で書く（`OPS_DATA_FILES` として Web のビルドがコピーする）。
- **第142〜199回（#219、spike は `docs/research/backfill-142-199.md`）**: 参院の本会議投票結果は第142回（1998-01-14）から在り、HTML は旧レイアウト（第200〜216回）と同じなのでパーサは無改修で読む（第141回以前は `vote_ind.htm` が 404 ＝押しボタン投票の導入前）。取得は日次 ETL ではなく `etl.yml` の手動 dispatch で、回次を分けて複数回流す（`docs/ops/etl.md`）。`DEFAULT_SESSIONS` は変えない。一覧ページが 404 の回次と、個票がパースできないページ（`RollCallParseError`）は**飛ばして回次・URL をログに出す**（全58回次の構造は事前確認していない。推定で埋めない）。404 以外（5xx・タイムアウト）は障害なので飛ばさず ETL を落とす（取りこぼしを「無かった」と記録しないため）。衆院の経過ページは回次によって「衆議院審議時会派態度」の項目自体が無く、その議案は `shugiinGroupStance` を持たない（「無い」を「全会派賛成」等に読み替えない）。
- **在職を確認できない氏名一致では紐づけない（#230）**: 氏名が名簿の1人と一致しても、**その記録の時点に在職していたことを名簿から確認できなければ紐づけない**（`resolveMember` → `tenureVerified`）。名簿には任期満了日（`to`）はあるが**在職開始日にあたるフィールドが無い**ので、在職の確認は次の 2 つだけを事実として認める。どちらでもなければ紐づけず、氏名と会派は未突合（`unmatched/{session}.json`）に残す。
  - **(a) 名簿がその回次を覆っている**: `sessionFrom <= session <= sessionTo`。その回次の議員一覧に載っている＝その回次の議員であることが一次資料に書いてある。
  - **(b) より前の回次の名簿に載っていて、任期満了日が記録の日付以後**: `sessionTo < session` かつ `to >= date`。参院の議員一覧は会期後のスナップショットなので、会期中に辞職・任期満了した議員は次の回次の一覧に載らない（`groupAt` と同じ事情）。前の回次の一覧に載っている＝その時点までに既に議員であり、任期満了日がまだ来ていない＝その日も任期中。どちらも名簿に書いてある事実。
  - (b) が「**より前の**回次の名簿」を要求するのが要点。任期満了日だけを見ると、2028年に任期が切れる現職が 1998 年の票に「任期満了日 >= 1998年」で通ってしまう（初当選より前かどうかは名簿から分からない）。
  - **在職未確認の候補は会派が一致しても採らない**。同姓同名の絞り込みでも候補から外す（「候補ですらない」として扱う）。回次の分からない呼び出し（`at` を渡さない）はそもそも在職を確認しようがないので誰にも紐づかないので、呼び出し側は必ず記録の回次と日付を渡す。
  - 記録は失われない: 外れた氏名は原文の会派つきで未突合に載り、採決ページ・議案ページ・会議録への一次資料リンクは残る（`validateDataset` が「空 `memberId` の票は未突合に載っていること」を検査する）。
  - **引き継ぎ行も確認し直す**（`carriedTenureVerified`）。引き継ぎ（`readCarried`）は前回出力の `memberId` をそのまま戻すので、採決（再突合する）と違って speech / question / attendance / 参法 bill は名寄せがやり直されない。#230 より前の出力の在職未確認の行をそのまま戻さないよう、今の名簿で確認し直して落とす（その回次を取り直せば現行の名寄せで作り直される）。
  - **この変更で外れた件数（2026-08-24 時点のデータで測定、`m_` 空間のみ）**: 計 24,610 行 — 票 18,401 / 発言 4,790 / 質問主意書 1,305 / 参法 114。第200〜215回に分布し、第216回以降は 0（(b) が会期中に名簿から消えた議員を救うため）。影響を受けた議員は 772 人中 304 人で、timeline が空になった議員はいない。衆院（`h_`）は元から名簿の覆う回次しか名寄せしないので 0 行。
- 投票結果一覧（`touhyoulist/{N}/vote_ind.htm`）には**起立採決**のページ（個人票が無く「起立採決により可決されました」等の 1 行だけ。第200〜216回に多く、第210回・第216回は全件）も載る。個人票が無いので `RollCall` にはせず、ETL は件数をログに出して飛ばす（`standingVoteNote`）。第217回以降の一覧は押しボタン投票だけ。
- 採決が 0 件の回次（特別国会など）は `rollcalls/{session}/` を作らない。`meta.sessions` には載る。

## 鮮度
- `meta.fetchedAt` を全ページのフッターに出す。ETL は日次。
