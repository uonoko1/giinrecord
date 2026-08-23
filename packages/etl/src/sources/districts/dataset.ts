import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stableJson } from "../../json.ts";
import { HOKKAIDO_BUREAUS_URL } from "./hokkaido-bureaus.ts";
import { KEN_ALL_PAGE_URL, KEN_ALL_ZIP_URL } from "./ken-all.ts";
import type { ResolveResult, ResolvedMunicipality, ZipDistricts } from "./resolve.ts";
import { SOUMU_PAGE_URL } from "./soumu-districts.ts";
import { RENAMED_MUNICIPALITIES, TOKYO_BRANCH_OFFICES } from "./static-areas.ts";

/**
 * `data/districts/`（docs/DATA_CONTRACT.md「選挙区」、Issue #111）。
 *   by-zip.json          Record<郵便番号7桁, { sangiin: string[]; shugiin: string[]; municipalities: string[] }>
 *   municipalities.json  { code, pref, city, shugiin[], split }[]（団体コード順）
 *   meta.json            DistrictsMeta（出典 URL・取得日時・基準日・件数・分割市区町村）
 */
export interface DistrictsMeta {
  fetchedAt: string;
  /** 基準日: KEN_ALL の更新日（ダウンロードページの表記）、小選挙区の区域の施行日（区割り改定法）。 */
  asOf: { kenAll: string; shugiinDistricts: string };
  sources: { name: string; url: string; fetchedAt: string }[];
  counts: { zips: number; municipalities: number; shugiinDistricts: number; splitMunicipalities: number };
  /** 複数の小選挙区にまたがる市区町村（候補を並べた。推定しない）。 */
  splitMunicipalities: { code: string; pref: string; city: string; shugiin: string[] }[];
}

export function buildDistrictsMeta(
  resolved: ResolveResult,
  input: { fetchedAt: string; kenAllUpdated: string; effectiveDate: string; prefectureUrls: { pref: string; url: string }[] },
): DistrictsMeta {
  const { fetchedAt } = input;
  const districts = new Set(resolved.municipalities.flatMap((m) => m.shugiin));
  return {
    fetchedAt,
    asOf: { kenAll: input.kenAllUpdated, shugiinDistricts: input.effectiveDate },
    sources: [
      { name: "日本郵便 郵便番号データ（KEN_ALL）ダウンロードページ", url: KEN_ALL_PAGE_URL, fetchedAt },
      { name: "日本郵便 郵便番号データ（KEN_ALL.CSV、全国一括）", url: KEN_ALL_ZIP_URL, fetchedAt },
      { name: "総務省 衆議院小選挙区の区割りの改定等について（令和4年改定）", url: SOUMU_PAGE_URL, fetchedAt },
      ...input.prefectureUrls.map(({ pref, url }) => ({ name: `総務省 衆議院小選挙区選出議員の選挙区（${pref}）`, url, fetchedAt })),
      { name: "北海道 総合振興局・振興局の所管市町村", url: HOKKAIDO_BUREAUS_URL, fetchedAt },
      { name: "東京都支庁設置条例（支庁の所管区域）", url: TOKYO_BRANCH_OFFICES.source, fetchedAt },
      ...RENAMED_MUNICIPALITIES.map((r) => ({ name: `${r.pref} 区の再編（別表の旧区名と現在の区の対応）`, url: r.source, fetchedAt })),
    ],
    counts: {
      zips: Object.keys(resolved.byZip).length,
      municipalities: resolved.municipalities.length,
      shugiinDistricts: districts.size,
      splitMunicipalities: resolved.splits.length,
    },
    splitMunicipalities: resolved.splits.map(({ code, pref, city, shugiin }) => ({ code, pref, city, shugiin })),
  };
}

export async function writeDistricts(dataDir: string, resolved: ResolveResult, meta: DistrictsMeta): Promise<void> {
  const dir = join(dataDir, "districts");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "by-zip.json"), stableJson(resolved.byZip));
  await writeFile(join(dir, "municipalities.json"), stableJson(resolved.municipalities));
  await writeFile(join(dir, "meta.json"), stableJson(meta));
}

