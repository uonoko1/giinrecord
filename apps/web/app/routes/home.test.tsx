import { render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import Home, { meta as routeMeta } from "./home";
import { DIET_ASSEMBLIES } from "../lib/data-contract";
import { dataset } from "../test-fixtures/dataset";

const EVALUATIVE_WORDS = ["おすすめ", "ランキング", "一致率"];
const CAMPAIGN_WORDS = ["応援", "守る", "守ろう", "ぜひ", "お願いします", "あなたの力", "みんなで"];

function renderHome(data = dataset) {
  return render(
    <MemoryRouter>
      <Home data={data} />
    </MemoryRouter>,
  );
}

describe("Home", () => {
  it("見出しと方針文がある", () => {
    renderHome();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("言ったことではなく、やったことを。");
    expect(screen.getByText(/公式記録だけを、そのまま並べます。評価はしません。/)).toBeInTheDocument();
  });

  /*
   * #242 で発言の収録範囲が本会議だけでなく委員会も含むようになった。
   * 「本会議でどう投票し、…何を発言したか」は「本会議で」が 3 つの動詞に等しく係って読めるため、
   * 発言まで本会議に限られると読める。投票（本会議のみ公表される事実）と発言（本会議＋委員会）を
   * 文として分ける。トップページの lead と meta description の両方に出る文なので、ここで固定する。
   */
  it("方針文は投票（本会議のみ）と発言（本会議＋委員会）を混同させない", () => {
    renderHome();
    const lead = screen.getByText(/公式記録だけを、そのまま並べます。/);
    expect(lead).toHaveTextContent("本会議でどう投票したか");
    expect(lead).toHaveTextContent("本会議と委員会で何を発言したか");
    expect(lead.textContent).not.toContain("本会議でどう投票し、どの法案を出し、何を発言したか");
  });

  it("評価語を含まない", () => {
    const { container } = renderHome();
    for (const word of EVALUATIVE_WORDS) {
      expect(container.textContent).not.toContain(word);
    }
  });

  it("サイト共通フッターに利用規約・プライバシーポリシーのリンクがある（#167）", () => {
    renderHome();
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
    expect(within(footer).getByRole("link", { name: "プライバシーポリシー" })).toHaveAttribute("href", "/privacy");
  });

  it("検索入口は /members へ向く", () => {
    renderHome();
    expect(screen.getByRole("link", { name: /議員一覧/ })).toHaveAttribute("href", "/members");
  });

  it("郵便番号の入力欄がさがす入口にある（#112）", () => {
    renderHome();
    const entry = screen.getByRole("region", { name: "さがす" });
    expect(within(entry).getByRole("textbox", { name: /郵便番号/ })).toBeInTheDocument();
    expect(within(entry).getByRole("button", { name: "選挙区をさがす" })).toBeInTheDocument();
  });

  it("プリレンダー（JS 無し）の HTML では入力欄の代わりに /members へのリンクを出す", () => {
    const html = renderToString(
      <MemoryRouter>
        <Home data={dataset} />
      </MemoryRouter>,
    );
    expect(html).not.toContain("<input");
    expect(html).toContain('href="/members"');
    expect(html).toContain("選挙区からさがす");
  });

  it("最近の本会議採決は日付降順で上位4件を出し、各件が採決ページへリンクする", () => {
    renderHome();
    const section = screen.getByRole("region", { name: "最近の本会議採決" });
    const items = section.querySelectorAll("li");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent("日本国憲法の改正手続に関する法律の一部を改正する法律案");
    expect(items[0]).toHaveTextContent("2026.07.24");
    expect(items[0]).toHaveTextContent("可決");
    expect(items[0].querySelector("a")).toHaveAttribute("href", "/rollcalls/221/221-0724-v001");
    expect(section.textContent).not.toContain("一番古い案件");
  });

  it("採決が無ければ「最近の本会議採決」を出さない", () => {
    renderHome({ ...dataset, rollcalls: [] });
    expect(screen.queryByRole("region", { name: "最近の本会議採決" })).not.toBeInTheDocument();
  });

  it("規模（議員数・回次）を出す", () => {
    renderHome();
    const section = screen.getByRole("region", { name: "このサイトにあるもの" });
    expect(section).toHaveTextContent("3");
    expect(section).toHaveTextContent("参議院議員");
    expect(section).toHaveTextContent("第220—221回");
  });

  it("規模に衆議院議員数を出し、衆院の注記の文言を保つ", () => {
    const shugiin = { ...dataset.members[0], id: "h_000001", name: "衆 太郎", kana: "しゅう たろう", house: "shugiin" as const };
    renderHome({ ...dataset, members: [...dataset.members, shugiin, { ...shugiin, id: "h_000002" }] });
    const section = screen.getByRole("region", { name: "このサイトにあるもの" });
    const figures = within(section).getAllByText(/議員$/).map((el) => `${el.previousElementSibling?.textContent} ${el.textContent}`);
    expect(figures).toContain("3 参議院議員");
    expect(figures).toContain("2 衆議院議員");
    expect(section).toHaveTextContent("衆議院は個人の投票記録が公開されていないため、会派の態度として別に扱います");
  });

  // #351: 元職を足すと参院が 307 名になり、**定数248を超える**。読者は「参議院議員が307人いる」と読む。
  // fixture に元職が1人も居なかったので、この分岐は検査されていなかった（Sprint 18 レトロの形）。
  it("元職（current: false）は数えない。定数を超える人数を出さない", () => {
    const former = { ...dataset.members[0], id: "m_former1", name: "元職 一郎", kana: "もとしょく いちろう", current: false };
    const former2 = { ...dataset.members[0], id: "m_former2", name: "元職 二郎", kana: "もとしょく じろう", current: false };
    renderHome({ ...dataset, members: [...dataset.members, former, former2] });
    const section = screen.getByRole("region", { name: "このサイトにあるもの" });
    const figures = within(section).getAllByText(/議員$/).map((el) => `${el.previousElementSibling?.textContent} ${el.textContent}`);
    // 現職3名のまま（元職2名を足して 5 にしない）
    expect(figures).toContain("3 参議院議員");
    expect(figures).not.toContain("5 参議院議員");
  });

  it("current を持たない古いデータは現職として数える（/members の既定と同じ扱い）", () => {
    const noFlag = { ...dataset.members[0], id: "m_noflag", name: "旗なし 三郎", kana: "はたなし さぶろう" };
    delete (noFlag as { current?: boolean }).current;
    renderHome({ ...dataset, members: [...dataset.members, noFlag] });
    const section = screen.getByRole("region", { name: "このサイトにあるもの" });
    const figures = within(section).getAllByText(/議員$/).map((el) => `${el.previousElementSibling?.textContent} ${el.textContent}`);
    expect(figures).toContain("4 参議院議員");
  });

  it("規模に地方議会の数を出す（assemblies/index.json の national 以外。無ければ［集計中］）。議会一覧へのリンクがある（#158）", () => {
    const miyagi = { id: "pref-04" as const, kind: "prefectural" as const, name: "宮城県議会", prefCode: "04", sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/meibo/index.html" };
    renderHome({ ...dataset, assemblies: [...DIET_ASSEMBLIES, miyagi] });
    const section = screen.getByRole("region", { name: "このサイトにあるもの" });
    const local = within(section).getByText("地方議会");
    expect(local.previousElementSibling).toHaveTextContent("1");
    expect(screen.getByRole("link", { name: /議会一覧/ })).toHaveAttribute("href", "/assemblies");
  });

  it("assemblies/index.json が無い古いデータでは地方議会は［集計中］", () => {
    renderHome();
    const section = screen.getByRole("region", { name: "このサイトにあるもの" });
    expect(within(section).getByText("地方議会").previousElementSibling).toHaveTextContent("［集計中］");
  });

  it("出典と更新時刻を出す", () => {
    renderHome();
    const section = screen.getByRole("region", { name: "出典と更新" });
    expect(section).toHaveTextContent("参議院 本会議投票結果");
    expect(section).toHaveTextContent("2026.08.22 06:00");
    expect(screen.getByRole("link", { name: "参議院 本会議投票結果" })).toHaveAttribute(
      "href",
      "https://www.sangiin.go.jp/japanese/joho1/kousei/vote/221/221-0000/votelist.html",
    );
  });

  it("データが無くても落ちず、規模は［集計中］になる", () => {
    renderHome({ meta: undefined, members: [], rollcalls: [] });
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "このサイトにあるもの" })).toHaveTextContent("［集計中］");
  });

  describe("フッターの支援リンク", () => {
    it("/terms#funding への控えめなリンクがあり、ボタンではない（#174）", () => {
      renderHome();
      const link = screen.getByRole("link", { name: "支援する" });
      expect(link).toHaveAttribute("href", "/terms#funding");
      expect(link.className).not.toMatch(/button|btn|entry__link/);
      expect(link.closest(".links")).not.toBeNull();
    });

    it("運動的な言葉を含まない", () => {
      const { container } = renderHome();
      for (const word of CAMPAIGN_WORDS) {
        expect(container.textContent).not.toContain(word);
      }
    });
  });
});

describe("meta()", () => {
  it("title はサイト名、canonical と OGP（website）を持つ", () => {
    const tags = routeMeta({ location: { pathname: "/" } } as unknown as Parameters<typeof routeMeta>[0]);
    expect(tags).toContainEqual({ title: "議員レコード" });
    expect(tags).toContainEqual({ tagName: "link", rel: "canonical", href: "/" });
    expect(tags).toContainEqual({ property: "og:type", content: "website" });
    expect(tags).toContainEqual({ name: "description", content: expect.stringContaining("評価はしません") });
  });
});
