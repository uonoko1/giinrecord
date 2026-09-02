import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MemberDetail } from "../lib/data-contract";
import sangiin from "../test-fixtures/member.json";
import shugiin from "../test-fixtures/member-shugiin.json";
import shugiinSpeeches from "../test-fixtures/member-shugiin-speeches.json";
import meta from "../test-fixtures/meta";
import { MemberPage, meta as routeMeta } from "./member";

const detail = shugiin as MemberDetail;
/** 発言は #242 で members/{id}/speeches.json に移った。件数はビルド時に数えて渡す */
const speechCount = shugiinSpeeches.speeches.length;
const renderPage = () => render(<MemberPage detail={detail} meta={meta} speechCount={speechCount} />);

describe("衆院議員ページ 表紙（#73）", () => {
  it("件数帯は 提出法案 / 賛同法案 / 質問主意書 / 発言 で、記名採決の枠を出さない（#242 で委員会も入るので「本会議発言」とは言わない）", () => {
    renderPage();
    const counts = screen.getByRole("heading", { level: 1 }).closest("header")!;
    const terms = within(counts).getAllByRole("term").map((t) => t.textContent);
    expect(terms).toEqual(["提出法案", "賛同法案", "質問主意書", "発言"]);
    expect(within(counts).queryByText("記名採決")).not.toBeInTheDocument();
    const defs = within(counts).getAllByRole("definition").map((d) => d.textContent);
    expect(defs).toEqual(["1", "1", "1", "1"]);
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
  it("タブは 本人の記録（すべて / 提出法案 / 質問主意書 / 発言 / 委員会の役職）と 所属会派の記録（会派の態度）に分かれ、採決タブは無い（#238 / #244）", () => {
    renderPage();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "すべて5件",   // 発言は timeline に無い（#242）
      "提出法案2件",
      "質問主意書1件",
      "発言1件",
      "委員会の役職0件",
      "会派の態度2件",
    ]);
    expect(screen.queryByRole("tab", { name: /^採決/ })).not.toBeInTheDocument();
  });
  it("衆院の question 行は経過状況の原文（答弁受理）を出し、出典は衆院 経過ページ", () => {
    renderPage();
    const row = screen.getByText(/在日米軍基地従業員の給与支払日/).closest("li")!;
    expect(within(row).getByLabelText("質問")).toHaveAttribute("data-tone", "act");
    expect(within(row).getByText(/答弁受理/)).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "質問主意書" })).toHaveAttribute("href", expect.stringMatching(/itdb_shitsumon\.nsf/));
  });
  it("会派の態度タブは stance 行だけを出し、注記を添える", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: /^会派の態度/ }));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getAllByRole("listitem")).toHaveLength(2);
    expect(within(panel).getByText(/会派の態度であり、本人の投票ではありません/)).toBeInTheDocument();
  });
  it("会派の態度タブは 20 件で折りたたみ、「さらに表示」で残りを出す（#88）", async () => {
    const base = detail.timeline.find((e): e is Extract<typeof e, { kind: "stance" }> => e.kind === "stance")!;
    const many: MemberDetail = {
      ...detail,
      timeline: Array.from({ length: 25 }, (_, i) => ({ ...base, billId: `221-閣法-${i + 1}`, title: `法案 ${i + 1}`, date: `2026-01-${String(25 - i).padStart(2, "0")}` })),
    };
    render(<MemberPage detail={many} meta={meta} />);
    await userEvent.click(screen.getByRole("tab", { name: /^会派の態度/ }));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getAllByRole("listitem")).toHaveLength(20);
    const more = within(panel).getByRole("button", { name: "さらに表示（残り5件）" });
    await userEvent.click(more);
    expect(within(panel).getAllByRole("listitem")).toHaveLength(25);
    expect(within(panel).queryByRole("button", { name: /さらに表示/ })).not.toBeInTheDocument();
  });
  it("会派の態度が 20 件以下なら「さらに表示」は出ない", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: /^会派の態度/ }));
    expect(screen.queryByRole("button", { name: /さらに表示/ })).not.toBeInTheDocument();
  });
  it("提出法案タブは 提出者・賛成者 の行を出す", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: /^提出法案/ }));
    expect(screen.getByLabelText("提出")).toBeInTheDocument();
    expect(screen.getByLabelText("賛同")).toBeInTheDocument();
  });
});

describe("衆院議員ページ meta", () => {
  it("title は「{氏名}（衆議院・{選挙区}）の記録」（投票記録は無いので「投票」と言わない）", () => {
    const tags = routeMeta({ data: { detail, meta }, location: { pathname: "/members/h_000321" } } as never);
    expect(tags.find((t) => "title" in t)).toEqual({ title: "山田 太郎（衆議院・東京1区）の記録 ・ 議員レコード" });
  });
});
