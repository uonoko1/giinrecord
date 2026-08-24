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
    expect(screen.getAllByLabelText("発言")).toHaveLength(3);
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
    const links = within(screen.getByRole("tabpanel")).getAllByRole("link", { name: /参院投票結果|議案情報|会議録/ });
    expect(links).toHaveLength(7);
    for (const a of links) {
      expect(a).toHaveAttribute("target", "_blank");
      expect(a.getAttribute("rel")).toMatch(/noopener/);
      expect(a.getAttribute("href")).toMatch(/^https:\/\/(www\.sangiin\.go\.jp|www\.shugiin\.go\.jp|kokkai\.ndl\.go\.jp)\//);
    }
  });
});

describe("MemberPage 発言行の役職", () => {
  it("役職付きの発言は役職を原文のまま表示する", () => {
    renderPage();
    const row = screen.getByText(/道路法等の一部を改正する法律案/).closest("li")!;
    expect(within(row).getByText("国土交通大臣")).toBeInTheDocument();
    expect(row).toHaveAttribute("data-position", "国土交通大臣");
  });
  it("議長の議事進行発言は「議長」と明記して区別する", () => {
    renderPage();
    const row = screen.getByText(/ただいまから会議を開きます/).closest("li")!;
    expect(within(row).getByText("議長")).toBeInTheDocument();
    expect(row).toHaveAttribute("data-position", "議長");
  });
  it("役職の無い発言には役職ラベルを出さない", () => {
    renderPage();
    const row = screen.getByText(/予算委員会における審査の経過と結果/).closest("li")!;
    expect(row).not.toHaveAttribute("data-position");
    expect(within(row).queryByText(/議長|大臣/)).not.toBeInTheDocument();
  });
  it("表紙の本会議発言の数は役職付きも含める", () => {
    renderPage();
    const dt = screen.getByText("本会議発言");
    expect(dt.nextElementSibling).toHaveTextContent("3");
  });
});

describe("MemberPage 提出法案の行", () => {
  it("提出者の行は「提出」の判、発議者欄の原文（外N名）と審議状況を出す", () => {
    renderPage();
    const row = screen.getByText(/国会議員の歳費、旅費及び手当等/).closest("li")!;
    expect(within(row).getByLabelText("提出")).toBeInTheDocument();
    expect(within(row).getByText(/提出者/)).toBeInTheDocument();
    expect(within(row).getByText(/藤川政人君 外3名/)).toBeInTheDocument();
    expect(within(row).getByText(/審査未了/)).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "議案情報" })).toHaveAttribute("href", expect.stringMatching(/kousei\/gian\/217\/meisai\//));
  });
  it("賛成者の行は「賛同」の判（提出とは別の文言、同じ act 色）", () => {
    renderPage();
    const row = screen.getByText(/国民の祝日に関する法律/).closest("li")!;
    const stamp = within(row).getByLabelText("賛同");
    expect(stamp).toHaveAttribute("data-tone", "act");
    expect(within(row).getByText(/賛成者/)).toBeInTheDocument();
  });
  it("表紙の提出法案の数は提出者・賛成者の両方を含む", () => {
    renderPage();
    const dt = within(screen.getByRole("banner")).getByText("提出法案");
    expect(dt.nextElementSibling).toHaveTextContent("2");
  });
});

describe("MemberPage 提出法案タブ", () => {
  it("日付／件名／立場／審議状況／出典の表になる", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "提出法案" }));
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["日付", "件名", "立場", "審議状況", "出典"]);
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByLabelText("提出")).toBeInTheDocument();
    expect(within(rows[1]).getByText(/藤川政人君 外3名/)).toBeInTheDocument();
    expect(within(rows[1]).getByText("審査未了")).toBeInTheDocument();
    expect(within(rows[2]).getByLabelText("賛同")).toBeInTheDocument();
    expect(within(rows[2]).getByText("—")).toBeInTheDocument();
    expect(screen.queryByLabelText("発言")).not.toBeInTheDocument();
  });
});

