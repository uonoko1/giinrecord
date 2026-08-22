import { describe, expect, it } from "vitest";
import { links } from "./root";

describe("root links", () => {
  it("Google Fonts（Shippori Mincho / BIZ UDPGothic）の stylesheet を preconnect 付きで読み込む", () => {
    const all = links();
    const sheet = all.find((l) => l.rel === "stylesheet");
    expect(sheet?.href).toContain("fonts.googleapis.com");
    expect(sheet?.href).toContain("Shippori+Mincho");
    expect(sheet?.href).toContain("BIZ+UDPGothic");
    expect(all.some((l) => l.rel === "preconnect" && l.href === "https://fonts.gstatic.com")).toBe(true);
  });
});
