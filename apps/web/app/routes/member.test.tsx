import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MemberDetail } from "../lib/data-contract";
import member from "../test-fixtures/member.json";
import meta from "../test-fixtures/meta.json";
import { MemberPage, meta as routeMeta } from "./member";

const detail = member as MemberDetail;

function renderPage() {
  return render(<MemberPage detail={detail} meta={meta} />);
}

describe("MemberPage 表紙", () => {
  it("氏名・ふりがな・所属を出す", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("藤川 政人");
    expect(screen.getByText("ふじかわ まさひと")).toBeInTheDocument();
    expect(screen.getByText(/参議院 ・ 愛知 ・ 自由民主党・無所属の会/)).toBeInTheDocument();
  });
});

describe("MemberPage 時系列", () => {
  it("kind ごとに判（Stamp）が出る", () => {
    renderPage();
    expect(screen.getByLabelText("反対")).toBeInTheDocument();
    expect(screen.getByLabelText("投票なし")).toBeInTheDocument();
    expect(screen.getByLabelText("提出")).toBeInTheDocument();
    expect(screen.getByLabelText("発言")).toBeInTheDocument();
  });
  it("会派と本人が異なる行は「会派は{値}」と明記する", () => {
    renderPage();
    const row = screen.getByText("所得税法等の一部を改正する法律案").closest("li")!;
    expect(within(row).getByText(/会派は賛成/)).toBeInTheDocument();
  });
  it("「投票なし」の行に「理由は記録されない」を出す", () => {
    renderPage();
    const row = screen.getByText("関税定率法等の一部を改正する法律案").closest("li")!;
    expect(within(row).getByText(/理由は記録されない/)).toBeInTheDocument();
  });
  it("同じ日付の行は1つの日付見出しにまとまる", () => {
    renderPage();
    expect(screen.getAllByText("2025.03.14")).toHaveLength(1);
  });
  it("全行に sourceUrl へのリンク（新規タブ・noopener）がある", () => {
    renderPage();
    const links = screen.getAllByRole("link", { name: /参院投票結果|議案情報|会議録/ });
    expect(links).toHaveLength(4);
    for (const a of links) {
      expect(a).toHaveAttribute("target", "_blank");
      expect(a.getAttribute("rel")).toMatch(/noopener/);
      expect(a.getAttribute("href")).toMatch(/^https:\/\/(www\.sangiin\.go\.jp|www\.shugiin\.go\.jp|kokkai\.ndl\.go\.jp)\//);
    }
  });
});

describe("MemberPage 採決タブ", () => {
  it("本人／会派／結果の表になる", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "採決" }));
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "日付",
      "案件",
      "本人",
      "会派",
      "結果",
      "出典",
    ]);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(screen.queryByLabelText("発言")).not.toBeInTheDocument();
  });
});

describe("MemberPage フッター", () => {
  it("出典3つと取得日時を出す", () => {
    renderPage();
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByRole("link", { name: "参議院" })).toHaveAttribute("href", "https://www.sangiin.go.jp/");
    expect(within(footer).getByRole("link", { name: "衆議院" })).toBeInTheDocument();
    expect(within(footer).getByRole("link", { name: /国立国会図書館/ })).toBeInTheDocument();
    expect(within(footer).getByText(/2025\.04\.01/)).toBeInTheDocument();
  });
});

describe("meta()", () => {
  it("title は「{氏名} ・ 政治記録」、description に所属", () => {
    const tags = routeMeta({ data: { detail, meta } } as Parameters<typeof routeMeta>[0]);
    expect(tags).toContainEqual({ title: "藤川 政人 ・ 政治記録" });
    expect(tags).toContainEqual({
      name: "description",
      content: expect.stringContaining("自由民主党・無所属の会"),
    });
  });
});
