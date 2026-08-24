import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, useLocation, useNavigate } from "react-router";
import { describe, expect, it } from "vitest";
import { type Assembly, DIET_ASSEMBLIES } from "../lib/data-contract";
import { dataset } from "../test-fixtures/dataset";
import { members } from "../test-fixtures/members-index";
import Members, { meta as routeMeta } from "./members";

const EVALUATIVE_WORDS = ["おすすめ", "ランキング", "一致率"];

function renderMembers(list = members) {
  return render(
    <MemoryRouter>
      <Members data={{ ...dataset, members: list }} />
    </MemoryRouter>,
  );
}

describe("/members", () => {
  it("絞り込み無しの見出しは全議会が対象と分かる文言・件数「10 名」・評価語なし（#239）", () => {
    const { container } = renderMembers();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("すべての議会の議員");
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveTextContent("国会議員");
    expect(screen.getByText("国会（参議院・衆議院）と地方議会の議員を五十音順に。氏名・ふりがな・議会・会派・選挙区でさがせます。")).toBeInTheDocument();
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

  describe("議会（assembly）の絞り込み（#156: 院フィルタの一般化。国会2＋将来の地方議会）", () => {
    const shugiin = { ...members[0], id: "h_000001", name: "衆 太郎", kana: "しゅう たろう", house: "shugiin" as const, group: "自民", district: "東京1区" };
    const both = [...members, shugiin];

    it("既定はすべての議会を出し、議会の select は すべて／参議院／衆議院（assemblies/index.json が無ければ国会の2議会）", () => {
      renderMembers(both);
      const assembly = screen.getByRole("combobox", { name: "議会" });
      expect(within(assembly).getAllByRole("option").map((o) => o.textContent)).toEqual(["すべて", "参議院", "衆議院"]);
      expect(within(assembly).getAllByRole("option").map((o) => (o as HTMLOptionElement).value)).toEqual(["", "diet-sangiin", "diet-shugiin"]);
      expect(assembly).toHaveValue("");
      expect(screen.queryByRole("combobox", { name: "院" })).not.toBeInTheDocument();
      expect(screen.getByText("11 名")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /衆 太郎/ })).toHaveAttribute("href", "/members/h_000001");
    });

    it("すべての議会を表示しているとき各行に議会名を添える", () => {
      renderMembers(both);
      expect(screen.getByRole("link", { name: /衆 太郎/ }).closest("li")).toHaveTextContent("衆議院");
      expect(screen.getByRole("link", { name: /藤川 政人/ }).closest("li")).toHaveTextContent("参議院");
    });

    it("衆議院を選ぶと衆院のみになり、会派・選挙区の選択肢もその議会のものになる", async () => {
      const user = userEvent.setup();
      renderMembers(both);
      await user.selectOptions(screen.getByRole("combobox", { name: "議会" }), "diet-shugiin");
      expect(screen.getByText("1 名")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /藤川 政人/ })).not.toBeInTheDocument();
      const district = screen.getByRole("combobox", { name: "選挙区" });
      expect(within(district).getAllByRole("option").map((o) => o.textContent)).toEqual(["すべて", "東京1区"]);
    });

    it("参議院を選ぶと参院のみ。元職トグルは議会と独立に効く", async () => {
      const user = userEvent.setup();
      const former = { ...shugiin, id: "h_000002", name: "元 衆", kana: "もと しゅう", current: false as const };
      renderMembers([...both, former]);
      await user.selectOptions(screen.getByRole("combobox", { name: "議会" }), "diet-sangiin");
      expect(screen.getByText("10 名")).toBeInTheDocument();
      await user.selectOptions(screen.getByRole("combobox", { name: "議会" }), "diet-shugiin");
      expect(screen.getByText("1 名")).toBeInTheDocument();
      await user.click(screen.getByRole("checkbox", { name: "元職も含める" }));
      expect(screen.getByText("2 名")).toBeInTheDocument();
    });

    it("会派・選挙区を選んだ状態で議会を切り替えると、その絞り込みはリセットされ 0 名にならない", async () => {
      const user = userEvent.setup();
      renderMembers(both);
      const group = screen.getByRole("combobox", { name: "会派" });
      await user.selectOptions(group, "立憲");
      await user.selectOptions(screen.getByRole("combobox", { name: "議会" }), "diet-shugiin");
      expect(group).toHaveValue("");
      expect(screen.getByRole("combobox", { name: "選挙区" })).toHaveValue("");
      expect(screen.getByText("1 名")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /衆 太郎/ })).toBeInTheDocument();
    });

    it("assemblies/index.json に地方議会があれば select に並び、その議会の議員だけに絞れる", async () => {
      const user = userEvent.setup();
      const miyagi: Assembly = { id: "pref-04", kind: "prefectural", name: "宮城県議会", prefCode: "04", sourceUrl: "https://www.pref.miyagi.jp/" };
      const local = { ...members[0], id: "p_04_000001", name: "宮城 太郎", kana: "みやぎ たろう", assemblyId: "pref-04" as const, group: "自由民主党・県民会議", district: "仙台市青葉区" };
      render(
        <MemoryRouter>
          <Members data={{ ...dataset, members: [...both, local], assemblies: [...DIET_ASSEMBLIES, miyagi] }} />
        </MemoryRouter>,
      );
      const assembly = screen.getByRole("combobox", { name: "議会" });
      expect(within(assembly).getAllByRole("option").map((o) => o.textContent)).toEqual(["すべて", "参議院", "衆議院", "宮城県議会"]);
      expect(screen.getByText("12 名")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /宮城 太郎/ }).closest("li")).toHaveTextContent("宮城県議会");
      await user.selectOptions(assembly, "pref-04");
      expect(screen.getByText("1 名")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /宮城 太郎/ })).toHaveAttribute("href", "/members/p_04_000001");
      expect(within(screen.getByRole("combobox", { name: "会派" })).getAllByRole("option").map((o) => o.textContent)).toEqual(["すべて", "自由民主党・県民会議"]);
    });
  });

  describe("?assembly= クエリ（#158: 議会ページから）", () => {
    const shugiin = { ...members[0], id: "h_000001", name: "衆 太郎", kana: "しゅう たろう", house: "shugiin" as const, assemblyId: "diet-shugiin" as const, group: "自民", district: "東京1" };
    function renderAt(url: string) {
      return render(
        <MemoryRouter initialEntries={[url]}>
          <Members data={{ ...dataset, members: [...members, shugiin] }} />
        </MemoryRouter>,
      );
    }
    it("assembly を初期値として議会の select と絞り込みに反映する", () => {
      renderAt("/members?assembly=diet-shugiin");
      expect(screen.getByRole("combobox", { name: "議会" })).toHaveValue("diet-shugiin");
      expect(screen.getByText("1 名")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /衆 太郎/ })).toBeInTheDocument();
    });
    it("存在しない議会 id は無視してすべてを出す", () => {
      renderAt("/members?assembly=pref-99");
      expect(screen.getByRole("combobox", { name: "議会" })).toHaveValue("");
      expect(screen.getByText("11 名")).toBeInTheDocument();
    });
  });

  describe("?district= クエリ（#112: Home の郵便番号から）", () => {
    const shugiin = { ...members[0], id: "h_000001", name: "衆 太郎", kana: "しゅう たろう", house: "shugiin" as const, group: "自民", district: "東京1" };
    function renderAt(url: string, list = [...members, shugiin]) {
      return render(
        <MemoryRouter initialEntries={[url]}>
          <Members data={{ ...dataset, members: list }} />
        </MemoryRouter>,
      );
    }

    it("district を初期値として両院から絞り込み、選挙区の select にも反映する", () => {
      renderAt("/members?district=%E6%9D%B1%E4%BA%AC");
      expect(screen.getByText("2 名")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /佐藤 花子/ })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /蓮舫/ })).toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: "選挙区" })).toHaveValue("東京");
    });

    it("衆院の小選挙区名（東京1）でも絞り込める", () => {
      renderAt("/members?district=%E6%9D%B1%E4%BA%AC1");
      expect(screen.getByText("1 名")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /衆 太郎/ })).toBeInTheDocument();
    });

    it("絞り込み中のチップを出し、解除すると全員に戻る", async () => {
      const user = userEvent.setup();
      renderAt("/members?district=%E6%9D%B1%E4%BA%AC");
      const chip = screen.getByText("選挙区：東京");
      expect(chip).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "選挙区の絞り込みを解除" }));
      expect(screen.queryByText("選挙区：東京")).not.toBeInTheDocument();
      expect(screen.getByText("11 名")).toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: "選挙区" })).toHaveValue("");
    });

    it("該当しない選挙区なら 0 名と「該当する議員はいません」", () => {
      renderAt("/members?district=%E5%AD%98%E5%9C%A8%E3%81%97%E3%81%AA%E3%81%84");
      expect(screen.getByText("0 名")).toBeInTheDocument();
      expect(screen.getByText("該当する議員はいません。")).toBeInTheDocument();
      expect(screen.getByText("選挙区：存在しない")).toBeInTheDocument();
    });

    it("クエリが後から変わっても（プリレンダーの DOM からの hydration 後を含む）select と絞り込みに反映する（#120）", async () => {
      const user = userEvent.setup();
      render(
        <MemoryRouter initialEntries={["/members"]}>
          <Link to="/members?district=%E6%9D%B1%E4%BA%AC1">東京1 へ</Link>
          <Members data={{ ...dataset, members: [...members, shugiin] }} />
        </MemoryRouter>,
      );
      expect(screen.getByRole("combobox", { name: "選挙区" })).toHaveValue("");
      await user.click(screen.getByRole("link", { name: "東京1 へ" }));
      expect(screen.getByRole("combobox", { name: "選挙区" })).toHaveValue("東京1");
      expect(screen.getByText("1 名")).toBeInTheDocument();
      expect(screen.getByText("選挙区：東京1")).toBeInTheDocument();
    });

    it("クエリが無ければチップは出ない", () => {
      renderAt("/members");
      expect(screen.queryByRole("button", { name: "選挙区の絞り込みを解除" })).not.toBeInTheDocument();
    });
  });

  it("取得日時をフッターに出す", () => {
    renderMembers();
    expect(screen.getByText(/2026\.08\.22 06:00/)).toBeInTheDocument();
  });

  describe("絞り込みが URL に入り、リロードで復元される（#239）", () => {
    const tokushima: Assembly = { id: "pref-36", kind: "prefectural", name: "徳島県議会", prefCode: "36", sourceUrl: "https://www.pref.tokushima.lg.jp/" };
    const local = { ...members[0], id: "p_36_000001", name: "徳島 太郎", kana: "とくしま たろう", assemblyId: "pref-36" as const, group: "自由民主党", district: "徳島市" };
    const list = [...members, local];

    /**
     * 現在の URL を DOM に出して観測し（実ブラウザのアドレスバーに相当）、
     * 戻る／進む用のボタンも置く。MemoryRouter は履歴スタックを持つので navigate(-1) が「戻る」と同じに動く。
     */
    function Url() {
      const location = useLocation();
      const navigate = useNavigate();
      return (
        <>
          <output data-testid="url">{`${location.pathname}${location.search}`}</output>
          <button type="button" onClick={() => navigate(-1)}>
            戻る
          </button>
          <button type="button" onClick={() => navigate(1)}>
            進む
          </button>
        </>
      );
    }

    function renderAt(at = "/members") {
      return render(
        <MemoryRouter initialEntries={[at]}>
          <Url />
          <Members data={{ ...dataset, members: list, assemblies: [...DIET_ASSEMBLIES, tokushima] }} />
        </MemoryRouter>,
      );
    }

    const url = () => screen.getByTestId("url").textContent;

    it("議会を選ぶと URL に ?assembly= が入り、見出し・説明・件数が一致する", async () => {
      const user = userEvent.setup();
      renderAt();
      expect(url()).toBe("/members");
      await user.selectOptions(screen.getByRole("combobox", { name: "議会" }), "pref-36");
      expect(url()).toBe("/members?assembly=pref-36");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("徳島県議会の議員");
      expect(screen.getByText("徳島県議会の議員を五十音順に。氏名・ふりがな・議会・会派・選挙区でさがせます。")).toBeInTheDocument();
      expect(screen.getByText("1 名")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /徳島 太郎/ })).toBeInTheDocument();
    });

    it("会派・選挙区も URL に入り、見出しに並ぶ", async () => {
      const user = userEvent.setup();
      renderAt();
      await user.selectOptions(screen.getByRole("combobox", { name: "議会" }), "pref-36");
      await user.selectOptions(screen.getByRole("combobox", { name: "会派" }), "自由民主党");
      expect(url()).toBe("/members?assembly=pref-36&group=%E8%87%AA%E7%94%B1%E6%B0%91%E4%B8%BB%E5%85%9A");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("徳島県議会・自由民主党の議員");
      await user.selectOptions(screen.getByRole("combobox", { name: "選挙区" }), "徳島市");
      expect(url()).toBe("/members?assembly=pref-36&group=%E8%87%AA%E7%94%B1%E6%B0%91%E4%B8%BB%E5%85%9A&district=%E5%BE%B3%E5%B3%B6%E5%B8%82");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("徳島県議会・自由民主党・徳島市の議員");
      expect(screen.getByText("1 名")).toBeInTheDocument();
    });

    it("その URL を直接開くと（リロード相当）同じ状態が復元される", () => {
      renderAt("/members?assembly=pref-36&group=%E8%87%AA%E7%94%B1%E6%B0%91%E4%B8%BB%E5%85%9A&district=%E5%BE%B3%E5%B3%B6%E5%B8%82");
      expect(screen.getByRole("combobox", { name: "議会" })).toHaveValue("pref-36");
      expect(screen.getByRole("combobox", { name: "会派" })).toHaveValue("自由民主党");
      expect(screen.getByRole("combobox", { name: "選挙区" })).toHaveValue("徳島市");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("徳島県議会・自由民主党・徳島市の議員");
      expect(screen.getByText("1 名")).toBeInTheDocument();
    });

    it("ブラウザの戻る／進むで前後の絞り込みに移る", async () => {
      const user = userEvent.setup();
      renderAt();
      const assembly = screen.getByRole("combobox", { name: "議会" });
      await user.selectOptions(assembly, "pref-36");
      await user.selectOptions(screen.getByRole("combobox", { name: "会派" }), "自由民主党");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("徳島県議会・自由民主党の議員");

      await user.click(screen.getByRole("button", { name: "戻る" }));
      expect(url()).toBe("/members?assembly=pref-36");
      expect(screen.getByRole("combobox", { name: "会派" })).toHaveValue("");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("徳島県議会の議員");

      await user.click(screen.getByRole("button", { name: "戻る" }));
      expect(url()).toBe("/members");
      expect(screen.getByRole("combobox", { name: "議会" })).toHaveValue("");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("すべての議会の議員");
      expect(screen.getByText("11 名")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "進む" }));
      expect(url()).toBe("/members?assembly=pref-36");
      expect(screen.getByRole("combobox", { name: "議会" })).toHaveValue("pref-36");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("徳島県議会の議員");
    });

    it("議会を「すべて」に戻すと URL からクエリが消える", async () => {
      const user = userEvent.setup();
      renderAt("/members?assembly=pref-36");
      await user.selectOptions(screen.getByRole("combobox", { name: "議会" }), "");
      expect(url()).toBe("/members");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("すべての議会の議員");
    });

    it("氏名の検索は URL に入れない（打鍵ごとに履歴を積まない）", async () => {
      const user = userEvent.setup();
      renderAt();
      await user.type(screen.getByRole("searchbox", { name: /氏名/ }), "とくしま");
      expect(url()).toBe("/members");
      expect(screen.getByText("1 名")).toBeInTheDocument();
    });
  });
});

