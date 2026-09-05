import { afterEach, describe, expect, it } from "vitest";
import { IGNORED_NAVIGATOR_KEYS, IGNORED_WINDOW_KEYS, describeDrift, snapshotGlobals } from "./global-leak-guard";

/**
 * 見張り（`vitest.setup.ts` が呼ぶ `installGlobalLeakGuard`）そのものの検査（Issue #512）。
 *
 * **「違反を書けば落ちる」だけでは、検査が生きている証明にならない**（#484）。
 * ここでは 3 つを別々に固定する:
 *
 * 1. **落とすべき形**（漏れ 8 種）を 1 つずつ、その 1 行だけが出ることまで
 * 2. **通すべき形**（後始末したなら差 0 件）
 * 3. **allowlist の中身そのもの**——広げたらここが落ちる
 */

/** 見本を置いて → 差分を採って → 必ず片付ける。片付けを忘れるとこのファイル自身が見張りに落とされる。 */
function driftFrom(mutate: () => void, restore: () => void): string[] {
  const before = snapshotGlobals();
  try {
    mutate();
    return describeDrift(before, snapshotGlobals());
  } finally {
    restore();
  }
}

/**
 * `expected` は**その形で出るべき行を全部**並べる（`drift` と順序込みで完全一致させる）。
 * 「1 行を含む」で済ませると、余分な行が出ても気づけない。
 * `userAgent` だけ 2 行なのは、own プロパティが生えたことと値が変わったことを**別々に**数えているため。
 */
const LEAKS: readonly (readonly [name: string, mutate: () => void, restore: () => void, expected: readonly RegExp[]])[] = [
  [
    "window にキーを残す（#512 の本体。__giinrecordInstallPrompt がこれ）",
    () => {
      (window as unknown as Record<string, unknown>).__leakProbe = 1;
    },
    () => {
      delete (window as unknown as Record<string, unknown>).__leakProbe;
    },
    [/^window に増えた: __leakProbe$/],
  ],
  [
    "window からキーを消す（他人が置いたものを奪う形）",
    () => {
      // 消す前に自分で置く。`before` に入れるため、この 1 件だけ手順が違う
      delete (window as unknown as Record<string, unknown>).__leakProbeToRemove;
    },
    () => {},
    [/^window から消えた: __leakProbeToRemove$/],
  ],
  [
    "navigator にキーを残す（navigator.standalone など）",
    () => {
      Object.defineProperty(navigator, "__leakProbe", { value: 1, configurable: true });
    },
    () => {
      delete (navigator as unknown as Record<string, unknown>).__leakProbe;
    },
    [/^navigator に増えた: __leakProbe$/],
  ],
  [
    "navigator.userAgent を差し替えたまま返さない（InstallLink / install-prompt がこれ）",
    () => {
      Object.defineProperty(navigator, "userAgent", { value: "LeakProbe/1.0", configurable: true });
    },
    () => {
      delete (navigator as { userAgent?: string }).userAgent;
    },
    [/^navigator に増えた: userAgent$/, /^navigator\.userAgent: .* → LeakProbe\/1\.0$/],
  ],
  [
    "<html> に属性を残す（ThemeToggle / SiteFooter.theme の data-theme）",
    () => document.documentElement.setAttribute("data-leak-probe", "dark"),
    () => document.documentElement.removeAttribute("data-leak-probe"),
    [/^<html> に増えた属性: data-leak-probe=dark$/],
  ],
  [
    "document.body に描画物を残す（contrast.test.ts の TABS_HTML）",
    () => {
      document.body.innerHTML = '<span class="member-tab-label">本会議</span>';
    },
    () => {
      document.body.innerHTML = "";
    },
    [/^document\.body が残っている（\d+ 文字）: <span class="member-tab-label">本会議<\/span>$/],
  ],
  [
    "document.head に style を残す（contrast.test.ts の 22,809 文字）",
    () => {
      document.head.innerHTML = "<style>.x{color:red}</style>";
    },
    () => {
      document.head.innerHTML = "";
    },
    [/^document\.head が残っている（\d+ 文字）: <style>\.x\{color:red\}<\/style>$/],
  ],
  [
    "localStorage に残す（CompareAdd / ThemeToggle）",
    () => localStorage.setItem("leak-probe", "1"),
    () => localStorage.clear(),
    [/^localStorage: \{\} → \{"leak-probe":"1"\}$/],
  ],
  [
    "sessionStorage に残す",
    () => sessionStorage.setItem("leak-probe", "1"),
    () => sessionStorage.clear(),
    [/^sessionStorage: \{\} → \{"leak-probe":"1"\}$/],
  ],
];

