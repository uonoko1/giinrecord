# データ契約（`data/` のファイル仕様）

ETL（書く側）と Web（読む側）はこのファイル群だけで結合する。型は `packages/shared/src/index.ts` が正。
すべて UTF-8 の JSON。キーはソート済み、末尾改行あり（差分を小さくするため）。

```
data/
  meta.json                         DatasetMeta（取得日時・出典・対象回次）
  members/
    index.json                      MemberSummary[]  検索・一覧用（軽量）
    {memberId}.json                 MemberDetail     議員ページ用（その人の全記録）
  rollcalls/
    index.json                      RollCallSummary[] 採決一覧用
    {session}/{rollCallId}.json     RollCall          採決ページ用（全議員の票）
  unmatched.json                    名寄せできなかった氏名表記の一覧（票: rollCallId / 発言: speechId / 参法の発議者: billId。運用者が確認する）
  unmatched-bills.json              議案情報の審議結果と紐づかなかった採決の一覧（人事案件・決議など。得票のみの result になる）
  unmatched-groups.json             名簿の会派略称のうち対応表（sangiin-groups.ts）に無いものの一覧（group は原文のまま公開され、運用者が対応表に追記する）
```

## 型（shared に追加する）

```ts
interface MemberSummary { id: MemberId; name: string; kana: string; house: House; group: string; district: string; termEnd?: string; current: boolean; counts: { rollcalls: number; bills: number; speeches: number } }
interface MemberDetail extends Member { timeline: TimelineEntry[] }
type TimelineEntry =
  | { kind: "vote"; date: string; rollCallId: string; title: string; value: VoteValue; result: string; groupValue?: VoteValue; sourceUrl: string }
  | { kind: "bill"; date: string; billId: string; title: string; role: "提出者" | "賛成者"; submitterText?: string; status?: string; sourceUrl: string }
  | { kind: "speech"; date: string; speechId: string; meeting: string; excerpt: string; chars: number; position?: string; sourceUrl: string };
interface RollCallSummary { id: string; session: number; date: string; title: string; totals: { total: number; yes: number; no: number }; result: string }
```

## 不変条件
- `RollCall.votes[].memberId` は `members/index.json` に存在する id、または名寄せ失敗時は `""`（その場合 `unmatched.json` に載る）。
- `Σ groups[].size === votes.length`（会派人数と個人票の件数は一致する）。
- `MemberSummary.group` は会派の正式名称（投票結果ページと同じ表記。名簿の略称「自民」「い党」等は ETL が解決する）。解決できなかった略称は原文のまま入り `unmatched-groups.json` に載る。
- `MemberSummary.current` は最新回次（`meta.sessions` の最大）の名簿に載っているか。辞職・任期満了・補選で入れ替わった議員も `false` のまま残り、票の事実は消えない。Web の `/members` は既定で現職のみを出し、トグルで元職も出す。
- `Member.terms` は回次ごとの名簿の (会派, 選挙区, 任期満了) を新しい順に並べ、隣接する回次で同じなら1つに畳む（`sessionFrom`〜`sessionTo`）。氏名・かなは最新回次の表記。
- `timeline` は日付降順（回次をまたいでも一つの timeline）。
- どのレコードも `sourceUrl` を持ち、衆参・NDL のドメインを指す。
- `RollCallSummary.result` / `TimelineEntry(vote).result` は必ず得票「賛成 N・反対 N」を含む。参院 議案情報の審議結果（原文: 可決・否決・同意・是認 など）と紐づいた採決は「可決（賛成 N・反対 N）」の形。可否を多数決から推論しない。
- 「投票なし」は欠席と棄権を区別しない。区別した表現を作らない。
- `TimelineEntry(bill)` は参院 議案情報の議案詳細ページ（meisai）から作る。`sourceUrl` は必ずその議案ページ（`https://www.sangiin.go.jp/japanese/joho1/kousei/gian/{回次}/meisai/m….htm`）。`date` は議案ページの「提出日」（参法の参議院への提出＝受理の日）。`billId` は `{回次}-{種別}-{提出番号}`（例 `221-参法-16`）。`counts.bills` は timeline の bill 行の数。
- 参法の「発議者」欄に載る氏名は筆頭者だけ（原文「打越さく良君 外9名」）で、「外N名」と賛成者の氏名は議案ページにも提出法律案 PDF にも公表されていない。載っている氏名だけを `role: "提出者"` にし、人数の事実は `submitterText` に原文のまま残す。誰が「外N名」かを推測しない。`role: "賛成者"` は型として残すが、現在の一次資料からは生成されない。
- 閣法に発議者は無く、衆法の発議者は衆議院議員（参院名簿に無いのが正常）なので、bill 行は参法だけから作る。議案ページに会派が無いので同姓同名は絞れず `unmatched.json`（billId 付き）に載る。
- `TimelineEntry(bill).status` は議案ページの経過ブロック（参議院委員会・参議院本会議・衆議院委員会・衆議院本会議・公布）のうち日付が最新のものを「段階名 議決の原文」で（例「参議院本会議 可決」「参議院 環境委員会 未了」「公布（法律第13号）」）。成立・廃案などへの言い換えはしない。経過が無ければ省略。
- `TimelineEntry(speech).position` は会議録の `speakerPosition` の原文（例: 「議長」「国土交通大臣」「財政金融委員長」）。役職として行った発言（議事進行・政府答弁・委員長報告）も事実として timeline に入れ、`counts.speeches` に含める（内訳は持たない）。Web は `position` をそのまま表示して区別する。

## 回次
- ETL は「指定された回次 ∪ `meta.sessions` に既にある回次」を毎回まとめて処理し、`rollcalls/{session}/` を回次ごとに並べる。部分実行で他回次の出力は消えない（回次を減らすときは `data/` を消してから実行する）。
- 採決が 0 件の回次（特別国会など）は `rollcalls/{session}/` を作らない。`meta.sessions` には載る。

## 鮮度
- `meta.fetchedAt` を全ページのフッターに出す。ETL は日次。
