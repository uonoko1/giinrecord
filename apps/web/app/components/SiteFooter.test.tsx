import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SiteFooter } from "./SiteFooter";

/** ルーター文脈なしで描画できること自体が仕様（MemberPage はルーター無しでテストされる）。 */
function renderFooter() {
  return render(<SiteFooter />);
}

describe("SiteFooter（#167）", () => {
  it("利用規約・プライバシーポリシー・このデータについてへの内部リンクを持つ", () => {
    renderFooter();
    expect(screen.getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "プライバシーポリシー" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("link", { name: "このデータについて" })).toHaveAttribute("href", "/about");
  });

  it("GitHub は外部リンクで noopener noreferrer", () => {
    renderFooter();
    const link = screen.getByRole("link", { name: "GitHub" });
    expect(link).toHaveAttribute("href", "https://github.com/uonoko1/gikailog");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("contentinfo ランドマークである", () => {
    renderFooter();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });
});
