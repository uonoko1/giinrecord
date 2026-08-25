import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Assembly } from "@seiji-kiroku/shared";
import type { AssemblySession } from "../lib/data-contract";
import type { Dataset, MemberSummary } from "../lib/dataset";
import assembliesFixture from "../test-fixtures/assemblies/index.json";
import localMembers from "../test-fixtures/assemblies/members-index.json";
import sessionsFixture from "../test-fixtures/assemblies/sessions.json";
import { dataset } from "../test-fixtures/dataset";
import { CoveragePage, meta as routeMeta } from "./coverage";
import type { ShugiinBillNameStats } from "../lib/coverage";

/** #251: 事実の記述だけを載せる。言い訳・評価にあたる語もここで塞ぐ（「残念」「限界」「不十分」など） */
const EVALUATIVE_WORDS = ["おすすめ", "ランキング", "一致率", "遅れ", "不十分", "優れ", "充実", "網羅", "残念", "限界", "やむを得", "しかたが", "仕方が", "できていません", "ご了承"];
const assemblies = assembliesFixture as Assembly[];
const sessions = new Map<string, AssemblySession[]>([["pref-04", sessionsFixture as AssemblySession[]]]);
const withLocal: Dataset = { ...dataset, assemblies, members: [...dataset.members, ...(localMembers as MemberSummary[])] };

function renderPage(data: Dataset = withLocal, s = sessions, shugiinBillNames: ShugiinBillNameStats | null = null) {
  return render(
    <MemoryRouter>
      <CoveragePage data={data} sessions={s} shugiinBillNames={shugiinBillNames} />
    </MemoryRouter>,
  );
}

