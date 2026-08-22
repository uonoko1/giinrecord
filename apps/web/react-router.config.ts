import type { Config } from "@react-router/dev/config";
import { defaultDataDir } from "./app/lib/data-files";
import { prerenderPaths } from "./app/lib/prerender";

/**
 * Static site only. `ssr: false` means NO server code ships or runs in production;
 * `prerender` writes an HTML file per route at build time so search engines
 * can land directly on a member page. The path list lives in app/lib/prerender.ts.
 */
export default {
  ssr: false,
  prerender: () => prerenderPaths(defaultDataDir()),
} satisfies Config;
