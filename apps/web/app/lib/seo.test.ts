/**
 * SEO タグ生成の仕様。SITE_ORIGIN が無ければ相対 URL で壊れない。
 */
import { describe, expect, it } from "vitest";
import { canonicalUrl, isStagingOrigin, metaIdentity, normalizeOrigin, robotsMeta, seoMeta, staleHeadTags } from "./seo";

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
    expect(tags).toContainEqual({ title: "藤川 政人（参議院・愛知）の投票記録 ・ 議員レコード" });
    expect(tags).toContainEqual({ name: "description", content: "説明" });
    expect(tags).toContainEqual({ tagName: "link", rel: "canonical", href: "https://example.test/members/m_1" });
    expect(tags).toContainEqual({ property: "og:title", content: "藤川 政人（参議院・愛知）の投票記録 ・ 議員レコード" });
    expect(tags).toContainEqual({ property: "og:description", content: "説明" });
    expect(tags).toContainEqual({ property: "og:type", content: "article" });
    expect(tags).toContainEqual({ property: "og:url", content: "https://example.test/members/m_1" });
    expect(tags).toContainEqual({ property: "og:site_name", content: "議員レコード" });
  });
  it("title が無ければサイト名だけ、type は既定で website、origin 未設定なら相対", () => {
    const t = seoMeta({ description: "d", pathname: "/", origin: "" });
    expect(t).toContainEqual({ title: "議員レコード" });
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

// Issue #127: staging.giinrecord.jp はクローラに拾わせない（robots Disallow + <meta name=robots content=noindex>）。
describe("isStagingOrigin / robotsMeta", () => {
  it("SITE_ORIGIN=https://staging.giinrecord.jp は staging", () => {
    expect(isStagingOrigin("https://staging.giinrecord.jp")).toBe(true);
    expect(isStagingOrigin("https://staging.giinrecord.jp/")).toBe(true);
  });
  it("本番・未設定・staging を含むだけのホストは staging ではない", () => {
    expect(isStagingOrigin("https://giinrecord.jp")).toBe(false);
    expect(isStagingOrigin("")).toBe(false);
    expect(isStagingOrigin(undefined)).toBe(false);
    expect(isStagingOrigin("https://notstaging.giinrecord.jp")).toBe(false);
    expect(isStagingOrigin("https://giinrecord.jp/staging")).toBe(false);
  });
  it("staging のときだけ noindex, nofollow の robots meta を返す", () => {
    expect(robotsMeta("https://staging.giinrecord.jp")).toEqual({ name: "robots", content: "noindex, nofollow" });
    expect(robotsMeta("https://giinrecord.jp")).toBeNull();
    expect(robotsMeta("")).toBeNull();
  });
});

describe("metaIdentity / staleHeadTags（#239: プリレンダーの meta が残って二重になるのを消す）", () => {
  /** `<meta …>` の代わり。getAttribute だけを見る */
  function tag(attrs: Record<string, string>) {
    return { attrs, getAttribute: (name: string) => attrs[name] ?? null };
  }

  it("metaIdentity は name → property の順に同一性を決め、どちらも無ければ null", () => {
    expect(metaIdentity(tag({ name: "description", content: "あ" }))).toBe("name:description");
    expect(metaIdentity(tag({ property: "og:url", content: "/members" }))).toBe("property:og:url");
    expect(metaIdentity(tag({ charset: "utf-8" }))).toBeNull();
  });

  it("同じ name が複数あれば最後の1つ（React が今書いたもの）だけを残し、前のものを返す", () => {
    const stale = tag({ name: "description", content: "プリレンダーの説明" });
    const fresh = tag({ name: "description", content: "絞り込み後の説明" });
    expect(staleHeadTags([stale, fresh], metaIdentity)).toEqual([stale]);
  });

  it("name と property が混ざっていてもそれぞれ独立に最後の1つを残す", () => {
    const staleDesc = tag({ name: "description", content: "旧" });
    const freshDesc = tag({ name: "description", content: "新" });
    const staleOg = tag({ property: "og:title", content: "旧" });
    const freshOg = tag({ property: "og:title", content: "新" });
    const viewport = tag({ name: "viewport", content: "width=device-width" });
    expect(staleHeadTags([staleDesc, staleOg, viewport, freshDesc, freshOg], metaIdentity)).toEqual([staleDesc, staleOg]);
  });

  it("重複が無ければ何も消さない（クエリ無しで開いた通常のページ）", () => {
    const tags = [tag({ name: "description", content: "あ" }), tag({ property: "og:title", content: "い" }), tag({ charset: "utf-8" })];
    expect(staleHeadTags(tags, metaIdentity)).toEqual([]);
  });

  it("name も property も無い meta（charset など）は対象外で消さない", () => {
    const a = tag({ charset: "utf-8" });
    const b = tag({ charset: "utf-8" });
    expect(staleHeadTags([a, b], metaIdentity)).toEqual([]);
  });
});
