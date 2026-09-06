import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY, ThemeToggle } from "./ThemeToggle";

describe("ThemeToggle", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    localStorage.clear();
  });
  // テーマは `<html data-theme>` と localStorage に**残る**。消さないと実行順しだいで
  // 後ろのファイルが暗いテーマの html を見る（#512）。
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("初期状態は OS 追従（data-theme なし）", () => {
    render(<ThemeToggle />);
    expect(screen.getByRole("group", { name: "表示テーマ" })).toBeInTheDocument();
    expect(document.documentElement).not.toHaveAttribute("data-theme");
    expect(screen.getByRole("radio", { name: "OS に合わせる" })).toBeChecked();
  });

  it("「夜」を選ぶと html に data-theme=dark が付き、localStorage に保存される", () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("radio", { name: "夜" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(screen.getByRole("radio", { name: "夜" })).toBeChecked();
  });

  it("保存済みの選択を読み、「OS に合わせる」に戻すと data-theme と保存が消える", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    render(<ThemeToggle />);
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    fireEvent.click(screen.getByRole("radio", { name: "OS に合わせる" }));
    expect(document.documentElement).not.toHaveAttribute("data-theme");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("localStorage が使えなくても落ちずに切り替わる", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("radio", { name: "昼" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });
});
