import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHokkaidoBureaus } from "../src/sources/districts/hokkaido-bureaus.ts";
import { parseKenAll } from "../src/sources/districts/ken-all.ts";
import { parseDistrictText } from "../src/sources/districts/soumu-districts.ts";
import { resolveDistricts, type Municipality } from "../src/sources/districts/resolve.ts";
import { buildDistrictsMeta, validateDistricts, writeDistricts, type DistrictsMeta } from "../src/sources/districts/dataset.ts";

// data/districts/（docs/DATA_CONTRACT.md「選挙区」）の書き出しと不変条件（Issue #111）。
const fixture = (name: string) => new URL(`./fixtures/districts/${name}`, import.meta.url);
const rows = parseKenAll(readFileSync(fixture("ken-all-excerpt.csv"))).filter((r) => r.pref === "東京都");
const munis: Municipality[] = readFileSync(fixture("ken-all-municipalities.csv"), "utf8").trim().split("\n").slice(1)
  .map((line) => { const [code, pref, city] = line.split(","); return { code, pref, city }; }).filter((m) => m.pref === "東京都");
const bureaus = parseHokkaidoBureaus(readFileSync(fixture("hokkaido-shicho.html"), "utf8"));
const tokyo = { ...parseDistrictText(readFileSync(fixture("soumu-text-tokyo.txt"), "utf8"), "東京都"), url: "https://www.soumu.go.jp/main_content/000853814.pdf" };
const resolved = resolveDistricts(rows, [tokyo], bureaus, munis);
const fetchedAt = "2026-08-23T07:00:00.000Z";
const meta = (): DistrictsMeta => buildDistrictsMeta(resolved, { fetchedAt, kenAllUpdated: "2026-07-31", effectiveDate: "2022-12-28", prefectureUrls: [{ pref: "東京都", url: tokyo.url }] });

test("buildDistrictsMeta: 出典 URL・取得日時・基準日（KEN_ALL の更新日、区割りの施行日）・件数・分割市区町村の一覧を持つ", () => {
  const m = meta();
  assert.equal(m.fetchedAt, fetchedAt);
  assert.deepEqual(m.asOf, { kenAll: "2026-07-31", shugiinDistricts: "2022-12-28" });
  assert.ok(m.sources.every((s) => s.url.startsWith("https://") && s.fetchedAt === fetchedAt && s.name));
  assert.ok(m.sources.some((s) => s.url === "https://www.soumu.go.jp/main_content/000853814.pdf" && s.name.includes("東京都")));
  assert.ok(m.sources.some((s) => s.url.includes("reiki.metro.tokyo.lg.jp")), "東京都支庁設置条例");
  assert.ok(m.sources.some((s) => s.url.includes("city.hamamatsu.shizuoka.jp")), "浜松市 区の再編");
  assert.deepEqual(m.counts, { zips: Object.keys(resolved.byZip).length, municipalities: munis.length, shugiinDistricts: 30, splitMunicipalities: resolved.splits.length });
  assert.ok(m.splitMunicipalities.some((s) => s.city === "大田区" && s.shugiin.join() === "東京4,東京26"));
});

test("writeDistricts: by-zip.json / municipalities.json / meta.json を stableJson で書き、validateDistricts が通る", async () => {
  const dir = await mkdtemp(join(tmpdir(), "districts-"));
  await writeDistricts(dir, resolved, meta());
  const byZip = JSON.parse(await readFile(join(dir, "districts", "by-zip.json"), "utf8"));
  assert.deepEqual(byZip["1440052"], { sangiin: ["東京"], shugiin: ["東京4", "東京26"] });
  const text = await readFile(join(dir, "districts", "by-zip.json"), "utf8");
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(await validateDistricts(dir), []);
});

test("validateDistricts: 7 桁でない郵便番号・空の候補・名簿表記でない区名・by-zip に無い市区町村の区・件数の不一致を違反として列挙する", async () => {
  const dir = await mkdtemp(join(tmpdir(), "districts-"));
  await writeDistricts(dir, resolved, meta());
  const file = join(dir, "districts", "by-zip.json");
  const byZip = JSON.parse(await readFile(file, "utf8"));
  byZip["12345"] = { sangiin: ["東京"], shugiin: ["東京1"] };
  byZip["1000001"] = { sangiin: [], shugiin: ["東京第1区"] };
  await writeFile(file, JSON.stringify(byZip));
  const v = await validateDistricts(dir);
  assert.ok(v.some((x) => x.includes("12345")), v.join("\n"));
  assert.ok(v.some((x) => x.includes("1000001") && x.includes("sangiin")), v.join("\n"));
  assert.ok(v.some((x) => x.includes("東京第1区")), v.join("\n"));
  assert.ok(v.some((x) => x.includes("counts.zips")), v.join("\n"));
});

test("validateDistricts: ファイルが無ければ違反", async () => {
  const dir = await mkdtemp(join(tmpdir(), "districts-"));
  const v = await validateDistricts(dir);
  assert.ok(v.length >= 1 && v[0].includes("by-zip.json"));
});
