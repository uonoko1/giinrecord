import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Assembly, MemberAssemblyCount } from "@seiji-kiroku/shared";
import type { AssemblySession } from "../lib/data-contract";
import type { Dataset } from "../lib/dataset";
import assembliesFixture from "../test-fixtures/assemblies/index.json";
import sessionsFixture from "../test-fixtures/assemblies/sessions.json";
import { billsBySession, dataset } from "../test-fixtures/dataset";
import { CoveragePage, meta as routeMeta } from "./coverage";
import type { LinkedRecordCounts, SangiinVoteLinkStats, ShugiinBillNameStats } from "../lib/coverage";
import { source } from "../test-fixtures/source";

/** #251: 事実の記述だけを載せる。言い訳・評価にあたる語もここで塞ぐ（「残念」「限界」「不十分」など） */
const EVALUATIVE_WORDS = ["おすすめ", "ランキング", "一致率", "遅れ", "不十分", "優れ", "充実", "網羅", "残念", "限界", "やむを得", "しかたが", "仕方が", "できていません", "ご了承"];
const assemblies = assembliesFixture as Assembly[];
const sessions = new Map<string, AssemblySession[]>([["pref-04", sessionsFixture as AssemblySession[]]]);
const withLocal: Dataset = { ...dataset, assemblies };
/*
 * #441: 議員数は名簿の全件ではなく **議会ごとの人数**（members/by-assembly.json）から来る。
 * この画面が読むのは **total**（元職を含む）。`current` はわざと違う数にしてある
 * （同じ数だと、どちらの列を読んでいるか見分けられない）
 */
const byAssembly: MemberAssemblyCount[] = [
  { assemblyId: "diet-sangiin", current: 2, total: 3 },
  { assemblyId: "pref-04", current: 2, total: 3 },
];
/** #441: 院ごとの「議員ページに出ている件数」は loader（Node 側）から来る。参院の fixture は counts.speeches が 1+0+2=3 */
const linkedFixture = { sangiin: { rollcalls: 15, bills: 1, speeches: 3, questions: 0 }, shugiin: null };

