import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { CoverBrand } from "./CoverBrand";

describe("CoverBrand（表紙の「議員レコード」ロゴ、#129）", () => {
  it("文字ロゴ「議員レコード」はそのまま、横に高さ 1em のマーク（装飾・aria-hidden）を置く", () => {
    const { container } = render(<CoverBrand />);
    expect(screen.getByText("議員レコード")).toBeInTheDocument();
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 100 100");
    expect(svg?.getAttribute("height")).toBe("1em");
  });

  it("マークは文字色（currentColor）と真鍮トークンだけを使う（ダークは tokens で反転）", () => {
    const { container } = render(<CoverBrand />);
    const svg = container.querySelector("svg")!;
    const fills = [...svg.querySelectorAll("circle")].map((c) => c.getAttribute("fill"));
    expect(fills).toEqual(["currentColor", "currentColor", "var(--brass-on-cover)"]);
    for (const l of svg.querySelectorAll("line")) expect(l.getAttribute("stroke")).toBe("currentColor");
  });

  it("to を渡すとトップへのリンクになる", () => {
    render(
      <MemoryRouter>
        <CoverBrand to="/" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "議員レコード" })).toHaveAttribute("href", "/");
  });

  it("to が無ければリンクにしない（トップページ自身）", () => {
    render(<CoverBrand />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