describe("meta()", () => {
  function metaAt(pathname: string, search = "") {
    return routeMeta({ location: { pathname, search } } as unknown as Parameters<typeof routeMeta>[0]);
  }

  it("title・canonical・OGP を持つ。クエリ無しの title は全議会が対象と分かる文言（#239）", () => {
    const tags = metaAt("/members");
    expect(tags).toContainEqual({ title: "すべての議会の議員 ・ 議員レコード" });
    expect(tags).toContainEqual({ tagName: "link", rel: "canonical", href: "/members" });
    expect(tags).toContainEqual({ property: "og:url", content: "/members" });
    expect(tags).toContainEqual({ property: "og:title", content: "すべての議会の議員 ・ 議員レコード" });
  });

  it("?assembly= があれば title・description・OGP がその議会を指す（#239）", () => {
    const tags = metaAt("/members", "?assembly=diet-shugiin");
    expect(tags).toContainEqual({ title: "衆議院の議員 ・ 議員レコード" });
    expect(tags).toContainEqual({ property: "og:title", content: "衆議院の議員 ・ 議員レコード" });
    expect(tags).toContainEqual({ name: "description", content: "衆議院の議員を五十音順に。氏名・ふりがな・議会・会派・選挙区でさがせます。" });
    expect(tags).toContainEqual({ property: "og:description", content: "衆議院の議員を五十音順に。氏名・ふりがな・議会・会派・選挙区でさがせます。" });
  });

  it("会派・選挙区も title に入る。canonical はクエリを含めない（#239）", () => {
    const tags = metaAt("/members", "?assembly=diet-sangiin&group=%E8%87%AA%E6%B0%91&district=%E6%AF%94%E4%BE%8B");
    expect(tags).toContainEqual({ title: "参議院・自民・比例の議員 ・ 議員レコード" });
    expect(tags).toContainEqual({ tagName: "link", rel: "canonical", href: "/members" });
  });

  it("知らない議会 id は無視して全議会の title に戻す（#239）", () => {
    expect(metaAt("/members", "?assembly=pref-99")).toContainEqual({ title: "すべての議会の議員 ・ 議員レコード" });
  });
});
