import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FactsSection } from "./FactsSection";

describe("FactsSection", () => {
  it("見出しと region を持ち、事実2件・推定1件を文字で区別する", () => {
    render(<FactsSection />);
    expect(screen.getByRole("region", { name: "何が事実で、何が推定か" })).toBeInTheDocument();
    expect(screen.getAllByText("事実")).toHaveLength(2);
    expect(screen.getAllByText("推定")).toHaveLength(1);
    expect(screen.getByText("参議院の記名・押しボタン投票")).toBeInTheDocument();
    expect(screen.getByText("衆議院の賛否")).toBeInTheDocument();
  });

  it("推定カードは衆院公開後の文言（準備中と言わず、会派の態度（推定）として表示すると書く）", () => {
    render(<FactsSection />);
    expect(screen.queryByText(/準備中/)).not.toBeInTheDocument();
    expect(screen.getByText(/所属会派の態度を「会派の態度（推定）」として表示し/)).toBeInTheDocument();
    expect(screen.getByText(/個人の賛否とは断定しません/)).toBeInTheDocument();
  });

  it("事実と推定でタグのクラスが異なる（色の意味は良し悪しではない）", () => {
    render(<FactsSection />);
    expect(screen.getAllByText("事実")[0]).toHaveClass("tag--fact");
    expect(screen.getByText("推定")).toHaveClass("tag--estimate");
  });
});