describe("MemberPage 質問主意書（#106）", () => {
  it("question 行は「質問」の判（act 色）、提出者の原文・答弁書受領日を出し、出典（詳細ページ）と答弁本文へのリンクがある", () => {
    renderPage();
    const row = screen.getByText(/高額療養費制度の見直しに関する質問主意書/).closest("li")!;
    const stamp = within(row).getByLabelText("質問");
    expect(stamp).toHaveAttribute("data-tone", "act");
    expect(within(row).getByText(/藤川 政人君/)).toBeInTheDocument();
    expect(within(row).getByText(/答弁書受領 2025\.04\.08/)).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "質問主意書" })).toHaveAttribute("href", expect.stringMatching(/kousei\/syuisyo\/217\/meisai\//));
    expect(within(row).getByRole("link", { name: "答弁本文" })).toHaveAttribute("href", expect.stringMatching(/syuisyo\/217\/touh\//));
  });
  it("表紙の件数帯に「質問主意書」の数を出す", () => {
    renderPage();
    const dt = within(screen.getByRole("banner")).getByText("質問主意書");
    expect(dt.nextElementSibling).toHaveTextContent("1");
  });
  it("「質問主意書」タブは 日付／件名／答弁書／出典 の表になる", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "質問主意書" }));
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["日付", "件名", "答弁書", "出典"]);
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(2);
    expect(within(rows[1]).getByText(/高額療養費制度/)).toBeInTheDocument();
    expect(within(rows[1]).getByRole("link", { name: "答弁本文" })).toHaveAttribute("href", expect.stringMatching(/touh/));
    expect(within(rows[1]).getByRole("link", { name: "質問主意書" })).toHaveAttribute("href", expect.stringMatching(/meisai/));
    expect(screen.queryByLabelText("発言")).not.toBeInTheDocument();
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
    const footer = screen.getByText(/^出典/).closest("footer") as HTMLElement;
    expect(within(footer).getByRole("link", { name: "参議院" })).toHaveAttribute("href", "https://www.sangiin.go.jp/");
    expect(within(footer).getByRole("link", { name: "衆議院" })).toBeInTheDocument();
    expect(within(footer).getByRole("link", { name: /国立国会図書館/ })).toBeInTheDocument();
    expect(within(footer).getByText(/2025\.04\.01/)).toBeInTheDocument();
  });
});

describe("meta()", () => {
  const args = { data: { detail, meta }, location: { pathname: "/members/m_1" } } as unknown as Parameters<typeof routeMeta>[0];
  it("title は「{氏名}（{院}・{選挙区}）の投票記録 ・ 議員レコード」（検索語を含み、評価語なし）", () => {
    const tags = routeMeta(args);
    expect(tags).toContainEqual({ title: "藤川 政人（参議院・愛知）の投票記録 ・ 議員レコード" });
    expect(tags).toContainEqual({
      name: "description",
      content: expect.stringContaining("自由民主党・無所属の会"),
    });
  });
  it("canonical と OGP（article）を持つ", () => {
    const tags = routeMeta(args);
    expect(tags).toContainEqual({ tagName: "link", rel: "canonical", href: "/members/m_1" });
    expect(tags).toContainEqual({ property: "og:type", content: "article" });
    expect(tags).toContainEqual({ property: "og:url", content: "/members/m_1" });
  });
  it("data が無ければサイト名だけ", () => {
    expect(routeMeta({ data: undefined, location: { pathname: "/members/x" } } as unknown as Parameters<typeof routeMeta>[0])).toEqual([
      { title: "議員レコード" },
    ]);
  });
});

describe("MemberPage 比較に追加（#104）", () => {
  it("表紙に「比較に追加」ボタンがある", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "比較に追加" })).toBeInTheDocument();
  });
});
