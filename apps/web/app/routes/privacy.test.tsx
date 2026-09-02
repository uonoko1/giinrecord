import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import Privacy, { PRIVACY_UPDATED } from "./privacy";

/**
 * プライバシーポリシーは**このサイトで最も正確であるべき文書**なのに、テストが1件も無かった
 * （Issue 380 で気づいた）。「書いていないものが保存されている」状態を防ぐ。
 *
 * ここで検査するのは**約束の内容**であって文言そのものではない。文言を磨くのは自由だが、
 * 「Cookie を使わない」「保存するものを全部書く」という約束が消えたら落ちる。
 */
const body = () => (document.querySelector("main") as HTMLElement).textContent ?? "";

describe("/privacy", () => {
  it("ブラウザに保存するものを全部書く（localStorage と sessionStorage）", () => {
    render(<MemoryRouter><Privacy /></MemoryRouter>);
    const t = body();
    // localStorage に入れる2つ（比較の議員一覧・テーマ）
    expect(t).toContain("localStorage");
    expect(t).toContain("比較");
    expect(t).toContain("テーマ");
    // Issue 380: React Router がスクロール位置を sessionStorage に入れる。中身は無害だが書く
    expect(t).toContain("sessionStorage");
    expect(t).toContain("スクロール位置");
    // 誤解を生まないための2点：タブを閉じれば消える／URL は残らない
    expect(t).toContain("タブを閉じると消えます");
    expect(t).toMatch(/URL は残らず|URL は残りません/);
  });

  it("Cookie を使わないと言い切る", () => {
    render(<MemoryRouter><Privacy /></MemoryRouter>);
    expect(body()).toContain("Cookie は使いません");
  });

  it("第三者に送らないと言い切る", () => {
    render(<MemoryRouter><Privacy /></MemoryRouter>);
    expect(body()).toContain("第三者に送りません");
  });

  it("エラー時の IP という例外を隠さない", () => {
    render(<MemoryRouter><Privacy /></MemoryRouter>);
    const t = body();
    expect(t).toContain("IP アドレスは記録しません");
    expect(t).toMatch(/エラー時の診断ログ|接続に失敗したとき/);
  });

  it("更新日を出す（本文を変えたら改める約束）", () => {
    render(<MemoryRouter><Privacy /></MemoryRouter>);
    expect(screen.getByText(PRIVACY_UPDATED)).toBeInTheDocument();
    expect(PRIVACY_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
