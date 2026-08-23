/**
 * Build-time enumeration of every path the static site must contain.
 * Called from react-router.config.ts; kept here so route PBIs can add their
 * paths without touching the (shared) config file. Node only.
 */
import { assemblyPaths, memberPaths, rollCallPaths } from "./data-files";

export const STATIC_PATHS = ["/", "/about", "/terms", "/privacy"];

/** Without data/ only the static pages exist; every data-backed path comes from the index.json files under data/. */
export async function prerenderPaths(dataDir: string): Promise<string[]> {
  const [members, assemblies, rollcalls] = await Promise.all([memberPaths(dataDir), assemblyPaths(dataDir), rollCallPaths(dataDir)]);
  return [...STATIC_PATHS, ...members, ...assemblies, ...rollcalls];
}
