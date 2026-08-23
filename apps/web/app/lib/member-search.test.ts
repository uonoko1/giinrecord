import { describe, expect, it } from "vitest";
import { filterMembers, formatTermEnd, groupByKanaRow, kanaRow, memberAssemblyId } from "./member-search";
import { members } from "../test-fixtures/members-index";

describe("kanaRow: かなの先頭文字から五十音の行を決める", () => {
  it.each([
    ["あおき あい", "あ"],
    ["かたやま さつき", "か"],
    ["さとう はなこ", "さ"],
    ["たなか いちろう", "た"],
    ["なかむら", "な"],
    ["ふじかわ まさひと", "は"],
    ["まつい", "ま"],
    ["やまだ たろう", "や"],
    ["れんほう", "ら"],
    ["わたなべ たけゆき", "わ"],
  ])("%s → %s行", (kana, row) => {
    expect(kanaRow(kana)).toBe(row);
  });

  it("濁音・半濁音は清音の行（が→か、ぱ→は）", () => {
    expect(kanaRow("がーしー")).toBe("か");
    expect(kanaRow("ぱんだ")).toBe("は");
    expect(kanaRow("ざとう")).toBe("さ");
    expect(kanaRow("だて")).toBe("た");
  });

  it("カタカナ・小書きも同じ行", () => {
    expect(kanaRow("アオキ")).toBe("あ");
    expect(kanaRow("ぁ")).toBe("あ");
  });

  it("かなで始まらなければ「その他」", () => {
    expect(kanaRow("")).toBe("その他");
    expect(kanaRow("A.B")).toBe("その他");
  });
});

describe("groupByKanaRow", () => {
  it("五十音の行順に並び、行内はかな順", () => {
    const groups = groupByKanaRow(members);
    expect(groups.map((g) => g.row)).toEqual(["あ", "か", "さ", "た", "は", "や", "ら", "わ"]);
    expect(groups[0].members.map((m) => m.name)).toEqual(["青木 愛", "小野田 紀美"]);
    expect(groups[1].members.map((m) => m.name)).toEqual(["ガーシー", "片山 さつき"]);
  });

  it("0名なら空配列", () => {
    expect(groupByKanaRow([])).toEqual([]);
  });
});

describe("filterMembers", () => {
  it("氏名の部分一致（1文字から）", () => {
    expect(filterMembers(members, { query: "田" }).map((m) => m.name)).toEqual(["山田 太郎", "田中 一郎", "小野田 紀美"]);
  });

  it("かなの部分一致", () => {
    expect(filterMembers(members, { query: "たろ" }).map((m) => m.name)).toEqual(["山田 太郎"]);
  });

  it("全角／半角スペースは無視する（入力側も氏名側も）", () => {
    expect(filterMembers(members, { query: "藤川政人" })).toHaveLength(1);
    expect(filterMembers(members, { query: "藤川　政" })).toHaveLength(1);
    expect(filterMembers(members, { query: "ふじかわま" })).toHaveLength(1);
    expect(filterMembers(members, { query: " 　" })).toHaveLength(members.length);
  });

  it("カタカナ入力はひらがなとして照合する（全角・半角とも）", () => {
    expect(filterMembers(members, { query: "タロ" }).map((m) => m.name)).toEqual(["山田 太郎"]);
    expect(filterMembers(members, { query: "ﾌｼﾞｶﾜ" }).map((m) => m.name)).toEqual(["藤川 政人"]);
  });

  it("全角英数字は半角として照合する（NFKC）", () => {
    expect(filterMembers([{ ...members[0], name: "A. B" }], { query: "Ａ" })).toHaveLength(1);
  });

  it("議会（assemblyId）で絞り込める。未指定・空文字はすべての議会（#156）", () => {
    const shugiin = { ...members[0], id: "h_000001", name: "衆 太郎", kana: "しゅう たろう", house: "shugiin" as const, assemblyId: "diet-shugiin" as const };
    const local = { ...members[0], id: "p_04_000001", name: "宮城 太郎", kana: "みやぎ たろう", assemblyId: "pref-04" as const };
    const all = [...members, shugiin, local];
    expect(filterMembers(all, { assemblyId: "diet-shugiin" }).map((m) => m.id)).toEqual(["h_000001"]);
    expect(filterMembers(all, { assemblyId: "pref-04" }).map((m) => m.id)).toEqual(["p_04_000001"]);
    expect(filterMembers(all, { assemblyId: "diet-sangiin" })).toHaveLength(members.length);
    expect(filterMembers(all, {})).toHaveLength(all.length);
    expect(filterMembers(all, { assemblyId: "" })).toHaveLength(all.length);
  });

  it("memberAssemblyId: assemblyId が無い古いデータは house から diet-{house} を補う", () => {
    expect(memberAssemblyId(members[0])).toBe("diet-sangiin");
    expect(memberAssemblyId({ ...members[0], house: "shugiin" })).toBe("diet-shugiin");
    expect(memberAssemblyId({ ...members[0], assemblyId: "city-33100" })).toBe("city-33100");
  });

  it("会派・選挙区で絞り込める（組み合わせ可）", () => {
    expect(filterMembers(members, { group: "立憲" })).toHaveLength(3);
    expect(filterMembers(members, { district: "比例" })).toHaveLength(5);
    expect(filterMembers(members, { group: "自民", district: "比例" }).map((m) => m.name)).toEqual(["山田 太郎", "片山 さつき"]);
    expect(filterMembers(members, { query: "さ", group: "立憲", district: "東京" }).map((m) => m.name)).toEqual(["佐藤 花子"]);
  });

  it("一致なしは空配列", () => {
    expect(filterMembers(members, { query: "存在しない" })).toEqual([]);
  });
});

describe("formatTermEnd", () => {
  it("2028-07-25 → 〜2028.07", () => {
    expect(formatTermEnd("2028-07-25")).toBe("〜2028.07");
  });
  it("未設定や想定外の形式は undefined", () => {
    expect(formatTermEnd(undefined)).toBeUndefined();
    expect(formatTermEnd("不明")).toBeUndefined();
  });
});
