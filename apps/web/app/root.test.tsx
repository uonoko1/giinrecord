import { describe, expect, it, vi } from "vitest";
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
});
