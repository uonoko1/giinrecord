import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Assembly, LocalRollCallSummary } from "../lib/data-contract";
import index from "../test-fixtures/assemblies/data/assemblies/pref-31/rollcalls/index.json";
import { LocalRollCallsPage, meta as routeMeta } from "./local-rollcalls";

const assembly: Assembly = { id: "pref-31", kind: "prefectural", name: "鳥取県議会", prefCode: "31", sourceUrl: "https://www.pref.tottori.lg.jp/gikai/" };
const rollCalls = index as unknown as LocalRollCallSummary[];

function renderPage(list: LocalRollCallSummary[] = rollCalls) {
  return render(
    <MemoryRouter>
      <LocalRollCallsPage assembly={assembly} rollCalls={list} />
    </MemoryRouter>,
  );
}

describe("LocalRollCallsPage", () => {
  it("議会名と件数を出す", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("鳥取県議会");
    expect(screen.getByTestId("local-rollcalls-total")).toHaveTextContent("3 件");
  });

  /**
   * #757: **「0 件」と「1 件も読めていない」を同じ出力にしない。**
   * 母数（件数）を消すと落ちる。
   */
  it("1 件も無いときは 0 件とは書かず、取得していない事実を書く", () => {
    renderPage([]);
    expect(screen.getByTestId("local-rollcalls-total")).toHaveTextContent("表決の記録は取得していません");
    expect(screen.getByTestId("local-rollcalls-total").textContent).not.toMatch(/0 件/);
  });

  it("1 行ごとに議決日・議案名・議案番号・議決結果と、採決 1 件のページへのリンクを出す", () => {
    renderPage();
    const rows = screen.getAllByRole("row").slice(1); // thead を除く
    expect(rows).toHaveLength(3);
    const first = rows[0];
    expect(within(first).getByRole("link", { name: /損害賠償に係る和解/ })).toHaveAttribute("href", "/assemblies/pref-31/rollcalls/pref-31-2026-06-20260629-知事提案-第10号");
    expect(first).toHaveTextContent("2026.06.29");
    expect(first).toHaveTextContent("第10号");
    expect(first).toHaveTextContent("可決");
  });

  /**
   * **絶対原則**（#791 の検査 1）。一次資料へのリンクが無い行は出せない。
   * 全行が外部の表決結果へのリンクを持つことを、行ごとに確かめる。
   */
  it("全行が一次資料（表決結果）への外部リンクを持つ", () => {
    renderPage();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const link = within(row).getByRole("link", { name: "表決結果（公式）" });
      expect(link.getAttribute("href")).toMatch(/^https:\/\/www\.pref\.tottori\.lg\.jp\//);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link.getAttribute("rel")).toMatch(/noopener/);
    }
  });

  /** 一次資料の無い行は**落とさずに**「出典がありません」と書く、ではなく——出さない（絶対原則）。 */
  it("sourceUrl の無い行は表に出さず、出さなかった件数を書く", () => {
    const broken = [{ ...rollCalls[0], id: "broken", sourceUrl: "" }, ...rollCalls];
    renderPage(broken as LocalRollCallSummary[]);
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(3);
    expect(screen.getByTestId("local-rollcalls-omitted")).toHaveTextContent("1 件");
  });

  it("評価・順位・賛成率を出さない", () => {
    renderPage();
    expect(document.body.textContent).not.toMatch(/％|%|賛成率|ランキング|順位|おすすめ/);
  });

  it("議会ページへ戻れる", () => {
    renderPage();
    expect(screen.getByRole("link", { name: /鳥取県議会のページ/ })).toHaveAttribute("href", "/assemblies/pref-31");
  });
});

describe("LocalRollCallsPage meta", () => {
  it("title に議会名、description は事実だけ", () => {
    const tags = routeMeta({ data: { assembly, rollCalls }, location: { pathname: "/assemblies/pref-31/rollcalls" } } as never);
    const title = tags.find((t) => "title" in t) as { title: string };
    expect(title.title).toContain("鳥取県議会");
    const desc = tags.find((t) => (t as { name?: string }).name === "description") as { content: string };
    expect(desc.content).not.toMatch(/評価|おすすめ|ランキング|率/);
  });
});
