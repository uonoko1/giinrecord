import type { Config } from "@react-router/dev/config";
import { defaultDataDir, memberPaths } from "./app/lib/data-files";

/**
 * Static site only. `ssr: false` means NO server code ships or runs in production;
 * `prerender` writes an HTML file per route at build time so search engines
 * can land directly on a member page.
 */
export default {
  ssr: false,
  prerender: async () => {
    // Member pages come from data/members/index.json; without data/ only the static pages exist.
    return ["/", "/about", ...(await memberPaths(defaultDataDir()))];
  },
} satisfies Config;
