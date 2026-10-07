import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CabinetRoleEntry, MemberDetail } from "../lib/data-contract";
import member from "../test-fixtures/member.json";
import meta from "../test-fixtures/meta";
import { MemberPage } from "./member";

/**
 * **大臣・副大臣・大臣政務官の役職**（#1152。取得と名寄せは #1140）。
 *
 * ## 何を固定するか
 *
 * **「いつから」は名簿に書いてある**（内閣の発足日）。**「いつまで」は書かれていない**（#1141）。
 * **だから画面に期間を作らない**——`committeeRole`（#244）と同じ判断で、
 * **範囲を意味する表記（「〜」「期間」「退任」）を 1 つも出さない。**
 * **ただし理由は違う**: `committeeRole` は「出席の事実で在任ではない」から、
 * **こちらは「就任は記録だが、退任は記録されていない」**からである。
 *
 * **役職名は名簿の原文のまま**（「内閣府特命担当大臣（金融）」を「金融担当」に言い換えない）。
 */
const finance: CabinetRoleEntry = {
  kind: "cabinetRole",
  estimated: false,
  date: "2026-09-17",
  section: "閣僚等",
  role: "財務大臣",
  effectiveDateText: "令和８年９月１７日発足",
  cabinet: 105,
  sourceUrl: "https://www.kantei.go.jp/jp/105/meibo/index.html",
};

/** 兼務（名簿では同じ人の 2 行目）。**丸めずに別の行として出る。** */
const fsa: CabinetRoleEntry = { ...finance, role: "内閣府特命担当大臣（金融）" };

/** 副大臣のページは発足日が 1 日違う（名簿の事実。1 つに丸めない）。 */
const vice: CabinetRoleEntry = {
  ...finance,
  date: "2026-09-18",
  section: "副大臣",
  role: "財務副大臣",
  effectiveDateText: "令和８年９月１８日",
  sourceUrl: "https://www.kantei.go.jp/jp/105/meibo/fukudaijin.html",
};

const detail: MemberDetail = { ...(member as MemberDetail), timeline: [vice, fsa, finance, ...(member as MemberDetail).timeline] };

const renderPage = () => render(<MemberPage detail={detail} meta={meta} />);
const rowOf = (text: RegExp) => screen.getByText(text).closest("li")!;
const clickTab = async () => {
  const { default: userEvent } = await import("@testing-library/user-event");
  await userEvent.click(screen.getByRole("tab", { name: /役職$|^役職/ }));
};

describe("MemberPage 大臣等の役職の行（cabinetRole、#1152）", () => {
  it("役職名の原文をそのまま出し、出典（官邸の名簿）に繋ぐ", () => {
    renderPage();
    const row = rowOf(/^財務大臣$/);
    const link = within(row).getByRole("link", { name: "閣僚等名簿" });
    expect(link).toHaveAttribute("href", "https://www.kantei.go.jp/jp/105/meibo/index.html");
    expect(link.getAttribute("rel")).toMatch(/noopener/);
  });

  it("判は「就任」で、記録された値の色（act）になる（推定の est ではない）", () => {
    renderPage();
    const row = rowOf(/^財務大臣$/);
    expect(within(row).getByLabelText("就任")).toHaveAttribute("data-tone", "act");
    expect(row).not.toHaveAttribute("data-estimated");
    expect(within(row).queryByText(/推定/)).not.toBeInTheDocument();
  });

  it("名簿の日付表記の原文を出す（「令和８年９月１７日発足」）", () => {
    renderPage();
    expect(within(rowOf(/^財務大臣$/)).getByText(/令和８年９月１７日発足/)).toBeInTheDocument();
  });

  it("名簿の区分（閣僚等／副大臣／大臣政務官）が出典のラベルになる。役職名から分類を作らない", () => {
    renderPage();
    // **区分はリンクのラベルだけに持たせている**（meta にも出すと同じ語が 1 行に 2 回並ぶ）
    expect(within(rowOf(/^財務大臣$/)).getByRole("link", { name: "閣僚等名簿" })).toBeInTheDocument();
    const vice = within(rowOf(/^財務副大臣$/));
    expect(vice.getByRole("link", { name: "副大臣名簿" })).toHaveAttribute("href", "https://www.kantei.go.jp/jp/105/meibo/fukudaijin.html");
    // **発足日はページごとに違う**（閣僚 09-17 / 副大臣 09-18）。1 つに丸めていない
    expect(vice.getByText(/令和８年９月１８日/)).toBeInTheDocument();
  });

  it("**終了日・期間を 1 つも出さない**（「いつまで」は名簿に書かれていない。#1141）", () => {
    const { container } = renderPage();
    const html = container.innerHTML;
    for (const w of ["〜", "～", "期間", "退任", "まで", "現在まで"]) {
      expect(html, `禁止語 ${w} が出た（終了日は一次資料に無い）`).not.toContain(w);
    }
  });

  it("兼務は役職ごとに別の行になる（名簿の原文を丸めない）", () => {
    renderPage();
    expect(screen.getByText(/^財務大臣$/)).toBeInTheDocument();
    expect(screen.getByText(/^内閣府特命担当大臣（金融）$/)).toBeInTheDocument();
  });

  it("日付はページ共通の表記（formatDate）で、生の ISO を混ぜない", () => {
    renderPage();
    expect(rowOf(/^財務大臣$/).textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("「役職」タブは本人の記録のカテゴリに入り、衆参どちらにも在る", async () => {
    const { TABS } = await import("./member");
    for (const house of ["sangiin", "shugiin"] as const) {
      expect(TABS[house].find((t) => t.id === "cabinetRole")).toMatchObject({ label: "役職", category: "self", kind: "cabinetRole" });
    }
  });

  it("「役職」タブで絞り込める（件数はタブに出る）", async () => {
    renderPage();
    expect(screen.getByRole("tab", { name: /役職\s*3/ })).toBeInTheDocument();
    await clickTab();
    expect(screen.getByText(/^財務大臣$/)).toBeInTheDocument();
    expect(screen.queryByLabelText("賛成")).not.toBeInTheDocument();
  });

  it("タブに「内閣の発足日で、退任は名簿に載らない」ことの注記を出す", async () => {
    renderPage();
    await clickTab();
    expect(screen.getByText(/首相官邸の閣僚等名簿に載っている現在の役職です/)).toBeInTheDocument();
  });

  it("回次を持たないので「回次不明」の節に入る（発足日から回次を逆算していない）", async () => {
    renderPage();
    await clickTab();
    const section = screen.getByText("回次不明").closest("details")!;
    expect(within(section).getByText(/^財務大臣$/)).toBeInTheDocument();
    expect(within(section).getByText("3件")).toBeInTheDocument();
  });

  it("表紙の件数（採決・提出法案・質問主意書・発言）には数えない", () => {
    renderPage();
    const banner = within(screen.getByRole("banner"));
    expect(banner.queryByText("役職")).not.toBeInTheDocument();
  });
});
