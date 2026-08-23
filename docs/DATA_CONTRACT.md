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
  unmatched.json                    名寄せできなかった氏名表記の一覧（票: rollCallId / 発言: speechId / 参法の発議者・衆院議案の提出者と賛成者: billId（後者は kind: "bill" 付き）/ 質問主意書の提出者: questionId（kind: "question"）/ 委員会出席の発議者: meetingId（kind: "attendance"）。運用者が確認する）
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
  | { kind: "attendance"; estimated: false; session: number; date: string; meetingId: string; meeting: string; role: "発議者"; bills: { billId: string; title: string }[]; sourceUrl: string }; // 委員会に発議者として出席（事実。提出者ではない）
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
- 個人別表決の公開状況（公開／会派別／総数のみ／不明）は `data/` ではなく `apps/web/app/data/vote-disclosure.json`（#128 の調査表 `docs/research/local-assemblies.md` から機械的に起こしたもの。調査日付き）。`/assemblies/` が事実として表示する。

### 地方議会の ETL が書く原本（`assemblies/{assemblyId}/`、Issue #157。最初の議会は宮城県議会 `pref-04`、2 つ目は徳島県議会 `pref-36` #183）

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
- **不変条件（`validateLocalAssemblies`、`validateDataset` から呼ぶ）**: `assemblies/index.json` の地方議会の行ごとに `assemblies/{id}/` があれば検査する（無くて `members/index.json` にその議会の行があれば違反）。全ファイルが stableJson。全レコードの `sourceUrl`（と `profileUrl`）のホストはその議会の `Assembly.sourceUrl` のホストに一致し https。`members/index.json` のその議会の行は id が一意で `p_{prefCode}_…`、`house` を持たず、`assemblyId` は index の id、`asOf` は ISO 日付。`members/{id}.json` は `terms[{group, district, asOf}]` を持ち、timeline は `localVote` だけ・新しい順・`counts.rollcalls` と一致。`sessions.json` は新しい順・id 一意で、各行の `rollcalls` と `date` は `rollcalls/index.json` のその会期の件数・最終議決日に一致（会期の集合も一致）。`rollcalls/index.json` は新しい順で votes を持たない。各 `LocalRollCall` の `votes[].value` は `raw`・`legend` が空でなく `mapped` は 3 値だけ（不明には付けない）。`method` はあれば `raw` と空でない `legend` を持つ（無い議会＝徳島は省略）。`memberId` は index にあるか、空なら `unmatched.json` に載っている。議員ごとの timeline の件数＝rollcalls/ にあるその人の票の数。`meta.counts` の members / rollcalls / cells（議員数×議案数、不明を含む）/ unknownCells / unmatchedNames が実ファイルと一致。
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
- `timeline` の全行が `session`（国会の回次）を持つ（#103）。vote は採決の回次（`rollCallId` の先頭 `{回次}-` と一致。`validateDataset` が検査する）、bill は議案の提出回次（`billId` の先頭）、speech は会議録の回次（API の `session`）、stance は議案の提出回次、question は質問の回次、attendance は会議の回次。Web の議員ページは `session` で回次ごとに折りたたむ（直近 2 回次を展開、それ以前は「第N回国会・件数」の見出しだけ）。`session` の無い行は #103 以前の出力で、Web は「回次不明」として最後にまとめる（推定しない）。
- どのレコードも `sourceUrl` を持ち、衆参・NDL のドメインを指す。
- `RollCallSummary.result` / `TimelineEntry(vote).result` は必ず得票「賛成 N・反対 N」を含む。参院 議案情報の審議結果（原文: 可決・否決・同意・是認 など）と紐づいた採決は「可決（賛成 N・反対 N）」の形。可否を多数決から推論しない。
- 「投票なし」は欠席と棄権を区別しない。区別した表現を作らない。
- `TimelineEntry(bill)` は参院 議案情報の議案詳細ページ（meisai）から作る。`sourceUrl` は必ずその議案ページ（`https://www.sangiin.go.jp/japanese/joho1/kousei/gian/{回次}/meisai/m….htm`）。`date` は議案ページの「提出日」（参法の参議院への提出＝受理の日）。`billId` は `{回次}-{種別}-{提出番号}`（例 `221-参法-16`）。`counts.bills` は timeline の bill 行の数。
- 参法の「発議者」欄に載る氏名は筆頭者だけ（原文「打越さく良君 外9名」）で、「外N名」と賛成者の氏名は議案ページにも提出法律案 PDF にも公表されていない。載っている氏名だけを `role: "提出者"` にし、人数の事実は `submitterText` に原文のまま残す。誰が「外N名」かを推測しない。`role: "賛成者"` は型として残すが、現在の一次資料からは生成されない。参議院公報（Web 版）・参議院法制局・国会会議録（委員会の出席者欄に載るのは出席した発議者だけ）・衆院の経過ページにも全員の氏名は無いことを #63 で確認した（`docs/research/sangiin-cosponsors.md`）。
- 委員会提出の参法（議案ページの「提出者区分」が「委員会発議」。例 217/meisai/m217100217005.htm「提出者 厚生労働委員長」）には発議者欄が無く、「提出者」欄に委員長の役職名だけが載る。役職名は個人の氏名ではないので名寄せせず、bill 行（timeline）にも `unmatched.json` にも載らない。ETL はこれを黙って落とさず件数と id・提出者の原文（例「厚生労働委員長」）をログに出す（Issue #64）。一覧の参法件数と timeline の bill 行の差はここから生じる。
- 閣法に発議者は無く、衆法の発議者は衆議院議員（参院名簿に無いのが正常）なので、bill 行は参法だけから作る。議案ページに会派が無いので同姓同名は絞れず `unmatched.json`（billId 付き）に載る。
- `TimelineEntry(bill).status` は議案ページの経過ブロック（参議院委員会・参議院本会議・衆議院委員会・衆議院本会議・公布）のうち日付が最新のものを「段階名 議決の原文」で（例「参議院本会議 可決」「参議院 環境委員会 未了」「公布（法律第13号）」）。成立・廃案などへの言い換えはしない。経過が無ければ省略。
- `TimelineEntry(speech)` は国会会議録検索システムの本会議の発言（参議院本会議・衆議院本会議）。参院本会議は取得回次を回次ごとの参院名簿に突合する。衆院本会議（#73）は衆院名簿が「現在」の1回次分しか無いので、議案の名寄せと同じく名簿が覆う回次（`meta.sessions` の最大）だけ取得・突合し、過去回次の衆院本会議は取得しない（名簿に無い旧議員を同名の現職に紐づけない。#71 で回次ごとの名簿が入れば広がる）。その回次が引き継ぎ（carried）のとき（過去回次だけの手動実行）は衆院本会議も取得せず前回出力の行を引き継ぐ（取得すると同じ発言が2行になる。`shouldFetchShugiinSpeeches`。#103 レビュー）。不変条件（`validateDataset`）: 1人の timeline に同じ `speechId` の行は1つ。衆院議員の `counts.speeches` はその範囲の件数。発言の院（会議録の `nameOfHouse`）と紐づけ先議員の院は一致する（ETL が不一致を拒否する。#107）。
- `TimelineEntry(speech).position` は会議録の `speakerPosition` の原文（例: 「議長」「国土交通大臣」「財政金融委員長」）。役職として行った発言（議事進行・政府答弁・委員長報告）も事実として timeline に入れ、`counts.speeches` に含める（内訳は持たない）。Web は `position` をそのまま表示して区別する。

