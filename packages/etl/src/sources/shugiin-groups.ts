/**
 * 衆議院 会派の略称 → 正式名称。
 * 略称は議員一覧（syu/{n}giin.htm）に、正式名称は会派名及び会派別所属議員数（syu/kaiha_m.htm）に現れる。
 * 出典: https://www.shugiin.go.jp/internet/itdb_annai.nsf/html/statics/syu/kaiha_m.htm （令和8年2月18日現在、2026-08-23 確認）
 * 会派は選挙・離合集散で変わるため、新しい略称が出たらここに追記する（テストが kaiha_m のフィクスチャと突き合わせる）。
 * 未知の略称は resolveShugiinGroup が原文のまま返し、data/unmatched-groups.json に列挙される（ETL は止めない）。
 */
export const SHUGIIN_GROUPS: Readonly<Record<string, string>> = {
  自民: "自由民主党・無所属の会",
  中道: "中道改革連合・無所属",
  維新: "日本維新の会",
  国民: "国民民主党・無所属クラブ",
  参政: "参政党",
  みらい: "チームみらい",
  共産: "日本共産党",
  無: "無所属",
};

const FULL_NAMES: ReadonlySet<string> = new Set(Object.values(SHUGIIN_GROUPS));

/** 名簿セルの文字列（略称または既に正式名称）を正式名称に解決する。解決できなければ原文をそのまま返す（事実を隠さない）。 */
export function resolveShugiinGroup(cell: string): string {
  return SHUGIIN_GROUPS[cell] ?? cell;
}

/** 対応表の正式名称か（略称・未知の文字列は false）。 */
export function isKnownShugiinGroup(name: string): boolean {
  return FULL_NAMES.has(name);
}
