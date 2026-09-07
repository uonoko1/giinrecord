/**
 * Build-time enumeration of every path the static site must contain.
 * Called from react-router.config.ts; kept here so route PBIs can add their
 * paths without touching the (shared) config file. Node only.
 */
import { assemblyPaths, memberPaths, rollCallPaths } from "./data-files";

export const STATIC_PATHS = ["/", "/about", "/coverage", "/terms", "/privacy"];

/**
 * Issue #610: catch-all（`routes/not-found.tsx`, `route("*", …)`）はワイルドカードで、
 * 実在パスを持たないので `STATIC_PATHS` には入れられない——sitemap.ts / robots.ts も
 * `prerenderPaths` の戻り値をそのまま使っており、`STATIC_PATHS` に混ぜると
 * noindex のはずの not-found が sitemap に載ってしまう（#325 に反する）。
 * 実在しないことが保証できる `NOT_FOUND_PRERENDER_PATH` だけを、prerender の対象には足すが
 * sitemap 側の列挙（`prerenderPaths`）には入れない。ビルド後、このパスの HTML が
 * `deploy/nginx/site.conf` の 404 body として使われる（`__spa-fallback.html` の代わり）。
 */
export const NOT_FOUND_PRERENDER_PATH = "/__not-found";

/** Without data/ only the static pages exist; every data-backed path comes from the index.json files under data/. */
export async function prerenderPaths(dataDir: string): Promise<string[]> {
  const [members, assemblies, rollcalls] = await Promise.all([memberPaths(dataDir), assemblyPaths(dataDir), rollCallPaths(dataDir)]);
  return [...STATIC_PATHS, ...members, ...assemblies, ...rollcalls];
}

/** react-router.config.ts が実際に prerender するパス一覧。sitemap には出さない `NOT_FOUND_PRERENDER_PATH` を足す。 */
export async function buildPrerenderPaths(dataDir: string): Promise<string[]> {
  return [...(await prerenderPaths(dataDir)), NOT_FOUND_PRERENDER_PATH];
}
