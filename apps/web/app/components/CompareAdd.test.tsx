/**
 * 議員ページの「比較に追加」（Issue #104）。localStorage に最大4名の id を保存し、/compare へのリンクを出す。
 * Cookie は使わない。storage が使えなくても落ちない。
 */
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPARE_STORAGE_KEY } from "../lib/compare";
import { CompareAdd } from "./CompareAdd";

function renderAdd(id: string) {
  return render(<CompareAdd memberId={id} />);
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("CompareAdd", () => {
  it("押すと localStorage に id を足し、ボタンが「比較から外す」になり、/compare?m=… へのリンクが出る", async () => {
    renderAdd("m_014002");
    await userEvent.click(screen.getByRole("button", { name: "比較に追加" }));
    expect(localStorage.getItem(COMPARE_STORAGE_KEY)).toBe('["m_014002"]');
    expect(screen.getByRole("button", { name: "比較から外す" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /並べて見る（1名）/ })).toHaveAttribute("href", "/compare?m=m_014002");
  });
  it("保存済みなら最初から「比較から外す」で、押すと外れる", async () => {
    localStorage.setItem(COMPARE_STORAGE_KEY, '["m_1","m_014002"]');
    renderAdd("m_014002");
    await userEvent.click(await screen.findByRole("button", { name: "比較から外す" }));
    expect(localStorage.getItem(COMPARE_STORAGE_KEY)).toBe('["m_1"]');
    expect(screen.getByRole("button", { name: "比較に追加" })).toBeInTheDocument();
  });
  it("4名保存済みなら追加できず、上限を伝える", async () => {
    localStorage.setItem(COMPARE_STORAGE_KEY, '["a","b","c","d"]');
    renderAdd("m_014002");
    await userEvent.click(await screen.findByRole("button", { name: "比較に追加" }));
    expect(localStorage.getItem(COMPARE_STORAGE_KEY)).toBe('["a","b","c","d"]');
    expect(screen.getByText(/4名まで/)).toBeInTheDocument();
  });
  it("localStorage が投げても落ちず、ページ内の状態だけで動く", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    renderAdd("m_014002");
    await userEvent.click(screen.getByRole("button", { name: "比較に追加" }));
    expect(screen.getByRole("button", { name: "比較から外す" })).toBeInTheDocument();
  });
  it("Cookie は使わない", async () => {
    renderAdd("m_014002");
    await userEvent.click(screen.getByRole("button", { name: "比較に追加" }));
    expect(document.cookie).toBe("");
  });
});
