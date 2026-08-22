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
