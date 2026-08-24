import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Assembly } from "@seiji-kiroku/shared";
import type { Dataset, MemberSummary } from "../lib/dataset";
import assembliesFixture from "../test-fixtures/assemblies/index.json";
import localMembers from "../test-fixtures/assemblies/members-index.json";
import { dataset } from "../test-fixtures/dataset";
import Assemblies, { meta as routeMeta } from "./assemblies";

const EVALUATIVE_WORDS = ["おすすめ", "ランキング", "一致率", "遅れ", "不十分", "優れ"];
const assemblies = assembliesFixture as Assembly[];
const withLocal: Dataset = { ...dataset, assemblies, members: [...dataset.members, ...(localMembers as MemberSummary[])] };

function renderPage(data: Dataset = withLocal) {
  return render(
    <MemoryRouter>
      <Assemblies data={data} />
    </MemoryRouter>,
  );
}

describe("/assemblies 一覧", () => {
  it("見出しと、データにある議会（国会2＋地方）を名称・議員数つきで並べ、各行が /assemblies/{id} へリンクする", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("議会");
    const list = screen.getByRole("list", { name: "このサイトにある議会" });
    const links = within(list).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/assemblies/diet-sangiin", "/assemblies/diet-shugiin", "/assemblies/pref-04"]);
    expect(within(list).getByText("宮城県議会")).toBeInTheDocument();
    const miyagi = within(list).getByText("宮城県議会").closest("li")!;
    expect(within(miyagi).getByText(/3 名/)).toBeInTheDocument();
  });

  it("assemblies/index.json が無い古いデータでは国会の2議会だけ", () => {
    renderPage(dataset);
    const list = screen.getByRole("list", { name: "このサイトにある議会" });
    expect(within(list).getAllByRole("link").map((a) => a.textContent)).toEqual([expect.stringContaining("参議院"), expect.stringContaining("衆議院")]);
  });

  /** 都道府県と政令市の2表。見出し行を除いた全行 */
  function disclosureRows() {
    const tables = screen.getAllByRole("table", { name: /個人別表決の公開状況/ });
    expect(tables.map((t) => t.querySelector("caption")?.textContent)).toEqual([expect.stringContaining("都道府県議会"), expect.stringContaining("政令指定都市議会")]);
    return tables.flatMap((t) => within(t).getAllByRole("row").slice(1));
  }

  it("個人別表決の公開状況の表: 47 + 20 = 67 行、4 値、調査日、出典 URL（新規タブ・noopener）", () => {
    renderPage();
    const rows = disclosureRows();
    expect(rows).toHaveLength(67);
    const miyagi = rows.find((r) => within(r).queryByText("宮城"))!;
    expect(miyagi).toHaveTextContent("公開");
    expect(miyagi).toHaveTextContent("PDF（index は HTML）");
    const src = within(miyagi).getByRole("link", { name: /確認したページ/ });
    expect(src).toHaveAttribute("href", "https://www.pref.miyagi.jp/site/kengikai/kakohonkaigi.html");
    expect(src).toHaveAttribute("target", "_blank");
    expect(src.getAttribute("rel")).toMatch(/noopener/);
    expect(screen.getByText(/調査日 2026\.08\.23/)).toBeInTheDocument();
  });

  it("但し書き（起立採決のみ）は状態の隣に原文で出す", () => {
    renderPage();
    const okayama = disclosureRows().find((r) => within(r).queryByText("岡山市"))!;
    expect(okayama).toHaveTextContent("公開（起立採決のみ）");
  });

  it("サイトにデータがある議会は表からも /assemblies/{id} へリンクし、無い議会はリンクしない", () => {
    renderPage();
    const rows = disclosureRows();
    const miyagi = rows.find((r) => within(r).queryByText("宮城"))!;
    expect(within(miyagi).getByRole("link", { name: "宮城" })).toHaveAttribute("href", "/assemblies/pref-04");
    const aomori = rows.find((r) => within(r).queryByText("青森"))!;
    expect(within(aomori).queryByRole("link", { name: "青森" })).toBeNull();
  });

  it("4 値の意味を調査の定義どおりに説明し、評価語を含まない", () => {
    const { container } = renderPage();
    expect(screen.getByText(/無いとは言っていない/)).toBeInTheDocument();
    for (const word of EVALUATIVE_WORDS) expect(container.textContent).not.toContain(word);
  });

  it("meta: タイトル・説明・canonical", () => {
    const tags = routeMeta({ location: { pathname: "/assemblies" } } as Parameters<typeof routeMeta>[0]);
    expect(tags).toContainEqual({ title: "議会一覧 ・ 議員レコード" });
    expect(tags).toContainEqual({ tagName: "link", rel: "canonical", href: "/assemblies" });
  });
});
