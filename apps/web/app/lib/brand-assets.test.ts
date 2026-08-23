/**
 * ロゴ案 D「時系列」（#129）の SVG ソース。縦の軸に記録の点、最新の点だけ真鍮。
 * public/ は配信されるファイル、brand/ はビルドがラスタライズする元（PNG/ICO/OGP）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRAND, BRAND_DARK } from "./brand-colors";

const WEB = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(WEB, rel), "utf8");

function parseSvg(src: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(src, "image/svg+xml");
  expect(doc.querySelector("parsererror")).toBeNull();
  const root = doc.documentElement as unknown as SVGSVGElement;
  expect(root.tagName).toBe("svg");
  return root;
}

describe("public/logo.svg（マーク単体）", () => {
  const src = read("public/logo.svg");
  it("viewBox 0 0 100 100 で、軸1本＋横線3本、点3つ", () => {
    const svg = parseSvg(src);
    expect(svg.getAttribute("viewBox")).toBe("0 0 100 100");
    expect(svg.querySelectorAll("circle")).toHaveLength(3);
    expect(svg.querySelectorAll("line")).toHaveLength(4);
  });
  it("墨藍で描き、最新（最下）の点だけ真鍮。文字は持たない", () => {
    const svg = parseSvg(src);
    const circles = [...svg.querySelectorAll("circle")].sort((a, b) => Number(a.getAttribute("cy")) - Number(b.getAttribute("cy")));
    expect(circles.map((c) => c.getAttribute("fill"))).toEqual([BRAND.ink, BRAND.ink, BRAND.brass]);
    expect(src).not.toContain("<text");
  });
});

describe("public/logo-wordmark.svg（マーク＋明朝「議会ログ」をパス化）", () => {
  const src = read("public/logo-wordmark.svg");
  it("SVG として解釈でき、text 要素を使わない（フォント非依存）", () => {
    const svg = parseSvg(src);
    expect(svg.querySelectorAll("path").length).toBeGreaterThan(0);
    expect(src).not.toContain("<text");
    expect(svg.getAttribute("aria-label")).toBe("議会ログ");
  });
  it("墨藍と真鍮を使う", () => {
    expect(src).toContain(BRAND.ink);
    expect(src).toContain(BRAND.brass);
  });
});

describe("public/favicon.svg", () => {
  const src = read("public/favicon.svg");
  it("角丸（rx 10）の墨藍地に紙色の軸と点、最後の点だけ真鍮", () => {
    const svg = parseSvg(src);
    expect(svg.querySelector("rect")?.getAttribute("rx")).toBe("10");
    expect(src).toContain(BRAND.ink);
    expect(src).toContain(BRAND.paper);
    expect(src).toContain(BRAND.brass);
  });
  it("prefers-color-scheme: dark で反転する style を内包する", () => {
    expect(src).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
    expect(src).toContain(BRAND_DARK.ink);
    expect(src).toContain(BRAND_DARK.paper);
    expect(src).toContain(BRAND_DARK.brass);
  });
});

describe("brand/icon-square.svg（PNG/ICO/apple-touch-icon の元。角丸なし・地色あり）", () => {
  const src = read("brand/icon-square.svg");
  it("地色は墨藍、軸は紙、最後の点は真鍮。media query は持たない（ラスタライズは常にライト）", () => {
    parseSvg(src);
    expect(src).toContain(BRAND.ink);
    expect(src).toContain(BRAND.paper);
    expect(src).toContain(BRAND.brass);
    expect(src).not.toContain("prefers-color-scheme");
  });
});

describe("brand/og-image.svg（1200×630、紙地に左へマーク、右に明朝の題とキャッチ）", () => {
  const src = read("brand/og-image.svg");
  it("1200×630 で、文字はパス化されていて <text> が無い", () => {
    const svg = parseSvg(src);
    expect(svg.getAttribute("width")).toBe("1200");
    expect(svg.getAttribute("height")).toBe("630");
    expect(src).not.toContain("<text");
    expect(svg.querySelectorAll("path").length).toBeGreaterThan(0);
  });
  it("紙・墨藍・真鍮を使う", () => {
    expect(src).toContain(BRAND.paper);
    expect(src).toContain(BRAND.ink);
    expect(src).toContain(BRAND.brass);
  });
});

describe("public/site.webmanifest", () => {
  it("name 議会ログ、theme_color 墨藍、background 紙、192/512 のアイコン", () => {
    const m = JSON.parse(read("public/site.webmanifest")) as Record<string, unknown>;
    expect(m.name).toBe("議会ログ");
    expect(m.theme_color).toBe(BRAND.ink);
    expect(m.background_color).toBe(BRAND.paper);
    const icons = m.icons as { src: string; sizes: string }[];
    expect(icons.map((i) => [i.src, i.sizes])).toEqual([
      ["/icon-192.png", "192x192"],
      ["/icon-512.png", "512x512"],
    ]);
  });
});

describe("brand-colors は tokens.css と同じ値", () => {
  it("墨藍 = --cover、紙 = --paper、真鍮 = --brass-on-cover（ライト）／ダークは紙と墨が入れ替わる", () => {
    const css = read("app/styles/tokens.css");
    expect(css).toContain(`--cover: ${BRAND.ink}`);
    expect(css).toContain(`--paper: ${BRAND.paper}`);
    expect(css).toContain(`--brass-on-cover: ${BRAND.brass}`);
    expect(css).toContain(`--paper: ${BRAND_DARK.ink}`);
    expect(css).toContain(`--ink: ${BRAND_DARK.paper}`);
    expect(css).toContain(`--brass: ${BRAND_DARK.brass}`);
  });
});
