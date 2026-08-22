import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import About from "./about";
import { dataset } from "../test-fixtures/dataset";

const EVALUATIVE_WORDS = ["おすすめ", "ランキング", "一致率"];

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
    for (const name of ["何が事実で、何が推定か", "記録にないこと", "更新", "検証する"]) {
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
    expect(screen.getByRole("link", { name: "データ一括取得" })).toHaveAttribute("href", `${repo}/tree/main/data`);
    expect(screen.getByRole("link", { name: "誤りを報告" })).toHaveAttribute("href", `${repo}/issues/new`);
  });

  it("データが無くても落ちない", () => {
    renderAbout({ meta: undefined, members: [], rollcalls: [] });
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
  });
});
