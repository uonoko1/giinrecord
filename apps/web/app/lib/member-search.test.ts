import { describe, expect, it } from "vitest";
import type { Assembly } from "@seiji-kiroku/shared";
import {
  filterMembers,
  formatTermEnd,
  foldKanaGroups,
  groupByKanaRow,
  kanaRow,
  memberAssemblyId,
  membersDescription,
  membersHeading,
  membersQueryString,
  membersScopeFromQuery,
} from "./member-search";
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

describe("membersHeading / membersDescription（#239: 見出し・説明が絞り込みを反映する）", () => {
  const none = { assemblyName: undefined, group: "", district: "", includeFormer: false };

  it("絞り込み無しは「収録している議会の現職議員」。全国を網羅していると読める表現は使わない", () => {
    expect(membersHeading(none)).toBe("収録している議会の現職議員");
    expect(membersDescription(none)).toBe("収録している議会の現職議員を五十音順に。氏名・ふりがな・議会・会派・選挙区でさがせます。");
    // 「国会議員」（実際は地方議員も含む）とも、「すべての議会」「網羅」「全国」（実際は9議会）とも書かない
    for (const word of ["国会議員", "すべての議会", "網羅", "全国"]) {
      expect(membersHeading(none)).not.toContain(word);
      expect(membersDescription(none)).not.toContain(word);
    }
  });

  it("議会を選ぶと議会名の見出しになる", () => {
    expect(membersHeading({ ...none, assemblyName: "徳島県議会" })).toBe("徳島県議会の現職議員");
    expect(membersHeading({ ...none, assemblyName: "参議院" })).toBe("参議院の現職議員");
  });

  it("会派・選挙区も見出しに入る（議会と組み合わせ可）", () => {
    expect(membersHeading({ ...none, assemblyName: "徳島県議会", group: "自由民主党" })).toBe("徳島県議会・自由民主党の現職議員");
    expect(membersHeading({ ...none, assemblyName: "参議院", district: "愛知" })).toBe("参議院・愛知の現職議員");
    expect(membersHeading({ ...none, group: "立憲", district: "東京" })).toBe("立憲・東京の現職議員");
  });

  it("「元職も含める」を入れると見出し・説明もそう言う（見出しが表示中の集合とずれない）", () => {
    const withFormer = { ...none, includeFormer: true };
    expect(membersHeading(withFormer)).toBe("収録している議会の議員（元職を含む）");
    expect(membersDescription(withFormer)).toBe("収録している議会の議員（元職を含む）を五十音順に。氏名・ふりがな・議会・会派・選挙区でさがせます。");
    expect(membersHeading({ ...withFormer, assemblyName: "徳島県議会" })).toBe("徳島県議会の議員（元職を含む）");
    expect(membersHeading({ ...withFormer, assemblyName: "徳島県議会", group: "自由民主党" })).toBe("徳島県議会・自由民主党の議員（元職を含む）");
  });

  it("現職のみ／元職を含む で見出しが必ず変わる（同じ文言にならない）", () => {
    for (const s of [none, { ...none, assemblyName: "参議院" }, { ...none, group: "自民", district: "比例" }]) {
      expect(membersHeading({ ...s, includeFormer: true })).not.toBe(membersHeading({ ...s, includeFormer: false }));
    }
  });

  it("説明は選んだ条件をそのまま並べる。評価語・形容詞を入れない", () => {
    const text = membersDescription({ ...none, assemblyName: "徳島県議会", group: "自由民主党", district: "徳島市" });
    expect(text).toBe("徳島県議会・自由民主党・徳島市の現職議員を五十音順に。氏名・ふりがな・議会・会派・選挙区でさがせます。");
    for (const word of ["おすすめ", "人気", "有力", "話題", "注目", "ランキング", "充実", "網羅"]) expect(text).not.toContain(word);
  });
});

