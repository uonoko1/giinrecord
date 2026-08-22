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
 */
const FIXTURE_DIR = join(__dirname, "../test-fixtures/about");
const fixture = (name: string) => readFileSync(join(FIXTURE_DIR, name), "utf8");

function renderAbout(data = dataset) {
  return render(
    <MemoryRouter>
      <About data={data} />
    </MemoryRouter>,
  ).container;
}

describe("About（分割前との一致）", () => {
  it("データありの描画 HTML とテキストが分割前と一致する", () => {
    const container = renderAbout();
    const before = fixture("with-data.html");
    expect(container.innerHTML).toBe(before);
    const div = document.createElement("div");
    div.innerHTML = before;
    expect(container.textContent).toBe(div.textContent);
  });

  it("meta なしの描画 HTML が分割前と一致する", () => {
    const container = renderAbout({ meta: undefined, members: [], rollcalls: [] });
    expect(container.innerHTML).toBe(fixture("without-meta.html"));
  });
});
