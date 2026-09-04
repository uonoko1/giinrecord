import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import Home, { meta as routeMeta } from "./home";
import { DIET_ASSEMBLIES } from "../lib/data-contract";
import { dataset, membersByAssembly } from "../test-fixtures/dataset";
import type { MemberAssemblyCount } from "@seiji-kiroku/shared";

const EVALUATIVE_WORDS = ["おすすめ", "ランキング", "一致率"];
const CAMPAIGN_WORDS = ["応援", "守る", "守ろう", "ぜひ", "お願いします", "あなたの力", "みんなで"];

function renderHome(data = dataset, byAssembly: readonly MemberAssemblyCount[] = membersByAssembly) {
  return render(
    <MemoryRouter>
      <Home data={data} membersByAssembly={byAssembly} />
    </MemoryRouter>,
  );
}

/** 「N 参議院議員」の形で、規模の節に出ている人数を全部拾う */
function figures() {
  const section = screen.getByRole("region", { name: "このサイトにあるもの" });
  return within(section).getAllByText(/議員$/).map((el) => `${el.previousElementSibling?.textContent} ${el.textContent}`);
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

  // #358: このリード文は seoMeta() にも渡るので、検索結果とソーシャルカードにも出る。
  // 地方議会（7議会・285名・1,089件の表決）を収録しているのに国会だけを指していると、
  // 検索から来た人に「書いてあることと違う」と感じさせる。
  it("リード文と meta description が、国会と地方議会の両方を指す", () => {
    renderHome();
    const lead = screen.getByText(/公式記録だけを、そのまま並べます。/);
    expect(lead).toHaveTextContent("国会議員");
    expect(lead).toHaveTextContent("地方議会");

    // meta() が返す description も同じ文言であること（片方だけ直すのを防ぐ）
    const tags = routeMeta({ location: { pathname: "/" } } as unknown as Parameters<typeof routeMeta>[0]);
    const description = tags.find((t): t is { name: string; content: string } => "name" in t && t.name === "description");
    expect(description?.content).toContain("地方議会");
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
    renderHome(dataset, [...membersByAssembly, { assemblyId: "diet-shugiin", current: 2, total: 2 }]);
    expect(figures()).toContain("3 参議院議員");
    expect(figures()).toContain("2 衆議院議員");
    expect(screen.getByRole("region", { name: "このサイトにあるもの" })).toHaveTextContent("衆議院は個人の投票記録が公開されていないため、会派の態度として別に扱います");
  });

  /*
   * #351: 元職を足すと参院が 307 名になり、**定数248を超える**。読者は「参議院議員が307人いる」と読む。
   * #441 で数えるのは ETL（`members/by-assembly.json` の `current` と `total`）になったので、
   * この画面の責任は「**どちらの列を読むか**」に変わった。current（現職）を読み、total（元職を含む）を読まない。
   * fixture の diet-sangiin は current 3 / total 4 で、**わざと違う数**にしてある（同じ数だと見分けられない）。
   */
  it("現職（current）を出す。元職を含む total は出さない", () => {
    renderHome(dataset, [{ assemblyId: "diet-sangiin", current: 3, total: 4 }]);
    expect(figures()).toContain("3 参議院議員");
    expect(figures()).not.toContain("4 参議院議員");
  });

  it("院を取り違えない（参院の数を衆院に出さない）", () => {
    renderHome(dataset, [
      { assemblyId: "diet-sangiin", current: 247, total: 307 },
      { assemblyId: "diet-shugiin", current: 465, total: 465 },
    ]);
    expect(figures()).toContain("247 参議院議員");
    expect(figures()).toContain("465 衆議院議員");
  });

  it("その議会の行が無ければ［集計中］（0 と書かない）", () => {
    renderHome(dataset, [{ assemblyId: "diet-sangiin", current: 3, total: 4 }]);
    const section = screen.getByRole("region", { name: "このサイトにあるもの" });
    expect(within(section).getByText("衆議院議員").previousElementSibling).toHaveTextContent("［集計中］");
  });

  it("地方議会の行は院の人数に混ぜない（#441）", () => {
    renderHome(dataset, [...membersByAssembly, { assemblyId: "pref-04", current: 56, total: 56 }]);
    expect(figures()).toContain("3 参議院議員");
    expect(figures()).not.toContain("59 参議院議員");
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
    renderHome({ meta: undefined, rollcalls: [] }, []);
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

/**
 * Issue 441: `members/index.json`（gzip 40KB）を `dataset` から切り出した。
 * **既定の経路＝本番が通る道**をここで通す（#411 / #408 の学び。全部 prop を渡すテストしか無いと、
 * 既定が黙って 0 名になっても全部緑のまま）。
 *
 * **期待値は集計（by-assembly.json）から作らない。** 生の `members/index.json` を直に数える。
 */
describe("/ の既定（bundled）で議員数が出る（Issue 441）", () => {
  const rawMembers: { house?: string; current?: boolean }[] = JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../../data/members/index.json"), "utf8"),
  );
  const rawCurrent = (house: string) => rawMembers.filter((m) => m.house === house && m.current !== false).length;

  it("data も集計も渡さずに描くと、現職の人数が members/index.json を直に数えた値と一致する", () => {
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>,
    );
    const shown = (label: string) => {
      const section = screen.getByRole("region", { name: "このサイトにあるもの" });
      return Number((within(section).getByText(label).previousElementSibling?.textContent ?? "").replace(/,/g, ""));
    };
    // **現職だけ**（#351）。元職を含む total を出したら落ちる: 実データは参院が current 247 / total 307
    expect(shown("参議院議員")).toBe(rawCurrent("sangiin"));
    expect(shown("衆議院議員")).toBe(rawCurrent("shugiin"));
    // 元職を足した数（定数248超え）を出していないことを名指しで固定する
    expect(shown("参議院議員")).not.toBe(rawMembers.filter((m) => m.house === "sangiin").length);
  });
});
