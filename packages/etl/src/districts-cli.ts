import { fileURLToPath } from "node:url";
import { fetchKenAll } from "./sources/districts/ken-all.ts";
import { fetchSoumuDistricts } from "./sources/districts/soumu-districts.ts";
import { fetchHokkaidoBureaus } from "./sources/districts/hokkaido-bureaus.ts";
import { resolveDistricts } from "./sources/districts/resolve.ts";
import { buildDistrictsMeta, validateDistricts, writeDistricts } from "./sources/districts/dataset.ts";

/**
 * 選挙区 ETL（Issue #111）。月次（.github/workflows/districts.yml）。日次 ETL（cli.ts）とは独立。
 *   日本郵便 KEN_ALL（郵便番号 → 市区町村）× 総務省 衆院小選挙区の区域 PDF（市区町村 → 小選挙区）× 参院は都道府県（合区あり）
 *   → data/districts/by-zip.json, municipalities.json, meta.json
 * 推定しない: 分割された市区町村は候補を全部並べ、件数をログに出す。照合できなければ非 0 終了。
 * Usage: pnpm etl:districts
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
const fetchedAt = new Date().toISOString();

const kenAll = await fetchKenAll();
console.log(`KEN_ALL: ${kenAll.rows.length} rows (updated ${kenAll.updated})`);
const soumu = await fetchSoumuDistricts();
const districtCount = soumu.prefectures.reduce((n, p) => n + p.districts.length, 0);
console.log(`soumu: ${soumu.prefectures.length} prefectures, ${districtCount} districts (effective ${soumu.effectiveDate})`);
const bureaus = await fetchHokkaidoBureaus();
console.log(`hokkaido: ${bureaus.size} bureaus, ${[...bureaus.values()].flat().length} municipalities`);

const resolved = resolveDistricts(kenAll.rows, soumu.prefectures, bureaus);
console.log(`districts: ${resolved.municipalities.length} municipalities, ${Object.keys(resolved.byZip).length} zips`);
// 分割区（市区町村が複数の小選挙区にまたがる）は推定せず候補を並べる。運用者が確認できるよう件数と一覧を出す。
console.log(`split municipalities (candidates listed, not resolved): ${resolved.splits.length}`);
for (const s of resolved.splits) console.log(`  ${s.pref}${s.city} (${s.code}): ${s.shugiin.join(" / ")}`);
const multiZips = Object.values(resolved.byZip).filter((z) => z.shugiin.length > 1).length;
console.log(`zips with multiple shugiin candidates: ${multiZips}`);

const meta = buildDistrictsMeta(resolved, {
  fetchedAt,
  kenAllUpdated: kenAll.updated,
  effectiveDate: soumu.effectiveDate,
  prefectureUrls: soumu.prefectures.map((p) => ({ pref: p.pref, url: p.url })),
});
await writeDistricts(DATA, resolved, meta);

const violations = await validateDistricts(DATA);
if (violations.length) {
  console.error(`districts contract violations: ${violations.length}`);
  for (const line of violations) console.error(`  ${line}`);
  process.exit(1);
}
console.log("done");
