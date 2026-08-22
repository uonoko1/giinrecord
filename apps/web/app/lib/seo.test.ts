/**
 * SEO タグ生成の仕様。SITE_ORIGIN が無ければ相対 URL で壊れない。
 */
import { describe, expect, it } from "vitest";
import { canonicalUrl, normalizeOrigin, seoMeta } from "./seo";

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
