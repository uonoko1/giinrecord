import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INSTALL_PROMPT_KEY } from "../lib/install-prompt";
import { InstallLink } from "./InstallLink";

function makeEvent() {
  const e = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt: ReturnType<typeof vi.fn>; userChoice: Promise<unknown> };
  e.prompt = vi.fn(() => Promise.resolve());
  e.userChoice = new Promise(() => {});
  return e;
}

const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14) Chrome/128";
const IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1";

function stubMatchMedia(standalone: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: standalone && q === "(display-mode: standalone)", media: q, addEventListener() {}, removeEventListener() {} })),
  );
}

beforeEach(() => {
  stubMatchMedia(false);
  Object.defineProperty(navigator, "userAgent", { value: ANDROID_UA, configurable: true });
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[INSTALL_PROMPT_KEY];
  // `Object.defineProperty` で navigator 自身に生やした own プロパティは `vi.unstubAllGlobals()` で戻らない。
  // 消さないと**次に走るファイル**が Android / iPhone の UA を見る（#512）。
  delete (navigator as { userAgent?: string }).userAgent;
  vi.unstubAllGlobals();
});

describe("InstallLink（#191）", () => {
  it("非対応ブラウザでは何も描画しない（プリレンダー HTML にも出ない）", () => {
    const { container } = render(<InstallLink />);
    expect(container.innerHTML).toBe("");
  });

  it("beforeinstallprompt 捕捉後に「ホーム画面に追加」ボタンを出し、クリックで prompt() を呼ぶ", () => {
    render(<InstallLink />);
    const e = makeEvent();
    act(() => {
      window.dispatchEvent(e);
    });
    const button = screen.getByRole("button", { name: "ホーム画面に追加" });
    expect(button).toHaveAttribute("type", "button");
    fireEvent.click(button);
    expect(e.prompt).toHaveBeenCalledTimes(1);
  });

  it("iOS では押すと「共有 → ホーム画面に追加」の手順を1行出す（prompt は無い）", () => {
    Object.defineProperty(navigator, "userAgent", { value: IOS_UA, configurable: true });
    render(<InstallLink />);
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "ホーム画面に追加" }));
    const hint = screen.getByRole("status");
    expect(hint.textContent).toContain("共有");
    expect(hint.textContent).toContain("ホーム画面に追加");
  });

  it("インストール済み（standalone）では描画しない", () => {
    stubMatchMedia(true);
    (window as unknown as Record<string, unknown>)[INSTALL_PROMPT_KEY] = makeEvent();
    const { container } = render(<InstallLink />);
    expect(container.innerHTML).toBe("");
  });
});
