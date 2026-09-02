import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import About from "./about";
import { dataset } from "../test-fixtures/dataset";

/**
 * #69 節ごとの分割は純粋なリファクタ。分割前の /about の描画結果を
 * app/test-fixtures/about/*.html に保存し、HTML とテキストが一致することを保証する。
 * フィクスチャは <main> の描画結果。サイト共通フッター（#167、<main> の外）は比較対象に含めない。
 * #218 で FactsSection の収録範囲の記述（「1998年（第142回国会）以降。」）を /coverage へのリンクに置き換えたので、
 * フィクスチャもその分だけ更新している（それ以外の文言は分割前のまま）。
 * #251 で FactsSection に「衆議院の記録が議員ページに紐づく範囲」への導線を 1 行足したので、同じくその分だけ更新している。
 * #242 で発言の収録範囲が本会議だけでなく委員会も含むようになったので、FactsSection の「本会議発言」を
 * 「本会議と委員会の発言」に直し、フィクスチャもその 2 文字列だけ置換して更新している（それ以外の文言は分割前のまま）。
 * #358 で FactsSection に「地方議会の表決」（事実）のカードを 1 枚足したので、フィクスチャもその分だけ更新している。
 * 差分がそのカードだけであることを確認済み（それ以外の文言は分割前のまま）。
 */
const FIXTURE_DIR = join(__dirname, "../test-fixtures/about");
const fixture = (name: string) => readFileSync(join(FIXTURE_DIR, name), "utf8");

function renderAbout(data = dataset) {
  const { container } = render(
    <MemoryRouter>
      <About data={data} />
    </MemoryRouter>,
  );
  const main = container.querySelector("main");
  if (!main) throw new Error("<main> がない");
  return main;
}

describe("About（分割前との一致）", () => {
  it("データありの描画 HTML とテキストが分割前と一致する", () => {
    const main = renderAbout();
    const before = fixture("with-data.html");
    expect(main.outerHTML).toBe(before);
    const div = document.createElement("div");
    div.innerHTML = before;
    expect(main.textContent).toBe(div.textContent);
  });

  it("meta なしの描画 HTML が分割前と一致する", () => {
    const main = renderAbout({ meta: undefined, members: [], rollcalls: [] });
    expect(main.outerHTML).toBe(fixture("without-meta.html"));
  });
});
