/**
 * 参議院 会派の略称 → 正式名称。
 * 略称は議員一覧（giin.htm）に、正式名称は投票結果ページ・会派別所属議員数（giinsu.htm）に現れる。
 * 出典: https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giinsu.htm （2026-08-22 確認）
 * 会派は回次ごとに変わるため、新しい略称が出たらここに追記する（テストが検出する）。
 */
export const SANGIIN_GROUPS: Readonly<Record<string, string>> = {
  自民: "自由民主党・無所属の会",
  立憲: "立憲民主・無所属",
  民主: "国民民主党・新緑風会",
  公明: "公明党",
  維新: "日本維新の会",
  参政: "参政党",
  共産: "日本共産党",
  い党: "いのちの党",
  保守: "日本保守党",
  沖縄: "沖縄の風",
  みら: "チームみらい・無所属の会",
  社民: "社会民主党",
  無所属: "各派に属しない議員",
};

/** 略称から正式名称。未知の略称は undefined。 */
export function groupFullName(abbr: string): string | undefined {
  return SANGIIN_GROUPS[abbr];
}

/** 名簿側の会派（略称または正式名称）と投票ページの会派名が同一会派を指すか。 */
export function matchesGroup(rosterGroup: string, voteGroup: string): boolean {
  return rosterGroup === voteGroup || groupFullName(rosterGroup) === voteGroup;
}
