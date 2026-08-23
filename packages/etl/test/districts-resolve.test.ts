import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHokkaidoBureaus } from "../src/sources/districts/hokkaido-bureaus.ts";
import { parseKenAll } from "../src/sources/districts/ken-all.ts";
import { parseDistrictText } from "../src/sources/districts/soumu-districts.ts";
import { resolveDistricts, sangiinDistrict, shugiinDistrict, type Municipality } from "../src/sources/districts/resolve.ts";

// 郵便番号 → 選挙区の解決（Issue #111）。推定しない: 分割された市区町村は候補を全部並べ、照合できない単位・区が付かない市区町村があれば失敗する。
const fixture = (name: string) => new URL(`./fixtures/districts/${name}`, import.meta.url);
const rows = parseKenAll(readFileSync(fixture("ken-all-excerpt.csv")));
// 市区町村の全一覧（KEN_ALL 2026-07-31 の 団体コード・都道府県・市区町村 を重複除去したもの、1892 件）。別表の単位はこの中から探す。
const allMunicipalities: Municipality[] = readFileSync(fixture("ken-all-municipalities.csv"), "utf8").trim().split("\n").slice(1)
  .map((line) => { const [code, pref, city] = line.split(","); return { code, pref, city }; });
const bureaus = parseHokkaidoBureaus(readFileSync(fixture("hokkaido-shicho.html"), "utf8"));
const text = (name: string) => readFileSync(fixture(`soumu-text-${name}.txt`), "utf8");
const only = (pref: string) => rows.filter((r) => r.pref === pref);
const munis = (pref: string) => allMunicipalities.filter((m) => m.pref === pref);
const resolve = (pref: string, table: ReturnType<typeof parseDistrictText>) => resolveDistricts(only(pref), [table], bureaus, munis(pref));

test("parseHokkaidoBureaus: 北海道の「総合振興局・振興局」ページから 14 局と所管市町村を取る", () => {
  assert.equal(bureaus.size, 14);
  assert.deepEqual(bureaus.get("根室振興局"), ["根室市", "別海町", "中標津町", "標津町", "羅臼町"]);
  assert.equal(bureaus.get("石狩振興局")?.[0], "札幌市");
  assert.equal([...bureaus.values()].flat().length, 179); // 35 市 129 町 15 村
});

test("parseHokkaidoBureaus: 14 局そろわなければ失敗する", () => {
  assert.throws(() => parseHokkaidoBureaus("<html><h2 id=\"a\"><a href=\"x\">空知総合振興局</a></h2><p>夕張市 ／岩見沢市</p></html>"), /14/);
});

test("選挙区名は名簿の表記に合わせる（参院: 東京 / 鳥取・島根、衆院: 東京4 / 北海道12）", () => {
  assert.equal(sangiinDistrict("東京都"), "東京");
  assert.equal(sangiinDistrict("北海道"), "北海道");
  assert.equal(sangiinDistrict("鳥取県"), "鳥取・島根");
  assert.equal(sangiinDistrict("島根県"), "鳥取・島根");
  assert.equal(sangiinDistrict("高知県"), "徳島・高知");
  assert.equal(shugiinDistrict("東京都", 4), "東京4");
  assert.equal(shugiinDistrict("北海道", 12), "北海道12");
  assert.equal(shugiinDistrict("京都府", 1), "京都1");
});

test("市区が丸ごと 1 つの区なら候補は 1 つ（千代田区 → 東京1）", () => {
  const r = resolve("東京都", parseDistrictText(text("tokyo"), "東京都"));
  assert.deepEqual(r.byZip["1000001"], { sangiin: ["東京"], shugiin: ["東京1"] });
  const chiyoda = r.municipalities.find((m) => m.city === "千代田区");
  assert.deepEqual(chiyoda, { code: "13101", pref: "東京都", city: "千代田区", shugiin: ["東京1"], split: false });
});

test("分割された市区（大田区 = 第4区と第26区）は郵便番号に関わらず両方の候補を並べ、split として数える", () => {
  const r = resolve("東京都", parseDistrictText(text("tokyo"), "東京都"));
  assert.deepEqual(r.byZip["1440052"], { sangiin: ["東京"], shugiin: ["東京4", "東京26"] });
  assert.deepEqual(r.splits.map((s) => [s.city, s.shugiin]).filter(([c]) => c === "大田区"), [["大田区", ["東京4", "東京26"]]]);
});

test("支庁管内（東京都支庁設置条例の所管区域）: 三宅島三宅村・八丈島八丈町のような KEN_ALL の表記でも町村に紐づく", () => {
  const r = resolve("東京都", parseDistrictText(text("tokyo"), "東京都"));
  assert.deepEqual(r.byZip["1001100"].shugiin, ["東京3"]); // 三宅村
  assert.deepEqual(r.byZip["1001400"].shugiin, ["東京3"]); // 八丈町
  assert.deepEqual(r.byZip["1002100"].shugiin, ["東京3"]); // 小笠原村
});

