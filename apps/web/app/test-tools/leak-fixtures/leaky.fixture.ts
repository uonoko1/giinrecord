/**
 * **わざと漏らす見本**（#512）。`global-leak-guard.e2e.test.ts` が
 * vitest を別プロセスで走らせて、**これが落ちること**を確かめる。
 *
 * `*.fixture.ts` なので `vitest.config.ts` の `include`（`app/**\/*.test.{ts,tsx}`）には入らない。
 * 通常のテスト実行では**走らない**（走れば必ず赤くなる見本なので、入れてはいけない）。
 */
import { describe, expect, it } from "vitest";

describe("わざと漏らす見本", () => {
  it("window にキーを残したまま終わる", () => {
    (window as unknown as Record<string, unknown>).__giinrecordInstallPrompt = { fake: true };
    expect(1).toBe(1); // このテスト自身は通る。落とすのは見張りの afterEach
  });
});
