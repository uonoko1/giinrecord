import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { FactsSection } from "./FactsSection";

const renderSection = () =>
  render(
    <MemoryRouter>
      <FactsSection />
    </MemoryRouter>,
  );

describe("FactsSection", () => {
  it("見出しと region を持ち、事実2件・推定1件を文字で区別する", () => {
    renderSection();
    expect(screen.getByRole("region", { name: "何が事実で、何が推定か" })).toBeInTheDocument();
    expect(screen.getAllByText("事実")).toHaveLength(2);
    expect(screen.getAllByText("推定")).toHaveLength(1);
    expect(screen.getByText("参議院の記名・押しボタン投票")).toBeInTheDocument();
    expect(screen.getByText("衆議院の賛否")).toBeInTheDocument();
  });

  it("推定カードは衆院公開後の文言（準備中と言わず、会派の態度（推定）として表示すると書く）", () => {
    renderSection();
    expect(screen.queryByText(/準備中/)).not.toBeInTheDocument();
    expect(screen.getByText(/所属会派の態度を「会派の態度（推定）」として表示し/)).toBeInTheDocument();
    expect(screen.getByText(/個人の賛否とは断定しません/)).toBeInTheDocument();
  });

  it("押しボタン投票が1998年（第142回国会）に始まった制度の事実は残す（収録範囲ではない、#218）", () => {
    renderSection();
    expect(screen.getByText(/この投票方式は1998年（第142回国会）に始まりました。/)).toBeInTheDocument();
  });

  it("収録範囲（このサイトに入っている回次・会期・件数）は /coverage へのリンクにし、ここに数値を書かない（#218）", () => {
    const { container } = renderSection();
    expect(screen.getByRole("link", { name: "収録範囲" })).toHaveAttribute("href", "/coverage");
    // 収録範囲の数え上げ（第200—221回 のようなレンジ）は About に置かない
    expect(container.textContent).not.toMatch(/第\d+—\d+回/);
  });

  it("衆院の記録が紐づく範囲は /coverage の節へのリンクにし、理由も数値もここに書かない（#251）", () => {
    const { container } = renderSection();
    expect(screen.getByRole("link", { name: /衆議院の記録が議員ページに紐づく範囲/ })).toHaveAttribute("href", "/coverage#coverage-shugiin-roster-heading");
    // 名簿が 1 枚しかないという説明は /coverage に 1 つだけ置く（About には重複させない）
    expect(container.textContent).not.toContain("名簿");
  });

  it("事実と推定でタグのクラスが異なる（色の意味は良し悪しではない）", () => {
    renderSection();
    expect(screen.getAllByText("事実")[0]).toHaveClass("tag--fact");
    expect(screen.getByText("推定")).toHaveClass("tag--estimate");
  });
});
