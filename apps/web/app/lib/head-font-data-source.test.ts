/**
 * **`readHeadFontDataSource` が痩せたら鳴る**（#520 のレビュー指摘）。
 *
 * この関数は**サブセットを作る側と、覆えているかを検査する側の両方**が読む。
 * だから**源が痩せると、期待値も一緒に痩せて検査は緑のまま**になる。自己参照の穴である。
 *
 * レビュアーが実際に当てた変異:
 *
 *     -  if (s.position) speakerPositions.push(s.position);
 *     +  if (false && s.position) speakerPositions.push(s.position);
 *     → font-subset-coverage.test.ts の 7 tests すべて green
 *
 * `.member-position` は **`data/` を読まないといけない最大の理由**として挙げた欄そのもの
 * （137 字あり、うち 68 字は氏名・会派・選挙区のどれにも出てこない）。
 * **そこが黙って消せる状態だった。**
 *
 * ここは「字が足りているか」ではなく**「欄そのものが取れているか」**を固定する。
 * 件数は実測値（2026-09-06）で、**下限だけを見る**（ETL が増やす方向には動くので上限は置かない）。
 */
import { describe, expect, it } from "vitest";
import { defaultDataDir } from "./data-files";
import { readHeadFontDataSource } from "./head-font-data-source";

const dataDir = defaultDataDir();
/** `data/` 全体を舐めるので**1 回だけ読む**（2 回読むと 20s の testTimeout に触れる。#501） */
const source = readHeadFontDataSource(dataDir);

describe("readHeadFontDataSource が data/ の 5 欄をすべて拾えている（#477 / #520）", () => {
  /**
   * 実測（2026-09-06）: members 1,057 / speakerPositions 17,416 / rollCallGroups 96,993（votes[] を含む）/
   * localVoteMarks 44,527 / assemblyNames 9。**下限は実測の半分**にして、
   * ETL の増減で無意味に落ちないようにしつつ、**欄が丸ごと消えたら必ず落ちる**ようにする。
   */
  it.each([
    ["members（議員の氏名・会派・選挙区）", () => source.members?.length ?? 0, 500],
    ["speakerPositions（発言の役職。HTML には焼き込まれない）", () => source.speakerPositions?.length ?? 0, 8000],
    ["rollCallGroups（採決の会派名。groups[] と votes[].group の両方）", () => source.rollCallGroups?.length ?? 0, 2000],
    ["localVoteMarks（地方議会の判の原文）", () => source.localVoteMarks?.length ?? 0, 20000],
    ["assemblyNames（/coverage が明朝700 で描く議会名）", () => source.assemblyNames?.length ?? 0, 5],
  ])("%s が取れている", (_name, count, min) => {
    expect(count()).toBeGreaterThanOrEqual(min);
  });

  /** `votes[].group` にしか無い会派（`unlistedGroups()` が同じクラスで描く）も入っていること */
  it("採決の会派名は votes[].group も含む（groups[] だけではない）", () => {
    const groups = new Set(source.rollCallGroups ?? []);
    // groups[] だけを読んでいたら、`rollCallGroups` の異なり数は「会派の数」程度で頭打ちになる。
    // votes[] も読むと同じ会派が票の数だけ積まれるので、**総数が異なり数より大きく上回る**
    expect(source.rollCallGroups!.length).toBeGreaterThan(groups.size * 2);
  });

  it("氏名には区切りの空白が入っている（落とすと 1,013 名で 1 グリフ欠ける）", () => {
    expect(source.members!.some((m) => (m.name ?? "").includes(" "))).toBe(true);
  });
});
