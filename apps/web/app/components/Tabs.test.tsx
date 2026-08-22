import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Tabs } from "./Tabs";

describe("Tabs", () => {
  it("すべて／採決／提出法案／発言 の4タブを tab 役割で出し、選択状態を示す", () => {
    render(<Tabs value="all" onChange={() => {}} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["すべて", "採決", "提出法案", "発言"]);
    expect(screen.getByRole("tab", { name: "すべて" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "採決" })).toHaveAttribute("aria-selected", "false");
  });

  it("クリックで onChange に key を渡す", () => {
    const onChange = vi.fn();
    render(<Tabs value="all" onChange={onChange} />);
    fireEvent.click(screen.getByRole("tab", { name: "発言" }));
    expect(onChange).toHaveBeenCalledWith("speech");
  });
});

describe("Tabs keyboard (APG tabs pattern)", () => {
  it("ArrowRight で次のタブ、ArrowLeft で前のタブに onChange する", () => {
    const onChange = vi.fn();
    render(<Tabs value="vote" onChange={onChange} />);
    const current = screen.getByRole("tab", { name: "採決" });
    fireEvent.keyDown(current, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("bill");
    fireEvent.keyDown(current, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("all");
  });

  it("端で循環する（最後→最初、最初→最後）", () => {
    const onChange = vi.fn();
    const { rerender } = render(<Tabs value="speech" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "発言" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("all");
    rerender(<Tabs value="all" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "すべて" }), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("speech");
  });

  it("Home/End で最初/最後のタブへ", () => {
    const onChange = vi.fn();
    render(<Tabs value="bill" onChange={onChange} />);
    const current = screen.getByRole("tab", { name: "提出法案" });
    fireEvent.keyDown(current, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("all");
    fireEvent.keyDown(current, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("speech");
  });

  it("選択後のタブがフォーカスを受け取る（roving tabindex）", () => {
    const onChange = vi.fn();
    const { rerender } = render(<Tabs value="all" onChange={onChange} />);
    const first = screen.getByRole("tab", { name: "すべて" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    rerender(<Tabs value="vote" onChange={onChange} />);
    expect(screen.getByRole("tab", { name: "採決" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "採決" })).toHaveAttribute("tabindex", "0");
    expect(first).toHaveAttribute("tabindex", "-1");
  });
});
