import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, useLocation, useNavigate } from "react-router";
import { describe, expect, it } from "vitest";
import { type Assembly, DIET_ASSEMBLIES } from "../lib/data-contract";
import { dataset } from "../test-fixtures/dataset";
import { members } from "../test-fixtures/members-index";
import Members, { meta as routeMeta } from "./members";

// coverage.test.tsx と同じ禁止語に、このページ特有のもの（収録は 9 議会なので網羅を主張しない）を足す。
// 語彙がずれていると片方だけがすり抜ける（#239: 「すべての議会の議員」がこのガードを素通りした）。
const EVALUATIVE_WORDS = ["おすすめ", "ランキング", "一致率", "遅れ", "不十分", "優れ", "充実", "網羅", "すべての議会", "全国", "国会議員"];

function renderMembers(list = members) {
  return render(
    <MemoryRouter>
      <Members data={{ ...dataset, members: list }} />
    </MemoryRouter>,
  );
}

describe("/members", () => {
  it("絞り込み無しの見出しは表示中の集合を指す文言・件数「10 名」・評価語なし（#239）", () => {
    const { container } = renderMembers();
    // 既定は現職のみ・収録済み9議会なので、「国会議員」とも「すべての議会」とも書かない
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("収録している議会の現職議員");
    expect(screen.getByText("収録している議会の現職議員を五十音順に。氏名・ふりがな・議会・会派・選挙区でさがせます。")).toBeInTheDocument();
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

    it("名簿に無い選挙区は無視して全員を出す（でっち上げた選挙区名を見出しに出さない）", () => {
      renderAt("/members?district=%E5%AD%98%E5%9C%A8%E3%81%97%E3%81%AA%E3%81%84");
      expect(screen.getByText("11 名")).toBeInTheDocument();
      expect(screen.queryByText("選挙区：存在しない")).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("収録している議会の現職議員");
      expect(screen.getByRole("combobox", { name: "選挙区" })).toHaveValue("");
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
          {/* <output> は暗黙の role=status を持つのでページ側の live region と紛れる。素の span にする */}
          <span data-testid="url">{`${location.pathname}${location.search}`}</span>
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
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("徳島県議会の現職議員");
      expect(screen.getByText("徳島県議会の現職議員を五十音順に。氏名・ふりがな・議会・会派・選挙区でさがせます。")).toBeInTheDocument();
      expect(screen.getByText("1 名")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /徳島 太郎/ })).toBeInTheDocument();
    });

    it("会派・選挙区も URL に入り、見出しに並ぶ", async () => {
      const user = userEvent.setup();
      renderAt();
      await user.selectOptions(screen.getByRole("combobox", { name: "議会" }), "pref-36");
      await user.selectOptions(screen.getByRole("combobox", { name: "会派" }), "自由民主党");
      expect(url()).toBe("/members?assembly=pref-36&group=%E8%87%AA%E7%94%B1%E6%B0%91%E4%B8%BB%E5%85%9A");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("徳島県議会・自由民主党の現職議員");
      await user.selectOptions(screen.getByRole("combobox", { name: "選挙区" }), "徳島市");
      expect(url()).toBe("/members?assembly=pref-36&group=%E8%87%AA%E7%94%B1%E6%B0%91%E4%B8%BB%E5%85%9A&district=%E5%BE%B3%E5%B3%B6%E5%B8%82");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("徳島県議会・自由民主党・徳島市の現職議員");
      expect(screen.getByText("1 名")).toBeInTheDocument();
    });

    it("その URL を直接開くと（リロード相当）同じ状態が復元される", () => {
      renderAt("/members?assembly=pref-36&group=%E8%87%AA%E7%94%B1%E6%B0%91%E4%B8%BB%E5%85%9A&district=%E5%BE%B3%E5%B3%B6%E5%B8%82");
      expect(screen.getByRole("combobox", { name: "議会" })).toHaveValue("pref-36");
      expect(screen.getByRole("combobox", { name: "会派" })).toHaveValue("自由民主党");
      expect(screen.getByRole("combobox", { name: "選挙区" })).toHaveValue("徳島市");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("徳島県議会・自由民主党・徳島市の現職議員");
      expect(screen.getByText("1 名")).toBeInTheDocument();
    });

    it("ブラウザの戻る／進むで前後の絞り込みに移る", async () => {
      const user = userEvent.setup();
      renderAt();
      const assembly = screen.getByRole("combobox", { name: "議会" });
      await user.selectOptions(assembly, "pref-36");
      await user.selectOptions(screen.getByRole("combobox", { name: "会派" }), "自由民主党");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("徳島県議会・自由民主党の現職議員");

      await user.click(screen.getByRole("button", { name: "戻る" }));
      expect(url()).toBe("/members?assembly=pref-36");
      expect(screen.getByRole("combobox", { name: "会派" })).toHaveValue("");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("徳島県議会の現職議員");

      await user.click(screen.getByRole("button", { name: "戻る" }));
      expect(url()).toBe("/members");
      expect(screen.getByRole("combobox", { name: "議会" })).toHaveValue("");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("収録している議会の現職議員");
      expect(screen.getByText("11 名")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "進む" }));
      expect(url()).toBe("/members?assembly=pref-36");
      expect(screen.getByRole("combobox", { name: "議会" })).toHaveValue("pref-36");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("徳島県議会の現職議員");
    });

    it("議会を「すべて」に戻すと URL からクエリが消える", async () => {
      const user = userEvent.setup();
      renderAt("/members?assembly=pref-36");
      await user.selectOptions(screen.getByRole("combobox", { name: "議会" }), "");
      expect(url()).toBe("/members");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("収録している議会の現職議員");
    });

    it("氏名の検索は URL に入れない（打鍵ごとに履歴を積まない）", async () => {
      const user = userEvent.setup();
      renderAt();
      await user.type(screen.getByRole("searchbox", { name: /氏名/ }), "とくしま");
      expect(url()).toBe("/members");
      expect(screen.getByText("1 名")).toBeInTheDocument();
    });

    it("「元職も含める」も URL に入り、見出しが件数と一致したまま変わる（#239 レビュー指摘 1a）", async () => {
      const user = userEvent.setup();
      const former = { ...local, id: "p_36_000002", name: "元 職太郎", kana: "もと しょくたろう", current: false as const };
      render(
        <MemoryRouter initialEntries={["/members"]}>
          <Url />
          <Members data={{ ...dataset, members: [...list, former], assemblies: [...DIET_ASSEMBLIES, tokushima] }} />
        </MemoryRouter>,
      );
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("収録している議会の現職議員");
      expect(screen.getByText("11 名")).toBeInTheDocument();

      await user.click(screen.getByRole("checkbox", { name: "元職も含める" }));
      expect(url()).toBe("/members?former=1");
      // 見出しが「現職議員」のままだと 12 名の一覧に現職だけの見出しが付く（レビューで指摘された矛盾）
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("収録している議会の議員（元職を含む）");
      expect(screen.getByText("12 名")).toBeInTheDocument();

      await user.click(screen.getByRole("checkbox", { name: "元職も含める" }));
      expect(url()).toBe("/members");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("収録している議会の現職議員");
    });

    it("?former=1 の URL を開くとチェックが入った状態で復元される（#239 レビュー指摘 1a）", () => {
      const former = { ...local, id: "p_36_000002", name: "元 職太郎", kana: "もと しょくたろう", current: false as const };
      render(
        <MemoryRouter initialEntries={["/members?former=1"]}>
          <Url />
          <Members data={{ ...dataset, members: [...list, former], assemblies: [...DIET_ASSEMBLIES, tokushima] }} />
        </MemoryRouter>,
      );
      expect(screen.getByRole("checkbox", { name: "元職も含める" })).toBeChecked();
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("収録している議会の議員（元職を含む）");
      expect(screen.getByRole("link", { name: /元 職太郎/ })).toBeInTheDocument();
    });

    it("見出しと件数を role=status で読み上げる（絞り込みの変化が支援技術に届く）", async () => {
      const user = userEvent.setup();
      renderAt();
      // toHaveTextContent は空白を正規化するので、全角スペースは半角として比較される
      expect(screen.getByRole("status")).toHaveTextContent("収録している議会の現職議員 11 名");
      await user.selectOptions(screen.getByRole("combobox", { name: "議会" }), "pref-36");
      expect(screen.getByRole("status")).toHaveTextContent("徳島県議会の現職議員 1 名");
    });

    it("名簿に無い会派名は見出しに出さず「すべて」として扱う（#239 レビュー指摘 2）", () => {
      renderAt(`/members?group=${encodeURIComponent("存在しない会派")}`);
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("収録している議会の現職議員");
      expect(screen.getByRole("heading", { level: 1 })).not.toHaveTextContent("存在しない会派");
      expect(screen.getByRole("combobox", { name: "会派" })).toHaveValue("");
      // 「存在しない会派の議員」という見出しの下に「該当する議員はいません」が出ない
      expect(screen.queryByText("該当する議員はいません。")).not.toBeInTheDocument();
      expect(screen.getByText("11 名")).toBeInTheDocument();
    });

    it("選んだ議会に無い会派・選挙区も無視する（他の議会にしか無い名前）（#239 レビュー指摘 2）", () => {
      renderAt(`/members?assembly=pref-36&district=${encodeURIComponent("比例")}`);
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("徳島県議会の現職議員");
      expect(screen.getByRole("combobox", { name: "選挙区" })).toHaveValue("");
      expect(screen.getByText("1 名")).toBeInTheDocument();
    });

    it("HTML らしき文字列を渡しても見出しにはテキストすら出さない（#239 レビュー指摘 2）", () => {
      const { container } = renderAt(`/members?group=${encodeURIComponent("<img src=x onerror=alert(1)>")}`);
      // container には URL を映す観測用の <output> も入るので、ページ本体（main）だけを見る
      const main = container.querySelector("main");
      expect(main?.textContent).not.toContain("onerror");
      expect(main?.querySelector("img")).toBeNull();
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("収録している議会の現職議員");
    });
  });
});

