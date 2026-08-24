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
    expect(within(totals).getByText("3")).toBeInTheDocument(); // 議会 3（国会2＋宮城）
    expect(within(totals).getByText("6")).toBeInTheDocument(); // 議員 3＋3
    expect(within(totals).getByText("10")).toBeInTheDocument(); // 採決 5（国会）＋5（宮城）
  });

  it("国会: 院ごとに回次・採決件数・議員数と議員一覧（公式）の出典を出す", () => {
    renderPage();
    const table = screen.getByRole("table", { name: "国会の収録範囲" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    const sangiin = rows[0]!;
    expect(within(sangiin).getByRole("link", { name: "参議院" })).toHaveAttribute("href", "/assemblies/diet-sangiin");
    expect(sangiin).toHaveTextContent("第220—221回");
    expect(sangiin).toHaveTextContent("5 件");
    expect(sangiin).toHaveTextContent("3 名");
    const src = within(sangiin).getByRole("link", { name: "議員一覧（公式）" });
    expect(src).toHaveAttribute("href", assemblies[0]!.sourceUrl);
    expect(src.getAttribute("rel")).toMatch(/noopener/);
  });

  it("衆議院は個人票が無いことを行にも注記にも事実として書き、参院の件数を書かない", () => {
    renderPage();
    const table = screen.getByRole("table", { name: "国会の収録範囲" });
    const shugiin = within(table).getAllByRole("row")[2]!;
    expect(within(shugiin).getByRole("link", { name: "衆議院" })).toBeInTheDocument();
    expect(shugiin).toHaveTextContent("なし");
    expect(shugiin).not.toHaveTextContent("件");
    const diet = screen.getByRole("region", { name: "国会" });
    expect(diet).toHaveTextContent("衆議院は本会議の個人別の投票記録を公表していません");
    expect(diet).toHaveTextContent("推定");
  });

  it("取得の対象にした回次を meta.sessions から出す", () => {
    renderPage();
    expect(screen.getByRole("region", { name: "国会" })).toHaveTextContent("第220—221回");
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
