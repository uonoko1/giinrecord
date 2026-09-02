/**
 * /compare（Issue #104）。行＝採決・議案、列＝議員。事実（参院の個人票）と推定（衆院の会派態度）は別の表に分ける。
 * 一致率・スコア・色分けは出さない（禁止語検査）。
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { MemberDetail } from "../lib/data-contract";
import adachi from "../test-fixtures/compare/m_014002.json";
import otsubaki from "../test-fixtures/compare/m_023003.json";
import aisawa from "../test-fixtures/compare/h_41f223ac28.json";
import aoki from "../test-fixtures/compare/h_dcf5bd65bf.json";
import meta from "../test-fixtures/meta";
import { ComparePage, memberDataUrl, meta as routeMeta } from "./compare";

const fixtures: Record<string, MemberDetail> = Object.fromEntries(
  [adachi, otsubaki, aisawa, aoki].map((m) => [m.id, m as MemberDetail]),
);

/** HTTP 境界だけを差し替える（/data/members/{id}.json の代わりにフィクスチャを返す）。 */
async function load(id: string): Promise<MemberDetail | null> {
  return fixtures[id] ?? null;
}

function renderPage(ids: string[]) {
  return render(
    <MemoryRouter>
      <ComparePage ids={ids} load={load} meta={meta} />
    </MemoryRouter>,
  );
}

describe("meta", () => {
  it("noindex を出し、タイトルに評価語を含めない", () => {
    const tags = routeMeta();
    expect(tags).toContainEqual({ name: "robots", content: "noindex" });
    expect(JSON.stringify(tags)).not.toMatch(/一致|スコア|ランキング|おすすめ/);
  });
  it("議員 JSON は /data/members/{id}.json から取る（nginx の /data/ 配下）", () => {
    expect(memberDataUrl("m_014002")).toBe("/data/members/m_014002.json");
  });
});

describe("ComparePage 参院2名（事実）", () => {
  it("列見出しに議員名（議員ページへのリンク）、行に採決、セルに判を出す", async () => {
    renderPage(["m_014002", "m_023003"]);
    const table = await screen.findByRole("table", { name: "採決（事実）" });
    expect(within(table).getByRole("link", { name: "阿達 雅志" })).toHaveAttribute("href", "/members/m_014002");
    expect(within(table).getByRole("link", { name: "大椿 ゆうこ" })).toHaveAttribute("href", "/members/m_023003");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByLabelText("賛成")).toBeInTheDocument();
    expect(within(rows[0]!).getByLabelText("反対")).toBeInTheDocument();
    expect(within(rows[1]!).getByLabelText("投票なし")).toBeInTheDocument();
  });
  it("行ごとに日付・結果（得票）と出典リンクがある", async () => {
    renderPage(["m_014002", "m_023003"]);
    const table = await screen.findByRole("table", { name: "採決（事実）" });
    const row = within(table).getAllByRole("row")[1]!;
    expect(within(row).getByText("2025.06.13")).toBeInTheDocument();
    expect(within(row).getByText(/賛成 \d+・反対 \d+/)).toBeInTheDocument();
    const src = within(row).getByRole("link", { name: "参院投票結果" });
    expect(src).toHaveAttribute("href", expect.stringMatching(/^https:\/\/www\.sangiin\.go\.jp\//));
    expect(src).toHaveAttribute("rel", expect.stringMatching(/noopener/));
  });
  it("片方にしか無い採決は行にせず、件数として明記する", async () => {
    renderPage(["m_014002", "m_023003"]);
    await screen.findByRole("table", { name: "採決（事実）" });
    expect(screen.getByText(/阿達 雅志.*他の人に記録のない採決 1 件/)).toBeInTheDocument();
    expect(screen.queryByText(/221-0724-v007/)).not.toBeInTheDocument();
  });
  it("推定の表は出ない", async () => {
    renderPage(["m_014002", "m_023003"]);
    await screen.findByRole("table", { name: "採決（事実）" });
    expect(screen.queryByRole("table", { name: /推定/ })).not.toBeInTheDocument();
  });
});

describe("ComparePage 衆院と混在（推定）", () => {
  it("衆院2名は「会派の態度（推定）」の表になり、会派名と態度を出す", async () => {
    renderPage(["h_41f223ac28", "h_dcf5bd65bf"]);
    const table = await screen.findByRole("table", { name: "会派の態度（推定）" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByLabelText("会派の態度（推定）: 賛成")).toBeInTheDocument();
    expect(within(rows[0]!).getByLabelText("会派の態度（推定）: 反対")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("自由民主党・無所属の会")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("参政党")).toBeInTheDocument();
    expect(screen.getByText(/本人の投票ではありません/)).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "採決（事実）" })).not.toBeInTheDocument();
  });
  it("参院と衆院を混ぜると「事実」「推定」の見出しで表を分け、採決の列では衆院議員が「記録なし」", async () => {
    renderPage(["m_014002", "m_023003", "h_41f223ac28"]);
    const facts = await screen.findByRole("table", { name: "採決（事実）" });
    expect(screen.getByRole("heading", { name: "事実" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "推定" })).toBeInTheDocument();
    const row = within(facts).getAllByRole("row")[1]!;
    expect(within(row).getAllByText("記録なし")).toHaveLength(1);
    // 衆院1名だけでは会派態度の相手がいないので、推定の表は空の説明になる
    expect(screen.getByText(/会派の態度を並べられる議案はありません/)).toBeInTheDocument();
  });
});

