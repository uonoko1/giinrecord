import type { MemberSummary } from "../lib/data-contract";

/** /members 用の10名。五十音の行・濁音・半濁音・小書き・会派/選挙区の重なりを含む。わざと五十音順にしていない。 */
export const members: MemberSummary[] = [
  { id: "m_000001", name: "藤川 政人", kana: "ふじかわ まさひと", house: "sangiin", group: "自民", district: "愛知", termEnd: "2028-07-25", counts: { rollcalls: 120, bills: 0, speeches: 0 } },
  { id: "m_000002", name: "青木 愛", kana: "あおき あい", house: "sangiin", group: "立憲", district: "比例", termEnd: "2028-07-25", counts: { rollcalls: 120, bills: 0, speeches: 0 } },
  { id: "m_000003", name: "佐藤 花子", kana: "さとう はなこ", house: "sangiin", group: "立憲", district: "東京", termEnd: "2031-07-28", counts: { rollcalls: 120, bills: 0, speeches: 0 } },
  { id: "m_000004", name: "山田 太郎", kana: "やまだ たろう", house: "sangiin", group: "自民", district: "比例", termEnd: "2031-07-28", counts: { rollcalls: 120, bills: 0, speeches: 0 } },
  { id: "m_000005", name: "田中 一郎", kana: "たなか いちろう", house: "sangiin", group: "公明", district: "比例", termEnd: "2028-07-25", counts: { rollcalls: 120, bills: 0, speeches: 0 } },
  { id: "m_000006", name: "片山 さつき", kana: "かたやま さつき", house: "sangiin", group: "自民", district: "比例", termEnd: "2028-07-25", counts: { rollcalls: 120, bills: 0, speeches: 0 } },
  { id: "m_000007", name: "蓮舫", kana: "れんほう", house: "sangiin", group: "立憲", district: "東京", termEnd: "2028-07-25", counts: { rollcalls: 120, bills: 0, speeches: 0 } },
  { id: "m_000008", name: "ガーシー", kana: "がーしー", house: "sangiin", group: "N党", district: "比例", termEnd: "2028-07-25", counts: { rollcalls: 120, bills: 0, speeches: 0 } },
  { id: "m_000009", name: "小野田 紀美", kana: "おのだ きみ", house: "sangiin", group: "自民", district: "岡山", termEnd: "2028-07-25", counts: { rollcalls: 120, bills: 0, speeches: 0 } },
  { id: "m_000010", name: "渡辺 猛之", kana: "わたなべ たけゆき", house: "sangiin", group: "自民", district: "岐阜", counts: { rollcalls: 120, bills: 0, speeches: 0 } },
];