test("振興局管内は北海道の所管市町村表で町村に展開する（市は別表に直接載る）。同名の町は郡を除いた名前の完全一致で区別する", () => {
  const r = resolve("北海道", parseDistrictText(text("hokkaido"), "北海道"));
  assert.deepEqual(r.byZip["0440000"].shugiin, ["北海道4"]); // 虻田郡倶知安町（後志）
  assert.deepEqual(r.byZip["0861600"].shugiin, ["北海道7"]); // 標津郡標津町（根室）— 中標津町と混同しない
  assert.deepEqual(r.byZip["0801200"].shugiin, ["北海道11"]); // 河東郡士幌町（十勝）— 上士幌町と混同しない
  assert.deepEqual(r.byZip["0890100"].shugiin, ["北海道11"]); // 上川郡清水町（十勝）— 斜里郡小清水町（オホーツク=12区）と混同しない
  assert.deepEqual(r.byZip["0993600"].shugiin, ["北海道12"]);
});

test("同じ郵便番号が複数の市区町村にまたがれば区の候補は和集合（0040000 = 厚別区(5区)・清田区(3区)）", () => {
  const r = resolve("北海道", parseDistrictText(text("hokkaido"), "北海道"));
  assert.deepEqual(r.byZip["0040000"].shugiin, ["北海道3", "北海道5"]);
});

test("郡の括弧は町村の列挙: 東伯郡（三朝町）→ 1区、東伯郡（湯梨浜町…）→ 2区。郡だけなら郡の全町村", () => {
  const r = resolve("鳥取県", parseDistrictText(text("tottori"), "鳥取県"));
  assert.deepEqual(r.byZip["6820100"], { sangiin: ["鳥取・島根"], shugiin: ["鳥取1"] });
  assert.deepEqual(r.byZip["6820700"].shugiin, ["鳥取2"]);
  assert.deepEqual(r.byZip["6893200"].shugiin, ["鳥取2"]); // 西伯郡大山町（西伯郡 全体）
  assert.equal(r.splits.length, 0);
});

test("外字 〓 は任意の 1 文字として照合し、県内で 1 つに絞れるときだけ紐づく（〓石市 → 釜石市）", () => {
  const iwate = "岩 手 県\n第１区 盛岡市\n第２区 〓石市\n";
  const r = resolveDistricts(only("岩手県"), [parseDistrictText(iwate, "岩手県")], bureaus, munis("岩手県").filter((m) => ["盛岡市", "釜石市"].includes(m.city)));
  assert.deepEqual(r.byZip["0260000"].shugiin, ["岩手2"]);
});

test("区の再編で別表の区名が KEN_ALL に無い市（浜松市、2024-01-01）は再編の対応表で現在の区に展開し、複数の区にまたがれば候補を並べる", () => {
  const r = resolve("静岡県", parseDistrictText(text("shizuoka"), "静岡県"));
  const hamamatsu = r.municipalities.filter((m) => m.city.startsWith("浜松市")).map((m) => [m.city, m.shugiin, m.split]);
  assert.deepEqual(hamamatsu, [
    ["浜松市中央区", ["静岡7", "静岡8"], true], // 旧 中・東・南（8区）＋旧 西（7区）＋旧 北の一部（7区）
    ["浜松市浜名区", ["静岡7"], false], // 旧 北（7区）の残り＋旧 浜北（7区）
    ["浜松市天竜区", ["静岡7"], false],
  ]);
  // 富士市は別表で分割（第4区の一部／第5区）
  assert.deepEqual(r.byZip["4213304"].shugiin, ["静岡4", "静岡5"]);
});

test("別表の単位が KEN_ALL のどの市区町村にも紐づかなければ失敗する（推定しない）", () => {
  const iwate = "岩 手 県\n第１区 盛岡市、存在しない市\n";
  assert.throws(() => resolveDistricts(only("岩手県"), [parseDistrictText(iwate, "岩手県")], bureaus, munis("岩手県")), /存在しない市/);
});

test("〓 で候補が 2 つ以上になれば失敗する", () => {
  const hokkaido = "北 海 道\n第１区 札幌市〓〓区\n";
  assert.throws(() => resolveDistricts(only("北海道"), [parseDistrictText(hokkaido, "北海道")], bureaus, munis("北海道")), /札幌市〓〓区.*札幌市厚別区/);
});

test("KEN_ALL にあるのに区が 1 つも付かない市区町村があれば失敗する（別表の読み落とし検知）", () => {
  const iwate = "岩 手 県\n第１区 盛岡市\n";
  assert.throws(() => resolveDistricts(only("岩手県"), [parseDistrictText(iwate, "岩手県")], bureaus, munis("岩手県").filter((m) => ["盛岡市", "釜石市"].includes(m.city))), /釜石市/);
});

test("別表で一部の区域だけ指定された市区が 1 つの区にしか現れなければ失敗する（残りの区域の読み落とし）", () => {
  const iwate = "岩 手 県\n第１区 盛岡市（本庁管内）、釜石市\n";
  assert.throws(() => resolveDistricts(only("岩手県"), [parseDistrictText(iwate, "岩手県")], bureaus, munis("岩手県").filter((m) => ["盛岡市", "釜石市"].includes(m.city))), /盛岡市.*only one district/);
});

test("別表に無い都道府県の郵便番号があれば失敗する", () => {
  assert.throws(() => resolveDistricts(only("鳥取県"), [parseDistrictText(text("hokkaido"), "北海道")], bureaus, munis("鳥取県")), /鳥取県/);
});