describe("membersScopeFromQuery（#239: URL のクエリを絞り込みに読む。実在する値だけを受け付ける）", () => {
  const assemblies = [
    { id: "diet-sangiin", kind: "national", name: "参議院", sourceUrl: "https://www.sangiin.go.jp/" },
    { id: "pref-36", kind: "prefectural", name: "徳島県議会", prefCode: "36", sourceUrl: "https://www.pref.tokushima.lg.jp/" },
  ] as unknown as Assembly[];

  const roster = [
    { ...members[0], assemblyId: "pref-36" as const, group: "自由民主党", district: "徳島市" },
    { ...members[1], assemblyId: "pref-36" as const, group: "グローカルplus", district: "鳴門市" },
    { ...members[2], assemblyId: "diet-sangiin" as const, group: "自民", district: "愛知" },
  ];

  it("assembly・group・district を読み、議会 id は名前に解決する", () => {
    expect(membersScopeFromQuery(new URLSearchParams("assembly=pref-36&group=自由民主党&district=徳島市"), assemblies, roster)).toEqual({
      assemblyId: "pref-36",
      assemblyName: "徳島県議会",
      group: "自由民主党",
      district: "徳島市",
      includeFormer: false,
    });
  });

  it("知らない議会 id は無視する（すべての議会として扱う）", () => {
    expect(membersScopeFromQuery(new URLSearchParams("assembly=pref-99"), assemblies, roster).assemblyId).toBe("");
  });

  it("名簿に無い会派名・選挙区名は無視する（でっち上げた名前を見出し・OGP に出さない）", () => {
    const scope = membersScopeFromQuery(new URLSearchParams("group=存在しない会派&district=存在しない選挙区"), assemblies, roster);
    expect(scope.group).toBe("");
    expect(scope.district).toBe("");
    expect(membersHeading(scope)).toBe("収録している議会の現職議員");
  });

  it("会派・選挙区は選んだ議会の名簿にあるものだけ通す（他の議会にしか無い名前は無視）", () => {
    // 「愛知」は参院にしか無い選挙区。徳島県議会を選んでいるあいだは通さない
    const scope = membersScopeFromQuery(new URLSearchParams("assembly=pref-36&district=愛知"), assemblies, roster);
    expect(scope.district).toBe("");
    expect(membersHeading(scope)).toBe("徳島県議会の現職議員");
    expect(membersScopeFromQuery(new URLSearchParams("assembly=diet-sangiin&district=愛知"), assemblies, roster).district).toBe("愛知");
  });

  it("元職しかいない会派・選挙区は former=1 のときだけ通す（名簿の照合も元職の有無に従う）", () => {
    const withFormer = [...roster, { ...members[3], assemblyId: "pref-36" as const, group: "旧会派", district: "旧選挙区", current: false as const }];
    expect(membersScopeFromQuery(new URLSearchParams("group=旧会派"), assemblies, withFormer).group).toBe("");
    const on = membersScopeFromQuery(new URLSearchParams("group=旧会派&former=1"), assemblies, withFormer);
    expect(on.group).toBe("旧会派");
    expect(on.includeFormer).toBe(true);
  });

  it("former=1 のときだけ元職を含む。他の値・未指定は現職のみ", () => {
    expect(membersScopeFromQuery(new URLSearchParams("former=1"), assemblies, roster).includeFormer).toBe(true);
    expect(membersScopeFromQuery(new URLSearchParams("former=0"), assemblies, roster).includeFormer).toBe(false);
    expect(membersScopeFromQuery(new URLSearchParams(""), assemblies, roster).includeFormer).toBe(false);
  });

  it("クエリが無ければすべて空", () => {
    expect(membersScopeFromQuery(new URLSearchParams(""), assemblies, roster)).toEqual({
      assemblyId: "",
      assemblyName: undefined,
      group: "",
      district: "",
      includeFormer: false,
    });
  });

  it("名簿が空（データ取得前）でも落ちず、会派・選挙区は無視される", () => {
    const scope = membersScopeFromQuery(new URLSearchParams("assembly=pref-36&group=自由民主党"), assemblies, []);
    expect(scope.assemblyId).toBe("pref-36");
    expect(scope.group).toBe("");
  });
});

describe("membersQueryString（#239: 絞り込みを URL に書く）", () => {
  const none = { assemblyId: "" as const, group: "", district: "", includeFormer: false };

  it("選んだものだけを assembly・group・district・former の順で並べる", () => {
    expect(membersQueryString({ ...none, assemblyId: "pref-36", group: "自民", district: "徳島市" })).toBe(
      "assembly=pref-36&group=%E8%87%AA%E6%B0%91&district=%E5%BE%B3%E5%B3%B6%E5%B8%82",
    );
    expect(membersQueryString({ ...none, assemblyId: "pref-36" })).toBe("assembly=pref-36");
    expect(membersQueryString(none)).toBe("");
  });

  it("元職を含めるときだけ former=1 を書く（既定の現職のみは書かない）", () => {
    expect(membersQueryString({ ...none, includeFormer: true })).toBe("former=1");
    expect(membersQueryString({ ...none, assemblyId: "pref-36", includeFormer: true })).toBe("assembly=pref-36&former=1");
  });

  it("membersScopeFromQuery と往復する", () => {
    const assemblies = [{ id: "pref-36", kind: "prefectural", name: "徳島県議会", prefCode: "36", sourceUrl: "https://x.example/" }] as unknown as Assembly[];
    const roster = [{ ...members[0], assemblyId: "pref-36" as const, group: "自由民主党", district: "徳島市", current: false as const }];
    const scope = { assemblyId: "pref-36" as const, assemblyName: "徳島県議会", group: "自由民主党", district: "徳島市", includeFormer: true };
    expect(membersScopeFromQuery(new URLSearchParams(membersQueryString(scope)), assemblies, roster)).toEqual(scope);
  });
});

describe("foldKanaGroups: 一覧の初期表示を先頭N名までにする（#340）", () => {
  const g = (row: string, n: number) => ({ row, members: Array.from({ length: n }, (_, i) => ({ id: `${row}${i}`, kana: row })) }) as never;

  it("合計が limit 以下ならそのまま（隠さない）", () => {
    const groups = [g("あ行", 50), g("か行", 40)];
    expect(foldKanaGroups(groups, 200)).toEqual({ groups, hidden: 0 });
  });

  it("limit を超えたら行の区切りで切り、残り人数を返す", () => {
    const groups = [g("あ行", 120), g("か行", 100), g("さ行", 80)];
    const r = foldKanaGroups(groups, 200);
    // か行を足すと 220 > 200 なので、あ行だけ。見出しだけの空グループは作らない
    expect(r.groups.map((x) => x.row)).toEqual(["あ行"]);
    expect(r.hidden).toBe(180);
  });

  it("ちょうど limit に達したらそこで止める", () => {
    const r = foldKanaGroups([g("あ行", 120), g("か行", 80), g("さ行", 50)], 200);
    expect(r.groups.map((x) => x.row)).toEqual(["あ行", "か行"]);
    expect(r.hidden).toBe(50);
  });

  it("1行目が limit より大きくても、その行は出す（何も出ないのを避ける）", () => {
    const r = foldKanaGroups([g("あ行", 500), g("か行", 10)], 200);
    expect(r.groups.map((x) => x.row)).toEqual(["あ行"]);
    expect(r.hidden).toBe(10);
  });

  it("行の中身は削らない（途中で切って見出しと数が食い違うのを防ぐ）", () => {
    const r = foldKanaGroups([g("あ行", 120), g("か行", 100)], 200);
    expect(r.groups[0].members).toHaveLength(120);
  });
});