describe("meta()", () => {
  function metaAt(pathname: string, search = "") {
    return routeMeta({ location: { pathname, search } } as unknown as Parameters<typeof routeMeta>[0]);
  }
  const titleOf = (tags: ReturnType<typeof metaAt>) => (tags.find((t) => "title" in t) as { title: string } | undefined)?.title;
  const descOf = (tags: ReturnType<typeof metaAt>) => (tags.find((t) => (t as { name?: string }).name === "description") as { content: string } | undefined)?.content;

  it("title・canonical・OGP を持つ。クエリ無しの title は表示中の集合を指す文言（#239）", () => {
    const tags = metaAt("/members");
    expect(tags).toContainEqual({ title: "収録している議会の現職議員 ・ 議員レコード" });
    expect(tags).toContainEqual({ tagName: "link", rel: "canonical", href: "/members" });
    expect(tags).toContainEqual({ property: "og:url", content: "/members" });
    expect(tags).toContainEqual({ property: "og:title", content: "収録している議会の現職議員 ・ 議員レコード" });
  });

  it("?assembly= があれば title・description・OGP がその議会を指す（#239）", () => {
    const tags = metaAt("/members", "?assembly=diet-shugiin");
    expect(tags).toContainEqual({ title: "衆議院の現職議員 ・ 議員レコード" });
    expect(tags).toContainEqual({ property: "og:title", content: "衆議院の現職議員 ・ 議員レコード" });
    expect(tags).toContainEqual({ name: "description", content: "衆議院の現職議員を五十音順に。氏名・ふりがな・議会・会派・選挙区でさがせます。" });
    expect(tags).toContainEqual({ property: "og:description", content: "衆議院の現職議員を五十音順に。氏名・ふりがな・議会・会派・選挙区でさがせます。" });
  });

  it("?former=1 は title・description にも出る（見出しと同じ）（#239）", () => {
    expect(titleOf(metaAt("/members", "?former=1"))).toBe("収録している議会の議員（元職を含む） ・ 議員レコード");
    expect(descOf(metaAt("/members", "?former=1"))).toBe("収録している議会の議員（元職を含む）を五十音順に。氏名・ふりがな・議会・会派・選挙区でさがせます。");
  });

  it("canonical はクエリを含めない（クエリ違いを別ページにしない）（#239）", () => {
    expect(metaAt("/members", "?assembly=diet-sangiin&former=1")).toContainEqual({ tagName: "link", rel: "canonical", href: "/members" });
  });

  it("知らない議会 id は無視して既定の title に戻す（#239）", () => {
    expect(metaAt("/members", "?assembly=pref-99")).toContainEqual({ title: "収録している議会の現職議員 ・ 議員レコード" });
  });

  it("名簿に無い会派名・選挙区名は title・description・OGP に出さない（#239 レビュー指摘）", () => {
    const tags = metaAt("/members", "?group=%E5%AD%98%E5%9C%A8%E3%81%97%E3%81%AA%E3%81%84%E4%BC%9A%E6%B4%BE&district=%E5%AD%98%E5%9C%A8%E3%81%97%E3%81%AA%E3%81%84");
    for (const tag of tags) {
      const text = Object.values(tag).join(" ");
      expect(text).not.toContain("存在しない");
    }
    expect(titleOf(tags)).toBe("収録している議会の現職議員 ・ 議員レコード");
  });

  it("HTML/スクリプトらしき文字列を渡しても meta には入らない（#239 レビュー指摘）", () => {
    const tags = metaAt("/members", `?group=${encodeURIComponent("<img src=x onerror=alert(1)>")}`);
    for (const tag of tags) expect(Object.values(tag).join(" ")).not.toContain("onerror");
  });
});

