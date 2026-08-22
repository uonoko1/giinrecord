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
  unmatched.json                    名寄せできなかった氏名表記の一覧（運用者が確認する）
  unmatched-bills.json              議案情報の審議結果と紐づかなかった採決の一覧（人事案件・決議など。得票のみの result になる）
  unmatched-groups.json             名簿の会派略称のうち対応表（sangiin-groups.ts）に無いものの一覧（group は原文のまま公開され、運用者が対応表に追記する）
```

## 型（shared に追加する）

```ts
interface MemberSummary { id: MemberId; name: string; kana: string; house: House; group: string; district: string; termEnd?: string; counts: { rollcalls: number; bills: number; speeches: number } }
interface MemberDetail extends Member { timeline: TimelineEntry[] }
type TimelineEntry =
  | { kind: "vote"; date: string; rollCallId: string; title: string; value: VoteValue; result: string; groupValue?: VoteValue; sourceUrl: string }
  | { kind: "bill"; date: string; billId: string; title: string; role: "提出者" | "賛成者"; status?: string; sourceUrl: string }
  | { kind: "speech"; date: string; speechId: string; meeting: string; excerpt: string; chars: number; sourceUrl: string };
interface RollCallSummary { id: string; session: number; date: string; title: string; totals: { total: number; yes: number; no: number }; result: string }
```

## 不変条件
- `RollCall.votes[].memberId` は `members/index.json` に存在する id、または名寄せ失敗時は `""`（その場合 `unmatched.json` に載る）。
- `Σ groups[].size === votes.length`（会派人数と個人票の件数は一致する）。
- `MemberSummary.group` は会派の正式名称（投票結果ページと同じ表記。名簿の略称「自民」「い党」等は ETL が解決する）。解決できなかった略称は原文のまま入り `unmatched-groups.json` に載る。
- `timeline` は日付降順。
- どのレコードも `sourceUrl` を持ち、衆参・NDL のドメインを指す。
- `RollCallSummary.result` / `TimelineEntry(vote).result` は必ず得票「賛成 N・反対 N」を含む。参院 議案情報の審議結果（原文: 可決・否決・同意・是認 など）と紐づいた採決は「可決（賛成 N・反対 N）」の形。可否を多数決から推論しない。
- 「投票なし」は欠席と棄権を区別しない。区別した表現を作らない。

## 鮮度
- `meta.fetchedAt` を全ページのフッターに出す。ETL は日次。
