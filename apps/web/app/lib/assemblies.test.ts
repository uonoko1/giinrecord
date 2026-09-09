import { describe, expect, it } from "vitest";
import type { Assembly } from "@seiji-kiroku/shared";
import disclosure from "../data/vote-disclosure.json";
import rollCallIndex from "../test-fixtures/assemblies/data/assemblies/pref-31/rollcalls/index.json";
import assembliesFixture from "../test-fixtures/assemblies/index.json";
import localMember from "../test-fixtures/assemblies/member-local.json";
import tottoriMember from "../test-fixtures/assemblies/member-local-tottori.json";
import type { LocalRollCallSubject, LocalVoteEntry, MemberDetail } from "./data-contract";
import { DISCLOSURE_STATUSES, disclosureFor, findAssembly, isDietAssemblyId, isLocalMember, joinVoteSubjects, localAssemblies, localVoteTone, VOTE_DISCLOSURE, type VoteDisclosureRow, voteSubjectNote } from "./assemblies";

const assemblies = assembliesFixture as Assembly[];

describe("isDietAssemblyId / isLocalMember", () => {
  it("diet- で始まる id は国会、それ以外は地方", () => {
    expect(isDietAssemblyId("diet-sangiin")).toBe(true);
    expect(isDietAssemblyId("diet-shugiin")).toBe(true);
    expect(isDietAssemblyId("pref-04")).toBe(false);
    expect(isDietAssemblyId("city-33100")).toBe(false);
  });
  it("assemblyId が無い（古いデータ）議員は国会議員", () => {
    expect(isLocalMember({ house: "sangiin" })).toBe(false);
    expect(isLocalMember({ house: "sangiin", assemblyId: "diet-sangiin" })).toBe(false);
    expect(isLocalMember(localMember as MemberDetail)).toBe(true);
  });
});

describe("findAssembly / localAssemblies", () => {
  it("id で議会を引く。無ければ undefined", () => {
    expect(findAssembly(assemblies, "pref-04")?.name).toBe("宮城県議会");
    expect(findAssembly(assemblies, "pref-99")).toBeUndefined();
  });
  it("localAssemblies は national 以外だけ", () => {
    expect(localAssemblies(assemblies).map((a) => a.id)).toEqual(["pref-04"]);
    expect(localAssemblies(undefined)).toEqual([]);
  });
});