const DISTRICT_NAME = /^[^\d\s]+\d+$/; // 名簿表記「東京4」「北海道12」

/** 不変条件。違反を全部列挙する（空なら OK）。 */
export async function validateDistricts(dataDir: string): Promise<string[]> {
  const dir = join(dataDir, "districts");
  const v: string[] = [];
  const read = async <T>(name: string): Promise<T | undefined> => {
    try { return JSON.parse(await readFile(join(dir, name), "utf8")) as T; } catch { v.push(`districts/${name} missing or not JSON`); return undefined; }
  };
  const byZip = await read<Record<string, ZipDistricts>>("by-zip.json");
  const municipalities = await read<ResolvedMunicipality[]>("municipalities.json");
  const meta = await read<DistrictsMeta>("meta.json");
  if (!byZip || !municipalities || !meta) return v;

  const sangiinNames = new Set<string>();
  const shugiinNames = new Set<string>();
  for (const m of municipalities) {
    if (!/^\d{5}$/.test(m.code)) v.push(`municipalities: bad code ${m.code}`);
    if (!m.shugiin.length) v.push(`municipalities: ${m.pref}${m.city} has no shugiin district`);
    if (m.split !== m.shugiin.length > 1) v.push(`municipalities: ${m.pref}${m.city} split flag does not match candidates`);
    for (const d of m.shugiin) { if (!DISTRICT_NAME.test(d)) v.push(`municipalities: ${m.pref}${m.city} bad district name ${d}`); shugiinNames.add(d); }
  }
  for (const [zip, d] of Object.entries(byZip)) {
    if (!/^\d{7}$/.test(zip)) v.push(`by-zip: bad zip ${zip}`);
    if (!d.sangiin?.length) v.push(`by-zip: ${zip} has no sangiin district`);
    if (!d.shugiin?.length) v.push(`by-zip: ${zip} has no shugiin district`);
    if (!d.municipalities?.length) v.push(`by-zip: ${zip} has no municipalities`);
    for (const s of d.sangiin ?? []) { if (/\d/.test(s) || !s) v.push(`by-zip: ${zip} bad sangiin name ${s}`); sangiinNames.add(s); }
    for (const s of d.shugiin ?? []) {
      if (!DISTRICT_NAME.test(s)) v.push(`by-zip: ${zip} bad shugiin name ${s}`);
      else if (!shugiinNames.has(s)) v.push(`by-zip: ${zip} district ${s} is not in municipalities.json`);
    }
  }
  if (meta.counts.zips !== Object.keys(byZip).length) v.push(`meta: counts.zips ${meta.counts.zips} != ${Object.keys(byZip).length}`);
  if (meta.counts.municipalities !== municipalities.length) v.push(`meta: counts.municipalities ${meta.counts.municipalities} != ${municipalities.length}`);
  if (meta.counts.shugiinDistricts !== shugiinNames.size) v.push(`meta: counts.shugiinDistricts ${meta.counts.shugiinDistricts} != ${shugiinNames.size}`);
  if (meta.counts.splitMunicipalities !== municipalities.filter((m) => m.split).length) v.push("meta: counts.splitMunicipalities mismatch");
  if (meta.splitMunicipalities.length !== meta.counts.splitMunicipalities) v.push("meta: splitMunicipalities list does not match count");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.asOf?.kenAll ?? "")) v.push("meta: asOf.kenAll missing");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.asOf?.shugiinDistricts ?? "")) v.push("meta: asOf.shugiinDistricts missing");
  if (!meta.fetchedAt) v.push("meta: fetchedAt missing");
  for (const s of meta.sources ?? []) if (!s.name || !/^https:\/\//.test(s.url) || !s.fetchedAt) v.push(`meta: bad source ${JSON.stringify(s)}`);
  if (!meta.sources?.length) v.push("meta: sources empty");
  return v;
}
