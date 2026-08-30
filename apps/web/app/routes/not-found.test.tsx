/**
 * Issue #325: 存在しない URL の画面（catch-all ルート）。
 * - 検索エンジンに索引させない（noindex）
 * - 利用者に「無い」と分かる本文と、/coverage/ への導線
 * - 評価語・煽り語を書かない（他ページと同じ規律）
 */
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import NotFound, { meta as notFoundMeta } from "./not-found";

function renderPage() {
  return render(
    <MemoryRouter>
      <NotFound />
    </MemoryRouter>,
  );
}

describe("meta（#325）", () => {
  const tags = notFoundMeta() as { title?: string; name?: string; content?: string }[];

  it("noindex を出す（存在しない URL を索引させない）", () => {
    expect(tags).toContainEqual({ name: "robots", content: "noindex" });
  });

  it("canonical も og:url も出さない（クエリ・パス依存で正規 URL が無い）", () => {
    expect(JSON.stringify(tags)).not.toMatch(/canonical|og:url/);
  });

  it("タイトルにサイト名が入る（外形監視の <title> 検査を通さないための素の Loading... ではない）", () => {
    const title = tags.find((t) => "title" in t)?.title;
    expect(title).toContain("議員レコード");
  });
});

describe("画面（#325）", () => {
  it("「見つかりません」と分かる見出しを出す", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("見つかりません");
  });

  // 受け入れ条件は「404 の画面が /coverage への導線を含む」こと。
  // SiteFooter も /coverage を貼っているので、ページ全体のリンクを数えると
  // **このページから導線を消しても通ってしまう**（実際に通った）。<main> の中だけを見る。
  it("収録範囲 /coverage への導線を、フッターではなくページ本体に出す（受け入れ条件）", () => {
    renderPage();
    const main = screen.getByRole("main");
    const links = within(main).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).toContain("/coverage");
  });

  it("議員一覧とトップへも、ページ本体から戻れる", () => {
    renderPage();
    const main = screen.getByRole("main");
    const links = within(main).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).toContain("/members");
    expect(links).toContain("/");
  });

  it("評価語・煽り語を書かない", () => {
    const { container } = renderPage();
    for (const w of ["おすすめ", "ランキング", "一致率", "評価", "採点", "応援"]) {
      expect(container.textContent).not.toContain(w);
    }
  });
});