/**
 * #340: 一覧は 997 名を一度に描画していた（スマホで85画面）。初期表示を先頭 200 名までにする。
 * 「行の区切りを保つ」「絞り込み中は折りたたまない」の2つが設計の要点なので、その両方を見る。
 */
describe("/members 折りたたみ（#340）", () => {
  // あ行 150 名・か行 150 名。合計 300 > 200 なので、あ行だけが出るはず
  const many = [
    ...Array.from({ length: 150 }, (_, i) => ({ id: `m_a${i}`, name: `あ${i}`, kana: `あいうえ${i}`, house: "sangiin", group: "会派A", district: "東京", counts: { rollcalls: 0, bills: 0, speeches: 0 } })),
    ...Array.from({ length: 150 }, (_, i) => ({ id: `m_k${i}`, name: `か${i}`, kana: `かきくけ${i}`, house: "sangiin", group: "会派K", district: "大阪", counts: { rollcalls: 0, bills: 0, speeches: 0 } })),
  ] as never;

  const rows = () => screen.getAllByRole("listitem").length;

  it("200 名を超えたら行の区切りで折りたたみ、残り人数を出す", () => {
    renderMembers(many);
    expect(rows()).toBe(150); // か行を足すと 300 > 200 なので、あ行だけ
    expect(screen.getByRole("button", { name: "さらに表示（残り150名）" })).toBeInTheDocument();
    // 見出しだけの空グループを作らない
    expect(screen.queryByRole("heading", { name: "か行" })).not.toBeInTheDocument();
  });

  it("「さらに表示」で全員出る", async () => {
    renderMembers(many);
    await userEvent.click(screen.getByRole("button", { name: /さらに表示/ }));
    expect(rows()).toBe(300);
    expect(screen.queryByRole("button", { name: /さらに表示/ })).not.toBeInTheDocument();
  });

  it("絞り込んでいる間は折りたたまない（絞った結果が 200 名を超えても全件出す）", async () => {
    // 折りたたみが**実際に効く**形にする: あ行120・か行120・さ行120（計360）なら初期はあ行だけ。
    // そこで「会派K」で絞ると か行120 + さ行120 = 240 名 > 200 が残る。
    // 絞り込み中も折りたたむ実装だと、ここで か行だけ（120名）に切れて落ちる。
    const wide = [
      ...Array.from({ length: 120 }, (_, i) => ({ id: `m_a${i}`, name: `あ${i}`, kana: `あいうえ${i}`, house: "sangiin", group: "会派A", district: "東京", counts: { rollcalls: 0, bills: 0, speeches: 0 } })),
      ...Array.from({ length: 120 }, (_, i) => ({ id: `m_k${i}`, name: `か${i}`, kana: `かきくけ${i}`, house: "sangiin", group: "会派K", district: "大阪", counts: { rollcalls: 0, bills: 0, speeches: 0 } })),
      ...Array.from({ length: 120 }, (_, i) => ({ id: `m_s${i}`, name: `さ${i}`, kana: `さしすせ${i}`, house: "sangiin", group: "会派K", district: "京都", counts: { rollcalls: 0, bills: 0, speeches: 0 } })),
    ] as never;
    renderMembers(wide);
    expect(rows()).toBe(120); // 折りたたみが効いている（あ行だけ）

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "会派" }), "会派K");
    expect(rows()).toBe(240); // 200 を超えても絞り込み中は全件
    expect(screen.queryByRole("button", { name: /さらに表示/ })).not.toBeInTheDocument();
  });

  // 絞り込みの3経路（氏名検索・会派・選挙区）それぞれで折りたたみが解除されることを見る。
  // 会派だけで確かめていたので、query / district を `filtering` から外す変異が素通りしていた（レビュー指摘）
  it.each([
    ["氏名検索", async () => await userEvent.type(screen.getByRole("searchbox", { name: /氏名/ }), "かきくけ")],
    ["会派", async () => await userEvent.selectOptions(screen.getByRole("combobox", { name: "会派" }), "会派K")],
    ["選挙区", async () => await userEvent.selectOptions(screen.getByRole("combobox", { name: "選挙区" }), "大阪")],
  ])("%s で絞っている間は折りたたまない", async (_label, act) => {
    // か行120 + さ行120 = 240 名が残る絞り方にする（200 を超えないと折りたたみの有無を区別できない）
    const wide = [
      ...Array.from({ length: 120 }, (_, i) => ({ id: `m_a${i}`, name: `あ${i}`, kana: `あいうえ${i}`, house: "sangiin", group: "会派A", district: "東京", counts: { rollcalls: 0, bills: 0, speeches: 0 } })),
      ...Array.from({ length: 120 }, (_, i) => ({ id: `m_k${i}`, name: `かきくけ${i}`, kana: `かきくけ${i}`, house: "sangiin", group: "会派K", district: "大阪", counts: { rollcalls: 0, bills: 0, speeches: 0 } })),
      ...Array.from({ length: 120 }, (_, i) => ({ id: `m_s${i}`, name: `かきくけさ${i}`, kana: `さしすせ${i}`, house: "sangiin", group: "会派K", district: "大阪", counts: { rollcalls: 0, bills: 0, speeches: 0 } })),
    ] as never;
    renderMembers(wide);
    expect(rows()).toBe(120); // 折りたたみが効いている
    await act();
    expect(rows()).toBe(240); // 200 を超えても全件
    expect(screen.queryByRole("button", { name: /さらに表示/ })).not.toBeInTheDocument();
  });

  // 折りたたみ中は「該当997名」だけを読み上げると、直列に読む利用者は
  // 実 DOM に無い人数まで辿れると思って読み進めることになる（レビュー指摘）
  it("折りたたみ中は、該当人数と表示中の人数の両方を読み上げる", () => {
    renderMembers(many);
    expect(screen.getByRole("status")).toHaveTextContent("300 名（うち 150 名を表示中）");
  });

  it("折りたたんでいないときは表示中の人数を言わない（冗長にしない）", () => {
    renderMembers();
    expect(screen.getByRole("status").textContent).not.toContain("表示中");
  });

  it("「さらに表示」は aria-expanded と aria-controls を持つ", () => {
    renderMembers(many);
    const btn = screen.getByRole("button", { name: /さらに表示/ });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(btn.getAttribute("aria-controls")).toBeTruthy();
    expect(document.getElementById(btn.getAttribute("aria-controls") as string)).toBeInTheDocument();
  });

  it("200 名以下なら折りたたまない", () => {
    renderMembers();
    expect(screen.queryByRole("button", { name: /さらに表示/ })).not.toBeInTheDocument();
  });
});
