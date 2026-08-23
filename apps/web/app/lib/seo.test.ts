/**
 * SEO タグ生成の仕様。SITE_ORIGIN が無ければ相対 URL で壊れない。
 */
import { describe, expect, it } from "vitest";
import { canonicalUrl, isStagingOrigin, normalizeOrigin, robotsMeta, seoMeta } from "./seo";

describe("normalizeOrigin", () => {
  it("未設定・空なら空文字（相対 URL モード）", () => {
    expect(normalizeOrigin(undefined)).toBe("");
    expect(normalizeOrigin("")).toBe("");
    expect(normalizeOrigin("   ")).toBe("");
  });
  it("末尾スラッシュを落とす", () => {
    expect(normalizeOrigin("https://example.test/")).toBe("https://example.test");
    expect(normalizeOrigin("https://example.test")).toBe("https://example.test");
  });
});

describe("canonicalUrl", () => {
  it("origin があれば絶対 URL、末尾スラッシュ無し", () => {
    expect(canonicalUrl("https://example.test", "/members/m_1/")).toBe("https://example.test/members/m_1");
    expect(canonicalUrl("https://example.test", "/")).toBe("https://example.test/");
  });
  it("origin が無ければパスだけ", () => {
    expect(canonicalUrl("", "/members/m_1")).toBe("/members/m_1");
    expect(canonicalUrl("", "/")).toBe("/");
  });
  it("クエリ・ハッシュは含めない", () => {
    expect(canonicalUrl("", "/rollcalls?x=1#y")).toBe("/rollcalls");
  });
});

describe("seoMeta", () => {
  const tags = seoMeta({
    title: "藤川 政人（参議院・愛知）の投票記録",
    description: "説明",
    pathname: "/members/m_1",
    type: "article",
    origin: "https://example.test",
  });
  it("title / description / canonical / OGP を一式返す", () => {
    expect(tags).toContainEqual({ title: "藤川 政人（参議院・愛知）の投票記録 ・ 議会ログ" });
    expect(tags).toContainEqual({ name: "description", content: "説明" });
    expect(tags).toContainEqual({ tagName: "link", rel: "canonical", href: "https://example.test/members/m_1" });
    expect(tags).toContainEqual({ property: "og:title", content: "藤川 政人（参議院・愛知）の投票記録 ・ 議会ログ" });
    expect(tags).toContainEqual({ property: "og:description", content: "説明" });
    expect(tags).toContainEqual({ property: "og:type", content: "article" });
    expect(tags).toContainEqual({ property: "og:url", content: "https://example.test/members/m_1" });
    expect(tags).toContainEqual({ property: "og:site_name", content: "議会ログ" });
  });
  it("title が無ければサイト名だけ、type は既定で website、origin 未設定なら相対", () => {
    const t = seoMeta({ description: "d", pathname: "/", origin: "" });
    expect(t).toContainEqual({ title: "議会ログ" });
    expect(t).toContainEqual({ property: "og:type", content: "website" });
    expect(t).toContainEqual({ tagName: "link", rel: "canonical", href: "/" });
    expect(t).toContainEqual({ property: "og:url", content: "/" });
  });
});

describe("og:image（#129）", () => {
  it("origin 付きの絶対 URL で 1200×630 の og-image.png を指し、twitter:card は summary_large_image", () => {
    const tags = seoMeta({ description: "d", pathname: "/", origin: "https://example.test" });
    expect(tags).toContainEqual({ property: "og:image", content: "https://example.test/og-image.png" });
    expect(tags).toContainEqual({ property: "og:image:width", content: "1200" });
    expect(tags).toContainEqual({ property: "og:image:height", content: "630" });
    expect(tags).toContainEqual({ name: "twitter:card", content: "summary_large_image" });
  });

  it("origin が無ければ site-relative", () => {
    const tags = seoMeta({ description: "d", pathname: "/about", origin: "" });
    expect(tags).toContainEqual({ property: "og:image", content: "/og-image.png" });
  });
});

// Issue #127: staging.gikailog.jp はクローラに拾わせない（robots Disallow + <meta name=robots content=noindex>）。
describe("isStagingOrigin / robotsMeta", () => {
  it("SITE_ORIGIN=https://staging.gikailog.jp は staging", () => {
    expect(isStagingOrigin("https://staging.gikailog.jp")).toBe(true);
    expect(isStagingOrigin("https://staging.gikailog.jp/")).toBe(true);
  });
  it("本番・未設定・staging を含むだけのホストは staging ではない", () => {
    expect(isStagingOrigin("https://gikailog.jp")).toBe(false);
    expect(isStagingOrigin("")).toBe(false);
    expect(isStagingOrigin(undefined)).toBe(false);
    expect(isStagingOrigin("https://notstaging.gikailog.jp")).toBe(false);
    expect(isStagingOrigin("https://gikailog.jp/staging")).toBe(false);
  });
  it("staging のときだけ noindex, nofollow の robots meta を返す", () => {
    expect(robotsMeta("https://staging.gikailog.jp")).toEqual({ name: "robots", content: "noindex, nofollow" });
    expect(robotsMeta("https://gikailog.jp")).toBeNull();
    expect(robotsMeta("")).toBeNull();
  });
});
