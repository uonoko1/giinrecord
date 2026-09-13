import { describe, expect, test } from "vitest";
import type { LocalAssemblyMeta } from "./data-contract";
import { lossyNameMatchFor, lossyNameSummary } from "./lossy-name";

/**
 * #800: `meta.lossyNameMatches`（#778 / PR #794）は 11 県すべての `meta.json` に入ったが、
 * **配信も表示もされていなかった**（`grep -rn lossyNameMatches apps/web` が 0 件）。
 * ここは「data にある事実を画面に出す」ための読み側。**判定は変えない**（ETL 側のまま）。
 */

const meta = (lossy?: LocalAssemblyMeta["lossyNameMatches"], rollcalls = 125): LocalAssemblyMeta =>
  ({
    assemblyId: "pref-29",
    fetchedAt: "2026-09-04T22:17:32.500Z",
    rosterAsOf: "2026-04-24",
    sessions: [],
    sources: [],
    counts: { members: 40, rollcalls, cells: 5000, unknownCells: 0, unmatchedNames: 0 },
    ...(lossy ? { lossyNameMatches: lossy } : {}),
  }) as LocalAssemblyMeta;

const NARA = [
  { memberId: "p_29_52575", nameText: "西川", rosterName: "西川 均", rollCalls: 125 },
  { memberId: "p_29_52536", nameText: "髙清友", rosterName: "芦高 清友", rollCalls: 37 },
];

describe("lossyNameMatchFor: その議員の行だけを返す", () => {
  test("本番の奈良と同じ形で、議員 id の行が返る", () => {
    expect(lossyNameMatchFor(meta(NARA), "p_29_52575")).toEqual(NARA[0]);
    expect(lossyNameMatchFor(meta(NARA), "p_29_52536")).toEqual(NARA[1]);
  });

  test("否定的対照: lossyNameMatches に居ない議員には何も返さない", () => {
    expect(lossyNameMatchFor(meta(NARA), "p_29_00000")).toBeNull();
  });

  test("否定的対照: 欄が無い県（10 県）では誰にも返さない", () => {
    expect(lossyNameMatchFor(meta(undefined), "p_29_52575")).toBeNull();
  });

  test("meta が無い（国会議員・未取得）なら返さない", () => {
    expect(lossyNameMatchFor(null, "p_29_52575")).toBeNull();
  });

  test("空配列は「1 件も無い」なので返さない", () => {
    expect(lossyNameMatchFor(meta([]), "p_29_52575")).toBeNull();
  });
});

describe("lossyNameSummary: 議会ごとの件数と母数（#757）", () => {
  test("件数・人数・母数（表決の総数）を数えた実数で返す", () => {
    expect(lossyNameSummary(meta(NARA))).toEqual({ members: 2, rollCalls: 162, totalRollCalls: 125 });
  });

  test("否定的対照: 欄の無い県は 0 件だが母数は返す（「0 件」と「1 件も読めていない」を分ける）", () => {
    expect(lossyNameSummary(meta(undefined, 88))).toEqual({ members: 0, rollCalls: 0, totalRollCalls: 88 });
  });

  test("meta が無い（1 件も読めていない）なら null", () => {
    expect(lossyNameSummary(null)).toBeNull();
  });
});
