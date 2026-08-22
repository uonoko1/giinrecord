import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { RollCallSummary } from "../lib/data-contract";
import index from "../test-fixtures/data/rollcalls/index.json";
import meta from "../test-fixtures/meta.json";
import { RollCallsPage, meta as routeMeta } from "./rollcalls";

const rollcalls = index as RollCallSummary[];

function renderPage(session?: number, onSessionChange = vi.fn()) {
  render(
    <MemoryRouter>
      <RollCallsPage rollcalls={rollcalls} session={session} onSessionChange={onSessionChange} meta={meta} />
    </MemoryRouter>,
  );
  return onSessionChange;
}

describe("RollCallsPage 一覧", () => {
  it("日付降順に並び、各行が採決ページへリンクする", () => {
    renderPage();
    const links = within(screen.getByRole("list")).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/rollcalls/221/221-0724-v006",
      "/rollcalls/221/221-0724-v007",
      "/rollcalls/221/221-0323-v001",
      "/rollcalls/220/220-0124-v001",
    ]);
  });
  it("各行に日付・結果（公表された集計）を出す", () => {
    renderPage();
    const row = screen.getByText(/特別区の設置/).closest("li")!;
    expect(within(row).getByText("2026.07.24")).toBeInTheDocument();
    expect(within(row).getByText(/賛成 117・反対 127/)).toBeInTheDocument();
  });
  it("件数を出す", () => {
    renderPage();
    expect(screen.getByText("4件")).toBeInTheDocument();
  });
});

describe("RollCallsPage 回次で絞り込み", () => {
  it("session が指定されればその回次だけ", () => {
    renderPage(220);
    const links = within(screen.getByRole("list")).getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(screen.getByText("1件")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "回次" })).toHaveValue("220");
  });
  it("select には「すべて」と回次が新しい順に並ぶ", () => {
    renderPage();
    const options = within(screen.getByRole("combobox", { name: "回次" })).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["すべて", "第221回", "第220回"]);
  });
  it("select を変えると onSessionChange に回次（すべては undefined）を渡す", async () => {
    const onChange = renderPage(221);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "回次" }), "220");
    expect(onChange).toHaveBeenLastCalledWith(220);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "回次" }), "");
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
  it("該当が無ければ空の旨を出す", () => {
    renderPage(999);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getByText("採決はありません。")).toBeInTheDocument();
  });
});

describe("meta()", () => {
  it("回次指定なら「第N回国会の採決」、無指定なら「本会議採決」", () => {
    expect(routeMeta({ data: { rollcalls, session: 221, meta } } as Parameters<typeof routeMeta>[0])).toContainEqual({
      title: "第221回国会の採決 ・ 政治記録",
    });
    expect(routeMeta({ data: { rollcalls, session: undefined, meta } } as Parameters<typeof routeMeta>[0])).toContainEqual({
      title: "本会議採決 ・ 政治記録",
    });
  });
});
