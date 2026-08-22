import { describe, expect, it } from "vitest";
import { groupsBySize, sessionsDesc, sortByDateDesc, unlistedGroups, votesByGroup } from "./rollcall";

describe("groupsBySize", () => {
  it("人数の多い順。同数は原文の順を保つ", () => {
    const groups = [
      { group: "A", size: 2, yes: 2, no: 0 },
      { group: "B", size: 5, yes: 5, no: 0 },
      { group: "C", size: 2, yes: 0, no: 2 },
    ];
    expect(groupsBySize(groups).map((g) => g.group)).toEqual(["B", "A", "C"]);
  });
  it("元の配列を変更しない", () => {
    const groups = [
      { group: "A", size: 1, yes: 1, no: 0 },
      { group: "B", size: 2, yes: 2, no: 0 },
    ];
    groupsBySize(groups);
    expect(groups.map((g) => g.group)).toEqual(["A", "B"]);
  });
});

describe("votesByGroup", () => {
  it("会派ごとに原文の順で束ねる", () => {
    const votes = [
      { memberId: "m1", nameText: "一", group: "A", value: "賛成" as const },
      { memberId: "m2", nameText: "二", group: "B", value: "反対" as const },
      { memberId: "m3", nameText: "三", group: "A", value: "投票なし" as const },
    ];
    const map = votesByGroup(votes);
    expect(map.get("A")?.map((v) => v.nameText)).toEqual(["一", "三"]);
    expect(map.get("B")?.map((v) => v.nameText)).toEqual(["二"]);
    expect(map.get("C")).toBeUndefined();
  });
});

describe("sortByDateDesc / sessionsDesc", () => {
  const rows = [
    { id: "b", session: 220, date: "2026-01-24" },
    { id: "a", session: 221, date: "2026-07-24" },
    { id: "c", session: 221, date: "2026-03-23" },
  ];
  it("日付降順", () => {
    expect(sortByDateDesc(rows).map((r) => r.id)).toEqual(["a", "c", "b"]);
  });
  it("同日は id 昇順で安定する（入力の順に依存しない）", () => {
    const sameDay = [
      { id: "221-0724-v007", session: 221, date: "2026-07-24" },
      { id: "221-0724-v006", session: 221, date: "2026-07-24" },
      { id: "221-0724-v010", session: 221, date: "2026-07-24" },
    ];
    const expected = ["221-0724-v006", "221-0724-v007", "221-0724-v010"];
    expect(sortByDateDesc(sameDay).map((r) => r.id)).toEqual(expected);
    expect(sortByDateDesc([...sameDay].reverse()).map((r) => r.id)).toEqual(expected);
  });
  it("回次は重複を除き新しい順", () => {
    expect(sessionsDesc(rows)).toEqual([221, 220]);
  });
});

describe("unlistedGroups: groups[] に無い会派の票を黙って落とさない", () => {
  const groups = [{ group: "A", size: 1, yes: 1, no: 0 }];
  it("票にだけ現れる会派を、票の登場順に重複なく返す", () => {
    const votes = [
      { memberId: "m1", nameText: "一", group: "A", value: "賛成" as const },
      { memberId: "m2", nameText: "二", group: "C", value: "反対" as const },
      { memberId: "m3", nameText: "三", group: "B", value: "投票なし" as const },
      { memberId: "m4", nameText: "四", group: "C", value: "賛成" as const },
    ];
    expect(unlistedGroups(groups, votes)).toEqual(["C", "B"]);
  });
  it("すべての票の会派が groups[] にあれば空", () => {
    expect(unlistedGroups(groups, [{ memberId: "m1", nameText: "一", group: "A", value: "賛成" }])).toEqual([]);
  });
});
