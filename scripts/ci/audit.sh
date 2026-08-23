#!/usr/bin/env bash
# `pnpm audit` gate (Issue #133): fail on any advisory of severity high or critical, unless it is listed in
# scripts/ci/audit-ignore.txt with an expiry date AND a justification. Runs in CI (security.yml) and locally:
#   bash scripts/ci/audit.sh
#
# Ignore file format (one per line; `#` comments and blank lines ignored):
#   GHSA-xxxx-xxxx-xxxx  YYYY-MM-DD  why this is acceptable here (issue link)
# The entry stops working after the date, so every exception is revisited. Dependabot (enabled on the repo)
# opens the fix PRs; this gate only makes sure a new high+ advisory cannot slip into main unnoticed.
#   Tests: scripts/ci/test/audit.test.sh (pnpm is stubbed; AUDIT_IGNORE_FILE / AUDIT_TODAY are for tests)
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
IGNORE_FILE="${AUDIT_IGNORE_FILE:-$HERE/audit-ignore.txt}"
TODAY="${AUDIT_TODAY:-$(date -u +%F)}"

JSON=$(pnpm audit --json --audit-level=high || true)   # exit 1 = findings; the JSON decides

# node: parse advisories, apply the ignore list, print a report; exit 1 when anything high+ remains.
export JSON IGNORE_FILE TODAY
node - <<'JS'
const fs = require("fs");
let data;
try { data = JSON.parse(process.env.JSON); } catch { console.error("audit: pnpm audit did not return JSON:\n" + process.env.JSON.slice(0, 500)); process.exit(1); }
const advisories = Object.values(data.advisories ?? {});
const today = process.env.TODAY;

const ignores = new Map(); // id → { until, why }
let invalid = 0;
if (fs.existsSync(process.env.IGNORE_FILE)) {
  for (const raw of fs.readFileSync(process.env.IGNORE_FILE, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})\s+(\d{4}-\d{2}-\d{2})(?:\s+(.*))?$/.exec(line);
    if (!m || !m[3] || !m[3].trim()) { console.log(`!! audit-ignore: invalid line (want: GHSA-id YYYY-MM-DD justification): ${line}`); invalid++; continue; }
    ignores.set(m[1], { until: m[2], why: m[3].trim() });
  }
}

let failing = 0;
for (const a of advisories) {
  if (!["high", "critical"].includes(a.severity)) continue;
  const id = a.github_advisory_id ?? String(a.id);
  const ig = ignores.get(id);
  if (ig && ig.until >= today) { console.log(`ignored ${id} (${a.module_name}, ${a.severity}) until ${ig.until}: ${ig.why}`); continue; }
  const note = ig ? ` [ignore expired ${ig.until}]` : "";
  console.log(`!! ${a.severity} ${id} ${a.module_name}: ${(a.title ?? "").trim()} (patched: ${a.patched_versions ?? "?"})${note}`);
  failing++;
}
if (failing || invalid) { console.log(`audit: ${failing} high+ advisor${failing === 1 ? "y" : "ies"} not ignored, ${invalid} invalid ignore line(s)`); process.exit(1); }
console.log(`audit: clean (${advisories.length} advisor${advisories.length === 1 ? "y" : "ies"} below high, ${ignores.size} ignore entr${ignores.size === 1 ? "y" : "ies"})`);
JS
