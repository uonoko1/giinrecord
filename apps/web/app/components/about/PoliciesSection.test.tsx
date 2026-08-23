import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { PoliciesSection } from "./PoliciesSection";

function renderSection() {
  return render(
    <MemoryRouter>
      <PoliciesSection />
    </MemoryRouter>,
  );
}

describe("PoliciesSection（#166）", () => {
  it("id=policies の region で、利用規約とプライバシーポリシーへのリンクを置く", () => {
    renderSection();
    const section = screen.getByRole("region", { name: "規約とプライバシー" });
    expect(section).toHaveAttribute("id", "policies");
    expect(screen.getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "プライバシーポリシー" })).toHaveAttribute("href", "/privacy");
  });

  it("計測の説明は書かない（プライバシーポリシーへ移動、#167）", () => {
    const { container } = renderSection();
    for (const word of ["Cookie", "IP アドレス", "リファラ", "ページビュー"]) {
      expect(container.textContent).not.toContain(word);
    }
  });
});
