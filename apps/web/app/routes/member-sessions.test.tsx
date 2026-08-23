import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MemberDetail, TimelineEntry } from "../lib/data-contract";
import member from "../test-fixtures/member.json";
import meta from "../test-fixtures/meta.json";
import { EXPANDED_SESSIONS, MemberPage, groupBySession } from "./member";

// Issue #103: 第200回以降の採決が入ると1人の timeline が数百行になる。回次（国会の回次）ごとに折りたたみ、直近2回次だけ展開する。

const base = member as MemberDetail;
const vote = (session: number, mmdd: string, value: "賛成" | "反対" = "賛成"): TimelineEntry => ({
  kind: "vote", session, date: `${2000 + Math.floor(session / 10)}-${mmdd.slice(0, 2)}-${mmdd.slice(2)}`, rollCallId: `${session}-${mmdd}-v001`,
  title: `案件 ${session}-${mmdd}`, value, result: "賛成 1・反対 0", sourceUrl: `https://www.sangiin.go.jp/japanese/touhyoulist/${session}/${session}-${mmdd}-v001.htm`,
});
const detail: MemberDetail = {
  ...base,
  timeline: [vote(221, "0605"), vote(221, "0410"), vote(219, "1128"), vote(216, "1217", "反対"), vote(200, "1204"), vote(200, "1129")],
};

function renderPage(d: MemberDetail = detail) {
  return render(<MemberPage detail={d} meta={meta} />);
}

describe("groupBySession", () => {
  it("回次の降順にまとめ、回次の無い行（#103 以前のデータ）は最後に「回次不明」としてまとめる", () => {
    const noSession = { ...vote(221, "0101"), session: undefined } as unknown as TimelineEntry;
    const groups = groupBySession([...detail.timeline, noSession]);
    expect(groups.map((g) => [g.session, g.entries.length])).toEqual([[221, 2], [219, 1], [216, 1], [200, 2], [undefined, 1]]);
  });
  it("直近 2 回次だけ展開する（EXPANDED_SESSIONS = 2）", () => {
    expect(EXPANDED_SESSIONS).toBe(2);
    expect(groupBySession(detail.timeline).map((g) => g.expanded)).toEqual([true, true, false, false]);
  });
});

describe("MemberPage 回次ごとの折りたたみ（すべて）", () => {
  it("回次ごとの <details> になり、見出しは「第N回国会」と件数。直近2回次は open、それ以前は閉じている", () => {
    const { container } = renderPage();
    const sections = [...container.querySelectorAll("details.member-session")];
    expect(sections.map((s) => s.querySelector("summary")?.textContent)).toEqual(["第221回国会2件", "第219回国会1件", "第216回国会1件", "第200回国会2件"]);
    expect(sections.map((s) => s.hasAttribute("open"))).toEqual([true, true, false, false]);
  });
  it("折りたたまれた回次の行もマークアップには含まれる（JS なしでも開ける。件数はページ内に残る）", () => {
    renderPage();
    expect(screen.getByText("案件 200-1204")).toBeInTheDocument();
  });
  it("1回次しか無ければ折りたたみの見出しだけで open", () => {
    const { container } = renderPage(base);
    const sections = [...container.querySelectorAll("details.member-session")];
    expect(sections).toHaveLength(1);
    expect(sections[0].hasAttribute("open")).toBe(true);
    expect(sections[0].querySelector("summary")).toHaveTextContent("第217回国会");
  });
});

describe("MemberPage 回次ごとの折りたたみ（採決タブ）", () => {
  it("採決の表も回次ごとに分かれ、直近2回次だけ open", async () => {
    const { container } = renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "採決" }));
    const sections = [...container.querySelectorAll("details.member-session")];
    expect(sections).toHaveLength(4);
    expect(sections.map((s) => s.hasAttribute("open"))).toEqual([true, true, false, false]);
    expect(within(sections[3] as HTMLElement).getAllByRole("row")).toHaveLength(3);
    expect(within(sections[3] as HTMLElement).getAllByLabelText("賛成")).toHaveLength(2);
  });
});
