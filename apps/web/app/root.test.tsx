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
  it("https://staging.giinrecord.jp のビルドには <meta name=robots content=noindex, nofollow> が入る", async () => {
    expect(await renderWith("https://staging.giinrecord.jp")).toContain('<meta name="robots" content="noindex, nofollow"/>');
  });
  it("本番 origin のビルドには robots meta を入れない", async () => {
    expect(await renderWith("https://giinrecord.jp")).not.toContain('name="robots"');
  });

  // Issue #191: beforeinstallprompt はハイドレーション前に捕捉する（テーマと同じインラインスクリプト方式）
  it("head に installPromptInit をインラインで埋め込む", async () => {
    const html = await renderWith("https://giinrecord.jp");
    const { installPromptInit } = await import("./lib/install-prompt");
    expect(html).toContain(`<script>${installPromptInit}</script>`);
    expect(installPromptInit).toContain("beforeinstallprompt");
  });
});

/**
 * Issue #325: HydrateFallback が無いと、React Router は自前の既定フォールバックを使う。
 * それが吐く /__spa-fallback.html は `<html lang="en">` / `<title>Loading...</title>` で、
 * さらに開発者向けの `💿 Hey developer` を本番のコンソールに出す。
 *
 * root ルートの HydrateFallback は **Root の代わりに** 描かれる（Outlet の中身の差し替えではない）ので、
 * <html> から <Scripts /> までを自分で持つ必要がある。持たないとビルドが
 * `Did you forget to include <Scripts/>` で落ちる（実際に落ちた）。
 */
describe("HydrateFallback（#325）", () => {
  async function fallbackHtml(origin = "https://giinrecord.jp"): Promise<string> {
    vi.resetModules();
    vi.stubEnv("SITE_ORIGIN", origin);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { HydrateFallback } = await import("./root");
      const { createRoutesStub } = await import("react-router");
      const { renderToStaticMarkup } = await import("react-dom/server");
      const Stub = createRoutesStub([{ path: "/", Component: HydrateFallback }]);
      return renderToStaticMarkup(<Stub initialEntries={["/"]} />);
    } finally {
      quiet.mockRestore();
      vi.unstubAllEnvs();
    }
  }

  it("root.tsx は HydrateFallback を export する", async () => {
    expect(typeof (await import("./root")).HydrateFallback).toBe("function");
  });

  it("lang=\"ja\" の <html> を自分で描く（既定フォールバックは lang=\"en\" だった）", async () => {
    const html = await fallbackHtml();
    expect(html).toContain('<html lang="ja">');
    expect(html).not.toContain('lang="en"');
  });

  it("読み込み中と分かる本文を出し、開発者向けメッセージを含まない", async () => {
    const html = await fallbackHtml();
    expect(html).toMatch(/読み込/);
    expect(html).not.toContain("Hey developer");
  });

  // <Scripts /> が無いと `pnpm build` が "Did you forget to include <Scripts/>" で落ちる（実際に落ちた）。
  // ビルドを回さずに検出できるよう、Scripts が描く <script type="module"> と ScrollRestoration の
  // sessionStorage キーの両方を見る（どちらも Document に置いた要素だけが出す）。
  it("<Scripts /> と <ScrollRestoration /> を含む（含まないと SPA モードのビルドが落ちる）", async () => {
    const html = await fallbackHtml();
    expect(html).toContain('<script type="module"');
    expect(html).toContain("react-router-scroll-positions");
  });

  // nginx はこの HTML を 404 の本文としても返す（deploy/nginx/site.conf の error_page 404）。
  // <title> にサイト名が無いと外形監視 deploy/monitor/probe.sh の title 検査が通らず、
  // noindex が無いと 404 の本文が索引される。
  it("既定 meta はサイト名入りの <title> と noindex（404 の本文になるため）", async () => {
    vi.resetModules();
    const { meta } = await import("./root");
    const tags = meta() as { title?: string; name?: string; content?: string }[];
    expect(tags.find((t) => "title" in t)?.title).toBe("議員レコード");
    expect(tags).toContainEqual({ name: "robots", content: "noindex" });
  });
});

/**
 * Issue 394: skip link（「本文へ移動」）。
 *
 * 無いと、キーボード利用者は**ページを開くたびに**ヘッダのリンクを全部たどってから本文に着く。
 * 議員ページはタブが6つあるので、その手前を毎回通ることになる。
 *
 * axe はこれを**必須項目として出さない**（本番 13 ページの計測は違反 0 件だった）。
 * 「計測が緑」は「問題が無い」ではない、の例になった。
 */
describe("skip link（Issue 394）", () => {
  async function html(component: "Root" | "HydrateFallback"): Promise<string> {
    vi.resetModules();
    vi.stubEnv("SITE_ORIGIN", "https://giinrecord.jp");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const mod = await import("./root");
      const Component = component === "Root" ? mod.default : mod.HydrateFallback;
      const { createRoutesStub } = await import("react-router");
      const { renderToStaticMarkup } = await import("react-dom/server");
      const Stub = createRoutesStub([{ path: "/", Component }]);
      return renderToStaticMarkup(<Stub initialEntries={["/"]} />);
    } finally {
      quiet.mockRestore();
      vi.unstubAllEnvs();
    }
  }

  it("body の**最初**にある（Tab を1回押せば届く）", async () => {
    const body = (await html("Root")).split("<body>")[1];
    expect(body.trimStart()).toMatch(/^<a [^>]*class="skip-link"/);
  });

  it("本文へのアンカーで、その id を持つ要素が同じ文書にある", async () => {
    const out = await html("Root");
    const href = out.match(/class="skip-link" href="#([^"]+)"/)?.[1] ?? out.match(/href="#([^"]+)"[^>]*class="skip-link"/)?.[1];
    expect(href).toBeTruthy();
    expect(out).toContain(`id="${href}"`);
  });

  it("HydrateFallback にもある（読み込み中の画面でも本文へ飛べる）", async () => {
    expect(await html("HydrateFallback")).toContain('class="skip-link"');
  });

  it("移動先はフォーカスを受け取れる（tabindex=-1）", async () => {
    const out = await html("Root");
    const href = out.match(/href="#([^"]+)"/)?.[1];
    expect(out).toMatch(new RegExp(`id="${href}"[^>]*tabindex="-1"|tabindex="-1"[^>]*id="${href}"`));
  });
});
