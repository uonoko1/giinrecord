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
import CoveragePage, { meta as routeMeta } from "./coverage";

const EVALUATIVE_WORDS = ["おすすめ", "ランキング", "一致率", "遅れ", "不十分", "優れ", "充実", "網羅"];
const assemblies = assembliesFixture as Assembly[];
const sessions = new Map<string, AssemblySession[]>([["pref-04", sessionsFixture as AssemblySession[]]]);
const withLocal: Dataset = { ...dataset, assemblies, members: [...dataset.members, ...(localMembers as MemberSummary[])] };

function renderPage(data: Dataset = withLocal, s = sessions) {
  return render(
    <MemoryRouter>
      <CoveragePage data={data} sessions={s} />
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
