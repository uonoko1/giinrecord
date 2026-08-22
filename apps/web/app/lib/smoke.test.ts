/**
 * ビルド成果物スモークチェッカーの仕様（純粋関数部分）。
 * 実ファイルシステムは使わず、Map で表した偽のビルドディレクトリに対して検証する。
 */
import { describe, expect, it } from "vitest";
import { checkBuild, checkSitemap, extractInternalHrefs, resolveHrefTarget, formatReport, type BuildFiles } from "./smoke";

const html = (links: string[]) => `<html><body>${links.map((l) => `<a href="${l}">x</a>`).join("")}</body></html>`;

function fakeBuild(entries: Record<string, string>): BuildFiles {
  return new Map(Object.entries(entries));
}

describe("extractInternalHrefs", () => {
  it('href="/..." の内部リンクだけを重複なく抽出する', () => {
    const doc = html(["/about", "/members/m_1", "/about", "https://example.com/x", "mailto:a@b.c", "#top", "//cdn.example/x"]);
    expect(extractInternalHrefs(doc)).toEqual(["/about", "/members/m_1"]);
  });
  it("シングルクォートの href も拾う", () => {
    expect(extractInternalHrefs(`<a href='/members'>m</a>`)).toEqual(["/members"]);
  });
  it("リンクが無ければ空", () => {
    expect(extractInternalHrefs("<p>none</p>")).toEqual([]);
  });
});

describe("resolveHrefTarget", () => {
  it("クエリとハッシュを落とし、末尾スラッシュを正規化する", () => {
    expect(resolveHrefTarget("/about/?q=1#x")).toBe("about");
    expect(resolveHrefTarget("/")).toBe("");
    expect(resolveHrefTarget("/members/m_1")).toBe("members/m_1");
  });
});

describe("checkBuild", () => {
  const staticOnly = fakeBuild({
    "index.html": html(["/about", "/members"]),
    "about/index.html": html(["/", "/assets/entry-abc123.js"]),
    "members/index.html": html(["/"]),
    "assets/entry-abc123.js": "",
  });

  it("data/ が無いとき静的ページだけで成功する", () => {
    const r = checkBuild(staticOnly, { memberIds: null, rollCalls: null });
    expect(r.failures).toEqual([]);
    expect(r.checkedPages).toBe(3);
    expect(r.checkedLinks).toBeGreaterThan(0);
  });

  it("必須ページが無ければ失敗する", () => {
    const r = checkBuild(fakeBuild({ "index.html": html([]) }), { memberIds: null, rollCalls: null });
    expect(r.failures).toEqual(
      expect.arrayContaining([expect.stringContaining("about/index.html"), expect.stringContaining("members/index.html")]),
    );
  });

  it("members/index.json の全 id のページが必要", () => {
    const r = checkBuild(staticOnly, { memberIds: ["m_1"], rollCalls: null });
    expect(r.failures).toEqual([expect.stringContaining("members/m_1/index.html")]);
  });

  it("rollcalls/index.json の全件と rollcalls/index.html が必要", () => {
    const r = checkBuild(staticOnly, { memberIds: null, rollCalls: [{ session: 221, id: "r_1" }] });
    expect(r.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("rollcalls/index.html"),
        expect.stringContaining("rollcalls/221/r_1/index.html"),
      ]),
    );
  });

  it("内部リンク先が file でも dir/index.html でも存在すれば OK、無ければ失敗", () => {
    const b = fakeBuild({
      "index.html": html(["/about", "/members", "/robots.txt", "/members/missing", "/assets/gone-1234.js"]),
      "about/index.html": "",
      "members/index.html": "",
      "robots.txt": "",
    });
    const r = checkBuild(b, { memberIds: null, rollCalls: null });
    expect(r.failures).toEqual([
      expect.stringMatching(/index\.html.*\/members\/missing/),
      expect.stringMatching(/index\.html.*\/assets\/gone-1234\.js/),
    ]);
  });

  it("HTML 以外のファイルのリンクは走査しない", () => {
    const b = fakeBuild({
      "index.html": "",
      "about/index.html": "",
      "members/index.html": "",
      "assets/x.js": `href="/nope"`,
    });
    expect(checkBuild(b, { memberIds: null, rollCalls: null }).failures).toEqual([]);
  });
});

describe("checkSitemap", () => {
  const sitemap = (locs: string[]) =>
    `<?xml version="1.0" encoding="UTF-8"?><urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join("")}</urlset>`;
  const pages = { "index.html": "", "about/index.html": "", "members/index.html": "", "members/m_1/index.html": "" };

  it("sitemap.xml が無ければ失敗", () => {
    const r = checkSitemap(fakeBuild(pages), { memberIds: null, rollCalls: null });
    expect(r.failures).toEqual([expect.stringContaining("sitemap.xml")]);
  });

  it("絶対 URL でも相対パスでも、全 <loc> がビルドに存在すれば OK", () => {
    const b = fakeBuild({
      ...pages,
      "sitemap.xml": sitemap(["https://example.test/", "https://example.test/about", "/members", "/members/m_1"]),
    });
    const r = checkSitemap(b, { memberIds: ["m_1"], rollCalls: null });
    expect(r.failures).toEqual([]);
    expect(r.checkedUrls).toBe(4);
  });

  it("存在しないページを指す <loc> は失敗", () => {
    const b = fakeBuild({ ...pages, "sitemap.xml": sitemap(["/", "/about", "/members", "/members/m_1", "/members/gone"]) });
    expect(checkSitemap(b, { memberIds: ["m_1"], rollCalls: null }).failures).toEqual([expect.stringContaining("/members/gone")]);
  });

  it("data/ が約束したページが sitemap に無ければ失敗（全議員・全採決・静的ページ）", () => {
    const b = fakeBuild({ ...pages, "sitemap.xml": sitemap(["/", "/about", "/members"]) });
    expect(checkSitemap(b, { memberIds: ["m_1"], rollCalls: null }).failures).toEqual([
      expect.stringMatching(/not in sitemap.*\/members\/m_1/),
    ]);
  });
});

describe("formatReport", () => {
  it("成功時は件数だけ、失敗時は一覧を出す", () => {
    const ok = formatReport({ checkedPages: 3, checkedLinks: 5, failures: [] });
    expect(ok).toContain("OK");
    expect(ok).toMatch(/\b3\b.*\b5\b/s);
    const out = formatReport({ checkedPages: 1, checkedLinks: 0, failures: ["a", "b"] });
    expect(out).toContain("2 failure");
    expect(out).toContain("a");
  });
});
