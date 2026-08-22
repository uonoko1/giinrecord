/** Build-time env exposed to app code via Vite `envPrefix` (vite.config.ts). */
interface ImportMetaEnv {
  /** Public site origin, e.g. https://example.test — unset → relative URLs (see app/lib/seo.ts) */
  readonly SITE_ORIGIN?: string;
}
