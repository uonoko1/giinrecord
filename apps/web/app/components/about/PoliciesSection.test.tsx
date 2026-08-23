import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PoliciesSection } from "./PoliciesSection";

function renderSection() {
  return render(
    <MemoryRouter>
      <PoliciesSection />
    </MemoryRouter>,
  );
}

describe("PoliciesSection（#166）", () => {
  it("id=policies の region で、利用規約とプライバシーポリシーへのリンクを置く", () => {
    renderSection();
    const section = screen.getByRole("region", { name: "規約とプライバシー" });
    expect(section).toHaveAttribute("id", "policies");
    expect(screen.getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "プライバシーポリシー" })).toHaveAttribute("href", "/privacy");
  });

  it("計測の説明は書かない（プライバシーポリシーへ移動、#167）", () => {
    const { container } = renderSection();
    for (const word of ["Cookie", "IP アドレス", "リファラ", "ページビュー"]) {
      expect(container.textContent).not.toContain(word);
    }
  });
});

describe("PoliciesSection のインストール導線（#191）", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("既定ではボタンを出さない（プリレンダー HTML は変わらない）", () => {
    renderSection();
    expect(screen.queryByRole("button", { name: "ホーム画面に追加" })).toBeNull();
  });

  it("beforeinstallprompt 捕捉後は節の末尾に「ホーム画面に追加」を出す", () => {
    vi.stubGlobal("matchMedia", vi.fn((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })));
    renderSection();
    const e = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt: () => Promise<void>; userChoice: Promise<unknown> };
    e.prompt = () => Promise.resolve();
    e.userChoice = new Promise(() => {});
    act(() => {
      window.dispatchEvent(e);
    });
    const section = screen.getByRole("region", { name: "規約とプライバシー" });
    const button = screen.getByRole("button", { name: "ホーム画面に追加" });
    expect(section.lastElementChild).toContainElement(button);
  });
});
