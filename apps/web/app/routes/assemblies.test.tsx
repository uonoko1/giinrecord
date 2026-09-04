import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Assembly, MemberAssemblyCount } from "@seiji-kiroku/shared";
import type { Dataset } from "../lib/dataset";
import assembliesFixture from "../test-fixtures/assemblies/index.json";
import { dataset, membersByAssembly } from "../test-fixtures/dataset";
import Assemblies, { meta as routeMeta } from "./assemblies";

const EVALUATIVE_WORDS = ["おすすめ", "ランキング", "一致率", "遅れ", "不十分", "優れ"];
const assemblies = assembliesFixture as Assembly[];
const withLocal: Dataset = { ...dataset, assemblies };
// #441: 人数は ETL の集計（members/by-assembly.json）から出す。pref-04 は現職2・元職1
// （**current と total をわざと違う数にしてある**。同じ数だとどちらを読んでいるか見分けられない）
const counts: MemberAssemblyCount[] = [...membersByAssembly, { assemblyId: "pref-04", current: 2, total: 3 }];

function renderPage(data: Dataset = withLocal, byAssembly: readonly MemberAssemblyCount[] = counts) {
  return render(
    <MemoryRouter>
      <Assemblies data={data} membersByAssembly={byAssembly} />
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
    // 現職だけを数える（#355、#441）。集計は current 2 / total 3 なので 2 名（3 名にしない）
    expect(within(miyagi).getByText(/2 名/)).toBeInTheDocument();
    expect(within(miyagi).queryByText(/3 名/)).toBeNull();
  });

  /*
   * #441: 人数は `members/by-assembly.json` から議会 id で引く。
   * **議会を取り違えれば別の議会の人数が出る**（合計は変わらないので、合計だけを見ても気づけない。#435）。
   */
  it("議会ごとに正しい行を引く（議会間で人数が入れ替わらない）", () => {
    renderPage(withLocal, [
      { assemblyId: "diet-sangiin", current: 247, total: 307 },
      { assemblyId: "diet-shugiin", current: 465, total: 465 },
      { assemblyId: "pref-04", current: 56, total: 56 },
    ]);
    const list = screen.getByRole("list", { name: "このサイトにある議会" });
    const row = (name: string) => within(list).getByText(name).closest("li")!;
    expect(row("参議院")).toHaveTextContent("247 名");
    expect(row("衆議院")).toHaveTextContent("465 名");
    expect(row("宮城県議会")).toHaveTextContent("56 名");
  });

  it("集計に行が無い議会は 0 名（無い＝0 人。落ちない）", () => {
    renderPage(withLocal, []);
    const list = screen.getByRole("list", { name: "このサイトにある議会" });
    expect(within(list).getByText("宮城県議会").closest("li")!).toHaveTextContent("0 名");
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

/**
 * Issue 441: 既定の経路（prop を渡さない＝本番が通る道）で、議会ごとの人数が
 * 生の `members/index.json` を直に数えた値と一致することを固定する。
 * **期待値を集計（by-assembly.json）から作らない**——集計の誤りが両側に出て検出できなくなるため。
 */
describe("/assemblies の既定（bundled）で議員数が出る（Issue 441）", () => {
  const rawMembers: { house?: string; assemblyId?: string; current?: boolean }[] = JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../../data/members/index.json"), "utf8"),
  );
  const rawAssemblies: Assembly[] = JSON.parse(readFileSync(join(import.meta.dirname, "../../../../data/assemblies/index.json"), "utf8"));
  const rawCurrent = (assemblyId: string) => rawMembers.filter((m) => (m.assemblyId ?? `diet-${m.house}`) === assemblyId && m.current !== false).length;

  it("data も集計も渡さずに描くと、議会ごとの現職の人数が members/index.json を直に数えた値と一致する", () => {
    render(
      <MemoryRouter>
        <Assemblies />
      </MemoryRouter>,
    );
    const list = screen.getByRole("list", { name: "このサイトにある議会" });
    // **議会ごとに**見る（合計だけだと、議会間で人数が入れ替わっても気づけない。#435）
    for (const a of rawAssemblies) {
      const row = within(list).getByText(a.name).closest("li")!;
      const shown = Number(((row.textContent ?? "").match(/([\d,]+)\s*名/)?.[1] ?? "").replace(/,/g, ""));
      expect([a.id, shown]).toEqual([a.id, rawCurrent(a.id)]);
    }
    // **現職だけ**（#355）。参院で元職を含む行数（定数248超え）を出していない
    const sangiin = within(list).getByText("参議院").closest("li")!;
    expect(sangiin.textContent).not.toContain(`${rawMembers.filter((m) => (m.assemblyId ?? `diet-${m.house}`) === "diet-sangiin").length} 名`);
  });
});
