/**
 * sitemap.xml / robots.txt 生成の仕様（純粋関数）。
 */
import { describe, expect, it } from "vitest";
import { buildRobots, buildSitemap, sitemapLocs } from "./sitemap";

describe("buildSitemap", () => {
  it("全パスを <url> にし、lastmod は meta.fetchedAt の日付", () => {
    const xml = buildSitemap(["/", "/members/m_1"], { origin: "https://example.test", lastmod: "2026-08-22T13:49:50.028Z" });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain("<url><loc>https://example.test/</loc><lastmod>2026-08-22</lastmod></url>");
    expect(xml).toContain("<url><loc>https://example.test/members/m_1</loc><lastmod>2026-08-22</lastmod></url>");
    expect(xml.trimEnd().endsWith("</urlset>")).toBe(true);
  });
  it("origin が無ければ相対パス、lastmod が無ければ省略", () => {
    const xml = buildSitemap(["/about"], { origin: "", lastmod: null });
    expect(xml).toContain("<url><loc>/about</loc></url>");
    expect(xml).not.toContain("<lastmod>");
  });
  it("XML の特殊文字はエスケープする", () => {
    expect(buildSitemap(["/a&b"], { origin: "", lastmod: null })).toContain("<loc>/a&amp;b</loc>");
  });
});

describe("buildRobots", () => {
  it("origin があれば Sitemap 行を付ける", () => {
    expect(buildRobots("https://example.test")).toBe("User-agent: *\nAllow: /\n\nSitemap: https://example.test/sitemap.xml\n");
  });
  it("origin が無ければ Sitemap 行は出さない（相対 URL は仕様違反）", () => {
    expect(buildRobots("")).toBe("User-agent: *\nAllow: /\n");
  });
});

describe("sitemapLocs", () => {
  it("<loc> を順に取り出し、エスケープを戻す", () => {
    const xml = buildSitemap(["/", "/a&b"], { origin: "https://example.test", lastmod: null });
    expect(sitemapLocs(xml)).toEqual(["https://example.test/", "https://example.test/a&b"]);
  });
  it("sitemap で無ければ空", () => {
    expect(sitemapLocs("")).toEqual([]);
  });
});