function renderPage(
  data: Dataset = withLocal,
  s = sessions,
  shugiinBillNames: ShugiinBillNameStats | null = null,
  sangiinVotes: SangiinVoteLinkStats | null = null,
  linked: { sangiin: LinkedRecordCounts | null; shugiin: LinkedRecordCounts | null } = linkedFixture,
  members: readonly MemberAssemblyCount[] = byAssembly,
) {
  return render(
    <MemoryRouter>
      {/* Issue 408/411: 議案の集計は Dataset に入っていないので明示的に渡す。
          Issue 441: 議員の集計（人数）と loader 由来の件数も同じ理由で明示的に渡す。
          渡さないと本物の bundled データが使われ、fixture の件数と食い違う */}
      <CoveragePage data={data} sessions={s} billsBySession={billsBySession} membersByAssembly={members} shugiinBillNames={shugiinBillNames} sangiinVotes={sangiinVotes} linked={linked} />
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
      sources: [...dataset.meta!.sources, source({ name: "参議院 議員一覧（第216回）", url: "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/216/giin.htm", fetchedAt: "2026-08-22T06:00:00+09:00" })],
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
      sources: [...dataset.meta!.sources, source({ name: "参議院 議員一覧（第220回）", url: "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/220/giin.htm", fetchedAt: "2026-08-22T06:00:00+09:00" })],
    };
    renderPage({ ...withLocal, meta });
    expect(screen.queryByRole("region", { name: "議員ページに紐づかない回次" })).toBeNull();
  });

  /*
   * #274: 第215回以前の記録が議員ページに出ない理由と件数を書く。
   * 調査（docs/research/sangiin-tenure.md）で、参院サイトには在職開始日にあたる一次資料が無いことが分かった。
   * 書くのは事実だけ:「参院サイトに在職開始日は無い」「他の一次資料は未調査」「記録は残る」「件数はデータから数える」
   */
  describe("在職を確認できない理由と件数（#274）", () => {
    const rosterlessMeta = {
      ...dataset.meta!,
      sessions: [200, 201, 204, 216, 221],
      sources: [...dataset.meta!.sources, source({ name: "参議院 議員一覧（第216回）", url: "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/216/giin.htm", fetchedAt: "2026-08-22T06:00:00+09:00" })],
    };
    /** 数値はすべてここから来る（画面にもコンポーネントにも定数を書かない） */
    const votes: SangiinVoteLinkStats = {
      votes: 1000,
      linked: 700,
      sessions: [
        { session: 200, votes: 300, linked: 100 },
        { session: 201, votes: 200, linked: 200 },
        { session: 204, votes: 100, linked: 0 },
        { session: 221, votes: 400, linked: 400 },
      ],
    };
    const render274 = (v: SangiinVoteLinkStats | null = votes) => renderPage({ ...withLocal, meta: rosterlessMeta }, sessions, null, v);
    const section = () => screen.getByRole("region", { name: "議員ページに紐づかない回次" });

    it("在職開始日が名簿だけでなく参議院の議員個人ページにも無いことを書く", () => {
      render274();
      expect(section()).toHaveTextContent("参議院の議員個人ページ");
      expect(section()).toHaveTextContent("当選年");
      expect(section().textContent).toContain("月日がありません");
    });

    it("参院サイト以外の一次資料は調べていないことを、その範囲を限って書く", () => {
      render274();
      expect(section()).toHaveTextContent("参議院のサイト以外の一次資料は調べていません");
      // 「どこにも無い」「回復できない」と言い切らない
      expect(section().textContent).not.toContain("どこにもありません");
      expect(section().textContent).not.toContain("回復できません");
    });

    it("紐づかない票の件数と、その回次をデータから数えて出す（定数を埋め込まない）", () => {
      render274();
      // 名簿より前の 3 回次の票 600 のうち、紐づいているのは 300、紐づいていないのは 300
      expect(section()).toHaveTextContent("延べ 600 件");
      expect(section()).toHaveTextContent("紐づいているのは 300 件");
      expect(section()).toHaveTextContent("残る 300 件");
      expect(section().textContent).not.toContain("%");
    });

    // 数字を書くなら測り方を添える（docs/WORKING_AGREEMENT.md）
    it("件数には測り方を添える（どのデータを何で数えたか）", () => {
      render274();
      expect(section()).toHaveTextContent("いま配信しているデータの採決 1 件ずつを数えた結果");
      expect(section()).toHaveTextContent("票に議員の id が入っているかを数えています");
    });

    it("名簿より前でも紐づく票があることを、突合の規則として書く（一律に出ないとは書かない）", () => {
      render274();
      expect(section()).toHaveTextContent("第200—204回");
      expect(section()).toHaveTextContent("任期満了日が採決の日以後である");
      expect(section()).toHaveTextContent("名簿より前の回次の票が一律に出ないわけではありません");
    });

    /*
     * data/ の作り直し（docs/ops/etl.md）が済むと、この回次の票は 0 件まで減りうる。
     * 数えた結果をそのまま書くので、0 件になれば 0 件と出る（代理値や固定値に置き換えない）。
     */
    it("紐づいた票が 0 件でも、数えた結果をそのまま 0 件と書く", () => {
      render274({ votes: 600, linked: 0, sessions: [{ session: 200, votes: 600, linked: 0 }] });
      expect(section()).toHaveTextContent("紐づいているのは 0 件");
      expect(section()).toHaveTextContent("残る 600 件");
    });

    it("記録そのものは残ることを、票以外の記録も含めて書く", () => {
      render274();
      expect(section().textContent).toContain("採決ページへのリンクはそのまま残ります");
      expect(section()).toHaveTextContent("発言・議案・質問主意書");
    });

    it("数えた結果が無ければ件数の段落は出さない（節そのものと理由は残す）", () => {
      render274(null);
      expect(section()).toHaveTextContent("議員ページには紐づいていません");
      expect(section().textContent).not.toContain("延べ");
    });

    it("紐づいていない票が 1 件も無ければ件数の段落は出さない（無い事実を作らない）", () => {
      render274({ votes: 600, linked: 600, sessions: [{ session: 200, votes: 600, linked: 600 }] });
      expect(section().textContent).not.toContain("残る");
    });

    it("評価語を含まない", () => {
      const { container } = render274();
      for (const word of EVALUATIVE_WORDS) expect(container.textContent).not.toContain(word);
    });
  });

  // #251 / #235: 衆院の記録が議員ページに紐づく範囲。名簿が「現在」の 1 時点しかないという 1 つの事実にまとめる
  /*
   * Issue #242: 委員会の発言を収録する。/coverage には「どの会議まで取っているか」を書く。
   * 回次（どこまで遡るか）はここでは書かない。名簿の範囲の話で、下の 2 節が既に書いているため。
   */
  describe("発言をどの会議まで収録しているか（#242）", () => {
    const speechSrc = (house: "参議院" | "衆議院", scope: "all" | "plenary") =>
      source({
        name: `国会会議録検索システム 検索用API（${house} ${scope === "all" ? "本会議・委員会" : "本会議"}）`,
        url: `https://kokkai.ndl.go.jp/api/speech?nameOfHouse=${encodeURIComponent(house)}${scope === "plenary" ? "&nameOfMeeting=%E6%9C%AC%E4%BC%9A%E8%AD%B0" : ""}&sessionFrom=221&sessionTo=221`,
        fetchedAt: "2026-08-25T00:00:00.000Z",
        house: house === "参議院" ? "sangiin" : "shugiin",
        kind: "speech",
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

    /*
     * Issue #313: 会議録の院は**会議の院**であって発言者の院ではない。参議院の会議には衆院議員が
     * 大臣・副大臣として答弁に立ち、連合審査会にも出る（逆も同じ）。読者が「参議院の会議録＝参院議員の発言」と
     * 読んでしまわないよう、他院の議員の発言も紐づけること、ただし**その議員の院の名簿がその回次を覆う場合だけ**
     * であることを書く。「活動がない」「発言していない」とは書かない（収録と突合の範囲だけを書く）。
     */
    it("他院の議員の発言も、その議員の院の名簿が覆う回次なら紐づけることを書く（#313）", () => {
      renderPage(withSpeeches("all"), sessions);
      expect(section()).toHaveTextContent("他院の議員");
      expect(section()).toHaveTextContent("発言した議員の院の名簿がその回次を覆っている場合にかぎり議員ページに紐づけます");
      expect(section()).toHaveTextContent("覆っていない回次の発言は、会議録には残りますが議員ページには出ません");
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
    const shugiinRosterSource = source({ name: "衆議院 議員一覧（2026-02-18現在）", url: "https://www.shugiin.go.jp/internet/itdb_annai.nsf/html/statics/syu/1giin.htm", fetchedAt: "2026-08-22T06:00:00+09:00" });
    const sangiinRosterSources = [216, 221].map((s) => source({ name: `参議院 議員一覧（第${s}回）`, url: `https://www.sangiin.go.jp/japanese/joho1/kousei/giin/${s}/giin.htm`, fetchedAt: "2026-08-22T06:00:00+09:00" }));
    const questionSources = [219, 220].map((s) => source({ name: `衆議院 質問答弁情報（第${s}回）`, url: `https://www.shugiin.go.jp/internet/itdb_shitsumon.nsf/html/shitsumon/kaiji${s}_l.htm`, kind: "question", fetchedAt: "2026-08-22T06:00:00+09:00" }));
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
    /**
     * 議員ページに実際に出ている件数（#251）。#441 でこれは loader（Node 側で members/index.json の
     * counts を合計する `readLinkedRecordCounts`）から来るようになったので、テストもその形で渡す。
     */
    const shugiinLinked: LinkedRecordCounts = { rollcalls: 0, bills: 30, speeches: 0, questions: 0 };
    const withShugiin = () => ({ ...withLocal, meta });
    const linkedWith = (extra: Partial<LinkedRecordCounts> = {}) => ({ sangiin: linkedFixture.sangiin, shugiin: { ...shugiinLinked, ...extra } });
    const section = () => screen.getByRole("region", { name: "衆議院の記録が議員ページに紐づく範囲" });

    // #316: 衆院サイト以外の一次資料（国会会議録・総選挙の結果・官報）も調べたうえで無い、と書く。
    // #274 が参院について「参議院のサイト以外の一次資料は調べていません」と主張の範囲を限定したのと対になる。
    it("衆院サイト以外の一次資料も調べたうえで無い、と書く（#316）", () => {
      renderPage(withShugiin(), sessions, billNames, null, linkedWith());
      const t = section().textContent ?? "";
      expect(t).toContain("衆議院のサイト以外");
      // 調べた先を名指しする（「探したが無かった」だけでは、何を探したか分からない）
      expect(t).toContain("国会会議録");
      expect(t).toContain("総選挙の結果");
      expect(t).toContain("官報");
      // 総選挙の結果が使えたとしても在職の確認にはならない、という限界まで書く
      expect(t).toMatch(/辞職|補欠選挙/);
      // 調査の記録への導線
      expect(within(section()).getByRole("link", { name: /shugiin-tenure-sessions/ })).toHaveAttribute(
        "href",
        "https://github.com/uonoko1/giinrecord/blob/main/docs/research/shugiin-tenure-sessions.md",
      );
    });

    it("名簿が「現在」の 1 時点しかないことと、その時点を出典（meta）から出す", () => {
      renderPage(withShugiin(), sessions, billNames, null, linkedWith());
      expect(section()).toHaveTextContent("「現在」の 1 時点だけで、回次ごとの名簿はありません");
      expect(section()).toHaveTextContent("2026.02.18");
      expect(within(section()).getByRole("link", { name: "議員一覧" })).toHaveAttribute("href", shugiinRosterSource.url);
    });

    // #259 レビュー: 参院を「この制約が無い」と書くと、すぐ上の RosterlessSection（第216回より前は名簿が無い）と矛盾する
    it("参院は「制約が無い」ではなく、名簿のある範囲をデータから出し、上の節と整合させる", () => {
      renderPage(withShugiin(), sessions, billNames, null, linkedWith());
      expect(section()).toHaveTextContent("第216—221回");
      expect(section()).toHaveTextContent("それより前の回次に名簿が無いことは参議院も同じ");
      // 「参議院にはこの制約はありません」と読める書き方をしない
      expect(section().textContent).not.toContain("この制約はありません");
    });

    it("氏名が一致しても本人と確認できないことと、氏名だけで紐づけない理由を書く", () => {
      renderPage(withShugiin(), sessions, billNames, null, linkedWith());
      expect(section()).toHaveTextContent("氏名がこの名簿と一致しても、その人本人であることを一次資料から確認できません");
      expect(section()).toHaveTextContent("同姓同名の別人を 1 人にしないため");
    });

    it("氏名がいちばん多い回次の実数（議案の氏名 / 現在の名簿にある数）をデータから出す", () => {
      renderPage(withShugiin(), sessions, billNames, null, linkedWith());
      expect(section()).toHaveTextContent("第221回");
      expect(section()).toHaveTextContent("90 人のうち、現在の名簿にあるのは 88 人");
      expect(section().textContent).not.toContain("%");
    });

    it("紐づいていない氏名の延べ件数を出す（延べ数・紐づき数・残り）", () => {
      renderPage(withShugiin(), sessions, billNames, null, linkedWith());
      expect(section()).toHaveTextContent("延べ 400 件");
      expect(section()).toHaveTextContent("紐づいているのは 30 件");
      expect(section()).toHaveTextContent("残る 370 件");
      expect(section()).toHaveTextContent("現在の名簿 465 人のなかに同じ氏名の人はいません");
    });

    // #259 レビュー: 「第N回のぶんだけ出る」という代理値の主張をやめ、実際に出ている件数（counts の合計）を書く
    it("議員ページに実際に出ている件数を members の counts から出す（0 件なら 0 件と書く）", () => {
      renderPage(withShugiin(), sessions, billNames, null, linkedWith());
      expect(section()).toHaveTextContent("提出・賛成した議案が 30 件");
      expect(section()).toHaveTextContent("質問主意書が 0 件");
      expect(section()).toHaveTextContent("発言が 0 件");
      // 0 件なのに「第N回のぶんだけは出る」とは書かない
      expect(section()).toHaveTextContent("そのうち提出者を名簿に照合できたものはありません");
      expect(section().textContent).not.toMatch(/照合できるのは\s*第\d+回のぶんだけ/);
    });

    it("質問主意書が実際に紐づいていれば「照合できたものはありません」とは書かない", () => {
      renderPage(withShugiin(), sessions, billNames, null, linkedWith({ speeches: 12, questions: 4 }));
      expect(section()).toHaveTextContent("質問主意書が 4 件");
      expect(section()).toHaveTextContent("発言が 12 件");
      expect(section().textContent).not.toContain("照合できたものはありません");
    });

    it("質問主意書（#235）は別の節にせず、同じ節に統合して書く", () => {
      renderPage(withShugiin(), sessions, billNames, null, linkedWith());
      expect(screen.queryByRole("region", { name: "衆議院の質問主意書が議員ページに紐づく回次" })).toBeNull();
      expect(section()).toHaveTextContent("第219—220回");
    });

    it("名簿の出典も議案の氏名も無ければ、その節は出さない（無い事実を作らない）", () => {
      renderPage(withLocal, sessions, null);
      expect(screen.queryByRole("region", { name: "衆議院の記録が議員ページに紐づく範囲" })).toBeNull();
    });

    it("議案の氏名が 0 件なら件数の段落は出さない", () => {
      renderPage(withShugiin(), sessions, { names: 0, linked: 0, sessions: [], rosterMembers: 465, rosterDuplicateNames: 0 }, null, linkedWith());
      expect(section().textContent).not.toContain("延べ");
    });
  });

  it("地方議会のデータが無くても落ちない（国会だけ）", () => {
    renderPage({ ...dataset, assemblies: undefined }, new Map());
    expect(screen.getByRole("region", { name: "地方議会" })).toHaveTextContent("地方議会のデータはまだありません。");
  });

  it("データが空でも落ちない", () => {
    renderPage({ meta: undefined, rollcalls: [] }, new Map(), null, null, { sangiin: null, shugiin: null }, []);
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

/**
 * Issue 370: 議案は「X 人のうち名簿にあるのは Y 人」と数を出しているのに、
 * 発言は「議員ページには出ません」と書くだけで件数が無かった。
 */
describe("紐づけられなかった発言の件数（#370）", () => {
  const stats = { speeches: 301, speakers: 55, sessions: [{ session: 217, speeches: 251 }, { session: 219, speeches: 50 }] };
  const section = () => screen.getByRole("region", { name: "発言をどの会議まで収録しているか" });

  it("件数・人数・回次ごとの内訳を実数で出す", () => {
    render(<MemoryRouter><CoveragePage unmatchedSpeeches={stats} /></MemoryRouter>);
    const t = section().textContent ?? "";
    expect(t).toContain("301");
    expect(t).toContain("55");
    expect(t).toContain("217");
    expect(t).toContain("251");
    expect(t).toContain("219");
  });

  it("会議録から辿れることを書く（記録が失われていないと分かるように）", () => {
    render(<MemoryRouter><CoveragePage unmatchedSpeeches={stats} /></MemoryRouter>);
    expect(section().textContent).toContain("会議録には残って");
  });

  it("0 件・null なら何も出さない（無い事実を作らない）", () => {
    for (const v of [null, { speeches: 0, speakers: 0, sessions: [] }]) {
      const { unmount } = render(<MemoryRouter><CoveragePage unmatchedSpeeches={v} /></MemoryRouter>);
      expect(section().textContent).not.toContain("紐づけられていない発言");
      unmount();
    }
  });

  // #339 と同じ移行の形: session を持たない古い unmatched.json でも件数は出す
  it("回次の内訳が無くても件数と人数は出す（session を持たない古いデータ）", () => {
    render(<MemoryRouter><CoveragePage unmatchedSpeeches={{ speeches: 301, speakers: 55, sessions: [] }} /></MemoryRouter>);
    const t = section().textContent ?? "";
    expect(t).toContain("301");
    expect(t).toContain("55");
    expect(t).not.toContain("第217回");
  });

  it("評価語を含まない", () => {
    const { container } = render(<MemoryRouter><CoveragePage unmatchedSpeeches={stats} /></MemoryRouter>);
    for (const w of EVALUATIVE_WORDS) expect(container.textContent).not.toContain(w);
  });
});

/**
 * Issue 408: `bills` を `dataset` から切り出した（gzip 60KB、使うのはこの画面だけ）。
 *
 * **この画面のテストは全部 `data` を明示的に渡すので、既定の経路＝本番が通る道を
 * 誰も通っていなかった。** `withBills` を外して bills が黙って 0 件になる変異を入れても、
 * 46 件すべて緑のままだった。
 *
 * 「記録が出ない」は利用者から見ても分からない失敗なので、**既定で描いて確かめる**。
 */
describe("/coverage の既定（bundled）で議案が出る（Issue 408 / 411）", () => {
  it("data を渡さずに描くと、衆議院の行に議案の実件数が出る", async () => {
    const { billsBySession: bundled } = await import("../lib/bills");
    render(
      <MemoryRouter>
        <CoveragePage />
      </MemoryRouter>,
    );

    // 議案の行は **DietRows の中だけ**（国会の2行）。地方議会にはこの行が無い。
    // データは全件が house: "shugiin" なので、**件数が出るのは衆議院の1行だけ**が正しい
    // （最初「3行あって地方議会は—」と書いたが、3つ目は本文中の散文で行ではなかった。レビュー指摘）。
    const shugiin = screen
      .getAllByText(/議案情報/)
      .map((el) => el.closest("tr"))
      .find((r) => (r?.textContent ?? "").includes("件"));
    expect(shugiin, "議案の件数が出ている行が無い（bills が届いていない）").toBeTruthy();

    // **件数そのものを見る。** 「1件でも出れば合格」だと、1,941 件が 1 件に減っても通ってしまう
    // （実際に部分欠損の変異が全部緑だった。レビュー指摘）。
    // textContent を丸ごと正規表現に掛けると「うち議案のある回次 25」と「1,941 件」が
    // 繋がって "251,941 件" に見える（最初これで 251941 を拾って落ちた）。**セル単位**で見る
    const cells = [...(shugiin?.querySelectorAll("td") ?? [])].map((td) => td.textContent ?? "");
    const countCell = cells.find((t) => /^[\d,]+\s*議案$|[\d,]+\s*件\s*$/.test(t.trim())) ?? cells.at(-1) ?? "";
    const shown = Number((countCell.match(/([\d,]+)/)?.[1] ?? "").replace(/,/g, ""));

    // **期待値を bundled（集計）から作ってはいけない**（レビュー指摘）。
    // 集計が痩せれば期待値も一緒に痩せるので、1,941 → 101 のような**部分欠損が永久に検出できない**
    // （実際 95% 欠損させても全件緑だった）。
    //
    // Issue 411: /coverage は集計（bills/by-session.json）を読むようになったので、
    // 独立した経路は **bills/index.json そのもの**にする。集計を経由せず生の議案を数えた値と
    // 画面の数字を突き合わせるので、**集計が間違っていれば（画面と一緒に間違っても）ここで落ちる**。
    const fromFile: { house: string }[] = JSON.parse(readFileSync(join(import.meta.dirname, "../../../../data/bills/index.json"), "utf8"));
    const expected = fromFile.filter((b) => b.house === "shugiin").length;
    expect(shown).toBe(expected);

    // 集計の合計が index.json の行数と一致すること自体も見る（片方だけ痩せたら落ちる）。
    // 回次の範囲も index.json から直に数えた値と突き合わせる（件数が合っても回次がずれたら落ちる）
    expect(bundled.reduce((t, r) => t + r.count, 0)).toBe(fromFile.length);
    const sessionsFromFile = [...new Set((fromFile as { house: string; session: number }[]).filter((b) => b.house === "shugiin").map((b) => b.session))].sort((a, b) => a - b);
    const shownRange = cells.find((t) => /第[\d,]+—[\d,]+回/.test(t)) ?? "";
    expect(shownRange).toContain(`第${sessionsFromFile[0]}—${sessionsFromFile.at(-1)}回`);
    expect(bundled.filter((r) => r.house === "shugiin").map((r) => r.session).sort((a, b) => a - b)).toEqual(sessionsFromFile);
  });
});

/**
 * Issue 441: `members/index.json`（1,057 行・gzip 40KB）を `dataset` から切り出した。
 * #411 と同じ理由で、**既定の経路＝本番が通る道**をここで通す。
 *
 * **期待値は集計（by-assembly.json）から作らない。** 生の `members/index.json` を直に数える。
 * 集計から作ると、集計の誤りが期待値と画面の両方に出て**永久に検出できない**。
 */
describe("/coverage の既定（bundled）で議員数が出る（Issue 441）", () => {
  /** 生の members/index.json（集計を通さない独立した経路） */
  const rawMembers: { house?: string; assemblyId?: string; current?: boolean }[] = JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../../data/members/index.json"), "utf8"),
  );
  const rawTotal = (assemblyId: string) => rawMembers.filter((m) => (m.assemblyId ?? `diet-${m.house}`) === assemblyId).length;
  /** 生の assemblies/index.json（fixture ではなく、既定の経路が実際に描く議会） */
  const rawAssemblies: Assembly[] = JSON.parse(readFileSync(join(import.meta.dirname, "../../../../data/assemblies/index.json"), "utf8"));

  it("data を渡さずに描くと、議会ごとの議員数が members/index.json を直に数えた値と一致する", async () => {
    const { membersByAssembly: bundled } = await import("../lib/members-by-assembly");
    render(
      <MemoryRouter>
        <CoveragePage />
      </MemoryRouter>,
    );

    /** 国会の表: その院の行に出ている「N 名」 */
    const dietRow = (name: string) => {
      const row = screen.getAllByText(name).map((el) => el.closest("tr")).find((r) => /[\d,]+\s*名/.test(r?.textContent ?? ""))!;
      return Number(((row.textContent ?? "").match(/([\d,]+)\s*名/)?.[1] ?? "").replace(/,/g, ""));
    };
    /** 地方議会の節（aria-label に議会名）で「議員」の行に出ている「N 名」 */
    const localCount = (name: string) => {
      const region = screen.getByRole("region", { name });
      const dd = within(region).getByText("議員").closest(".assembly-facts__item")!.querySelector("dd")!;
      return Number(((dd.textContent ?? "").match(/([\d,]+)/)?.[1] ?? "").replace(/,/g, ""));
    };

    // **収録範囲は元職も含めて数える**（total）。現職だけ（current）を出したら落ちる:
    // 実データは参議院が current 247 / total 307 と違う数
    expect(dietRow("参議院")).toBe(rawTotal("diet-sangiin"));
    expect(dietRow("衆議院")).toBe(rawTotal("diet-shugiin"));
    // **議会を取り違えれば別の議会の人数が出る**（合計は変わらない。#435）ので、地方議会も 1 つずつ見る
    for (const a of rawAssemblies.filter((x) => x.kind !== "national")) {
      expect([a.id, localCount(a.name)]).toEqual([a.id, rawTotal(a.id)]);
    }

    // 合計（議員）も生の行数と一致する（1 人も取りこぼさない）
    const totals = screen.getByRole("region", { name: "合計" });
    const figure = (label: string) => Number((within(totals).getByText(label).closest(".figure")!.querySelector(".figure__num")!.textContent ?? "").replace(/,/g, ""));
    expect(figure("議員")).toBe(rawMembers.length);

    // 集計そのものも生の index.json と突き合わせる（**議会間の入れ替えは合計では見えない**ので議会ごとに）。#435
    for (const row of bundled) expect([row.assemblyId, row.total]).toEqual([row.assemblyId, rawTotal(row.assemblyId)]);
    expect(bundled.reduce((t, r) => t + r.total, 0)).toBe(rawMembers.length);
    expect(bundled.reduce((t, r) => t + r.current, 0)).toBe(rawMembers.filter((m) => m.current !== false).length);
  });
});
