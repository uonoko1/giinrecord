import { useCallback, useEffect, useState } from "react";

/**
 * Issue #191: PWA のインストール案内を自動表示しない。
 * Chrome/Edge は manifest を見つけると `beforeinstallprompt` を出し、既定動作として mini-infobar を表示する。
 * root.tsx のインラインスクリプト（installPromptInit）がハイドレーション前にそれを preventDefault して window に保持し、
 * useInstallPrompt() がそれを読んで「ホーム画面に追加」を押したときだけ prompt() する。
 * Service Worker は導入しない（オフラインは対象外）。
 */

/** 捕捉した beforeinstallprompt を置く window のプロパティ名 */
export const INSTALL_PROMPT_KEY = "__gikailogInstallPrompt";
/** インラインスクリプトが捕捉時に window へ dispatch するカスタムイベント名（ハイドレーション後に捕捉された場合の通知） */
export const INSTALL_PROMPT_EVENT = "gikailog:installprompt";

/** Chrome/Edge が出す非標準イベント。TS の lib.dom には無い。 */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

type InstallWindow = Window & { [INSTALL_PROMPT_KEY]?: BeforeInstallPromptEvent };

/** head に置くインラインスクリプト（1文、外部通信なし）。 */
export const installPromptInit = `window.addEventListener("beforeinstallprompt",function(e){e.preventDefault();window.${INSTALL_PROMPT_KEY}=e;window.dispatchEvent(new Event(${JSON.stringify(INSTALL_PROMPT_EVENT)}))});`;

export type InstallState =
  /** 非対応ブラウザ／インストール済み／イベント未到達 → 何も出さない */
  | { kind: "none" }
  /** beforeinstallprompt を保持している → ボタンを押すと prompt() */
  | { kind: "native" }
  /** iOS Safari（beforeinstallprompt 非対応） → ボタンを押すと手順を表示 */
  | { kind: "ios" };

function isStandalone(): boolean {
  try {
    if (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches) return true;
  } catch {
    /* matchMedia unavailable */
  }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isIOS(): boolean {
  return /iP(hone|ad|od)/.test(navigator.userAgent);
}

/**
 * インストール導線の状態と、押下時の動作。SSR/プリレンダーでは常に none（DOM を出さない）。
 * 表示の判定はすべてマウント後の effect で行う。
 */
export function useInstallPrompt(): { state: InstallState; install: () => Promise<void> } {
  const [state, setState] = useState<InstallState>({ kind: "none" });

  useEffect(() => {
    if (isStandalone()) return;
    const w = window as InstallWindow;
    const captured = () => setState({ kind: "native" });
    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      w[INSTALL_PROMPT_KEY] = e as BeforeInstallPromptEvent;
      captured();
    };
    const onInstalled = () => {
      delete w[INSTALL_PROMPT_KEY];
      setState({ kind: "none" });
    };

    if (w[INSTALL_PROMPT_KEY]) captured();
    else if (isIOS()) setState({ kind: "ios" });

    window.addEventListener(INSTALL_PROMPT_EVENT, captured);
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener(INSTALL_PROMPT_EVENT, captured);
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    const w = window as InstallWindow;
    const e = w[INSTALL_PROMPT_KEY];
    if (!e) return;
    await e.prompt();
    const { outcome } = await e.userChoice;
    if (outcome === "accepted") {
      delete w[INSTALL_PROMPT_KEY];
      setState({ kind: "none" });
    }
  }, []);

  return { state, install };
}
