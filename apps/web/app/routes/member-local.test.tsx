import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Assembly } from "@seiji-kiroku/shared";
import type { MemberDetail } from "../lib/data-contract";
import assembliesFixture from "../test-fixtures/assemblies/index.json";
import localMember from "../test-fixtures/assemblies/member-local.json";
import meta from "../test-fixtures/meta.json";
import { MemberPage, meta as routeMeta, pageTitle } from "./member";

const detail = localMember as MemberDetail;
const miyagi = (assembliesFixture as Assembly[])[2]!;
const EVALUATIVE_WORDS = ["おすすめ", "ランキング", "一致率", "造反", "裏切"];

function renderPage(assembly: Assembly | null = miyagi) {
  return render(<MemberPage detail={detail} meta={meta} assembly={assembly} />);
}

describe("地方議員の議員ページ（#158）: 表紙と注記", () => {
  it("氏名・ふりがな・所属（議会名 ・ 選挙区 ・ 会派）と表決の件数", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("宮城 太郎");
    expect(screen.getByText("みやぎ たろう")).toBeInTheDocument();
    expect(screen.getByText("宮城県議会 ・ 仙台市青葉区 ・ 自由民主党・県民会議")).toBeInTheDocument();
    expect(screen.getByText("表決", { selector: "dt" }).nextElementSibling).toHaveTextContent("4");
  });

  it("冒頭に議会名と出典（議会の公式ページ・議会ページへのリンク）を1文で示し、評価語を含まない", () => {
    const { container } = renderPage();
    const notice = screen.getByText(/宮城県議会の記録です/);
    expect(notice).toHaveTextContent("凡例");
    expect(within(notice).getByRole("link", { name: /宮城県議会（公式）/ })).toHaveAttribute("href", miyagi.sourceUrl);
    expect(within(notice).getByRole("link", { name: /議会ページ/ })).toHaveAttribute("href", "/assemblies/pref-04");
    for (const word of EVALUATIVE_WORDS) expect(container.textContent).not.toContain(word);
  });

  it("assemblies/index.json に議会が無くても落ちず、assemblyId を議会名の代わりに出す", () => {
    renderPage(null);
    expect(screen.getByText(/pref-04 ・ 仙台市青葉区/)).toBeInTheDocument();
  });

  it("タブは「すべて」と「表決」だけ（国会の採決・提出法案・質問主意書は出さない）", () => {
    renderPage();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["すべて", "表決"]);
  });
});

describe("地方議員の議員ページ: 表決の行は凡例付きの原文", () => {
  it("判の文字は原文（○×棄欠）、読み上げは「原文（凡例）」。凡例を必ず添える", () => {
    renderPage();
    expect(screen.getByLabelText("○（賛成）")).toHaveTextContent("○");
    expect(screen.getByLabelText("×（反対）")).toHaveTextContent("×");
    expect(screen.getByLabelText("棄（棄権）")).toHaveTextContent("棄");
    expect(screen.getByLabelText("欠（欠席）")).toHaveTextContent("欠");
    const row = screen.getByText(/手数料条例/).closest("li")!;
    expect(within(row).getByText(/凡例 棄＝棄権/)).toBeInTheDocument();
  });

  it("色は mapped がある値だけ（○→yes、×→no、欠→none）。mapped の無い 棄 は中立（raw）", () => {
    renderPage();
    expect(screen.getByLabelText("○（賛成）")).toHaveAttribute("data-tone", "yes");
    expect(screen.getByLabelText("×（反対）")).toHaveAttribute("data-tone", "no");
    expect(screen.getByLabelText("欠（欠席）")).toHaveAttribute("data-tone", "none");
    expect(screen.getByLabelText("棄（棄権）")).toHaveAttribute("data-tone", "raw");
  });

  it("会期・表決方法・議決結果の原文と、表決結果（公式）へのリンク（新規タブ・noopener）", () => {
    renderPage();
    const row = screen.getByText(/一般会計予算/).closest("li")!;
    expect(row).toHaveTextContent("第399回（令和8年2月定例会）");
    expect(row).toHaveTextContent("起立");
    expect(row).toHaveTextContent("可決");
    const a = within(row).getByRole("link", { name: /表決結果/ });
    expect(a).toHaveAttribute("href", "https://www.pref.miyagi.jp/documents/63622/syuusei_hyouketsu080318.pdf");
    expect(a).toHaveAttribute("target", "_blank");
    expect(a.getAttribute("rel")).toMatch(/noopener/);
  });

  it("「投票なし」に丸めた文言を出さない（欠席と棄権の区別を消さない）", () => {
    const { container } = renderPage();
    expect(container.textContent).not.toContain("投票なし");
    expect(container.textContent).not.toContain("理由は記録されない");
  });

  it("表決タブは表で、日付・案件・表決（原文＋凡例）・方法・結果・出典", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("tab", { name: "表決" }));
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["日付", "案件", "表決", "方法", "結果", "出典"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[3]).toHaveTextContent("2025.12.16");
    expect(rows[3]).toHaveTextContent("欠");
    expect(rows[3]).toHaveTextContent("欠席");
    expect(rows[3]).toHaveTextContent("簡易");
  });
});

describe("地方議員の議員ページ: meta", () => {
  it("pageTitle は「{氏名}（{議会}・{選挙区}）の表決記録」", () => {
    expect(pageTitle(detail, miyagi)).toBe("宮城 太郎（宮城県議会・仙台市青葉区）の表決記録");
  });
  it("description に議会名を含み、評価語を含まない", () => {
    const tags = routeMeta({ data: { detail, meta, assembly: miyagi }, location: { pathname: "/members/p_04_000001" } } as unknown as Parameters<typeof routeMeta>[0]);
    expect(tags).toContainEqual({ title: "宮城 太郎（宮城県議会・仙台市青葉区）の表決記録 ・ 議員レコード" });
    const desc = (tags.find((t) => "name" in t && t.name === "description") as { content: string }).content;
    expect(desc).toContain("宮城県議会");
    expect(desc).toContain("凡例");
  });
});
