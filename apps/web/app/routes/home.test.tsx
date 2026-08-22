import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import Home, { meta as routeMeta } from "./home";
import { dataset } from "../test-fixtures/dataset";

const EVALUATIVE_WORDS = ["おすすめ", "ランキング", "一致率"];
const CAMPAIGN_WORDS = ["応援", "守る", "守ろう", "ぜひ", "お願いします", "あなたの力", "みんなで"];

function renderHome(data = dataset) {
  return render(
    <MemoryRouter>
      <Home data={data} />
    </MemoryRouter>,
  );
}

describe("Home", () => {
  it("見出しと方針文がある", () => {
    renderHome();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("言ったことではなく、やったことを。");
    expect(screen.getByText(/公式記録だけを、そのまま並べます。評価はしません。/)).toBeInTheDocument();
  });

  it("評価語を含まない", () => {
    const { container } = renderHome();
    for (const word of EVALUATIVE_WORDS) {
      expect(container.textContent).not.toContain(word);
    }
  });

  it("検索入口は /members へ向く", () => {
    renderHome();
    expect(screen.getByRole("link", { name: /議員一覧/ })).toHaveAttribute("href", "/members");
  });

  it("最近の本会議採決は日付降順で上位4件を出し、各件が採決ページへリンクする", () => {
    renderHome();
    const section = screen.getByRole("region", { name: "最近の本会議採決" });
    const items = section.querySelectorAll("li");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent("日本国憲法の改正手続に関する法律の一部を改正する法律案");
    expect(items[0]).toHaveTextContent("2026.07.24");
    expect(items[0]).toHaveTextContent("可決");
    expect(items[0].querySelector("a")).toHaveAttribute("href", "/rollcalls/221/221-0724-v001");
    expect(section.textContent).not.toContain("一番古い案件");
  });

  it("採決が無ければ「最近の本会議採決」を出さない", () => {
    renderHome({ ...dataset, rollcalls: [] });
    expect(screen.queryByRole("region", { name: "最近の本会議採決" })).not.toBeInTheDocument();
  });

  it("規模（議員数・回次）を出す", () => {
    renderHome();
    const section = screen.getByRole("region", { name: "このサイトにあるもの" });
    expect(section).toHaveTextContent("3");
    expect(section).toHaveTextContent("参議院議員");
    expect(section).toHaveTextContent("第220—221回");
  });

  it("規模に衆議院議員数を出し、衆院の注記の文言を保つ", () => {
    const shugiin = { ...dataset.members[0], id: "h_000001", name: "衆 太郎", kana: "しゅう たろう", house: "shugiin" as const };
    renderHome({ ...dataset, members: [...dataset.members, shugiin, { ...shugiin, id: "h_000002" }] });
    const section = screen.getByRole("region", { name: "このサイトにあるもの" });
    const figures = within(section).getAllByText(/議員$/).map((el) => `${el.previousElementSibling?.textContent} ${el.textContent}`);
    expect(figures).toContain("3 参議院議員");
    expect(figures).toContain("2 衆議院議員");
    expect(section).toHaveTextContent("衆議院は個人の投票記録が公開されていないため、会派の態度として別に扱います");
  });

  it("出典と更新時刻を出す", () => {
    renderHome();
    const section = screen.getByRole("region", { name: "出典と更新" });
    expect(section).toHaveTextContent("参議院 本会議投票結果");
    expect(section).toHaveTextContent("2026.08.22 06:00");
    expect(screen.getByRole("link", { name: "参議院 本会議投票結果" })).toHaveAttribute(
      "href",
      "https://www.sangiin.go.jp/japanese/joho1/kousei/vote/221/221-0000/votelist.html",
    );
  });

  it("データが無くても落ちず、規模は［集計中］になる", () => {
    renderHome({ meta: undefined, members: [], rollcalls: [] });
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "このサイトにあるもの" })).toHaveTextContent("［集計中］");
  });

  describe("フッターの支援リンク", () => {
    it("/about#funding への控えめなリンクがあり、ボタンではない", () => {
      renderHome();
      const link = screen.getByRole("link", { name: "支援する" });
      expect(link).toHaveAttribute("href", "/about#funding");
      expect(link.className).not.toMatch(/button|btn|entry__link/);
      expect(link.closest(".links")).not.toBeNull();
    });

    it("運動的な言葉を含まない", () => {
      const { container } = renderHome();
      for (const word of CAMPAIGN_WORDS) {
        expect(container.textContent).not.toContain(word);
      }
    });
  });
});

describe("meta()", () => {
  it("title はサイト名、canonical と OGP（website）を持つ", () => {
    const tags = routeMeta({ location: { pathname: "/" } } as unknown as Parameters<typeof routeMeta>[0]);
    expect(tags).toContainEqual({ title: "政治記録" });
    expect(tags).toContainEqual({ tagName: "link", rel: "canonical", href: "/" });
    expect(tags).toContainEqual({ property: "og:type", content: "website" });
    expect(tags).toContainEqual({ name: "description", content: expect.stringContaining("評価はしません") });
  });
});