describe("/coverage 収録範囲", () => {
  it("見出しと、合計（議会・議員・採決）をデータの件数で出す", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("収録範囲");
    const totals = screen.getByRole("region", { name: "合計" });
    /** ラベル（議会・議員・…）に対応する数値。同じ数でも取り違えない */
    const figure = (label: string) => within(totals).getByText(label).closest(".figure")!.querySelector(".figure__num")!.textContent;
    expect(figure("議会")).toBe("3"); // 国会2＋宮城
    expect(figure("議員")).toBe("6"); // 3＋3
    expect(figure("採決・表決")).toBe("10"); // 国会 5＋宮城 5
    expect(figure("議案")).toBe("3");
  });

  /** 院ごとに「個人別の投票」と「議案情報」の2行。見出し行を除く */
  function dietRows() {
    const table = screen.getByRole("table", { name: "国会の収録範囲" });
    return within(table).getAllByRole("row").slice(1);
  }

  it("国会: 参院は個人別の投票の回次・件数・議員数と議員一覧（公式）の出典を出す", () => {
    renderPage();
    const rows = dietRows();
    expect(rows).toHaveLength(4); // 2院 × (個人票 + 議案)
    const votes = rows[0]!;
    expect(within(votes).getByRole("link", { name: "参議院" })).toHaveAttribute("href", "/assemblies/diet-sangiin");
    expect(votes).toHaveTextContent("個人別の投票（本会議の記名・押しボタン投票）");
    expect(votes).toHaveTextContent("第220—221回");
    expect(votes).toHaveTextContent("5 件");
    expect(votes).toHaveTextContent("3 名");
    const src = within(votes).getByRole("link", { name: "議員一覧（公式）" });
    expect(src).toHaveAttribute("href", assemblies[0]!.sourceUrl);
    expect(src.getAttribute("rel")).toMatch(/noopener/);
  });

  it("衆議院は個人票「なし」を書きつつ、持っている議案情報の回次と件数を出す（データが無いとは書かない、#218 レビュー2）", () => {
    renderPage();
    const rows = dietRows();
    const votes = rows[2]!;
    expect(within(votes).getByRole("link", { name: "衆議院" })).toBeInTheDocument();
    expect(votes).toHaveTextContent("個人別の投票：なし（一次資料に個人票が無い）");
    // 個人票の行に参院の件数を流用しない
    expect(votes).not.toHaveTextContent("5 件");
    const bills = rows[3]!;
    expect(bills).toHaveTextContent("議案情報（提出者・賛成者・各院の結果）");
    expect(bills).toHaveTextContent("第219—221回");
    expect(bills).toHaveTextContent("3 件");
    const diet = screen.getByRole("region", { name: "国会" });
    expect(diet).toHaveTextContent("衆議院は本会議の個人別の投票記録を公表していません");
    expect(diet).toHaveTextContent("推定");
  });

  it("回次が歯抜けなら実回次数を添える（連続収録と読ませない、#218 レビュー3）", () => {
    renderPage();
    // 衆院の議案は 219 と 221 のみ（220 は無い）＝ 範囲 3 に対し実回次 2
    expect(dietRows()[3]!).toHaveTextContent("うち議案のある回次 2");
    // 参院の採決は 220—221 が連続なので添えない
    expect(dietRows()[0]!).not.toHaveTextContent("うち");
  });

  it("取得の対象にした回次は回次数つきで出し、実収録の表と役割を区別する", () => {
    renderPage();
    const diet = screen.getByRole("region", { name: "国会" });
    expect(diet).toHaveTextContent("取得の対象にした回次: 第220—221回（2 回次）");
    expect(diet).toHaveTextContent("実際に記録のある回次と件数");
  });

  it("地方議会: 名称・会期範囲・表決数・議員数と、会期ごとの取得元（一次資料）を出す", () => {
    renderPage();
    const miyagi = screen.getByRole("region", { name: "宮城県議会" });
    expect(within(miyagi).getByRole("link", { name: "宮城県議会" })).toHaveAttribute("href", "/assemblies/pref-04");
    expect(miyagi).toHaveTextContent("都道府県議会");
    expect(miyagi).toHaveTextContent("第398回（令和7年11月定例会） 〜 第399回（令和8年2月定例会）");
    expect(miyagi).toHaveTextContent("5 件（2 会期）");
    expect(miyagi).toHaveTextContent("3 名");
    expect(within(miyagi).getByRole("link", { name: "議員名簿（公式）" })).toHaveAttribute("href", assemblies[2]!.sourceUrl);
    const table = within(miyagi).getByRole("table", { name: "宮城県議会の取得元" });
    const links = within(table).getAllByRole("link", { name: "表決結果（公式）" });
    expect(links.map((a) => a.getAttribute("href"))).toEqual((sessionsFixture as AssemblySession[]).map((s) => s.sourceUrl));
    for (const a of links) expect(a.getAttribute("rel")).toMatch(/noopener/);
  });

  it("「記録にないこと」は About の該当節へリンクする（重複して列挙しない）", () => {
    renderPage();
    const section = screen.getByRole("region", { name: "記録にないこと" });
    expect(within(section).getByRole("link", { name: /記録にないこと/ })).toHaveAttribute("href", "/about#none-heading");
  });

  it("評価語を含まない", () => {
    const { container } = renderPage();
    for (const word of EVALUATIVE_WORDS) expect(container.textContent).not.toContain(word);
  });

  // #219 / #230: 名簿の無い回次があることと、氏名が一致しても紐づけない理由を事実として出す
  it("名簿より前の回次があれば、紐づかない事実とその理由を出す（回次はデータから）", () => {
    const meta = {
      ...dataset.meta!,
      sessions: [142, 150, 200, 216, 221],
      sources: [...dataset.meta!.sources, { name: "参議院 議員一覧（第216回）", url: "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/216/giin.htm", fetchedAt: "2026-08-22T06:00:00+09:00" }],
    };
    renderPage({ ...withLocal, meta });
    const section = screen.getByRole("region", { name: "議員ページに紐づかない回次" });
    expect(section).toHaveTextContent("第216回");
    expect(section).toHaveTextContent("第142—200回");
    expect(section).toHaveTextContent("議員ページには紐づいていません");
    // #230: 氏名が一致しても在職を確認できなければ紐づけない、を理由つきで書く
    expect(section).toHaveTextContent("在職を確認できない氏名一致では紐づけません");
    expect(section.textContent).toContain("在職開始日にあたる項目が無く");
    // 記録が失われないことも書く（一次資料へのリンクは残る）
    expect(section.textContent).toContain("採決ページへのリンクはそのまま残ります");
    // 「推定を含む紐づけがある」とはもう書かない（#230 で解消した）
    expect(section.textContent).not.toContain("推定を含みます");
  });

  it("名簿の無い回次が無ければ、その節は出さない（無い事実を作らない）", () => {
    const meta = {
      ...dataset.meta!,
      sessions: [220, 221],
      sources: [...dataset.meta!.sources, { name: "参議院 議員一覧（第220回）", url: "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/220/giin.htm", fetchedAt: "2026-08-22T06:00:00+09:00" }],
    };
    renderPage({ ...withLocal, meta });
    expect(screen.queryByRole("region", { name: "議員ページに紐づかない回次" })).toBeNull();
  });

  // #251 / #235: 衆院の記録が議員ページに紐づく範囲。名簿が「現在」の 1 時点しかないという 1 つの事実にまとめる
  /*
   * Issue #242: 委員会の発言を収録する。/coverage には「どの会議まで取っているか」を書く。
   * 回次（どこまで遡るか）はここでは書かない。名簿の範囲の話で、下の 2 節が既に書いているため。
   */
  describe("発言をどの会議まで収録しているか（#242）", () => {
    const speechSrc = (house: "参議院" | "衆議院", scope: "all" | "plenary") => ({
      name: `国会会議録検索システム 検索用API（${house} ${scope === "all" ? "本会議・委員会" : "本会議"}）`,
      url: `https://kokkai.ndl.go.jp/api/speech?nameOfHouse=${encodeURIComponent(house)}${scope === "plenary" ? "&nameOfMeeting=%E6%9C%AC%E4%BC%9A%E8%AD%B0" : ""}&sessionFrom=221&sessionTo=221`,
      fetchedAt: "2026-08-25T00:00:00.000Z",
    });
    const withSpeeches = (scope: "all" | "plenary"): Dataset => ({
      ...withLocal,
      meta: { ...withLocal.meta!, sources: [...withLocal.meta!.sources, speechSrc("参議院", scope), speechSrc("衆議院", scope)] },
    });
    const section = () => screen.getByRole("region", { name: "発言をどの会議まで収録しているか" });

    it("委員会も取っていることと、会議名が原文で見分けられることを書く", () => {
      renderPage(withSpeeches("all"), sessions);
      expect(section()).toHaveTextContent("参議院・衆議院は本会議だけでなく委員会も収録しています");
      expect(section()).toHaveTextContent("分科会・審査会・連合審査会・公聴会・調査会");
      expect(section()).toHaveTextContent("会議名は会議録の原文のまま各行に出す");
    });

    it("議員でない発言者（政府参考人・参考人・公述人）を議員に紐づけないことを書く", () => {
      renderPage(withSpeeches("all"), sessions);
      expect(section()).toHaveTextContent("政府参考人・参考人・公述人");
      expect(section()).toHaveTextContent("会派の記載がない発言者は議員に紐づけません");
    });

    it("議員ページに出ている発言の件数は members の counts の合計から出す（推論しない）", () => {
      renderPage(withSpeeches("all"), sessions);
      // 参院フィクスチャの counts.speeches は 1 + 0 + 2 = 3
      expect(section()).toHaveTextContent("参議院が 3 件");
    });

    it("本会議だけを取っている出力（#242 以前）はそのとおりに書く", () => {
      renderPage(withSpeeches("plenary"), sessions);
      expect(section()).toHaveTextContent("参議院・衆議院は本会議だけを収録しています");
      expect(section().textContent).not.toContain("委員会も収録しています");
    });

    it("会議録 API の出典が無ければ節そのものを出さない（無い事実を作らない）", () => {
      renderPage(withLocal, sessions);
      expect(screen.queryByRole("region", { name: "発言をどの会議まで収録しているか" })).toBeNull();
    });
  });

  describe("衆議院の記録が議員ページに紐づく範囲", () => {
    const shugiinRosterSource = { name: "衆議院 議員一覧（2026-02-18現在）", url: "https://www.shugiin.go.jp/internet/itdb_annai.nsf/html/statics/syu/1giin.htm", fetchedAt: "2026-08-22T06:00:00+09:00" };
    const sangiinRosterSources = [216, 221].map((s) => ({ name: `参議院 議員一覧（第${s}回）`, url: `https://www.sangiin.go.jp/japanese/joho1/kousei/giin/${s}/giin.htm`, fetchedAt: "2026-08-22T06:00:00+09:00" }));
    const questionSources = [219, 220].map((s) => ({ name: `衆議院 質問答弁情報（第${s}回）`, url: `https://www.shugiin.go.jp/internet/itdb_shitsumon.nsf/html/shitsumon/kaiji${s}_l.htm`, fetchedAt: "2026-08-22T06:00:00+09:00" }));
    const meta = { ...dataset.meta!, sources: [...dataset.meta!.sources, shugiinRosterSource, ...sangiinRosterSources, ...questionSources] };
    /** 数値はすべてここから来る（画面にもコンポーネントにも定数を書かない）。実データとは別の値にして取り違えを検出する */
    const billNames: ShugiinBillNameStats = {
      names: 400,
      linked: 30,
      sessions: [
        { session: 219, names: 40, inRoster: 5 },
        { session: 221, names: 90, inRoster: 88 },
        { session: 220, names: 90, inRoster: 60 },
      ],
      rosterMembers: 465,
      rosterDuplicateNames: 0,
    };
    /** 議員ページに実際に出ている件数の材料（members/index.json の counts） */
    const shugiinMembers: MemberSummary[] = [
      { id: "h_1", name: "衆院 一郎", kana: "しゅういん いちろう", house: "shugiin", group: "自民", district: "東京1", counts: { rollcalls: 0, bills: 30, speeches: 0, questions: 0 } },
    ];
    const withShugiin = (extra: Partial<MemberSummary>[] = []) => ({
      ...withLocal,
      meta,
      members: [...withLocal.members, ...shugiinMembers.map((m, i) => ({ ...m, ...extra[i] }))],
    });
    const section = () => screen.getByRole("region", { name: "衆議院の記録が議員ページに紐づく範囲" });

    it("名簿が「現在」の 1 時点しかないことと、その時点を出典（meta）から出す", () => {
      renderPage(withShugiin(), sessions, billNames);
      expect(section()).toHaveTextContent("「現在」の 1 時点だけで、回次ごとの名簿はありません");
      expect(section()).toHaveTextContent("2026.02.18");
      expect(within(section()).getByRole("link", { name: "議員一覧" })).toHaveAttribute("href", shugiinRosterSource.url);
    });

    // #259 レビュー: 参院を「この制約が無い」と書くと、すぐ上の RosterlessSection（第216回より前は名簿が無い）と矛盾する
    it("参院は「制約が無い」ではなく、名簿のある範囲をデータから出し、上の節と整合させる", () => {
      renderPage(withShugiin(), sessions, billNames);
      expect(section()).toHaveTextContent("第216—221回");
      expect(section()).toHaveTextContent("それより前の回次に名簿が無いことは参議院も同じ");
      // 「参議院にはこの制約はありません」と読める書き方をしない
      expect(section().textContent).not.toContain("この制約はありません");
    });

    it("氏名が一致しても本人と確認できないことと、氏名だけで紐づけない理由を書く", () => {
      renderPage(withShugiin(), sessions, billNames);
      expect(section()).toHaveTextContent("氏名がこの名簿と一致しても、その人本人であることを一次資料から確認できません");
      expect(section()).toHaveTextContent("同姓同名の別人を 1 人にしないため");
    });

    it("氏名がいちばん多い回次の実数（議案の氏名 / 現在の名簿にある数）をデータから出す", () => {
      renderPage(withShugiin(), sessions, billNames);
      expect(section()).toHaveTextContent("第221回");
      expect(section()).toHaveTextContent("90 人のうち、現在の名簿にあるのは 88 人");
      expect(section().textContent).not.toContain("%");
    });

    it("紐づいていない氏名の延べ件数を出す（延べ数・紐づき数・残り）", () => {
      renderPage(withShugiin(), sessions, billNames);
      expect(section()).toHaveTextContent("延べ 400 件");
      expect(section()).toHaveTextContent("紐づいているのは 30 件");
      expect(section()).toHaveTextContent("残る 370 件");
      expect(section()).toHaveTextContent("現在の名簿 465 人のなかに同じ氏名の人はいません");
    });

    // #259 レビュー: 「第N回のぶんだけ出る」という代理値の主張をやめ、実際に出ている件数（counts の合計）を書く
    it("議員ページに実際に出ている件数を members の counts から出す（0 件なら 0 件と書く）", () => {
      renderPage(withShugiin(), sessions, billNames);
      expect(section()).toHaveTextContent("提出・賛成した議案が 30 件");
      expect(section()).toHaveTextContent("質問主意書が 0 件");
      expect(section()).toHaveTextContent("発言が 0 件");
      // 0 件なのに「第N回のぶんだけは出る」とは書かない
      expect(section()).toHaveTextContent("そのうち提出者を名簿に照合できたものはありません");
      expect(section().textContent).not.toMatch(/照合できるのは\s*第\d+回のぶんだけ/);
    });

    it("質問主意書が実際に紐づいていれば「照合できたものはありません」とは書かない", () => {
      renderPage(withShugiin([{ counts: { rollcalls: 0, bills: 30, speeches: 12, questions: 4 } }]), sessions, billNames);
      expect(section()).toHaveTextContent("質問主意書が 4 件");
      expect(section()).toHaveTextContent("発言が 12 件");
      expect(section().textContent).not.toContain("照合できたものはありません");
    });

    it("質問主意書（#235）は別の節にせず、同じ節に統合して書く", () => {
      renderPage(withShugiin(), sessions, billNames);
      expect(screen.queryByRole("region", { name: "衆議院の質問主意書が議員ページに紐づく回次" })).toBeNull();
      expect(section()).toHaveTextContent("第219—220回");
    });

    it("名簿の出典も議案の氏名も無ければ、その節は出さない（無い事実を作らない）", () => {
      renderPage(withLocal, sessions, null);
      expect(screen.queryByRole("region", { name: "衆議院の記録が議員ページに紐づく範囲" })).toBeNull();
    });

    it("議案の氏名が 0 件なら件数の段落は出さない", () => {
      renderPage(withShugiin(), sessions, { names: 0, linked: 0, sessions: [], rosterMembers: 465, rosterDuplicateNames: 0 });
      expect(section().textContent).not.toContain("延べ");
    });
  });

  it("地方議会のデータが無くても落ちない（国会だけ）", () => {
    renderPage({ ...dataset, assemblies: undefined }, new Map());
    expect(screen.getByRole("region", { name: "地方議会" })).toHaveTextContent("地方議会のデータはまだありません。");
  });

  it("データが空でも落ちない", () => {
    renderPage({ meta: undefined, members: [], rollcalls: [] }, new Map());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("収録範囲");
  });

  it("フッタから /coverage への導線がある", () => {
    renderPage();
    const footer = within(screen.getByRole("contentinfo"));
    expect(footer.getByRole("link", { name: "収録範囲" })).toHaveAttribute("href", "/coverage");
  });

  it("meta: タイトル・説明・canonical", () => {
    const tags = routeMeta({ location: { pathname: "/coverage" } } as Parameters<typeof routeMeta>[0]);
    expect(tags).toContainEqual({ title: "収録範囲 ・ 議員レコード" });
    expect(tags).toContainEqual({ name: "description", content: expect.any(String) });
    expect(tags).toContainEqual({ tagName: "link", rel: "canonical", href: "/coverage" });
  });
});
