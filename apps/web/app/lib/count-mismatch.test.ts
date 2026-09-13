import { describe, expect, test } from "vitest";
import type { LocalAssemblyMeta } from "./data-contract";
import { countMismatchSummary } from "./count-mismatch";

/**
 * #826: `meta.countMismatches` / `meta.countChecked` は 11 県すべての `meta.json` に入るが、
 * **`meta.json` は `/data/` で配信されず、バンドルもされない**（#800 でそれが起きていた）。
 * ここは「data にある事実を画面に出す」ための読み側。**判定は変えない**（ETL 側のまま）。
 */

const meta = (over: Partial<LocalAssemblyMeta> = {}): LocalAssemblyMeta =>
  ({
    assemblyId: "pref-41",
    fetchedAt: "2026-09-04T22:17:32.500Z",
    rosterAsOf: "2026-04-24",
    sessions: [],
    sources: [],
    counts: { members: 37, rollcalls: 23, cells: 851, unknownCells: 0, unmatchedNames: 0 },
    countChecked: { rows: 23, checked: 23, noCounts: 0, unreadableCells: 0 },
    ...over,
  }) as LocalAssemblyMeta;

describe("countMismatchSummary", () => {
  test("食い違いが 0 でも母数を返す（「0 件」は「見た上での 0」でなければ意味が無い。#757）", () => {
    expect(countMismatchSummary(meta())).toEqual({ mismatches: 0, checked: 23, noCounts: 0, unreadableCells: 0, rows: 23 });
  });

  test("山梨と同じ形の行があれば件数として返る（記録は出たまま）", () => {
    const m = meta({
      countMismatches: [{ rollCallId: "pref-41-x-1", counted: { yes: 19, no: 17 }, published: { yes: 18, no: 17 } }],
    });
    expect(countMismatchSummary(m)?.mismatches).toBe(1);
  });

  test("本番の高知の形（counts の欄が 104 件すべてに無い）: 母数 0 と食い違い 0 を区別できる", () => {
    const m = meta({ assemblyId: "pref-39", countChecked: { rows: 104, checked: 0, noCounts: 104, unreadableCells: 0 } } as Partial<LocalAssemblyMeta>);
    expect(countMismatchSummary(m)).toEqual({ mismatches: 0, checked: 0, noCounts: 104, unreadableCells: 0, rows: 104 });
  });

  test("本番の滋賀の形（凡例の引けないセルがある行が 4 件）", () => {
    const m = meta({ assemblyId: "pref-25", countChecked: { rows: 14, checked: 10, noCounts: 0, unreadableCells: 4 } } as Partial<LocalAssemblyMeta>);
    expect(countMismatchSummary(m)).toEqual({ mismatches: 0, checked: 10, noCounts: 0, unreadableCells: 4, rows: 14 });
  });

  test("否定的対照: meta がまだ読めていなければ null（0 件と同じ形にしない。#757）", () => {
    expect(countMismatchSummary(null)).toBeNull();
  });

  test("否定的対照: countChecked の無い古い meta でも null（欄が無いことを 0 にしない）", () => {
    expect(countMismatchSummary(meta({ countChecked: undefined } as Partial<LocalAssemblyMeta>))).toBeNull();
  });
});
