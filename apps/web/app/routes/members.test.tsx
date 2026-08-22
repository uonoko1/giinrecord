import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { dataset } from "../test-fixtures/dataset";
import { members } from "../test-fixtures/members-index";
import Members from "./members";

const EVALUATIVE_WORDS = ["おすすめ", "ランキング", "一致率"];

function renderMembers(list = members) {
  return render(
    <MemoryRouter>
      <Members data={{ ...dataset, members: list }} />
    </MemoryRouter>,
  );
}

describe("/members", () => {
  it("見出し・件数「10 名」・評価語なし", () => {
    const { container } = renderMembers();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("参議院議員");
    expect(screen.getByText("10 名")).toBeInTheDocument();
    for (const word of EVALUATIVE_WORDS) expect(container.textContent).not.toContain(word);
  });

  it("五十音の見出しでグループ化し、行内はかな順。濁音は清音の行", () => {
    renderMembers();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["あ", "か", "さ", "た", "は", "や", "ら", "わ"]);
    const ka = screen.getByRole("list", { name: "か" });
    expect(within(ka).getAllByRole("link").map((a) => a.textContent)).toEqual([expect.stringContaining("ガーシー"), expect.stringContaining("片山 さつき")]);
  });

  it("各行は /members/{id} へのリンクで、会派・選挙区・任期「〜2028.07」を添える", () => {
    renderMembers();
    const link = screen.getByRole("link", { name: /藤川 政人/ });
    expect(link).toHaveAttribute("href", "/members/m_000001");
    const row = link.closest("li");
    expect(row).toHaveTextContent("ふじかわ まさひと");
    expect(row).toHaveTextContent("自民");
    expect(row).toHaveTextContent("愛知");
    expect(row).toHaveTextContent("〜2028.07");
  });

  it("termEnd が無い議員には任期を出さない", () => {
    renderMembers();
    expect(screen.getByRole("link", { name: /渡辺 猛之/ }).closest("li")).not.toHaveTextContent("〜");
  });

  it("1文字で絞り込み、件数が更新される（氏名・かなの両方に一致）", async () => {
    const user = userEvent.setup();
    renderMembers();
    await user.type(screen.getByRole("searchbox", { name: /氏名/ }), "田");
    expect(screen.getAllByRole("link", { name: /\S/ }).filter((a) => a.getAttribute("href")?.startsWith("/members/"))).toHaveLength(3);
    expect(screen.getByText("3 名")).toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: /氏名/ }));
    await user.type(screen.getByRole("searchbox", { name: /氏名/ }), "ふじかわ　まさ");
    expect(screen.getByText("1 名")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /藤川 政人/ })).toBeInTheDocument();
  });

  it("会派・選挙区の select で絞り込める", async () => {
    const user = userEvent.setup();
    renderMembers();
    const group = screen.getByRole("combobox", { name: "会派" });
    const district = screen.getByRole("combobox", { name: "選挙区" });
    expect(within(group).getAllByRole("option").map((o) => o.textContent)).toEqual(["すべて", "N党", "公明", "自民", "立憲"]);
    await user.selectOptions(group, "自民");
    expect(screen.getByText("5 名")).toBeInTheDocument();
    await user.selectOptions(district, "比例");
    expect(screen.getByText("2 名")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /山田 太郎/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /片山 さつき/ })).toBeInTheDocument();
  });

  it("0件のときは「該当する議員はいません」と出し、見出しを出さない", async () => {
    const user = userEvent.setup();
    renderMembers();
    await user.type(screen.getByRole("searchbox", { name: /氏名/ }), "存在しない");
    expect(screen.getByText("0 名")).toBeInTheDocument();
    expect(screen.getByText("該当する議員はいません。")).toBeInTheDocument();
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
  });

  it("データ取得前（0名）でも落ちず、取得前と示す", () => {
    renderMembers([]);
    expect(screen.getByText("取得前です。")).toBeInTheDocument();
  });

  describe("現職／元職（current）", () => {
    const former = { ...members[0], id: "m_000099", name: "元 職太郎", kana: "もと しょくたろう", group: "立憲", district: "東京", current: false as const };
    const withFormer = [...members.map((m) => ({ ...m, current: true })), former];

    it("既定では現職のみを出し、件数も現職の数", () => {
      renderMembers(withFormer);
      expect(screen.queryByRole("link", { name: /元 職太郎/ })).not.toBeInTheDocument();
      expect(screen.getByText("10 名")).toBeInTheDocument();
    });

    it("「元職も含める」を入れると元職も出て、行に「元職」と添える", async () => {
      const user = userEvent.setup();
      renderMembers(withFormer);
      await user.click(screen.getByRole("checkbox", { name: "元職も含める" }));
      const row = screen.getByRole("link", { name: /元 職太郎/ }).closest("li");
      expect(row).toHaveTextContent("元職");
      expect(screen.getByText("11 名")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /藤川 政人/ }).closest("li")).not.toHaveTextContent("元職");
    });

    it("current が無い行（古いデータ）は現職として扱う", () => {
      renderMembers(members);
      expect(screen.getByText("10 名")).toBeInTheDocument();
      expect(screen.getAllByRole("link", { name: /\S/ }).filter((a) => a.getAttribute("href")?.startsWith("/members/"))).toHaveLength(10);
    });

    it("元職しかいない会派は、元職を含めるまで会派の選択肢に出ない", async () => {
      const user = userEvent.setup();
      renderMembers([...withFormer.slice(0, 10), { ...former, group: "旧会派" }]);
      const group = screen.getByRole("combobox", { name: "会派" });
      expect(within(group).getAllByRole("option").map((o) => o.textContent)).not.toContain("旧会派");
      await user.click(screen.getByRole("checkbox", { name: "元職も含める" }));
      expect(within(group).getAllByRole("option").map((o) => o.textContent)).toContain("旧会派");
    });
  });

  it("取得日時をフッターに出す", () => {
    renderMembers();
    expect(screen.getByText(/2026\.08\.22 06:00/)).toBeInTheDocument();
  });
});
