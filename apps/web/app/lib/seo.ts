/**
 * Per-page SEO tags shared by every route's `meta()`: <title>, description,
 * <link rel=canonical> and OGP. Pure; safe in the browser.
 *
 * The site origin comes from the SITE_ORIGIN env var at build time (Vite inlines
 * `import.meta.env.SITE_ORIGIN`, see vite.config.ts `envPrefix`). When it is unset
 * every URL is site-relative, so a build without a domain still works.
 */

export const SITE_NAME = "議会ログ";

export function normalizeOrigin(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/\/+$/, "");
}

/** Origin baked in at build time; "" when SITE_ORIGIN was not set. */
export function siteOrigin(): string {
  return normalizeOrigin(import.meta.env.SITE_ORIGIN);
}

/** `/members/m_1/` → `{origin}/members/m_1`; `/` stays `/`. No query/hash. */
export function canonicalUrl(origin: string, pathname: string): string {
  const path = pathname.split(/[?#]/, 1)[0] ?? "/";
  const trimmed = path.replace(/\/+$/, "") || "/";
  return `${origin}${trimmed}`;
}

export interface SeoInput {
  /** Page title without the site name; omitted → site name only (home). */
  title?: string;
  description: string;
  pathname: string;
  /** OGP type: "website" (default) or "article" (a single record page). */
  type?: "website" | "article";
  /** Injected for tests; defaults to the build-time SITE_ORIGIN. */
  origin?: string;
}

export function seoMeta({ title, description, pathname, type = "website", origin = siteOrigin() }: SeoInput) {
  const fullTitle = title ? `${title} ・ ${SITE_NAME}` : SITE_NAME;
  const url = canonicalUrl(origin, pathname);
  return [
    { title: fullTitle },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: url },
    { property: "og:title", content: fullTitle },
    { property: "og:description", content: description },
    { property: "og:type", content: type },
    { property: "og:url", content: url },
    { property: "og:site_name", content: SITE_NAME },
    { property: "og:image", content: `${origin}${OG_IMAGE_PATH}` },
    { property: "og:image:width", content: String(OG_IMAGE_SIZE.width) },
    { property: "og:image:height", content: String(OG_IMAGE_SIZE.height) },
    { name: "twitter:card", content: "summary_large_image" },
  ];
}

/** Rasterized at build time from brand/og-image.svg (scripts/brand-assets.ts, #129). */
export const OG_IMAGE_PATH = "/og-image.png";
export const OG_IMAGE_SIZE = { width: 1200, height: 630 } as const;
