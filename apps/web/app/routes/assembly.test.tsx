import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import type { Assembly } from "@seiji-kiroku/shared";
import type { AssemblySession } from "../lib/data-contract";
import type { Dataset, MemberSummary } from "../lib/dataset";
import assembliesFixture from "../test-fixtures/assemblies/index.json";
import localMembers from "../test-fixtures/assemblies/members-index.json";
import sessionsFixture from "../test-fixtures/assemblies/sessions.json";
import { dataset } from "../test-fixtures/dataset";
import AssemblyRoute, { AssemblyPage, meta as routeMeta, pageTitle } from "./assembly";

const EVALUATIVE_WORDS = ["おすすめ", "ランキング", "一致率", "遅れ", "不十分", "優れ"];
const assemblies = assembliesFixture as Assembly[];
const withLocal: Dataset = { ...dataset, assemblies, members: [...dataset.members, ...(localMembers as MemberSummary[])] };
const sessions = new Map<string, AssemblySession[]>([["pref-04", sessionsFixture as AssemblySession[]]]);

function renderPage(id: string, data: Dataset = withLocal, s = sessions) {
  return render(
    <MemoryRouter>
      <AssemblyPage id={id} data={data} sessions={s} />
    </MemoryRouter>,
  );
}

describe("/assemblies/{id} 地方議会", () => {
  it("名称・種別・名簿（公式）リンクと、公開状況（#128 の調査）を事実として出す", () => {
    const { container } = renderPage("pref-04");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("宮城県議会");
    expect(screen.getByText("都道府県議会")).toBeInTheDocument();
    const roster = screen.getByRole("link", { name: /議員名簿（公式）/ });
    expect(roster).toHaveAttribute("href", "https://www.pref.miyagi.jp/site/kengikai/meibo/index.html");
    expect(roster.getAttribute("rel")).toMatch(/noopener/);
    const facts = screen.getByRole("region", { name: "個人別表決の公開状況" });
    expect(facts).toHaveTextContent("公開");
    expect(facts).toHaveTextContent("PDF（index は HTML）");
    expect(within(facts).getByRole("link", { name: /確認したページ/ })).toHaveAttribute("href", "https://www.pref.miyagi.jp/site/kengikai/kakohonkaigi.html");
    for (const word of EVALUATIVE_WORDS) expect(container.textContent).not.toContain(word);
  });

  it("議員一覧: その議会の議員だけをかな順に、会派・選挙区つきで /members/{id} へリンク。元職は明記", () => {
    renderPage("pref-04");
    const list = screen.getByRole("list", { name: "議員" });
    const links = within(list).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/members/p_04_000002", "/members/p_04_000003", "/members/p_04_000001"]);
    const row = links[0]!.closest("li")!;
    expect(row).toHaveTextContent("みやぎ県民の声");
    expect(row).toHaveTextContent("石巻市・牡鹿郡");
    expect(links[1]!.closest("li")).toHaveTextContent("元職");
    expect(screen.getByText("3 名")).toBeInTheDocument();
  });

  it("会期一覧: sessions.json の並びのまま、会期の原文・議決日・表決件数・出典（公式）", () => {
    renderPage("pref-04");
    const table = screen.getByRole("table", { name: "会期" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("第399回（令和8年2月定例会）");
    expect(rows[0]).toHaveTextContent("2026.03.18");
    expect(rows[0]).toHaveTextContent("3");
    const src = within(rows[0]!).getByRole("link", { name: /表決結果/ });
    expect(src).toHaveAttribute("href", "https://www.pref.miyagi.jp/site/kengikai/hyoketu080318.html");
    expect(src).toHaveAttribute("target", "_blank");
  });

  it("sessions.json が無い議会は「会期の一覧は未取得です」", () => {
    renderPage("pref-04", withLocal, new Map());
    expect(screen.queryByRole("table", { name: "会期" })).toBeNull();
    expect(screen.getByText(/会期の一覧は未取得です/)).toBeInTheDocument();
  });
});

describe("/assemblies/{id} 国会", () => {
  it("参議院: 議員一覧は /members?assembly=diet-sangiin へ、採決は /rollcalls へリンクし、議員を並べない", () => {
    renderPage("diet-sangiin");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("参議院");
    expect(screen.getByRole("link", { name: /議員一覧/ })).toHaveAttribute("href", "/members?assembly=diet-sangiin");
    expect(screen.getByRole("link", { name: /本会議採決/ })).toHaveAttribute("href", "/rollcalls");
    expect(screen.queryByRole("list", { name: "議員" })).toBeNull();
    expect(screen.getByText("3 名")).toBeInTheDocument();
  });
  it("衆議院: 個人の投票記録が公開されていない事実を1文で示し、採決へのリンクは出さない", () => {
    renderPage("diet-shugiin");
    expect(screen.getByRole("link", { name: /議員一覧/ })).toHaveAttribute("href", "/members?assembly=diet-shugiin");
    expect(screen.queryByRole("link", { name: /本会議採決/ })).toBeNull();
    expect(screen.getByText(/個人の投票記録が公開されていません/)).toBeInTheDocument();
  });
  it("assemblies/index.json が無い古いデータでも国会の2議会は表示できる", () => {
    renderPage("diet-shugiin", dataset, new Map());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("衆議院");
  });
});

describe("/assemblies/{id} 無い id", () => {
  it("「この議会はありません」と一覧へのリンク。評価語なし", () => {
    renderPage("pref-99");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("この議会はありません");
    expect(screen.getByRole("link", { name: /議会一覧/ })).toHaveAttribute("href", "/assemblies");
  });
  it("ルートは URL の :id を読む", () => {
    render(
      <MemoryRouter initialEntries={["/assemblies/pref-04"]}>
        <Routes>
          <Route path="/assemblies/:id" element={<AssemblyRoute data={withLocal} sessions={sessions} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("宮城県議会");
  });
});

describe("meta", () => {
  it("pageTitle は議会名。無い id は「議会」", () => {
    expect(pageTitle(assemblies[2])).toBe("宮城県議会");
    expect(pageTitle(undefined)).toBe("議会");
  });
  it("canonical は /assemblies/{id}", () => {
    const tags = routeMeta({ location: { pathname: "/assemblies/diet-sangiin" }, params: { id: "diet-sangiin" } } as unknown as Parameters<typeof routeMeta>[0]);
    expect(tags).toContainEqual({ title: "参議院 ・ 議員レコード" });
    expect(tags).toContainEqual({ tagName: "link", rel: "canonical", href: "/assemblies/diet-sangiin" });
  });
});
