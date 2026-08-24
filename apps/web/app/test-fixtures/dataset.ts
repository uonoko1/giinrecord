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
      },
      {
        name: "衆参 議案情報",
        url: "https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian/menu.htm",
        fetchedAt: "2026-08-22T06:00:00+09:00",
      },
      { name: "国会会議録検索システム", url: "https://kokkai.ndl.go.jp/", fetchedAt: "2026-08-22T06:00:00+09:00" },
    ],
  },
  members: [
    { id: "m_000001", name: "藤川 政人", kana: "ふじかわ まさひと", house: "sangiin", group: "自由民主党", district: "愛知", counts: { rollcalls: 5, bills: 0, speeches: 1 } },
    { id: "m_000002", name: "山田 太郎", kana: "やまだ たろう", house: "sangiin", group: "自由民主党", district: "比例", counts: { rollcalls: 5, bills: 1, speeches: 0 } },
    { id: "m_000003", name: "佐藤 花子", kana: "さとう はなこ", house: "sangiin", group: "立憲民主・社民", district: "東京", counts: { rollcalls: 5, bills: 0, speeches: 2 } },
  ],
  rollcalls: [
    { id: "221-0605-v001", session: 221, date: "2026-06-05", title: "令和八年度一般会計補正予算（第１号）", totals: { total: 242, yes: 148, no: 94 }, result: "可決" },
    { id: "221-0724-v001", session: 221, date: "2026-07-24", title: "日本国憲法の改正手続に関する法律の一部を改正する法律案", totals: { total: 240, yes: 200, no: 40 }, result: "可決" },
    { id: "221-0717-v001", session: 221, date: "2026-07-17", title: "国旗の損壊等の処罰に関する法律案", totals: { total: 240, yes: 180, no: 60 }, result: "可決" },
    { id: "221-0717-v002", session: 221, date: "2026-07-17", title: "ヒトゲノム編集胚等の取扱いの規制に関する法律案", totals: { total: 240, yes: 230, no: 10 }, result: "可決" },
    { id: "220-0101-v001", session: 220, date: "2026-01-01", title: "一番古い案件", totals: { total: 240, yes: 120, no: 120 }, result: "否決" },
  ],
  // bills/index.json は衆院の議案情報（会派態度の裏づけ）。回次 219 は採決が無く、議案だけがある回次（歯抜けの検証用）
  bills: [
    { id: "221-閣法-1", session: 221, kind: "閣法", house: "shugiin", title: "令和八年度一般会計予算", status: "成立", sourceUrl: "https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian/keika/1DE14C2.htm" },
    { id: "221-閣法-2", session: 221, kind: "閣法", house: "shugiin", title: "刑法の一部を改正する法律案", status: "成立", sourceUrl: "https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian/keika/1DE14C3.htm" },
    { id: "219-閣法-1", session: 219, kind: "閣法", house: "shugiin", title: "古い議案", status: "成立", sourceUrl: "https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian/keika/1DE14C4.htm" },
  ],
};
