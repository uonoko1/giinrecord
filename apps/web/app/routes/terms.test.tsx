import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import Terms, { TERMS_UPDATED } from "./terms";

/**
 * 利用規約はサイトの約束を述べる文書なのに、テストが1件も無かった（Issue 383 で気づいた。
 * /privacy も同じで Issue 380 で足した）。検査するのは**約束の内容**であって文言そのものではない。
 */
const body = () => (document.querySelector("main") as HTMLElement).textContent ?? "";
const show = () => render(<MemoryRouter><Terms /></MemoryRouter>);

describe("/terms", () => {
  it("サイトの範囲に地方議会を含む（国会だけと言わない）", () => {
    show();
    const t = body();
    expect(t).toContain("参議院");
    expect(t).toContain("衆議院");
    expect(t).toContain("国立国会図書館");
    // Issue 383: 地方議会 7・議員 285名・表決 1,089件を収録しているのに書いていなかった
    expect(t).toContain("地方議会");
  });

  it("評価しないと言い切る", () => {
    show();
    expect(body()).toMatch(/評価・採点・推薦はしません/);
  });

  it("一次資料が優先することを書く（誤りがありうると認める）", () => {
    show();
    const t = body();
    expect(t).toContain("一次資料が優先");
    expect(t).toMatch(/保証しません/);
  });

  it("政党・候補者・業界団体から受け取っていないと明記する", () => {
    show();
    expect(body()).toMatch(/政党・候補者・業界団体からは受け取っていません/);
  });

  it("ライセンスを書く（データ CC BY 4.0 / コード MIT）", () => {
    show();
    const t = body();
    expect(t).toContain("CC BY 4.0");
    expect(t).toContain("MIT");
  });

  it("更新日を出す（変更したら改める約束）", () => {
    show();
    expect(screen.getByText(TERMS_UPDATED)).toBeInTheDocument();
    expect(TERMS_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
