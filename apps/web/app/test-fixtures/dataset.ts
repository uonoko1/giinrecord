import type { BillSessionCount, MemberAssemblyCount } from "@seiji-kiroku/shared";
import type { MemberSummary } from "../lib/dataset";
import type { Dataset } from "../lib/dataset";

/** Home / About 用の最小データ。採決はわざと日付順にしていない（降順ソートを検証するため）。 */
export const dataset: Dataset = {
  meta: {
    fetchedAt: "2026-08-22T06:00:00+09:00",
    sessions: [220, 221],
    sources: [
      {
        name: "参議院 本会議投票結果",
        url: "https://www.sangiin.go.jp/japanese/joho1/kousei/vote/221/221-0000/votelist.html",
        fetchedAt: "2026-08-22T06:00:00+09:00",
        house: "sangiin",
        kind: "vote",
      },
      {
        name: "衆参 議案情報",
        url: "https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian/menu.htm",
        fetchedAt: "2026-08-22T06:00:00+09:00",
        house: "shugiin",
        kind: "bill",
      },
      { name: "国会会議録検索システム", url: "https://kokkai.ndl.go.jp/", fetchedAt: "2026-08-22T06:00:00+09:00", house: "sangiin", kind: "speech" },
    ],
  },
  rollcalls: [
    { id: "221-0605-v001", session: 221, date: "2026-06-05", title: "令和八年度一般会計補正予算（第１号）", totals: { total: 242, yes: 148, no: 94 }, result: "可決" },
    { id: "221-0724-v001", session: 221, date: "2026-07-24", title: "日本国憲法の改正手続に関する法律の一部を改正する法律案", totals: { total: 240, yes: 200, no: 40 }, result: "可決" },
    { id: "221-0717-v001", session: 221, date: "2026-07-17", title: "国旗の損壊等の処罰に関する法律案", totals: { total: 240, yes: 180, no: 60 }, result: "可決" },
    { id: "221-0717-v002", session: 221, date: "2026-07-17", title: "ヒトゲノム編集胚等の取扱いの規制に関する法律案", totals: { total: 240, yes: 230, no: 10 }, result: "可決" },
    { id: "220-0101-v001", session: 220, date: "2026-01-01", title: "一番古い案件", totals: { total: 240, yes: 120, no: 120 }, result: "否決" },
  ],
};

// Issue 408: 議案は Dataset に入っていない（使うのは /coverage だけ）。テストは必要なところでこれを明示的に渡す。
// Issue 411: /coverage が読むのは全件ではなく **院・回次ごとの件数**（bills/by-session.json）。
// 衆院の議案情報（会派態度の裏づけ）で、回次 219 は採決が無く議案だけがある回次（歯抜けの検証用）。
// house 昇順・回次昇順（ETL の billsBySession と同じ並び）。0 件の回次の行は無い
export const billsBySession: BillSessionCount[] = [
    { house: "shugiin", session: 219, count: 1 },
    { house: "shugiin", session: 221, count: 2 },
];

// Issue 441: 名簿の全件も Dataset に入っていない（全件が要るのは /members と /assemblies/{id} だけ）。
// 全件が要るテストはこれを明示的に渡す。
export const members: MemberSummary[] = [
  { id: "m_000001", name: "藤川 政人", kana: "ふじかわ まさひと", house: "sangiin", group: "自由民主党", district: "愛知", counts: { rollcalls: 5, bills: 0, speeches: 1 } },
  { id: "m_000002", name: "山田 太郎", kana: "やまだ たろう", house: "sangiin", group: "自由民主党", district: "比例", counts: { rollcalls: 5, bills: 1, speeches: 0 } },
  { id: "m_000003", name: "佐藤 花子", kana: "さとう はなこ", house: "sangiin", group: "立憲民主・社民", district: "東京", counts: { rollcalls: 5, bills: 0, speeches: 2 } },
];

// Issue 441: /・/assemblies・/coverage が読むのは全件ではなく **議会ごとの人数**（members/by-assembly.json）。
// **`current` と `total` は違う数**（元職を含むかどうか）なので、上の members から機械的に導いた値は入れない
// ——テストがこの違いを見分けられるように、元職のいる形をここで作る。assemblyId 昇順（ETL の membersByAssembly と同じ並び）
export const membersByAssembly: MemberAssemblyCount[] = [
  { assemblyId: "diet-sangiin", current: 3, total: 4 },
];
