import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INSTALL_PROMPT_KEY } from "../lib/install-prompt";
import { SiteFooter } from "./SiteFooter";

/** ルーター文脈なしで描画できること自体が仕様（MemberPage はルーター無しでテストされる）。 */
function renderFooter() {
  return render(<SiteFooter />);
}

describe("SiteFooter（#167）", () => {
  it("利用規約・プライバシーポリシー・このデータについてへの内部リンクを持つ", () => {
    renderFooter();
    expect(screen.getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "プライバシーポリシー" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("link", { name: "このデータについて" })).toHaveAttribute("href", "/about");
  });

  it("収録範囲（/coverage、#218）への内部リンクを持つ", () => {
    renderFooter();
    expect(screen.getByRole("link", { name: "収録範囲" })).toHaveAttribute("href", "/coverage");
  });

  it("GitHub は外部リンクで noopener noreferrer", () => {
    renderFooter();
    const link = screen.getByRole("link", { name: "GitHub" });
    expect(link).toHaveAttribute("href", "https://github.com/uonoko1/giinrecord");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("contentinfo ランドマークである", () => {
    renderFooter();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });
});

describe("SiteFooter のインストール導線（#191）", () => {
  afterEach(() => {
    // `useInstallPrompt` は捕まえた beforeinstallprompt を window に**保存する**ので、
    // dispatch したテストは自分でそれを消す。消さないと実行順しだいで
    // **後ろに並んだ無関係なファイル**がボタンを描いて落ちる（#512）。
    delete (window as unknown as Record<string, unknown>)[INSTALL_PROMPT_KEY];
    vi.unstubAllGlobals();
  });

  it("既定（イベント未捕捉）ではボタンを出さない", () => {
    renderFooter();
    expect(screen.queryByRole("button", { name: "ホーム画面に追加" })).toBeNull();
  });

  it("beforeinstallprompt 捕捉後はリンク群の中に「ホーム画面に追加」を出す", () => {
    vi.stubGlobal("matchMedia", vi.fn((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })));
    renderFooter();
    const e = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt: () => Promise<void>; userChoice: Promise<unknown> };
    e.prompt = () => Promise.resolve();
    e.userChoice = new Promise(() => {});
    act(() => {
      window.dispatchEvent(e);
    });
    const button = screen.getByRole("button", { name: "ホーム画面に追加" });
    expect(screen.getByRole("navigation", { name: "サイト情報" })).toContainElement(button);
  });
});