describe("vote-disclosure.json（#128 の調査表から機械的に起こした公開状況）", () => {
  const rows = VOTE_DISCLOSURE.rows;
  it("47 都道府県 + 20 政令市 = 67 行、調査日と出典を持つ", () => {
    expect(rows).toHaveLength(67);
    expect(rows.filter((r) => r.kind === "prefectural")).toHaveLength(47);
    expect(rows.filter((r) => r.kind === "municipal")).toHaveLength(20);
    expect(VOTE_DISCLOSURE.surveyedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(VOTE_DISCLOSURE.source).toBe("docs/research/local-assemblies.md");
    expect(disclosure.rows).toHaveLength(67);
  });
  it("集計は調査の要約と一致する（都道府県 16/17/14/0、政令市 6/14/0/0）", () => {
    const count = (kind: VoteDisclosureRow["kind"], status: VoteDisclosureRow["status"]) => rows.filter((r) => r.kind === kind && r.status === status).length;
    // #710 で愛知が 総数のみ → 会派別 に動いた（会派別 16→17、総数のみ 15→14）。
    expect(DISCLOSURE_STATUSES.map((s) => count("prefectural", s))).toEqual([16, 17, 14, 0]);
    expect(DISCLOSURE_STATUSES.map((s) => count("municipal", s))).toEqual([6, 14, 0, 0]);
  });
  it("#670 で「不明」は 0 件になった（表の行を数えた数と一致する）", () => {
    // #128 は 7 件、#671 の後も 7 件残っていた。#670 で 7 件すべて確定させた。
    // 「不明が 0」は「全部わかった」ではない（総数のみ 2 県も会議録の全会期は見ていない。docs/research/local-assemblies.md）。
    expect(rows.filter((r) => r.status === "不明")).toHaveLength(0);
  });
  it("#670 で調べた 7 県は「到達できず」を名乗らず、4 値のどれかに確定している", () => {
    for (const id of ["pref-01", "pref-17", "pref-19", "pref-20", "pref-23", "pref-25", "pref-41"]) {
      const row = disclosureFor(id);
      expect(row, id).toBeDefined();
      expect(row!.status, id).not.toBe("不明");
      expect(row!.format, id).not.toBe("—");
      expect(row!.note, id).not.toMatch(/到達できず|未確認/);
      expect(row!.note, id).toMatch(/（2026-09-09、#670）/);
    }
  });
  it("#670: 山梨・滋賀・佐賀は個人票（公開）、石川は会派別、北海道・長野・愛知は総数のみ", () => {
    expect(disclosureFor("pref-19")).toMatchObject({ label: "山梨", status: "公開" });
    expect(disclosureFor("pref-25")).toMatchObject({ label: "滋賀", status: "公開" });
    expect(disclosureFor("pref-41")).toMatchObject({ label: "佐賀", status: "公開" });
    expect(disclosureFor("pref-17")).toMatchObject({ label: "石川", status: "会派別" });
    expect(disclosureFor("pref-01")).toMatchObject({ label: "北海道", status: "総数のみ" });
    expect(disclosureFor("pref-20")).toMatchObject({ label: "長野", status: "総数のみ" });
    // 愛知は #710 で 会派別 に動いた（下の #710 の it を見よ）。
  });
  // #688: #670 は「総数のみ 3 県は会議録を 1 本も開いていない」と留保を残した。
  // 起立採決の会議録に起立者名が載っていればそれは個人別の記録なので、3 県とも本会議の会議録本文まで見た。
  it("#688: 北海道・長野は会議録本文まで開いた（起立採決の記述と、名前が無いことを note が示す）", () => {
    for (const id of ["pref-01", "pref-20"]) {
      const row = disclosureFor(id);
      expect(row, id).toBeDefined();
      expect(row!.status, id).toBe("総数のみ");
      // 「会議録を開いていない」ではなく「開いて何が無かったか」が書かれていること。
      expect(row!.note, id).toMatch(/会議録本文を確認（2026-09-09、#688）/);
      // 会議録の原文をそのまま引くこと。北海道は「賛 成 者 起 立」と字間が空き、長野は空かない——
      // 原文の字面が違うので、空白を潰した形で一致を見る。
      expect(row!.note!.replace(/\s+/g, ""), id).toMatch(/〔賛成者起立〕/);
      expect(row!.note, id).toMatch(/起立多数/);
      // 名前も人数も無い、と明記していること（「起立多数」だけでは個人は分からない）。
      expect(row!.note, id).toMatch(/氏名も人数も無い/);
    }
  });
  // #710: #688 は「県サイト側に会議録 PDF は無い」で止まったが、探した範囲を書いていなかった。
  // 今回 /site/gikai/ 配下を全ページ辿ったところ、会議録は依然として無い一方で、
  // 日程ページ（#670・#688 のどちらも開いていなかった）に「議案ごとの各会派の態度」PDF があった。
  it("#710: 愛知は 会派別（会派ごとの ○× を PDF 本文で確認した）", () => {
    const row = disclosureFor("pref-23");
    expect(row).toBeDefined();
    expect(row!.status).toBe("会派別");
    // 表題ではなく PDF の本文を開いたこと。
    expect(row!.note).toMatch(/PDF 本文を確認（2026-09-09、#710）/);
    // 会派名と凡例を原文で引くこと（「態度」という語だけでは賛否かどうか分からない）。
    expect(row!.note).toMatch(/各会派の態度/);
    expect(row!.note).toMatch(/○…賛成、×…反対/);
    // 無所属は人数の集計で、個人名は無い——だから 公開 ではない。ここを落とすと別人の記録になる。
    expect(row!.note).toMatch(/無所属/);
    expect(row!.note).toMatch(/人数/);
    expect(row!.note).not.toMatch(/議員ごと|個人票/);
    // 出典 URL も日程ページに移す（結果概要ページにこの PDF は無い）。
    expect(row!.sourceUrl).toBe("https://www.pref.aichi.jp/site/gikai/teirei-rinji-nittei.html");
  });
  it("#710: 愛知の会議録には今も到達していない（robots.txt。到達できなかったことを隠さない）", () => {
    const row = disclosureFor("pref-23");
    expect(row!.note).not.toMatch(/会議録本文を確認/);
    expect(row!.note).toMatch(/robots\.txt/);
    expect(row!.note).toMatch(/Disallow: \//);
  });
  it("#671 で PDF 本文を開いた 5 件は「表題から分類した」を名乗らない", () => {
    for (const id of ["pref-28", "pref-34", "pref-43", "city-22100", "city-40100"]) {
      const row = disclosureFor(id);
      expect(row, id).toBeDefined();
      expect(row!.note, id).not.toMatch(/表題から/);
      expect(row!.note, id).toMatch(/PDF 本文を確認（2026-09-09、#671）/);
    }
  });
  it("#671: 熊本県は議員別の個人票（公開）、広島県・静岡市・北九州市は会派別（いずれも総数のみではない）", () => {
    expect(disclosureFor("pref-43")).toMatchObject({ label: "熊本", status: "公開" });
    expect(disclosureFor("pref-34")).toMatchObject({ label: "広島", status: "会派別" });
    expect(disclosureFor("city-22100")).toMatchObject({ label: "静岡市", status: "会派別" });
    expect(disclosureFor("city-40100")).toMatchObject({ label: "北九州市", status: "会派別" });
    expect(disclosureFor("pref-28")).toMatchObject({ label: "兵庫", status: "会派別" });
  });
  it("全行が https の出典 URL と一意の assemblyId を持ち、status は4値", () => {
    expect(new Set(rows.map((r) => r.assemblyId)).size).toBe(67);
    for (const r of rows) {
      expect(r.sourceUrl).toMatch(/^https:\/\//);
      expect(DISCLOSURE_STATUSES).toContain(r.status);
      expect(r.assemblyId).toMatch(/^(pref-\d{2}|city-\d{5})$/);
      expect(r.label.length).toBeGreaterThan(0);
    }
  });
  it("宮城は 公開・PDF、岡山市は 公開（起立採決のみ）", () => {
    expect(disclosureFor("pref-04")).toMatchObject({ label: "宮城", status: "公開", format: "PDF（index は HTML）" });
    expect(disclosureFor("city-33100")).toMatchObject({ label: "岡山市", status: "公開", statusNote: "起立採決のみ" });
    expect(disclosureFor("diet-sangiin")).toBeUndefined();
  });
});

describe("localVoteTone: 判の色は mapped がある値だけ。それ以外は中立", () => {
  it("mapped 賛成→yes、反対→no、投票なし→none", () => {
    expect(localVoteTone({ raw: "○", legend: "賛成", mapped: "賛成" })).toBe("yes");
    expect(localVoteTone({ raw: "×", legend: "反対", mapped: "反対" })).toBe("no");
    expect(localVoteTone({ raw: "欠", legend: "欠席", mapped: "投票なし" })).toBe("none");
  });
  it("mapped が無ければ raw が ○ でも中立（推定しない）", () => {
    expect(localVoteTone({ raw: "○", legend: "賛成" })).toBe("raw");
    expect(localVoteTone({ raw: "棄", legend: "棄権" })).toBe("raw");
  });
});

describe("voteSubjectNote（#204）: 請願・陳情の ○ を採択への賛成と読ませないための注記", () => {
  it("「委員長報告に対する賛否」は「賛否の対象：委員長報告（<委員長報告の原文>）」", () => {
    expect(voteSubjectNote({ voteSubject: "委員長報告に対する賛否", committeeReport: "不採択" })).toBe("賛否の対象：委員長報告（不採択）");
    expect(voteSubjectNote({ voteSubject: "委員長報告に対する賛否", committeeReport: "研究留保" })).toBe("賛否の対象：委員長報告（研究留保）");
    expect(voteSubjectNote({ voteSubject: "委員長報告に対する賛否" })).toBe("賛否の対象：委員長報告");
  });
  it("「議案に対する賛否」（議案そのものへの賛否＝既定の読み方）は注記しない", () => {
    expect(voteSubjectNote({ voteSubject: "議案に対する賛否" })).toBeNull();
    expect(voteSubjectNote({})).toBeNull();
  });
  it("知らない原文は言い換えずそのまま出す（推定しない）。委員長報告だけの行も落とさない", () => {
    expect(voteSubjectNote({ voteSubject: "修正案に対する賛否" })).toBe("賛否の対象：修正案に対する賛否");
    expect(voteSubjectNote({ voteSubject: "修正案に対する賛否", committeeReport: "不採択" })).toBe("賛否の対象：修正案に対する賛否 ・ 委員長報告：不採択");
    expect(voteSubjectNote({ committeeReport: "不採択" })).toBe("委員長報告：不採択");
  });
});

describe("joinVoteSubjects（#204）: rollcalls/index.json の voteSubject / committeeReport を rollCallId で timeline に結合する", () => {
  // フィクスチャは結合後の形なので、いったん外して結合前（members/{id}.json）の形に戻す
  const tottori = (tottoriMember as unknown as MemberDetail).timeline.map((e) => {
    const { voteSubject: _v, committeeReport: _c, ...rest } = e as LocalVoteEntry;
    return rest as LocalVoteEntry;
  });

  it("一致した行にだけ原文を写す。一致しない行はそのまま", () => {
    const joined = joinVoteSubjects(tottori, rollCallIndex as LocalRollCallSubject[]);
    const byId = new Map(joined.map((e) => [(e as LocalVoteEntry).rollCallId, e as LocalVoteEntry]));
    expect(byId.get("pref-31-2026-06-20260629-陳情-8年-11")).toMatchObject({ voteSubject: "委員長報告に対する賛否", committeeReport: "不採択" });
    expect(byId.get("pref-31-2026-06-20260629-知事提案-第10号")).toMatchObject({ voteSubject: "議案に対する賛否" });
    expect("committeeReport" in byId.get("pref-31-2026-06-20260629-知事提案-第10号")!).toBe(false);
  });
  it("index が null／空なら timeline をそのまま返す（宮城など rollcalls/index.json の無い議会）", () => {
    expect(joinVoteSubjects(tottori, null)).toEqual(tottori);
    expect(joinVoteSubjects(tottori, [])).toEqual(tottori);
  });
  it("localVote 以外の行（国会議員の timeline）は触らない", () => {
    const vote = { kind: "vote", date: "2026-01-01", rollCallId: "pref-31-2026-06-20260629-陳情-8年-11", title: "t", value: "賛成", sourceUrl: "https://example.com" } as unknown as MemberDetail["timeline"][number];
    expect(joinVoteSubjects([vote], rollCallIndex as LocalRollCallSubject[])).toEqual([vote]);
  });
});
