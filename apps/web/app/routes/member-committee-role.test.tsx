import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CommitteeRoleEntry, MemberDetail } from "../lib/data-contract";
import member from "../test-fixtures/member.json";
import meta from "../test-fixtures/meta.json";
import { MemberPage } from "./member";

/**
 * 委員会の役職（#244）。会議録の出席委員欄の委員長・理事・委員。
 * **在任期間ではなく出席の事実**なので、画面に範囲を意味する表記（「〜」「期間」）を出さないことを固定する（PO の判断）。
 */
const chair: CommitteeRoleEntry = {
  kind: "committeeRole",
  session: 221,
  estimated: false,
  date: "2026-02-10",
  committee: "内閣委員会",
  role: "委員長",
  meetings: 12,
  firstDate: "2026-02-10",
  lastDate: "2026-06-18",
  meetingId: "121714889X02520250620_000",
  sourceUrl: "https://kokkai.ndl.go.jp/txt/121714889X02520250620/0",
};

const once: CommitteeRoleEntry = {
  ...chair,
  committee: "憲法審査会",
  role: "委員",
  meetings: 1,
  date: "2026-06-04",
  firstDate: "2026-06-04",
  lastDate: "2026-06-04",
  meetingId: "121714183X00520250604_000",
  sourceUrl: "https://kokkai.ndl.go.jp/txt/121714183X00520250604/0",
};

const detail: MemberDetail = { ...(member as MemberDetail), timeline: [chair, once, ...(member as MemberDetail).timeline] };

function renderPage() {
  return render(<MemberPage detail={detail} meta={meta} />);
}

const rowOf = (text: RegExp) => screen.getByText(text).closest("li")!;

describe("MemberPage 委員会の役職の行（committeeRole、#244）", () => {
  it("委員会名と役職の原文を「◯◯委員会 委員長として出席」と出し、出典（会議録）に繋ぐ", () => {
    renderPage();
    const row = rowOf(/内閣委員会 委員長として出席/);
    expect(within(row).getByLabelText("出席")).toHaveAttribute("data-tone", "act");
    const link = within(row).getByRole("link", { name: "会議録" });
    expect(link).toHaveAttribute("href", "https://kokkai.ndl.go.jp/txt/121714889X02520250620/0");
    expect(link.getAttribute("rel")).toMatch(/noopener/);
  });

  it("出席の回数と、最初／最新の**出席日**であることが表記自体から分かる（在任期間と読ませない）", () => {
    renderPage();
    const row = rowOf(/内閣委員会 委員長として出席/);
    expect(within(row).getByText(/出席 12 回/)).toBeInTheDocument();
    expect(within(row).getByText(/最初の出席 2026-02-10/)).toBeInTheDocument();
    expect(within(row).getByText(/最新の出席 2026-06-18/)).toBeInTheDocument();
  });

  it("範囲を意味する表記を出さない（「〜」「期間」「就任」「在任」「から」）", () => {
    renderPage();
    const row = rowOf(/内閣委員会 委員長として出席/);
    const text = row.textContent ?? "";
    for (const forbidden of ["〜", "～", "期間", "就任", "在任", "退任"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("1 回だけの出席は最初／最新を重ねて出さない（出席 1 回とその日だけ）", () => {
    renderPage();
    const row = rowOf(/憲法審査会 委員として出席/);
    expect(within(row).getByText(/出席 1 回/)).toBeInTheDocument();
    expect(within(row).queryByText(/最新の出席/)).not.toBeInTheDocument();
    expect(within(row).getByText(/出席 2026-06-04/)).toBeInTheDocument();
  });

  it("推定の判（est）や「推定」の文言は付かない（事実の行）", () => {
    renderPage();
    const row = rowOf(/内閣委員会 委員長として出席/);
    expect(row).not.toHaveAttribute("data-estimated");
    expect(within(row).queryByText(/推定/)).not.toBeInTheDocument();
  });

  it("表紙の件数（採決・提出法案・質問主意書・発言）には数えない", () => {
    renderPage();
    const banner = within(screen.getByRole("banner"));
    expect(banner.getByText("提出法案").nextElementSibling).toHaveTextContent("2");
    expect(banner.queryByText("委員会")).not.toBeInTheDocument();
  });

  it("「委員会の役職」タブは本人の記録のカテゴリに入る（会派の記録ではない）", async () => {
    const { TABS } = await import("./member");
    for (const house of ["sangiin", "shugiin"] as const) {
      const tab = TABS[house].find((t) => t.id === "committeeRole");
      expect(tab).toMatchObject({ label: "委員会の役職", category: "self", kind: "committeeRole" });
    }
  });

  it("「委員会の役職」タブで絞り込める", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    renderPage();
    const tab = screen.getByRole("tab", { name: /委員会の役職/ });
    await userEvent.click(tab);
    expect(screen.getByText(/内閣委員会 委員長として出席/)).toBeInTheDocument();
    expect(screen.getByText(/憲法審査会 委員として出席/)).toBeInTheDocument();
    expect(screen.queryByLabelText("賛成")).not.toBeInTheDocument();
  });

  it("タブに「在任期間ではなく出席の事実」であることの注記を出す", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: /委員会の役職/ }));
    expect(screen.getByText(/会議録の出席委員欄に載った役職です。在任期間ではありません/)).toBeInTheDocument();
  });
});
