import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import iconv from "iconv-lite";
import { extractPdfText } from "../src/sources/districts/pdf-text.ts";
import { parseDistrictText, parseEffectiveDate, parsePrefecturePdfLinks } from "../src/sources/districts/soumu-districts.ts";

// 総務省「衆議院小選挙区の区割りの改定等について」（令和4年改定、Issue #111）。
//   ページ: https://www.soumu.go.jp/senkyo/senkyo_s/news/senkyo/shu_kuwari/shu_kuwari_4.html（Shift_JIS、2026-08-23 取得）
//   区域は都道府県ごとの PDF（公職選挙法 別表第一の写し）。フィクスチャは岩手県の PDF（000853804.pdf、2026-08-23 取得）と、
//   他県の PDF から extractPdfText で抜き出したテキスト（原文のまま）。
const fixture = (name: string) => new URL(`./fixtures/districts/${name}`, import.meta.url);
const page = iconv.decode(readFileSync(fixture("soumu-shu_kuwari_4.html")), "Shift_JIS");
const text = (name: string) => readFileSync(fixture(`soumu-text-${name}.txt`), "utf8");

test("parsePrefecturePdfLinks: 「衆議院小選挙区選出議員の選挙区（都道府県別）」の表から 47 都道府県の PDF を順に取る", () => {
  const links = parsePrefecturePdfLinks(page, "https://www.soumu.go.jp/senkyo/senkyo_s/news/senkyo/shu_kuwari/shu_kuwari_4.html");
  assert.equal(links.length, 47);
  assert.deepEqual(links[0], { pref: "北海道", url: "https://www.soumu.go.jp/main_content/000853801.pdf" });
  assert.deepEqual(links[12], { pref: "東京都", url: "https://www.soumu.go.jp/main_content/000853814.pdf" });
  assert.deepEqual(links[46], { pref: "沖縄県", url: "https://www.soumu.go.jp/main_content/000853868.pdf" });
});

test("parsePrefecturePdfLinks: 表が無い・47 件でないページは失敗する（別の表を黙って読まない）", () => {
  assert.throws(() => parsePrefecturePdfLinks("<html><table summary=\"x\"></table></html>", "https://www.soumu.go.jp/x"), /都道府県別/);
});

test("parseEffectiveDate: 本文の「令和4年11月28日に公布され、同年12月28日から施行」を施行日 2022-12-28 にする", () => {
  assert.equal(parseEffectiveDate(page), "2022-12-28");
});

test("parseEffectiveDate: 文言が無ければ失敗する", () => {
  assert.throws(() => parseEffectiveDate("<p>改定</p>"), /施行/);
});

test("extractPdfText: 岩手県の PDF からテキストを取り、Unicode に無い外字（釜石市の「釜」）は 〓 にする", async () => {
  const t = await extractPdfText(readFileSync(fixture("soumu-000853804-iwate.pdf")));
  assert.match(t, /^岩 手 県/);
  assert.match(t, /第１区/);
  assert.match(t, /陸前高田市、〓石市、二戸市/);
});

test("parseDistrictText: 岩手県（市・郡だけ）を 3 区に分け、単位は 、 で区切る", async () => {
  const t = await extractPdfText(readFileSync(fixture("soumu-000853804-iwate.pdf")));
  const d = parseDistrictText(t, "岩手県");
  assert.equal(d.pref, "岩手県");
  assert.deepEqual(d.districts.map((x) => x.number), [1, 2, 3]);
  assert.deepEqual(d.districts[0].units, [{ name: "盛岡市", raw: "盛岡市" }, { name: "紫波郡", raw: "紫波郡" }]);
  assert.deepEqual(d.districts[1].units.map((u) => u.name).slice(5, 8), ["〓石市", "二戸市", "八幡平市"]);
});

test("parseDistrictText: 見出しの県名が渡した県名と違えば失敗する（取り違え防止）", async () => {
  const t = await extractPdfText(readFileSync(fixture("soumu-000853804-iwate.pdf")));
  assert.throws(() => parseDistrictText(t, "宮城県"), /宮城県.*岩 手 県/);
});

test("parseDistrictText: 東京都 — 括弧付きの市区は一部の区域（分割）、支庁管内はそのまま単位になる", () => {
  const d = parseDistrictText(text("tokyo"), "東京都");
  assert.equal(d.districts.length, 30);
  const d3 = d.districts[2].units.map((u) => u.name);
  assert.deepEqual(d3, ["品川区", "東京都大島支庁管内", "東京都三宅支庁管内", "東京都八丈支庁管内", "東京都小笠原支庁管内"]);
  const ota = d.districts[3].units[0];
  assert.equal(ota.name, "大田区");
  assert.match(ota.area ?? "", /^大田区大森東特別出張所管内、.*矢口３丁目（１番、８番）に属する区域に限る。）、.*蒲田東特別出張所管内$/);
  // 大田区の残り（第26区）も出張所管内の列挙で、どちらも「大田区」の一部
  const rest = d.districts.flatMap((x) => x.units.filter((u) => u.name === "大田区").map((u) => x.number));
  assert.deepEqual(rest, [4, 26]);
  assert.match(d.districts[25].units.find((u) => u.name === "大田区")?.area ?? "", /^大田区嶺町特別出張所管内、.*に属する区域を除く。）$/);
});

test("parseDistrictText: 鳥取県 — 郡の括弧は町村の列挙（分割ではない）", () => {
  const d = parseDistrictText(text("tottori"), "鳥取県");
  assert.deepEqual(d.districts[0].units.map((u) => [u.name, u.area]), [["鳥取市", undefined], ["倉吉市", undefined], ["岩美郡", undefined], ["八頭郡", undefined], ["東伯郡", "三朝町"]]);
  assert.deepEqual(d.districts[1].units.find((u) => u.name === "東伯郡")?.area, "湯梨浜町、琴浦町、北栄町");
});

test("parseDistrictText: 千葉県 — 半角括弧を含む入れ子でも区の見出しを括弧の中で拾わない", () => {
  const d = parseDistrictText(text("chiba"), "千葉県");
  assert.equal(d.districts.length, 14);
  assert.deepEqual(d.districts[4].units.map((u) => u.name), ["市川市", "浦安市"]);
  assert.deepEqual(d.districts[13].units.map((u) => u.name), ["船橋市", "習志野市"]);
});

test("parseDistrictText: 北海道 — 「（第１区に属しない区域）」の中の「第１区」を見出しにしない", () => {
  const d = parseDistrictText(text("hokkaido"), "北海道");
  assert.equal(d.districts.length, 12);
  assert.deepEqual(d.districts[1].units.map((u) => [u.name, u.area]), [["札幌市北区", "第１区に属しない区域"], ["札幌市東区", undefined]]);
  assert.deepEqual(d.districts[3].units.map((u) => u.name), ["札幌市西区", "札幌市手稲区", "小樽市", "石狩市", "北海道後志総合振興局管内"]);
});

test("parseDistrictText: 区番号が 1 から連続していなければ失敗する（ページ落ち・レイアウト変化の検知）", () => {
  assert.throws(() => parseDistrictText("岩 手 県\n第１区 盛岡市\n第３区 花巻市\n", "岩手県"), /expected 第2区, found 第3区/);
});
