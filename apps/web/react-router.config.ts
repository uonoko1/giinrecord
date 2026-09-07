import type { Config } from "@react-router/dev/config";
import { defaultDataDir } from "./app/lib/data-files";
import { buildPrerenderPaths } from "./app/lib/prerender";

/**
 * Static site only. `ssr: false` means NO server code ships or runs in production;
 * `prerender` writes an HTML file per route at build time so search engines
 * can land directly on a member page. The path list lives in app/lib/prerender.ts.
 * `buildPrerenderPaths` also adds the not-found page (#610); sitemap.ts uses the plain
 * `prerenderPaths` on purpose, so that noindex path never appears in the sitemap.
 */
export default {
  ssr: false,
  prerender: () => buildPrerenderPaths(defaultDataDir()),
} satisfies Config;
