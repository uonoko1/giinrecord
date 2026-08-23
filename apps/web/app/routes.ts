import { existsSync } from "node:fs";
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

export default [
  index("routes/home.tsx"),
  route("about", "routes/about.tsx"),
  route("members", "routes/members.tsx"),
  route("compare", "routes/compare.tsx"), // #104: クエリ依存・プリレンダー無し（SPA fallback）・noindex
  ...(hasMemberData ? [route("members/:id", "routes/member.tsx")] : []),
  ...(hasRollCallData ? [route("rollcalls/:session?", "routes/rollcalls.tsx"), route("rollcalls/:session/:id", "routes/rollcall.tsx")] : []),
] satisfies RouteConfig;
