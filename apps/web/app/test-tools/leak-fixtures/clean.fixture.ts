/**
 * **漏らさない見本**（#512）。`global-leak-guard.e2e.test.ts` が
 * 「見張りが通すべきものを通す」ことを確かめるための否定的対照。
 * これが赤くなるなら、見張りが厳しすぎて正しいテストまで落としている。
 */
import { describe, expect, it } from "vitest";

describe("漏らさない見本", () => {
  it("置いたものを自分で片付ける", () => {
    const w = window as unknown as Record<string, unknown>;
    w.__giinrecordInstallPrompt = { fake: true };
    delete w.__giinrecordInstallPrompt;
    expect(1).toBe(1);
  });
});
