import { describe, expect, it, vi } from "vitest";
import { BRAND } from "./lib/brand-colors";
import { FONTS_CSS_HREF, links, THEME_COLOR } from "./root";

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

  // Issue #168: フォントは自サイト配信。Google Fonts への link / preconnect は無く、外部 URL を一切含まない
  it("フォントは /fonts/fonts.css（自サイト配信）だけを読み込み、preconnect や外部 URL を含まない", () => {
    expect(byRel("stylesheet")).toEqual([{ rel: "stylesheet", href: FONTS_CSS_HREF }]);
    expect(FONTS_CSS_HREF).toBe("/fonts/fonts.css");
    expect(byRel("preconnect")).toEqual([]);
    for (const l of all) expect(l.href).not.toMatch(/^(https?:)?\/\//);
  });

  it("theme-color は墨藍", () => {
    expect(THEME_COLOR).toBe(BRAND.ink);
  });
});

// Issue #127: SITE_ORIGIN が staging のビルドは全ページ noindex。origin は import.meta.env にインライン化されるので
// モジュールを読み直して検証する。
describe("root robots meta", () => {
  async function renderWith(origin: string): Promise<string> {
    vi.resetModules();
    vi.stubEnv("SITE_ORIGIN", origin);
    // createRoutesStub has no manifest, so <Scripts /> renders href="" — React warns; irrelevant to <head> contents.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { default: Root } = await import("./root");
      const { createRoutesStub } = await import("react-router");
      const { renderToStaticMarkup } = await import("react-dom/server");
      const Stub = createRoutesStub([{ path: "/", Component: Root }]);
      return renderToStaticMarkup(<Stub initialEntries={["/"]} />);
    } finally {
      quiet.mockRestore();
      vi.unstubAllEnvs();
    }
  }
  it("https://staging.gikailog.jp のビルドには <meta name=robots content=noindex, nofollow> が入る", async () => {
    expect(await renderWith("https://staging.gikailog.jp")).toContain('<meta name="robots" content="noindex, nofollow"/>');
  });
  it("本番 origin のビルドには robots meta を入れない", async () => {
    expect(await renderWith("https://gikailog.jp")).not.toContain('name="robots"');
  });

  // Issue #191: beforeinstallprompt はハイドレーション前に捕捉する（テーマと同じインラインスクリプト方式）
  it("head に installPromptInit をインラインで埋め込む", async () => {
    const html = await renderWith("https://gikailog.jp");
    const { installPromptInit } = await import("./lib/install-prompt");
    expect(html).toContain(`<script>${installPromptInit}</script>`);
    expect(installPromptInit).toContain("beforeinstallprompt");
  });
});
