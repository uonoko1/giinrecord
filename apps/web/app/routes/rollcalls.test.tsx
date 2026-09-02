import { fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { RollCallSummary } from "../lib/data-contract";
import index from "../test-fixtures/data/rollcalls/index.json";
import meta from "../test-fixtures/meta";
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
  it("日付降順（同日は id 降順）に並び、各行が採決ページへリンクする", () => {
    renderPage();
    const links = within(screen.getByRole("list")).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/rollcalls/221/221-0724-v007",
      "/rollcalls/221/221-0724-v006",
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
  const args = (session: number | undefined, pathname: string) =>
    ({ data: { rollcalls, session, meta }, location: { pathname } }) as unknown as Parameters<typeof routeMeta>[0];
  it("回次指定なら「第N回国会の採決」、無指定なら「本会議採決」", () => {
    expect(routeMeta(args(221, "/rollcalls/221"))).toContainEqual({ title: "第221回国会の採決 ・ 議員レコード" });
    expect(routeMeta(args(undefined, "/rollcalls"))).toContainEqual({ title: "本会議採決 ・ 議員レコード" });
  });
  it("canonical はそのページのパス", () => {
    expect(routeMeta(args(221, "/rollcalls/221"))).toContainEqual({ tagName: "link", rel: "canonical", href: "/rollcalls/221" });
    expect(routeMeta(args(undefined, "/rollcalls"))).toContainEqual({ property: "og:url", content: "/rollcalls" });
  });
});

/**
 * #363: 回次「すべて」は本番で 380 件・スマホ 43 画面だった。200 件で折りたたむ。
 * 回次で絞っている間は折りたたまない（最大の回次でも 120 件。#340 と同じ考え方）。
 */
describe("RollCallsPage 折りたたみ（#363）", () => {
  const many = (n: number): RollCallSummary[] =>
    Array.from({ length: n }, (_, i) => ({
      ...(rollcalls[0] as RollCallSummary),
      id: `221-0724-v${String(i).padStart(3, "0")}`,
      title: `議案 ${i}`,
      session: i < 250 ? 221 : 220,
    }));
  const renderMany = (list: RollCallSummary[], session?: number) =>
    render(
      <MemoryRouter>
        <RollCallsPage rollcalls={list} session={session} onSessionChange={vi.fn()} meta={meta} />
      </MemoryRouter>,
    );
  const rows = () => screen.getAllByRole("listitem").length;

  it("回次「すべて」で 200 件を超えたら折りたたみ、残り件数を出す", () => {
    renderMany(many(380));
    expect(rows()).toBe(200);
    expect(screen.getByRole("button", { name: "さらに表示（残り180件）" })).toBeInTheDocument();
  });

  it("件数の表示は折りたたんでも全件（380件）のまま", () => {
    renderMany(many(380));
    expect(screen.getByText("380件")).toBeInTheDocument();
  });

  it("「さらに表示」で全件出る", async () => {
    renderMany(many(380));
    fireEvent.click(screen.getByRole("button", { name: /さらに表示/ }));
    expect(rows()).toBe(380);
    expect(screen.queryByRole("button", { name: /さらに表示/ })).not.toBeInTheDocument();
  });

  // Issue 393: 押すとボタンが消え、フォーカスが <body> に落ちていた。
  // キーボード / スクリーンリーダーの利用者は文書の先頭へ戻され、続きを読むには頭からたどり直すことになる。
  // **3箇所それぞれで**確かめる（1箇所だけ検査して他を落としたことが実際にある）。
  it("押した後、フォーカスが body に落ちず、続きの手前に移る（Issue 393）", async () => {
    renderMany(many(380));
    const button = screen.getByRole("button", { name: /さらに表示/ });
    button.focus();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);

    expect(document.activeElement).not.toBe(document.body);
    expect((document.activeElement as HTMLElement).textContent).toContain("続きを表示しました");
  });

  it("回次で絞っている間は折りたたまない（250 件 > 200 でも全件）", () => {
    renderMany(many(380), 221);
    expect(rows()).toBe(250);
    expect(screen.queryByRole("button", { name: /さらに表示/ })).not.toBeInTheDocument();
  });

  it("200 件以下なら折りたたまない（境界）", () => {
    renderMany(many(200));
    expect(rows()).toBe(200);
    expect(screen.queryByRole("button", { name: /さらに表示/ })).not.toBeInTheDocument();
  });
});