## 質問主意書（timeline の `question` 行、Issue #106）
- **事実**。出典は衆議院 質問答弁情報（一覧 `https://www.shugiin.go.jp/internet/itdb_shitsumon.nsf/html/shitsumon/kaiji{回次}_l.htm` → 経過ページ `…/shitsumon/{回次}{番号3桁}.htm`、どちらも Shift_JIS）と参議院 質問主意書（一覧 `https://www.sangiin.go.jp/japanese/joho1/kousei/syuisyo/{回次}/syuisyo.htm` → 詳細ページ `…/syuisyo/{回次}/meisai/m{回次}{番号3桁}.htm`、UTF-8）。`sourceUrl` は必ず経過ページ／詳細ページ（提出日・提出者の一次資料。一覧には提出日が無い）。
- `questionId` は `{回次}-{house}-{番号}`（例 `221-shugiin-1`、`221-sangiin-12`。衆参で番号が独立なので院を含める）。`date` は提出日（衆院「質問主意書提出年月日」／参院「提出日」）。提出日の無いページは例外（日付を推定しない）。
- `title` は件名、`submitterText` は提出者欄の原文（「緒方 林太郎君」。全角空白は半角1つ）、`status` は衆院の「経過状況」の原文（答弁受理・転送に至らず など。参院のページには無いので省略）、`answerDate` は答弁書受領日（衆院「答弁書受領年月日」／参院「答弁書受領日」）、`answerUrl` は答弁本文（HTML）。受領日が空欄なら `answerDate` も `answerUrl` も付けない（空欄は「未定または無し」で、未受領と言い切らない）。
- 提出者は両院とも1人（第217〜221回に「外N名」の形は無い）。名寄せは `resolveMember`: 参院の質問は回次ごとの参院名簿に（その回次に効いている名簿の会派で同姓同名を分ける。詳細ページに会派は無いので分けられなければ `unmatched.json` に `kind: "question"`、`questionId` 付きで載る）。衆院の質問は衆院名簿に、経過ページの「会派名」で同姓同名を分ける。衆院名簿は「現在」の1回次分しか無い（#71）ので、議案と同じく名簿が覆う回次（`meta.sessions` の最大）の質問だけ名寄せし、過去回次は紐づけず `unmatched.json` にも出さない。
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
- ETL がネットワークから取得するのは**指定された回次**（無ければ既定の直近 5 回次）だけ（#103、`packages/etl/src/sessions.ts`）。`meta.sessions` に既にある他の回次（carried）は前回出力から引き継ぐ: 採決は `rollcalls/{session}/` を読み、票の氏名・会派を今回の名簿で**再突合**する（名簿は取得回次 ∪ 引き継ぐ回次の全回次分に加え、連続するブロックごとにその1つ前の回次の分も毎回取る（`rosterSessionsFor`）。回次が飛んでいても第217回の再突合に第216回の名簿が要る。再突合で memberId の付いた票が前回出力より減ったら名簿の取り漏れなので、ETL は書き出さずに非0終了する（`lostVoteMatches`））。審議結果は `rollcalls/index.json` の `result`（「可決（賛成 N・反対 N）」）から原文を戻す。議案は `bills/` の全部を先に入れ取得分で上書きする。speech / question / attendance / 参法の bill 行は `members/{id}.json` の `session` が引き継ぐ回次の行をそのまま戻す（名簿から消えた memberId の行は落とし件数をログに出す）。`meta.sessions` は 取得 ∪ 引き継ぎ。部分実行で他回次の出力は消えず、日次実行（既定 5 回次）は第200〜216回を毎日取り直さない。回次を減らすときは `data/` を消してから実行する。
- 第215回以前は回次ごとの参院名簿（`giin/{N}/giin.htm`）が公開されていない（404）。ETL は「名簿が無い」事実として飛ばし（`fetchMembers` → undefined）、その回次の採決は手元の名簿（第216回以降）で突合する。紐づかない氏名（第216回より前に退任した議員など）は `unmatched.json` に載る（上限を設けない。古い回次ほど多い）。氏名だけから Member を作ることはしない（同名の別人を 1 人にしない）。
- 投票結果一覧（`touhyoulist/{N}/vote_ind.htm`）には**起立採決**のページ（個人票が無く「起立採決により可決されました」等の 1 行だけ。第200〜216回に多く、第210回・第216回は全件）も載る。個人票が無いので `RollCall` にはせず、ETL は件数をログに出して飛ばす（`standingVoteNote`）。第217回以降の一覧は押しボタン投票だけ。
- 採決が 0 件の回次（特別国会など）は `rollcalls/{session}/` を作らない。`meta.sessions` には載る。

## 鮮度
- `meta.fetchedAt` を全ページのフッターに出す。ETL は日次。
