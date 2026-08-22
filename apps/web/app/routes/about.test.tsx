import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import About, { meta as routeMeta } from "./about";
import { dataset } from "../test-fixtures/dataset";

const EVALUATIVE_WORDS = ["おすすめ", "ランキング", "一致率"];
/** 運動的・煽り的な言葉。事実と依頼だけを書く（#47）。 */
const CAMPAIGN_WORDS = ["応援", "守る", "守ろう", "ぜひ", "お願いします", "あなたの力", "みんなで", "寄付をお願い"];

function renderAbout(data = dataset) {
  return render(
    <MemoryRouter>
      <About data={data} />
    </MemoryRouter>,
  );
}

describe("About", () => {
  it("方針文と各節の見出しがある", () => {
    renderAbout();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("このデータについて");
    expect(screen.getByText(/評価・採点・推薦はしません。すべての行に出典があります。/)).toBeInTheDocument();
    for (const name of ["何が事実で、何が推定か", "記録にないこと", "更新", "検証する", "運営費について"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
  });

  it("事実と推定を文字で区別する", () => {
    renderAbout();
    expect(screen.getAllByText("事実")).toHaveLength(2);
    expect(screen.getAllByText("推定")).toHaveLength(1);
    expect(screen.getByText("参議院の記名・押しボタン投票")).toBeInTheDocument();
    expect(screen.getByText("衆議院の賛否（準備中）")).toBeInTheDocument();
  });

  it("記録にないことを列挙する", () => {
    renderAbout();
    expect(screen.getByText("「投票なし」が欠席か棄権か")).toBeInTheDocument();
    expect(screen.getByText("選挙公約との一致・不一致の判定")).toBeInTheDocument();
  });

  it("評価語を含まない", () => {
    const { container } = renderAbout();
    for (const word of EVALUATIVE_WORDS) {
      expect(container.textContent).not.toContain(word);
    }
  });

  it("更新時刻を出典ごとに出す", () => {
    renderAbout();
    expect(screen.getByText("参議院 本会議投票結果")).toBeInTheDocument();
    expect(screen.getAllByText("2026.08.22 06:00").length).toBeGreaterThan(0);
  });

  it("検証するのリンクはリポジトリ URL を指す", () => {
    renderAbout();
    const repo = "https://github.com/uonoko1/seiji-kiroku";
    expect(screen.getByRole("link", { name: "ソースコード" })).toHaveAttribute("href", repo);
    expect(screen.getByRole("link", { name: "誤りを報告" })).toHaveAttribute("href", `${repo}/issues/new`);
  });

  it("データ一括取得は自サイトの zip（/data/data-archive.zip）を指し、ライセンスを添える（#49）", () => {
    renderAbout();
    const link = screen.getByRole("link", { name: "データ一括取得" });
    expect(link).toHaveAttribute("href", "/data/data-archive.zip");
    expect(link).toHaveAttribute("download");
    const section = screen.getByRole("region", { name: "検証する" });
    expect(section).toHaveTextContent("CC BY 4.0");
    expect(section).toHaveTextContent("政治記録");
    expect(screen.getByRole("link", { name: "GitHub のデータ" })).toHaveAttribute("href", "https://github.com/uonoko1/seiji-kiroku/tree/main/data");
  });

  it("データが無くても落ちない", () => {
    renderAbout({ meta: undefined, members: [], rollcalls: [] });
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
  });

  describe("運営費について", () => {
    it("費用・収入源・受け取らないもの・公開の約束を書く", () => {
      renderAbout();
      const section = screen.getByRole("region", { name: "運営費について" });
      expect(section).toHaveTextContent("VPS");
      expect(section).toHaveTextContent("未算出");
      expect(section).toHaveTextContent("ドメイン");
      expect(section).toHaveTextContent("取得予定");
      expect(section).toHaveTextContent("運営者の自費");
      expect(section).toHaveTextContent("政党・候補者・業界団体からは一切受け取りません");
      expect(section).toHaveTextContent("資金源と支出を公開します");
    });

    it("広告は将来の可能性として予告だけする", () => {
      renderAbout();
      const section = screen.getByRole("region", { name: "運営費について" });
      expect(section).toHaveTextContent("政治カテゴリを除外した広告");
      expect(section.querySelector("ins, iframe, script")).toBeNull();
    });

    it("支援リンクはリポジトリ URL を指す（GitHub Sponsors 有効化までの代替）", () => {
      renderAbout();
      expect(screen.getByRole("link", { name: "支援する" })).toHaveAttribute("href", "https://github.com/uonoko1/seiji-kiroku");
    });

    it("運動的な言葉を含まない", () => {
      const { container } = renderAbout();
      for (const word of CAMPAIGN_WORDS) {
        expect(container.textContent).not.toContain(word);
      }
    });
  });

  describe("計測について（#58）", () => {
    it("見出しがあり、何を記録し何を記録しないかを書く", () => {
      renderAbout();
      expect(screen.getByRole("heading", { level: 2, name: "計測について" })).toBeInTheDocument();
      const text = screen.getByRole("heading", { level: 2, name: "計測について" }).parentElement?.textContent ?? "";
      expect(text).toContain("Cookie");
      expect(text).toContain("IP アドレス");
      expect(text).toMatch(/ページビュー|PV/);
      expect(text).toContain("リファラ");
    });
  });
});

describe("meta()", () => {
  it("title・description・canonical を持つ", () => {
    const tags = routeMeta({ location: { pathname: "/about" } } as unknown as Parameters<typeof routeMeta>[0]);
    expect(tags).toContainEqual({ title: "このデータについて ・ 政治記録" });
    expect(tags).toContainEqual({ name: "description", content: expect.any(String) });
    expect(tags).toContainEqual({ tagName: "link", rel: "canonical", href: "/about" });
  });
});
