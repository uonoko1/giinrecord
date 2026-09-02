import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AttendanceEntry, MemberDetail } from "../lib/data-contract";
import member from "../test-fixtures/member.json";
import meta from "../test-fixtures/meta";
import { MemberPage } from "./member";

/** 委員会に発議者として出席した記録（#109）。出席した発議者は発議者全員ではないので、提出法案（bill 行）とは別の kind。 */
const attendance: AttendanceEntry = {
  kind: "attendance",
  estimated: false,
  date: "2026-07-09",
  meetingId: "122115007X01420260709_000",
  meeting: "農林水産委員会 第14号",
  role: "発議者",
  bills: [{ billId: "221-参法-11", title: "主要農作物の優良な品種を確保するための公的新品種育成の促進等に関する法律案" }],
  sourceUrl: "https://kokkai.ndl.go.jp/txt/122115007X01420260709/0",
};

const detail: MemberDetail = { ...(member as MemberDetail), timeline: [attendance, ...(member as MemberDetail).timeline] };

function renderPage() {
  return render(<MemberPage detail={detail} meta={meta} />);
}

describe("MemberPage 委員会出席の行（attendance、#109）", () => {
  it("「出席」の判（act 色）で「委員会に発議者として出席」と明記し、会議名・その日の参法・出典（会議録）を出す", () => {
    renderPage();
    const row = screen.getByText(/委員会に発議者として出席/).closest("li")!;
    expect(within(row).getByLabelText("出席")).toHaveAttribute("data-tone", "act");
    expect(within(row).getByText(/農林水産委員会 第14号/)).toBeInTheDocument();
    expect(within(row).getByText(/主要農作物の優良な品種を確保するための公的新品種育成の促進等に関する法律案/)).toBeInTheDocument();
    const link = within(row).getByRole("link", { name: "会議録" });
    expect(link).toHaveAttribute("href", "https://kokkai.ndl.go.jp/txt/122115007X01420260709/0");
    expect(link.getAttribute("rel")).toMatch(/noopener/);
  });
  it("提出法案（bill 行）とは別物: 「提出」の判にならず、表紙の提出法案の数にも入らない", () => {
    renderPage();
    const row = screen.getByText(/委員会に発議者として出席/).closest("li")!;
    expect(within(row).queryByLabelText("提出")).not.toBeInTheDocument();
    expect(within(row).queryByText(/提出者/)).not.toBeInTheDocument();
    const dt = within(screen.getByRole("banner")).getByText("提出法案");
    expect(dt.nextElementSibling).toHaveTextContent("2");
  });
  it("推定の判（est）や「推定」の文言は付かない（事実の行）", () => {
    renderPage();
    const row = screen.getByText(/委員会に発議者として出席/).closest("li")!;
    expect(row).not.toHaveAttribute("data-estimated");
    expect(within(row).queryByText(/推定/)).not.toBeInTheDocument();
  });
});
