/**
 * 参議院 会派の略称 → 正式名称。
 * 略称は議員一覧（giin.htm）に、正式名称は投票結果ページ・会派別所属議員数（giinsu.htm）に現れる。
 * 出典: https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giinsu.htm （2026-08-22 確認）
 * 会派は回次ごとに変わるため、新しい略称が出たらここに追記する（テストが検出する）。
 *
 * 「みら」「い党」は名簿ページがそのまま使っている2文字略称（改行や切り詰めではない。Issue #36）。
 * 名簿は略称のまま公開せず resolveGroup で正式名称に解決し、未知の略称は原文のまま保持して
 * data/unmatched-groups.json に列挙する（ETL は止めない）。
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
  れ新: "れいわ新選組",     // 第217〜220回の名簿。第221回に「いのちの党」へ改称
  保守: "日本保守党",
  沖縄: "沖縄の風",
  みら: "チームみらい・無所属の会",
  社民: "社会民主党",
  無所属: "各派に属しない議員",
  Ｎ党: "ＮＨＫから国民を守る党", // 第216回名簿まで（令和7年の通常選挙で議席なし）
};

/**
 * 略称 → 改称前の正式名称（投票結果ページに現れた旧表記）。回次をまたいで採決を突合するために使う。
 * 名簿の group は最新の正式名称に解決し、公開データの採決ページ側は投票ページの原文のまま（事実）。
 */
export const SANGIIN_GROUP_FORMER_NAMES: Readonly<Record<string, readonly string[]>> = {
  自民: ["自由民主党"],                 // 〜第219回
  立憲: ["立憲民主・社民・無所属"],      // 〜第219回
  Ｎ党: ["ＮＨＫ党"],                   // 第217回中に一時改称
};

const FULL_NAMES: ReadonlySet<string> = new Set(Object.values(SANGIIN_GROUPS));

/** 略称から正式名称。未知の略称は undefined。 */
export function groupFullName(abbr: string): string | undefined {
  return SANGIIN_GROUPS[abbr];
}

/** 名簿セルの文字列（略称または既に正式名称）を正式名称に解決する。解決できなければ原文をそのまま返す（事実を隠さない）。 */
export function resolveGroup(cell: string): string {
  return groupFullName(cell) ?? cell;
}

/** 対応表の正式名称か（略称・未知の文字列は false）。公開データの group に略称が残っていないことの検査に使う。 */
export function isKnownGroup(name: string): boolean {
  return FULL_NAMES.has(name);
}

/** 名簿側の会派（略称または正式名称）と投票ページの会派名が同一会派を指すか。 */
export function matchesGroup(rosterGroup: string, voteGroup: string): boolean {
  if (rosterGroup === voteGroup || groupFullName(rosterGroup) === voteGroup) return true;
  const abbr = SANGIIN_GROUPS[rosterGroup] ? rosterGroup : ABBR_OF.get(rosterGroup);
  return abbr !== undefined && (SANGIIN_GROUP_FORMER_NAMES[abbr] ?? []).includes(voteGroup);
}

/** 正式名称 → 略称（逆引き）。 */
const ABBR_OF: ReadonlyMap<string, string> = new Map(Object.entries(SANGIIN_GROUPS).map(([abbr, full]) => [full, abbr]));