describe("ComparePage 異常系", () => {
  it("id が無ければ使い方を示す", async () => {
    renderPage([]);
    expect(await screen.findByText(/議員ページの「比較に追加」/)).toBeInTheDocument();
  });
  it("1名だけなら比べる相手がいない旨を出す", async () => {
    renderPage(["m_014002"]);
    expect(await screen.findByText(/もう1名以上/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "阿達 雅志" })).toBeInTheDocument();
  });
  it("存在しない id は「見つかりません」として列にせず、残りで並べる", async () => {
    renderPage(["m_014002", "zzz", "m_023003"]);
    const table = await screen.findByRole("table", { name: "採決（事実）" });
    expect(within(table).getAllByRole("columnheader")).toHaveLength(4); // 案件・阿達・大椿・出典
    expect(screen.getByText(/zzz.*見つかりません/)).toBeInTheDocument();
  });
  it("取得日時と出典を出す", async () => {
    renderPage(["m_014002", "m_023003"]);
    await screen.findByRole("table", { name: "採決（事実）" });
    expect(screen.getByText(/取得 /)).toBeInTheDocument();
  });
});

describe("禁止語・色分け", () => {
  it("一致率・スコア・ランキング・おすすめ・％を出さない", async () => {
    for (const ids of [
      ["m_014002", "m_023003"],
      ["h_41f223ac28", "h_dcf5bd65bf"],
      ["m_014002", "m_023003", "h_41f223ac28", "h_dcf5bd65bf"],
    ]) {
      const { container, unmount } = renderPage(ids);
      await waitFor(() => expect(container.querySelector("table")).not.toBeNull());
      expect(container.textContent).not.toMatch(/一致率|一致|不一致|スコア|得点|ランキング|順位|おすすめ|推薦|採点|%|％/);
      unmount();
    }
  });
  it("行・セルに賛否で色分けする属性を付けない（判の data-value/data-tone 以外）", async () => {
    const { container } = renderPage(["m_014002", "m_023003", "h_41f223ac28", "h_dcf5bd65bf"]);
    await waitFor(() => expect(container.querySelectorAll("table")).toHaveLength(2));
    for (const el of container.querySelectorAll("tr, td, th")) {
      expect([...el.attributes].map((a) => a.name).filter((n) => n.startsWith("data-"))).toEqual([]);
      expect(el.getAttribute("style")).toBeNull();
    }
  });
});
