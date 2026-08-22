import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { RollCall } from "../lib/data-contract";
import meta from "../test-fixtures/meta.json";
import fixture from "../test-fixtures/rollcall.json";
import { RollCallPage, meta as routeMeta } from "./rollcall";

const rollCall = fixture as RollCall;

function renderPage(rc: RollCall = rollCall) {
  return render(
    <MemoryRouter>
      <RollCallPage rollCall={rc} meta={meta} />
    </MemoryRouter>,
  );
}

describe("RollCallPage 見出し", () => {
  it("案件名・日付・回次・総数・結果（公表された集計）を出す", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(rollCall.title);
    expect(screen.getByText("2026.07.24")).toBeInTheDocument();
    expect(screen.getByText(/第221回国会/)).toBeInTheDocument();
    expect(screen.getByText(/賛成 3 ・ 反対 6 ・ 投票総数 9/)).toBeInTheDocument();
  });
  it("出典（参院投票結果）へのリンクを持つ", () => {
    renderPage();
    const link = screen.getByRole("link", { name: /参議院 本会議投票結果/ });
    expect(link).toHaveAttribute("href", "https://www.sangiin.go.jp/japanese/touhyoulist/221/221-0724-v007.htm");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toMatch(/noopener/);
  });
});

describe("RollCallPage 会派", () => {
  it("会派は人数の多い順に並ぶ（データの順序ではなく）", () => {
    renderPage();
    const names = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(names).toEqual(["れいわ新選組", "自由民主党・無所属の会", "沖縄の風"]);
  });
  it("会派ごとの集計（人数・賛成・反対）を出す", () => {
    renderPage();
    const section = screen.getByRole("region", { name: "れいわ新選組" });
    expect(within(section).getByText(/5名 ・ 賛成 1 ・ 反対 3/)).toBeInTheDocument();
  });
  it("会派内の議員は原文の順で、判（Stamp）と議員ページへのリンクを持つ", () => {
    renderPage();
    const section = screen.getByRole("region", { name: "自由民主党・無所属の会" });
    const rows = within(section).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual(["反対青木 一彦", "反対赤松 健", "反対浅尾 慶一郎"]);
    expect(within(rows[0]).getByRole("img", { name: "反対" })).toBeInTheDocument();
    expect(within(rows[0]).getByRole("link", { name: "青木 一彦" })).toHaveAttribute("href", "/members/m_010001");
  });
  it("名寄せできなかった議員（memberId が空）はリンクにしない", () => {
    renderPage();
    const section = screen.getByRole("region", { name: "れいわ新選組" });
    expect(within(section).getByText("伊勢崎 賢治")).toBeInTheDocument();
    expect(within(section).queryByRole("link", { name: "伊勢崎 賢治" })).not.toBeInTheDocument();
  });
  it("「投票なし」は欠席と棄権を区別せずそのまま出す", () => {
    renderPage();
    const section = screen.getByRole("region", { name: "れいわ新選組" });
    const row = within(section).getByText("天畠 大輔").closest("li")!;
    expect(within(row).getByRole("img", { name: "投票なし" })).toBeInTheDocument();
    expect(section.textContent).not.toMatch(/欠席|棄権/);
  });
  it("会派が1つも無い採決でも落ちず、空の旨を出す", () => {
    renderPage({ ...rollCall, groups: [], votes: [] });
    expect(screen.getByText("個人別の票はありません。")).toBeInTheDocument();
  });
});

describe("RollCallPage フッター", () => {
  it("取得日時を出す", () => {
    renderPage();
    expect(within(screen.getByRole("contentinfo")).getByText(/2025-04-01/)).toBeInTheDocument();
  });
});

describe("meta()", () => {
  it("title は案件名", () => {
    const tags = routeMeta({ data: { rollCall, meta } } as Parameters<typeof routeMeta>[0]);
    expect(tags).toContainEqual({ title: `${rollCall.title} ・ 政治記録` });
    expect(tags).toContainEqual({ name: "description", content: expect.stringContaining("2026.07.24") });
  });
  it("data が無ければサイト名だけ", () => {
    expect(routeMeta({ data: undefined } as Parameters<typeof routeMeta>[0])).toEqual([{ title: "政治記録" }]);
  });
});
