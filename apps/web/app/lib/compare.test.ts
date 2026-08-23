/**
 * /compare（Issue #104）の純粋ロジック。採決・議案を rollCallId / billId で揃え、列＝議員・行＝案件にする。
 * 一致率・スコアは作らない（ここに無いことが仕様）。
 */
import { describe, expect, it } from "vitest";
import type { MemberDetail } from "./data-contract";
import adachi from "../test-fixtures/compare/m_014002.json";
import otsubaki from "../test-fixtures/compare/m_023003.json";
import aisawa from "../test-fixtures/compare/h_41f223ac28.json";
import aoki from "../test-fixtures/compare/h_dcf5bd65bf.json";
import { COMPARE_MAX, COMPARE_STORAGE_KEY, alignTimelines, parseCompareIds, readStoredCompareIds, toggleCompareId, writeStoredCompareIds } from "./compare";

const A = adachi as MemberDetail;
const O = otsubaki as MemberDetail;
const AI = aisawa as MemberDetail;
const AO = aoki as MemberDetail;

describe("parseCompareIds", () => {
  it("カンマ区切りを id の配列にする（空・重複・不正な文字は落とす）", () => {
    expect(parseCompareIds("m_1,m_2,,m_1, h_3")).toEqual(["m_1", "m_2", "h_3"]);
    expect(parseCompareIds("../x,m_1")).toEqual(["m_1"]);
  });
  it("最大 4 名で切る", () => {
    expect(COMPARE_MAX).toBe(4);
    expect(parseCompareIds("a,b,c,d,e")).toEqual(["a", "b", "c", "d"]);
  });
  it("無指定は空", () => {
    expect(parseCompareIds(null)).toEqual([]);
    expect(parseCompareIds("")).toEqual([]);
  });
});

describe("toggleCompareId", () => {
  it("未登録なら末尾に追加、登録済みなら外す", () => {
    expect(toggleCompareId(["m_1"], "m_2")).toEqual({ ids: ["m_1", "m_2"], added: true });
    expect(toggleCompareId(["m_1", "m_2"], "m_1")).toEqual({ ids: ["m_2"], added: false });
  });
  it("4 名登録済みなら追加しない（full）", () => {
    expect(toggleCompareId(["a", "b", "c", "d"], "e")).toEqual({ ids: ["a", "b", "c", "d"], added: false, full: true });
  });
  it("localStorage のキーは名前空間付き", () => {
    expect(COMPARE_STORAGE_KEY).toBe("seiji-kiroku:compare");
  });
});

describe("localStorage の比較リスト", () => {
  it("保存して読み戻せる。空にすればキーを消す", () => {
    writeStoredCompareIds(["m_1", "h_2"]);
    expect(localStorage.getItem(COMPARE_STORAGE_KEY)).toBe('["m_1","h_2"]');
    expect(readStoredCompareIds()).toEqual(["m_1", "h_2"]);
    writeStoredCompareIds([]);
    expect(localStorage.getItem(COMPARE_STORAGE_KEY)).toBeNull();
  });
  it("壊れた値・配列でない値・不正な id は空か除外にして落ちない", () => {
    localStorage.setItem(COMPARE_STORAGE_KEY, "{not json");
    expect(readStoredCompareIds()).toEqual([]);
    localStorage.setItem(COMPARE_STORAGE_KEY, '{"a":1}');
    expect(readStoredCompareIds()).toEqual([]);
    localStorage.setItem(COMPARE_STORAGE_KEY, '["m_1", 2, "../x"]');
    expect(readStoredCompareIds()).toEqual(["m_1"]);
    localStorage.removeItem(COMPARE_STORAGE_KEY);
  });
});

describe("alignTimelines 参院（事実）", () => {
  const rows = alignTimelines([A, O]);
  it("2人以上に記録のある採決だけを行にし、日付降順に並べる", () => {
    expect(rows.facts.map((r) => r.id)).toEqual(["217-0613-v003", "217-0516-v006"]);
  });
  it("各列にその議員の票を置き、値はそのまま", () => {
    const r = rows.facts[0]!;
    expect(r.title).toBe(A.timeline[1]!.title);
    expect(r.cells.map((c) => c?.value)).toEqual(["賛成", "反対"]);
    expect(r.cells[0]?.sourceUrl).toMatch(/^https:\/\/www\.sangiin\.go\.jp\//);
  });
  it("投票なしは投票なしのまま（欠席と棄権を区別しない）", () => {
    expect(rows.facts[1]!.cells[1]?.value).toBe("投票なし");
  });
  it("1人にしか記録の無い採決は行にならず、件数として残す", () => {
    expect(rows.facts.map((r) => r.id)).not.toContain("221-0724-v007");
    expect(rows.unsharedVotes).toEqual([1, 0]);
  });
  it("衆院議員がいなければ推定行は空", () => {
    expect(rows.estimated).toEqual([]);
  });
});

describe("alignTimelines 衆院（推定）と混在", () => {
  it("衆院同士は会派の態度を billId で揃え、会派名と態度の原文を残す", () => {
    const rows = alignTimelines([AI, AO]);
    expect(rows.facts).toEqual([]);
    expect(rows.estimated.map((r) => r.id)).toEqual(["221-衆法-27", "221-衆法-25"]);
    const r = rows.estimated[0]!;
    expect(r.cells.map((c) => c && [c.group, c.stance])).toEqual([
      ["自由民主党・無所属の会", "賛成"],
      ["参政党", "反対"],
    ]);
    expect(r.cells[0]?.estimated).toBe(true);
  });
  it("参院と衆院を混ぜると、採決の行では衆院の列が「記録なし」（null）になる", () => {
    const rows = alignTimelines([A, O, AI]);
    expect(rows.facts[0]!.cells).toHaveLength(3);
    expect(rows.facts[0]!.cells[2]).toBeNull();
    expect(rows.estimated).toEqual([]);
  });
  it("1人だけなら行は作らない（比べる相手がいない）", () => {
    const rows = alignTimelines([A]);
    expect(rows.facts).toEqual([]);
    expect(rows.unsharedVotes).toEqual([3]);
  });
});
