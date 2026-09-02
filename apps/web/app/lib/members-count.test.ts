import { describe, expect, it } from "vitest";
import { isCurrentMember, isCurrentOf } from "./members-count";

/**
 * 議員数の数え方（#351 / #355）。トップ・/assemblies・議会ページの3ページが使う。
 * ルート経由のテストはあるが、**ここ自体のテストが無かった**ので足す。
 * 数え方が変わると「参議院議員 307」（定数248超え）のような誤りが復活する。
 */
const m = (o: Partial<{ house: string; current: boolean }>) => o as Parameters<ReturnType<typeof isCurrentOf>>[0];

describe("isCurrentMember", () => {
  it("current: false は現職でない（元職）", () => {
    expect(isCurrentMember(m({ current: false }))).toBe(false);
  });

  it("current: true は現職", () => {
    expect(isCurrentMember(m({ current: true }))).toBe(true);
  });

  // #351: `current` を持たない古いデータを元職扱いにすると、議員が丸ごと数から消える。
  // /members の既定（現職のみ）と同じ扱いにそろえる
  it("current が無ければ現職として扱う（古いデータ）", () => {
    expect(isCurrentMember(m({}))).toBe(true);
    expect(isCurrentMember(m({ current: undefined }))).toBe(true);
  });
});

describe("isCurrentOf", () => {
  it("院が一致する現職だけ真", () => {
    expect(isCurrentOf("sangiin")(m({ house: "sangiin", current: true }))).toBe(true);
    expect(isCurrentOf("sangiin")(m({ house: "shugiin", current: true }))).toBe(false);
  });

  it("院が一致しても元職は偽", () => {
    expect(isCurrentOf("sangiin")(m({ house: "sangiin", current: false }))).toBe(false);
  });

  it("house を持たない議員（地方議員）はどちらの院にも数えない", () => {
    // 地方議員は house を持たない。国会の人数に混ぜない
    expect(isCurrentOf("sangiin")(m({ current: true }))).toBe(false);
    expect(isCurrentOf("shugiin")(m({ current: true }))).toBe(false);
  });
});
