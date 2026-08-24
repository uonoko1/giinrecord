import { render, screen, within } from "@testing-library/react";
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
    for (const name of ["何が事実で、何が推定か", "記録にないこと", "更新", "検証する", "規約とプライバシー"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
  });

  it("事実と推定を文字で区別する", () => {
    renderAbout();
    expect(screen.getAllByText("事実")).toHaveLength(2);
    expect(screen.getAllByText("推定")).toHaveLength(1);
    expect(screen.getByText("参議院の記名・押しボタン投票")).toBeInTheDocument();
    expect(screen.getByText("衆議院の賛否")).toBeInTheDocument();
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
    const repo = "https://github.com/uonoko1/gikailog";
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
    expect(section).toHaveTextContent("議員レコード");
    expect(screen.getByRole("link", { name: "GitHub のデータ" })).toHaveAttribute("href", "https://github.com/uonoko1/gikailog/tree/main/data");
  });

  it("データが無くても落ちない", () => {
    renderAbout({ meta: undefined, members: [], rollcalls: [] });
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
  });

  describe("運営費（#174：節は削除し、検証する の末尾1文に集約）", () => {
    it("「運営費について」の節と id=funding は無い", () => {
      const { container } = renderAbout();
      expect(screen.queryByRole("heading", { level: 2, name: "運営費について" })).toBeNull();
      expect(container.querySelector("#funding")).toBeNull();
      expect(screen.queryByRole("link", { name: "支援する" })).toBeNull();
    });

    it("検証する の末尾に1文があり、利用規約（/terms）へリンクする", () => {
      renderAbout();
      const section = screen.getByRole("region", { name: "検証する" });
      expect(section).toHaveTextContent("運営者の自費で運営し、政党・候補者・業界団体からは受け取っていません。運営の方針は利用規約に書いています。");
      expect(within(section).getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
    });

    it("費目・金額は書かず、広告要素も置かない（#160）", () => {
      const { container } = renderAbout();
      for (const banned of ["VPS", "ドメイン", "未算出", "取得予定", "月額"]) {
        expect(container.textContent).not.toContain(banned);
      }
      expect(container.querySelector("ins, iframe, script")).toBeNull();
    });

    it("運動的な言葉を含まない", () => {
      const { container } = renderAbout();
      for (const word of CAMPAIGN_WORDS) {
        expect(container.textContent).not.toContain(word);
      }
    });
  });

  describe("規約とプライバシー（#166）", () => {
    it("計測の節は無く、本文の節に /terms と /privacy へのリンクがある", () => {
      const { container } = renderAbout();
      expect(screen.queryByRole("heading", { level: 2, name: "計測について" })).toBeNull();
      const policies = within(container.querySelector("main #policies") as HTMLElement);
      expect(policies.getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
      expect(policies.getByRole("link", { name: "プライバシーポリシー" })).toHaveAttribute("href", "/privacy");
    });

    it("サイト共通フッター（#167）も描画され、同じリンクを持つ", () => {
      renderAbout();
      const footer = within(screen.getByRole("contentinfo"));
      expect(footer.getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
      expect(footer.getByRole("link", { name: "プライバシーポリシー" })).toHaveAttribute("href", "/privacy");
    });
  });
});

describe("meta()", () => {
  it("title・description・canonical を持つ", () => {
    const tags = routeMeta({ location: { pathname: "/about" } } as unknown as Parameters<typeof routeMeta>[0]);
    expect(tags).toContainEqual({ title: "このデータについて ・ 議員レコード" });
    expect(tags).toContainEqual({ name: "description", content: expect.any(String) });
    expect(tags).toContainEqual({ tagName: "link", rel: "canonical", href: "/about" });
  });
});
