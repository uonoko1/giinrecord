import { describe, expect, it } from "vitest";
import { BRAND } from "./lib/brand-colors";
import { links, THEME_COLOR } from "./root";

describe("root links / meta（#129 ファビコン・manifest）", () => {
  const all = links() as Record<string, string | undefined>[];
  const byRel = (rel: string) => all.filter((l) => l.rel === rel);

  it("SVG ファビコンと ICO ファビコンを両方リンクする", () => {
    expect(byRel("icon")).toEqual([
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "icon", href: "/favicon.ico", sizes: "48x48" },
    ]);
  });

  it("apple-touch-icon と manifest をリンクする", () => {
    expect(byRel("apple-touch-icon")).toEqual([{ rel: "apple-touch-icon", href: "/apple-touch-icon.png", sizes: "180x180" }]);
    expect(byRel("manifest")).toEqual([{ rel: "manifest", href: "/site.webmanifest" }]);
  });

  it("Google Fonts（Shippori Mincho / BIZ UDPGothic）の stylesheet を preconnect 付きで読み込む", () => {
    const sheet = byRel("stylesheet");
    expect(sheet).toHaveLength(1);
    expect(sheet[0]?.href).toContain("fonts.googleapis.com");
    expect(sheet[0]?.href).toContain("Shippori+Mincho");
    expect(sheet[0]?.href).toContain("BIZ+UDPGothic");
    expect(byRel("preconnect").some((l) => l.href === "https://fonts.gstatic.com")).toBe(true);
  });

  it("theme-color は墨藍", () => {
    expect(THEME_COLOR).toBe(BRAND.ink);
  });
});
