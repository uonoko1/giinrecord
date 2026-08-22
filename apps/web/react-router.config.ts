import type { Config } from "@react-router/dev/config";

/**
 * Static site only. `ssr: false` means NO server code ships or runs in production;
 * `prerender` writes an HTML file per route at build time so search engines
 * can land directly on a member page.
 */
export default {
  ssr: false,
  prerender: async () => {
    // S1: enumerate members/rollcalls from data/ once the ETL populates it.
    return ["/", "/about"];
  },
} satisfies Config;
