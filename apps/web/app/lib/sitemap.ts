/**
 * sitemap.xml / robots.txt text generation. Pure; scripts/sitemap.ts does the I/O.
 * With no origin the <loc> values are site-relative paths: not spec-compliant, but the
 * build keeps working and the smoke test can still verify every entry exists.
 */
import { canonicalUrl, isStagingOrigin } from "./seo";

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

export interface SitemapOptions {
  /** normalized origin ("" → relative) */
  origin: string;
  /** ISO datetime (meta.fetchedAt); null → no <lastmod> */
  lastmod: string | null;
}

export function buildSitemap(paths: string[], { origin, lastmod }: SitemapOptions): string {
  const day = lastmod ? lastmod.slice(0, 10) : null;
  const urls = paths.map((p) => {
    const loc = `<loc>${escapeXml(canonicalUrl(origin, p))}</loc>`;
    return `  <url>${loc}${day ? `<lastmod>${day}</lastmod>` : ""}</url>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}

export function buildRobots(origin: string): string {
  // staging.gikailog.jp (#127): nothing is crawlable, and no sitemap is advertised.
  if (isStagingOrigin(origin)) return "User-agent: *\nDisallow: /\n";
  // /compare (#104) is query-driven, served from the SPA fallback and meta noindex; keep crawlers off it here too.
  const base = "User-agent: *\nAllow: /\nDisallow: /compare\n";
  return origin ? `${base}\nSitemap: ${origin}/sitemap.xml\n` : base;
}

/** Every <loc> in document order (used by the smoke test). */
export function sitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => unescapeXml(m[1] ?? ""));
}
