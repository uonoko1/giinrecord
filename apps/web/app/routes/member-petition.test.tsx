import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Assembly } from "@seiji-kiroku/shared";
import type { MemberDetail } from "../lib/data-contract";
import localMember from "../test-fixtures/assemblies/member-local.json";
import tottoriMember from "../test-fixtures/assemblies/member-local-tottori.json";
import meta from "../test-fixtures/meta.json";
import { MemberPage } from "./member";

/**
 * #204: 鳥取の請願・陳情の賛否は「委員長報告（例：不採択）に対する賛否」であって請願・陳情そのものへの賛否ではない。
 * ○ を採択への賛成と読ませないために、採決行に「賛否の対象：委員長報告（不採択）」を事実として表示する。
 * フィクスチャは実データ（p_31_item_1165926 の timeline に rollcalls/index.json の voteSubject / committeeReport を
 * 結合した、loader の出力の形）。
 */
const detail = tottoriMember as MemberDetail;
const tottori: Assembly = { id: "pref-31", kind: "prefectural", name: "鳥取県議会", prefCode: "31", sourceUrl: "https://www.pref.tottori.lg.jp/75928.htm" };

function renderPage(d: MemberDetail = detail) {
  return render(<MemberPage detail={d} meta={meta} assembly={tottori} />);
}

describe("地方議員の採決行（すべて）: 賛否の対象の注記（#204）", () => {
  it("陳情の行に「賛否の対象：委員長報告（不採択）」を出す（○＝採択賛成と読ませない）", () => {
    renderPage();
    const row = screen.getByText(/ゆたかな学びの実現/).closest("li")!;
    expect(row).toHaveTextContent("賛否の対象：委員長報告（不採択）");
    expect(within(row).getByRole("img", { name: "○（賛成）" })).toBeInTheDocument();
  });
  it("委員長報告の原文はそのまま（「研究留保」も言い換えない）", () => {
    renderPage();
    const row = screen.getByText(/旧姓の通称使用の法制化を求める陳情/).closest("li")!;
    expect(row).toHaveTextContent("賛否の対象：委員長報告（研究留保）");
  });
  it("「議案に対する賛否」（議案そのものへの賛否）の行には注記を出さない", () => {
    renderPage();
    const row = screen.getByText(/損害賠償に係る和解/).closest("li")!;
    expect(row).not.toHaveTextContent("賛否の対象");
  });
  it("○ の判は原文＋凡例のまま（「採択に賛成」等の言い換えを作らない）", () => {
    const { container } = renderPage();
    for (const stamp of screen.getAllByRole("img", { name: "○（賛成）" })) expect(stamp).toHaveTextContent("○");
    expect(container.textContent).not.toContain("採択に賛成");
    expect(container.textContent).not.toContain("採択賛成");
  });
});

describe("地方議員の表決タブの表: 賛否の対象の注記（#204）", () => {
  it("表決の列に「賛否の対象：委員長報告（不採択）」を出す", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("tab", { name: "表決" }));
    const table = screen.getByRole("table");
    const row = within(table).getByText(/ゆたかな学びの実現/).closest("tr")!;
    expect(row).toHaveTextContent("賛否の対象：委員長報告（不採択）");
    expect(row).toHaveTextContent("不採択");
  });
  it("「議案に対する賛否」の行には注記を出さない", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("tab", { name: "表決" }));
    const table = screen.getByRole("table");
    const row = within(table).getByText(/損害賠償に係る和解/).closest("tr")!;
    expect(row).not.toHaveTextContent("賛否の対象");
  });
});

describe("voteSubject の無い議会（宮城）はこれまでどおり", () => {
  it("「賛否の対象」「委員長報告」を出さない", () => {
    const { container } = renderPage(localMember as MemberDetail);
    expect(container.textContent).not.toContain("賛否の対象");
    expect(container.textContent).not.toContain("委員長報告");
  });
});