describe("グローバル状態の見張り（#512）", () => {
  afterEach(() => {
    // このファイル自身が漏らさないための保険。見本の restore が落ちても次に持ち越さない。
    delete (window as unknown as Record<string, unknown>).__leakProbe;
    delete (window as unknown as Record<string, unknown>).__leakProbeToRemove;
    delete (navigator as unknown as Record<string, unknown>).__leakProbe;
    delete (navigator as { userAgent?: string }).userAgent;
    document.documentElement.removeAttribute("data-leak-probe");
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    localStorage.clear();
    sessionStorage.clear();
  });

  it.each(LEAKS.map((l) => [l[0], l] as const))("漏れを見つける: %s", (_name, [, mutate, restore, expected]) => {
    if (_name.includes("消す")) {
      // 「消えた」を見るには、基準に入れてから消す必要がある
      (window as unknown as Record<string, unknown>).__leakProbeToRemove = 1;
    }
    const drift = driftFrom(mutate, restore);
    // **出る行を全部**照合する。余分が出るなら、見本が他のものも動かしている
    expect(drift, `${_name}: ${JSON.stringify(drift)}`).toHaveLength(expected.length);
    expected.forEach((re, i) => expect(drift[i], `${_name} の ${i} 行目`).toMatch(re));
  });

  /*
   * **通すべき形**（#484）。落とすことだけ試すと、正しい後始末まで落とす見張りができあがる。
   * 上の 9 形すべてについて、「触って→元に戻す」なら差 0 件であることを確かめる。
   * これが無いと `describeDrift` を `["always"]` を返すようにしても上の 9 件は全部緑になる。
   */
  it.each(LEAKS.map((l) => [l[0], l] as const))("後始末したなら差 0 件: %s", (_name, [, mutate, restore]) => {
    if (_name.includes("消す")) {
      (window as unknown as Record<string, unknown>).__leakProbeToRemove = 1;
    }
    const before = snapshotGlobals();
    mutate();
    restore();
    if (_name.includes("消す")) {
      (window as unknown as Record<string, unknown>).__leakProbeToRemove = 1;
    }
    expect(describeDrift(before, snapshotGlobals())).toEqual([]);
  });

  it("何もしなければ差 0 件", () => {
    const before = snapshotGlobals();
    expect(describeDrift(before, snapshotGlobals())).toEqual([]);
  });

  /*
   * **allowlist の中身そのものを固定する**（#484 / #499）。
   * 「個数」ではなく「要素そのもの」を書く——個数だけだと、中身がすり替わっても通る。
   * ここを広げる（＝見張りを緩める）と、この行が落ちる。
   */
  it("見逃す集合は、この 2 つだけ", () => {
    expect(IGNORED_WINDOW_KEYS).toEqual(["IS_REACT_ACT_ENVIRONMENT"]);
    expect(IGNORED_NAVIGATOR_KEYS).toEqual(["clipboard"]);
  });

  /*
   * **allowlist に載せた名前が実在すること。**
   * 名指しの allowlist は、対象が消えても黙って緑になりうる（#499）。
   * `IS_REACT_ACT_ENVIRONMENT` は RTL が `render` のときに置くので、ここで実際に置いて確かめる。
   */
  it("allowlist に載せた名前は、実際に見逃されている（置いても差 0 件）", () => {
    const before = snapshotGlobals();
    const g = window as unknown as Record<string, unknown>;
    const hadReact = "IS_REACT_ACT_ENVIRONMENT" in g;
    const hadClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard") !== undefined;
    try {
      if (!hadReact) g.IS_REACT_ACT_ENVIRONMENT = true;
      if (!hadClipboard) Object.defineProperty(navigator, "clipboard", { value: {}, configurable: true });
      expect(describeDrift(before, snapshotGlobals())).toEqual([]);
      // ただし「何を置いても見逃す」わけではないこと（allowlist が広すぎないか）
      g.IS_REACT_ACT_ENVIRONMENT_TYPO = true;
      expect(describeDrift(before, snapshotGlobals())).toEqual(["window に増えた: IS_REACT_ACT_ENVIRONMENT_TYPO"]);
    } finally {
      delete g.IS_REACT_ACT_ENVIRONMENT_TYPO;
      if (!hadReact) delete g.IS_REACT_ACT_ENVIRONMENT;
      if (!hadClipboard) delete (navigator as unknown as Record<string, unknown>).clipboard;
    }
  });

  /*
   * **見張りが `vitest.setup.ts` から本当に呼ばれていること**（#451 の「検査は残ったが対象が移動した」）。
   * ここが無いと、`vitest.setup.ts` を元の `afterEach(() => cleanup())` に戻しても
   * このファイルは全部緑のままになる（`describeDrift` を直に呼んでいるだけなので）。
   */
  it("vitest.setup.ts が見張りを設置している", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const setup = readFileSync(join(import.meta.dirname, "../../vitest.setup.ts"), "utf8");
    expect(setup, "vitest.setup.ts が installGlobalLeakGuard を呼んでいない。呼ばないと見張りは 1 ファイルも見ない").toContain("installGlobalLeakGuard(cleanup)");
  });
});
