import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INSTALL_PROMPT_EVENT, INSTALL_PROMPT_KEY, installPromptInit, useInstallPrompt, type BeforeInstallPromptEvent } from "./install-prompt";

type InstallWindow = Window & { [INSTALL_PROMPT_KEY]?: BeforeInstallPromptEvent };
const w = () => window as InstallWindow;

function makeEvent(outcome: "accepted" | "dismissed" = "accepted") {
  const e = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
    prompt: ReturnType<typeof vi.fn>;
    userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  };
  e.prompt = vi.fn(() => Promise.resolve());
  e.userChoice = Promise.resolve({ outcome, platform: "web" });
  return e;
}

function stubMatchMedia(standalone: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: standalone && q === "(display-mode: standalone)", media: q, addEventListener() {}, removeEventListener() {} })),
  );
}

/**
 * `navigator.userAgent` は `Object.defineProperty` で **navigator 自身に**上書きするので、
 * `vi.unstubAllGlobals()` では戻らない。戻さないと**次に走るファイル**が Android の UA を見る（#512）。
 * 素の `userAgent` は `Navigator.prototype` の getter なので、
 * 自身に生えた own プロパティを `delete` すれば元の値が透ける（実測で確認）。
 */
function stubUserAgent(ua: string) {
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
}
function restoreUserAgent() {
  delete (navigator as { userAgent?: string }).userAgent;
}

beforeEach(() => {
  stubMatchMedia(false);
  stubUserAgent("Mozilla/5.0 (Linux; Android 14) Chrome/128");
});
afterEach(() => {
  delete w()[INSTALL_PROMPT_KEY];
  restoreUserAgent();
  vi.unstubAllGlobals();
});

describe("installPromptInit（ハイドレーション前のインラインスクリプト）", () => {
  it("beforeinstallprompt を preventDefault して window に保持し、カスタムイベントを発火する", () => {
    const seen = vi.fn();
    window.addEventListener(INSTALL_PROMPT_EVENT, seen);
    new Function(installPromptInit)();
    const e = makeEvent();
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(w()[INSTALL_PROMPT_KEY]).toBe(e);
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener(INSTALL_PROMPT_EVENT, seen);
  });

  it("スクリプトは外部 URL を含まず1行で完結する", () => {
    expect(installPromptInit).not.toMatch(/https?:/);
    expect(installPromptInit).not.toContain("\n");
  });
});

describe("useInstallPrompt", () => {
  it("初期状態は none（イベント未捕捉・非 iOS）", () => {
    const { result } = renderHook(() => useInstallPrompt());
    expect(result.current.state).toEqual({ kind: "none" });
  });

  it("マウント前に捕捉済みのイベントがあれば native になる", () => {
    w()[INSTALL_PROMPT_KEY] = makeEvent();
    const { result } = renderHook(() => useInstallPrompt());
    expect(result.current.state.kind).toBe("native");
  });

  it("マウント後の beforeinstallprompt も preventDefault して native になる", () => {
    const { result } = renderHook(() => useInstallPrompt());
    const e = makeEvent();
    act(() => {
      window.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(true);
    expect(result.current.state.kind).toBe("native");
  });

  it("インラインスクリプト経由（カスタムイベント）でも native になる", () => {
    const { result } = renderHook(() => useInstallPrompt());
    act(() => {
      w()[INSTALL_PROMPT_KEY] = makeEvent();
      window.dispatchEvent(new Event(INSTALL_PROMPT_EVENT));
    });
    expect(result.current.state.kind).toBe("native");
  });

  it("install() は保持したイベントの prompt() を呼び、accepted なら none に戻る", async () => {
    const e = makeEvent("accepted");
    w()[INSTALL_PROMPT_KEY] = e;
    const { result } = renderHook(() => useInstallPrompt());
    await act(async () => {
      await result.current.install();
    });
    expect(e.prompt).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ kind: "none" });
    expect(w()[INSTALL_PROMPT_KEY]).toBeUndefined();
  });

  it("install() が dismissed なら保持したまま native のまま", async () => {
    const e = makeEvent("dismissed");
    w()[INSTALL_PROMPT_KEY] = e;
    const { result } = renderHook(() => useInstallPrompt());
    await act(async () => {
      await result.current.install();
    });
    expect(result.current.state.kind).toBe("native");
  });

  it("appinstalled で none に戻る", () => {
    w()[INSTALL_PROMPT_KEY] = makeEvent();
    const { result } = renderHook(() => useInstallPrompt());
    act(() => {
      window.dispatchEvent(new Event("appinstalled"));
    });
    expect(result.current.state).toEqual({ kind: "none" });
  });

  it("display-mode: standalone（インストール済み）では常に none", () => {
    stubMatchMedia(true);
    w()[INSTALL_PROMPT_KEY] = makeEvent();
    const { result } = renderHook(() => useInstallPrompt());
    act(() => {
      window.dispatchEvent(makeEvent());
    });
    expect(result.current.state).toEqual({ kind: "none" });
  });

  it("iOS Safari（beforeinstallprompt 非対応）では ios", () => {
    stubUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile/15E148 Safari/604.1");
    const { result } = renderHook(() => useInstallPrompt());
    expect(result.current.state).toEqual({ kind: "ios" });
  });

  it("iOS でもホーム画面から起動済み（navigator.standalone）なら none", () => {
    stubUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148");
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
    try {
      const { result } = renderHook(() => useInstallPrompt());
      expect(result.current.state).toEqual({ kind: "none" });
    } finally {
      delete (navigator as { standalone?: boolean }).standalone;
    }
  });

  it("アンマウントで付けたリスナーをすべて外す", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useInstallPrompt());
    const added = add.mock.calls.map(([type, fn]) => [type, fn]);
    expect(added.map(([type]) => type).sort()).toEqual(["appinstalled", "beforeinstallprompt", INSTALL_PROMPT_EVENT].sort());
    unmount();
    for (const pair of added) expect(remove).toHaveBeenCalledWith(...pair);
    add.mockRestore();
    remove.mockRestore();
  });
});
