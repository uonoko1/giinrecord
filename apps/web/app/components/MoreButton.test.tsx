import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { MoreButton } from "./MoreButton";

// #393: 「さらに表示」を押すとボタンが消え、フォーカスが <body> に落ちていた。
// 本番で実測: 押す前 BUTTON.members-more-button → 押した後 BODY、rows 229 → 997。
// キーボード / スクリーンリーダーの利用者は文書の先頭へ戻され、続きを読むには
// 997 件を頭からたどり直すことになる。押した人ほど不利になる。

function Harness({ total, fold, unit = "件" }: { total: number; fold: number; unit?: string }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? total : Math.min(fold, total);
  return (
    <div>
      <ul>
        {Array.from({ length: shown }, (_, i) => (
          <li key={i}>行{i + 1}</li>
        ))}
      </ul>
      <MoreButton hidden={total - shown} unit={unit} className="members" onExpand={() => setExpanded(true)} />
    </div>
  );
}

describe("MoreButton（#393）", () => {
  it("残り件数と単位を出す", () => {
    render(<Harness total={1000} fold={200} />);
    expect(screen.getByRole("button", { name: "さらに表示（残り800件）" })).toBeTruthy();
  });

  it("単位は差し替えられる（名簿は「名」）", () => {
    render(<Harness total={300} fold={200} unit="名" />);
    expect(screen.getByRole("button", { name: "さらに表示（残り100名）" })).toBeTruthy();
  });

  it("残りが 0 なら何も描かない（押していない状態）", () => {
    const { container } = render(<Harness total={10} fold={200} />);
    expect(container.querySelector(".members-more")).toBeNull();
  });

  it("押すと全件出る", () => {
    render(<Harness total={1000} fold={200} />);
    expect(document.querySelectorAll("li").length).toBe(200);
    fireEvent.click(screen.getByRole("button"));
    expect(document.querySelectorAll("li").length).toBe(1000);
  });

  // ここが #393 の本体
  it("押した後、フォーカスが <body> に落ちない", () => {
    render(<Harness total={1000} fold={200} />);
    const button = screen.getByRole("button");
    button.focus();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);

    expect(document.activeElement).not.toBe(document.body);
  });

  it("フォーカスの移り先は、続きが出たことを知らせる要素", () => {
    render(<Harness total={1000} fold={200} />);
    const button = screen.getByRole("button");
    button.focus();
    fireEvent.click(button);

    const active = document.activeElement as HTMLElement;
    expect(active.textContent).toContain("続きを表示しました");
    // クリックでは拾わず .focus() でだけ受け取る（tabindex=-1）
    expect(active.getAttribute("tabindex")).toBe("-1");
  });

  it("移り先はボタンがあった位置（続きの手前）で、続きの行より前にある", () => {
    render(<Harness total={1000} fold={200} />);
    const button = screen.getByRole("button");
    button.focus();
    fireEvent.click(button);

    const active = document.activeElement as HTMLElement;
    const list = document.querySelector("ul")!;
    // 続きの行はリストの中。移り先はその外（リストの後ろ）にあり、読み上げの位置が保たれる
    expect(list.contains(active)).toBe(false);
  });

  it("読み上げに変化を伝える（role=status）", () => {
    render(<Harness total={1000} fold={200} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("status").textContent).toContain("続きを表示しました");
  });

  // 押した**後**の再描画でこそ差が出る。移り先が DOM にある状態で、
  // 利用者が別の場所へフォーカスを移したあとに再描画されたとき、奪い返してはいけない。
  // （押していない再描画で試すと移り先がそもそも無く、`pressed` の判定を外しても
  //   素通りする——最初に書いたテストはこれで何も守っていなかった）
  it("展開した後の再描画で、利用者が移したフォーカスを奪い返さない", () => {
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    const { rerender } = render(<Harness total={1000} fold={200} />);

    const button = screen.getByRole("button");
    button.focus();
    fireEvent.click(button);
    expect(screen.getByRole("status")).toBe(document.activeElement);

    // 読み進めて、別の場所へフォーカスを移した
    outside.focus();
    expect(document.activeElement).toBe(outside);

    // 何かの拍子に再描画されても、移り先へ引き戻さない
    rerender(<Harness total={1000} fold={200} />);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("aria-controls を渡せる（展開される領域を指す）", () => {
    render(
      <div>
        <section id="the-list" />
        <MoreButton hidden={5} unit="件" className="members" controls="the-list" onExpand={() => {}} />
      </div>,
    );
    expect(screen.getByRole("button").getAttribute("aria-controls")).toBe("the-list");
  });

  it("class は呼び出し側の接頭辞に従う（既存の見た目を保つ）", () => {
    const { container } = render(<MoreButton hidden={5} unit="件" className="rollcalls" onExpand={() => {}} />);
    expect(container.querySelector(".rollcalls-more")).toBeTruthy();
    expect(container.querySelector(".rollcalls-more-button")).toBeTruthy();
  });
});
