import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MemberDetail } from "../lib/data-contract";
import sangiin from "../test-fixtures/member.json";
import shugiin from "../test-fixtures/member-shugiin.json";
import meta from "../test-fixtures/meta.json";
import { MemberPage, meta as routeMeta } from "./member";

const detail = shugiin as MemberDetail;
const renderPage = () => render(<MemberPage detail={detail} meta={meta} />);

describe("衆院議員ページ 表紙（#73）", () => {
  it("件数帯は 提出法案 / 賛同法案 / 本会議発言 で、記名採決の枠を出さない", () => {
    renderPage();
    const counts = screen.getByRole("heading", { level: 1 }).closest("header")!;
    const terms = within(counts).getAllByRole("term").map((t) => t.textContent);
    expect(terms).toEqual(["提出法案", "賛同法案", "本会議発言"]);
    expect(within(counts).queryByText("記名採決")).not.toBeInTheDocument();
    const defs = within(counts).getAllByRole("definition").map((d) => d.textContent);
    expect(defs).toEqual(["1", "1", "1"]);
  });
  it("所属は 衆議院 ・ 選挙区 ・ 会派", () => {
    renderPage();
    expect(screen.getByText(/衆議院 ・ 東京1区 ・ 日本共産党/)).toBeInTheDocument();
  });
  it("ページ冒頭に「衆議院は個人の投票記録が公開されていません。」と /about へのリンクを出す", () => {
    renderPage();
    const note = screen.getByText(/衆議院は個人の投票記録が公開されていません。/);
    expect(within(note.closest("p")!).getByRole("link")).toHaveAttribute("href", expect.stringMatching(/^\/about/));
  });
  it("参院ページには冒頭の注記も賛同法案の枠も出ない（回帰なし）", () => {
    render(<MemberPage detail={sangiin as MemberDetail} meta={meta} />);
    expect(screen.queryByText(/衆議院は個人の投票記録が公開されていません/)).not.toBeInTheDocument();
    expect(screen.getByText("記名採決")).toBeInTheDocument();
    expect(screen.queryByText("賛同法案")).not.toBeInTheDocument();
  });
});

describe("衆院議員ページ 会派の態度（推定）", () => {
  it("stance 行は専用の判（est）で、「会派の態度（推定）」ラベルと会派名・態度の原文を出す", () => {
    renderPage();
    const row = screen.getByText("所得税法等の一部を改正する法律案").closest("li")!;
    const stamp = within(row).getByRole("img");
    expect(stamp).toHaveAttribute("data-tone", "est");
    expect(stamp).toHaveAttribute("data-estimated", "true");
    expect(stamp).toHaveAccessibleName("会派の態度（推定）: 反対");
    expect(within(row).getByText("会派の態度（推定）")).toBeInTheDocument();
    expect(within(row).getByText(/日本共産党/)).toBeInTheDocument();
    expect(within(row).getByText(/多数/)).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "議案情報" })).toHaveAttribute("href", expect.stringMatching(/shugiin\.go\.jp.*keika/));
  });
  it("賛成の会派態度も同じ est の判（色で賛否を示さない）", () => {
    renderPage();
    const row = screen.getByText("地方税法の一部を改正する法律案").closest("li")!;
    expect(within(row).getByRole("img")).toHaveAttribute("data-tone", "est");
    expect(within(row).getByText(/全会一致/)).toBeInTheDocument();
  });
  it("個人の「賛成」「反対」の判（yes/no）は衆院ページに出ない", () => {
    renderPage();
    expect(document.querySelectorAll('[data-tone="yes"], [data-tone="no"]')).toHaveLength(0);
  });
  it("タブは すべて / 提出法案 / 会派の態度 / 発言（採決タブは無い）", () => {
    renderPage();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["すべて", "提出法案", "会派の態度", "発言"]);
  });
  it("会派の態度タブは stance 行だけを出し、注記を添える", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "会派の態度" }));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getAllByRole("listitem")).toHaveLength(2);
    expect(within(panel).getByText(/会派の態度であり、本人の投票ではありません/)).toBeInTheDocument();
  });
  it("提出法案タブは 提出者・賛成者 の行を出す", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "提出法案" }));
    expect(screen.getByLabelText("提出")).toBeInTheDocument();
    expect(screen.getByLabelText("賛同")).toBeInTheDocument();
  });
});

describe("衆院議員ページ meta", () => {
  it("title は「{氏名}（衆議院・{選挙区}）の記録」（投票記録は無いので「投票」と言わない）", () => {
    const tags = routeMeta({ data: { detail, meta }, location: { pathname: "/members/h_000321" } } as never);
    expect(tags.find((t) => "title" in t)).toEqual({ title: "山田 太郎（衆議院・東京1区）の記録 ・ 政治記録" });
  });
});
