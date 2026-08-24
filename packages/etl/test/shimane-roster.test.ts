import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DISTRICT_PAGES, parseDistrictIndex, parseDistrictPage, parseRoster, SHIMANE_ROSTER_URL } from "../src/sources/local/shimane/roster.ts";

// 島根県議会 議員名簿（選挙区別。/gikai/gaido/meibo/tiku.html → 12 の選挙区ページ。2026-08-24 取得）。
// 選挙区ページは写真の表で、セルごとに ふりがな・氏名（プロフィールへのリンク）・所属会派が並ぶ。
const fixture = (name: string) => readFileSync(new URL(`./fixtures/shimane/${name}`, import.meta.url), "utf8");
const origin = "https://www.pref.shimane.lg.jp";
const meibo = (slug: string) => fixture(`meibo-${slug}.html`);

test("parseDistrictIndex: 選挙区の表から 12 の選挙区ページ（選挙区名つき）を返す", () => {
  const districts = parseDistrictIndex(fixture("meibo-tiku.html"), SHIMANE_ROSTER_URL);
  assert.equal(districts.length, 12);
  assert.deepEqual(districts[0], { district: "松江", url: `${origin}/gikai/gaido/meibo/matsue.html` });
  assert.deepEqual(districts.map((d) => d.district), ["松江", "浜田", "出雲", "益田", "大田", "安来", "江津", "雲南・飯石", "仁多", "邑智", "鹿足", "隠岐"]);
  // DISTRICT_PAGES（取得順を固定するための一覧）と一致する
  assert.deepEqual(districts.map((d) => d.url), DISTRICT_PAGES.map((d) => `${origin}${d.path}`));
});

test("parseDistrictPage（松江）: 氏名・ふりがな・会派・プロフィール URL。id はプロフィールページの slug から", () => {
  const page = parseDistrictPage(meibo("matsue"), `${origin}/gikai/gaido/meibo/matsue.html`, "松江");
  assert.equal(page.asOf, "2023-05-17"); // caption の「（令和5年5月17日現在）」
  assert.equal(page.members.length, 10);
  assert.deepEqual(page.members[0], {
    id: "p_32_giin33_fukuda",
    assemblyId: "pref-32",
    name: "福田正明",
    kana: "ふくだまさあき",
    group: "自民党ネクスト島根",
    district: "松江",
    profileUrl: `${origin}/gikai/gaido/meibo/simeibetu/giin33_fukuda.html`,
    current: true,
    asOf: "2023-05-17",
    sourceUrl: `${origin}/gikai/gaido/meibo/matsue.html`,
    counts: { rollcalls: 0 },
  });
  // ふりがな・会派が氏名と同じ <p> にある人（五百川）も、別の <p> にある人（尾村）も同じように読む
  assert.deepEqual(
    page.members.map((m) => [m.name, m.kana, m.group]).slice(1, 4),
    [
      ["五百川純寿", "いおがわすみひさ", "自民党議員連盟"],
      ["尾村利成", "おむらとしなり", "日本共産党島根県議団"],
      ["白石恵子", "はくいしけいこ", "民主県民クラブ"],
    ],
  );
});

test("parseDistrictPage: 1 人区（表が無く <p> だけのページ）も同じように読む。掲載日は caption ではなく本文の <p>", () => {
  const page = parseDistrictPage(meibo("goutu"), `${origin}/gikai/gaido/meibo/goutu.html`, "江津");
  assert.equal(page.asOf, "2023-05-17");
  assert.equal(page.members.length, 1);
  assert.deepEqual([page.members[0].name, page.members[0].kana, page.members[0].group, page.members[0].district], ["坪内涼二", "つぼうちりょうじ", "自民党議員連盟", "江津"]);
});

test("parseRoster: 12 選挙区で 35 人。id は一意、asOf は選挙区ページの掲載日のうち最新", () => {
  const roster = parseRoster(DISTRICT_PAGES.map((d) => ({ district: d.district, url: `${origin}${d.path}`, html: meibo(d.slug) })));
  assert.equal(roster.members.length, 35);
  assert.equal(roster.asOf, "2023-05-17");
  assert.equal(new Set(roster.members.map((m) => m.id)).size, 35);
  for (const m of roster.members) {
    assert.ok(m.id.startsWith("p_32_"), m.id);
    assert.equal(m.assemblyId, "pref-32");
    assert.equal(m.asOf, "2023-05-17");
    assert.ok(m.name !== "" && m.kana !== "" && m.group !== "" && m.district !== "", JSON.stringify(m));
    assert.ok(m.profileUrl?.startsWith(`${origin}/gikai/gaido/meibo/simeibetu/`), m.profileUrl);
  }
  // 会派は名簿の原文のまま（会派別名簿 PDF の正式名称「自由民主党島根県議会議員連盟」等に寄せない。「会派に属しない」も原文）
  assert.deepEqual([...new Set(roster.members.map((m) => m.group))].sort(), ["会派に属しない", "公明党島根県議団", "日本共産党島根県議団", "民主県民クラブ", "自民党ネクスト島根", "自民党議員連盟"]);
  // 選挙区ごとの人数（選挙区別名簿の定数）
  const byDistrict = new Map<string, number>();
  for (const m of roster.members) byDistrict.set(m.district!, (byDistrict.get(m.district!) ?? 0) + 1);
  assert.equal(byDistrict.get("松江"), 10);
  assert.equal(byDistrict.get("出雲"), 9);
  assert.equal(byDistrict.get("隠岐"), 1);
});

test("parseRoster: どのページにも掲載日が無ければ例外（取得日で代用しない）", () => {
  const strip = (html: string) => html.replace(/[（(]令和5年5月17日現在[）)]/g, "").replace(/[（(]令和５年５月17日現在[）)]/g, "");
  const pages = DISTRICT_PAGES.map((d) => ({ district: d.district, url: `${origin}${d.path}`, html: strip(meibo(d.slug)) }));
  assert.throws(() => parseRoster(pages), /掲載日/);
});

test("parseRoster: 同じ議員が 2 つの選挙区ページに出たら例外（黙って重複させない）", () => {
  const pages = DISTRICT_PAGES.map((d) => ({ district: d.district, url: `${origin}${d.path}`, html: meibo(d.slug) }));
  assert.throws(() => parseRoster([...pages, { district: "隠岐", url: `${origin}/gikai/gaido/meibo/oki.html`, html: meibo("oki") }]), /listed twice/);
});
