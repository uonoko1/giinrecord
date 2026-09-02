import { isLocalMember } from "./assemblies";
import type { DatasetSource, MemberDetail, SourceKind } from "./data-contract";

/**
 * 出典欄が描画に必要とする最小の形。国会の `DatasetSource`（house/kind つき）も、
 * 地方議会の出典（`assemblies/{id}/meta.json`、house/kind を持たない）も、どちらもこれを満たす。
 */
export type PlainSource = { name: string; url: string; fetchedAt: string };

/**
 * その議員ページが実際に使った出典だけに絞る（Issue #339）。
 *
 * 以前は `meta.sources`（データセット全体の33件）を丸ごと出していたので、衆院議員のページに
 * 参議院の議員一覧・議案情報・質問主意書が17件並んでいた。このサイトの前提は
 * 「評価しない。全行に一次資料リンク」であり、**引いていない資料を出典として並べるのは
 * その約束に反する**（読者が検証しようと開いても、その議員の記録はそこに無い）。
 *
 * 絞り方は2段:
 *   1. **院** — その議員の院の出典だけ（`both` は院をまたぐ出典なので常に残す）
 *   2. **種別** — その議員が実際に持つ記録の種別だけ
 *
 * 議員一覧（roster）はその議員自身の出所なので、記録が1件も無くても常に残す。
 */
export function memberSources(sources: DatasetSource[], detail: MemberDetail, speechCount: number): DatasetSource[] {
  // #339 より前に作られた meta.json には house / kind が無い。そのまま絞ると**全件落ちて出典が空になる**
  // （出典を減らすつもりが、1件も出さない = 約束をもっと強く破る）。属性を持たない出典が1件でもあれば
  // 絞り込みを諦めて全件返す——「絞れない」ときに黙って隠すより、多く出す方が安全側。
  // 次回の ETL で meta.json が更新されれば、この分岐は通らなくなる。
  if (sources.some((s) => !s.house || !s.kind)) return sources;

  // 地方議会の議員はここに来ない（#346）。議員ページが議会自身の出典を先に選ぶため。
  // ただしこの関数を国会以外で直に呼ばれても壊れないよう、念のため素通しする。
  if (isLocalMember(detail)) return sources;

  const kinds = usedKinds(detail, speechCount);
  return sources.filter((s) => matchesHouse(s, detail) && kinds.has(s.kind));
}

function matchesHouse(s: DatasetSource, detail: MemberDetail): boolean {
  return s.house === "both" || s.house === detail.house;
}

/** その議員が実際に持つ記録から、必要な出典の種別を出す。 */
function usedKinds(detail: MemberDetail, speechCount: number): Set<SourceKind> {
  // roster は常に。その議員の氏名・会派・選挙区の出所そのものなので、記録ゼロでも要る。
  const kinds = new Set<SourceKind>(["roster"]);
  if (speechCount > 0) kinds.add("speech");
  for (const e of detail.timeline) {
    switch (e.kind) {
      // stance（会派の態度・推定）の出典は衆院の議案経過ページ = 議案情報
      case "vote": kinds.add("vote"); break;
      case "stance": case "bill": kinds.add("bill"); break;
      case "question": kinds.add("question"); break;
      case "committeeRole": case "attendance": kinds.add("committee"); break;
      // localVote は地方議会。国会の meta.sources には対応する出典が無い（議会ごとの出典は別に出す）
      case "localVote": break;
    }
  }
  return kinds;
}
