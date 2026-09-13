import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { type RouteConfig, index, route } from "@react-router/dev/routes";
import { defaultDataDir } from "./lib/data-files";

/**
 * `members/:id` uses a build-time `loader`, which React Router only permits under
 * `ssr:false` when the route is prerendered. So the route exists exactly when
 * data/members/index.json exists; before the ETL runs, the site is just `/` and `/about`.
 */
const hasMemberData = existsSync(path.join(defaultDataDir(), "members", "index.json"));
const hasRollCallData = existsSync(path.join(defaultDataDir(), "rollcalls", "index.json"));
/**
 * #791: 地方議会の採決ページ。`loader` を持つので（ssr:false では prerender 必須）、
 * 地方議会の採決データが 1 議会でもあるときだけルートを作る。
 * **国会の `rollcalls/:session/:id` は触らない**（`/rollcalls/221/221-0724-v007` はそのまま）。
 */
const hasLocalRollCallData = existsSync(path.join(defaultDataDir(), "assemblies", "index.json")) && hasAnyLocalRollCalls();
function hasAnyLocalRollCalls(): boolean {
  const root = path.join(defaultDataDir(), "assemblies");
  try {
    return readdirSync(root, { withFileTypes: true }).some((e) => e.isDirectory() && existsSync(path.join(root, e.name, "rollcalls", "index.json")));
  } catch {
    return false;
  }
}

export default [
  index("routes/home.tsx"),
  route("about", "routes/about.tsx"),
  // #218: 収録範囲。index.json はバンドルから数え、議案 1 件ずつの JSON にしかない氏名の数（#251）だけ loader で数える
  // （STATIC_PATHS に入っていて必ず prerender されるので、ssr:false でも loader を置ける）
  route("coverage", "routes/coverage.tsx"),
  route("terms", "routes/terms.tsx"), // #167
  route("privacy", "routes/privacy.tsx"), // #167
  route("members", "routes/members.tsx"),
  route("compare", "routes/compare.tsx"), // #104: クエリ依存・プリレンダー無し（SPA fallback）・noindex
  // #158: 議会一覧と議会ページ。loader 無し（index.json をバンドル）なのでデータが無くても存在する
  route("assemblies", "routes/assemblies.tsx"),
  route("assemblies/:id", "routes/assembly.tsx"),
  ...(hasMemberData ? [route("members/:id", "routes/member.tsx")] : []),
  ...(hasRollCallData ? [route("rollcalls/:session?", "routes/rollcalls.tsx"), route("rollcalls/:session/:id", "routes/rollcall.tsx")] : []),
  // #791: 地方議会の採決。**国会の /rollcalls とは分ける**（あちらは回次の「数」で切る作りで、
  // 地方の会期 id は数ではない。docs/DATA_CONTRACT.md「地方議会の採決の URL」）。
  // `assemblies/:id` より**後ろ**に置く（React Router は静的セグメントを優先するので順序で食い合わないが、
  // 読む順としてここが正しい）。
  ...(hasLocalRollCallData ? [route("assemblies/:assemblyId/rollcalls", "routes/local-rollcalls.tsx"), route("assemblies/:assemblyId/rollcalls/:id", "routes/local-rollcall.tsx")] : []),
  // #325: どのルートにも一致しない URL。**必ず最後**（React Router は上から照合するので、前に置くと実在ルートを飲み込む）。
  // nginx はこの本文を 404 で返す（deploy/nginx/site.conf の try_files … =404 + error_page）。/compare と同じく noindex。
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
