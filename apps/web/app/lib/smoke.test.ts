/**
 * ビルド成果物スモークチェッカーの仕様（純粋関数部分）。
 * 実ファイルシステムは使わず、Map で表した偽のビルドディレクトリに対して検証する。
 */
import { describe, expect, it } from "vitest";
import { checkBrandAssets, checkBuild, checkDistrictData, checkMemberData, checkSitemap, extractInternalHrefs, resolveHrefTarget, formatReport, type BuildFiles } from "./smoke";

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

/** /compare（#104）は実行時に /data/members/{id}.json を fetch するので、ビルドが全議員分をコピーしている必要がある。 */
describe("checkMemberData", () => {
  it("members/index.json の全 id について data/members/{id}.json がビルドに必要", () => {
    const b = fakeBuild({ "index.html": "", "data/members/m_1.json": "" });
    expect(checkMemberData(b, { memberIds: ["m_1", "m_2"], rollCalls: null }).failures).toEqual([
      expect.stringContaining("data/members/m_2.json"),
    ]);
    expect(checkMemberData(b, { memberIds: ["m_1"], rollCalls: null })).toEqual({ checkedFiles: 1, failures: [] });
  });
  it("data/ が無いときは何も要求しない", () => {
    expect(checkMemberData(fakeBuild({ "index.html": "" }), { memberIds: null, rollCalls: null })).toEqual({ checkedFiles: 0, failures: [] });
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

describe("checkDistrictData（#112: 郵便番号の分割ファイル）", () => {
  const sample = { zip: "1000001", districts: { sangiin: ["東京"], shugiin: ["東京1"] } };
  const districts = { prefixes: ["100", "680"], sample };
  const shard100 = JSON.stringify({ "1000001": sample.districts, "1000014": sample.districts });
  const ok = fakeBuild({
    "index.html": "",
    "data/districts/meta.json": JSON.stringify({ fetchedAt: "2026-08-01T03:00:00+09:00" }),
    "data/districts/zip/100.json": shard100,
    "data/districts/zip/680.json": "{}",
  });

  it("by-zip.json の上3桁ごとに data/districts/zip/{上3桁}.json と meta.json が必要", () => {
    expect(checkDistrictData(ok, { memberIds: null, rollCalls: null, districts })).toEqual({ checkedFiles: 3, failures: [] });
    const missing = fakeBuild({ "index.html": "", "data/districts/zip/100.json": shard100 });
    expect(checkDistrictData(missing, { memberIds: null, rollCalls: null, districts }).failures).toEqual([
      expect.stringContaining("data/districts/meta.json"),
      expect.stringContaining("data/districts/zip/680.json"),
    ]);
  });

  it("見本の郵便番号を分割ファイルから引くと by-zip.json と同じ値になる", () => {
    const wrong = fakeBuild({
      "index.html": "",
      "data/districts/meta.json": "{}",
      "data/districts/zip/100.json": JSON.stringify({ "1000001": { sangiin: ["東京"], shugiin: ["東京2"] } }),
      "data/districts/zip/680.json": "{}",
    });
    expect(checkDistrictData(wrong, { memberIds: null, rollCalls: null, districts }).failures).toEqual([expect.stringContaining("1000001")]);
    const absent = fakeBuild({ "index.html": "", "data/districts/meta.json": "{}", "data/districts/zip/100.json": "{}", "data/districts/zip/680.json": "{}" });
    expect(checkDistrictData(absent, { memberIds: null, rollCalls: null, districts }).failures).toEqual([expect.stringContaining("1000001")]);
  });

  it("data/districts/ が無いときは何も要求しない", () => {
    expect(checkDistrictData(fakeBuild({ "index.html": "" }), { memberIds: null, rollCalls: null })).toEqual({ checkedFiles: 0, failures: [] });
  });
});

describe("checkBrandAssets（#129: favicon / manifest / og:image の存在）", () => {
  const all = ["favicon.svg", "favicon.ico", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "site.webmanifest", "og-image.png", "logo.svg"];
  it("すべて揃っていれば失敗なし", () => {
    const files: BuildFiles = new Map(all.map((f) => [f, ""]));
    expect(checkBrandAssets(files)).toEqual({ checkedFiles: all.length, failures: [] });
  });
  it("欠けたファイルを一つずつ報告する", () => {
    const files: BuildFiles = new Map(all.filter((f) => f !== "favicon.ico" && f !== "og-image.png").map((f) => [f, ""]));
    expect(checkBrandAssets(files).failures).toEqual(["missing brand asset: favicon.ico", "missing brand asset: og-image.png"]);
  });
});
