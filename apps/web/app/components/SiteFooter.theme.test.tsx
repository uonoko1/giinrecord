import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SiteFooter } from "./SiteFooter";

describe("SiteFooter のテーマ切替（#365）", () => {
  it("マウント後にテーマの選択肢が出る", async () => {
    render(<SiteFooter />);
    expect(await screen.findByRole("group", { name: "表示テーマ" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "OS に合わせる" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "昼" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "夜" })).toBeInTheDocument();
  });

  it("「夜」を選ぶと data-theme=dark が付き、localStorage に保存される", async () => {
    render(<SiteFooter />);
    fireEvent.click(await screen.findByRole("radio", { name: "夜" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("seiji-kiroku:theme")).toBe("dark");
  });

  it("「OS に合わせる」で data-theme が外れ、保存も消える", async () => {
    render(<SiteFooter />);
    fireEvent.click(await screen.findByRole("radio", { name: "夜" }));
    fireEvent.click(screen.getByRole("radio", { name: "OS に合わせる" }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem("seiji-kiroku:theme")).toBeNull();
  });
});
