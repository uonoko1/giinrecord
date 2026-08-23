import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { unzipEntry } from "../src/sources/districts/zip.ts";
import { parseKenAll, parseKenAllUpdated } from "../src/sources/districts/ken-all.ts";

// 日本郵便 KEN_ALL（Issue #111）。フィクスチャは 2026-07-31 更新分の KEN_ALL.CSV から 34 行を Shift_JIS（CP932）のまま抜粋したもの。
const fixture = (name: string) => new URL(`./fixtures/districts/${name}`, import.meta.url);
const zipBytes = readFileSync(fixture("ken-all-excerpt.zip"));
const csvBytes = readFileSync(fixture("ken-all-excerpt.csv"));

test("unzipEntry: zip の中の KEN_ALL.CSV を deflate 展開して元のバイト列を返す", () => {
  const out = unzipEntry(zipBytes, "KEN_ALL.CSV");
  assert.equal(Buffer.compare(out, csvBytes), 0);
});

test("unzipEntry: 無いエントリ名は候補を添えて失敗する", () => {
  assert.throws(() => unzipEntry(zipBytes, "ken_all.csv"), /ken_all\.csv.*KEN_ALL\.CSV/);
});

test("parseKenAll: Shift_JIS の CSV を 郵便番号・団体コード・都道府県・市区町村・町域 に読む", () => {
  const rows = parseKenAll(csvBytes);
  assert.equal(rows.length, 34);
  assert.deepEqual(rows[0], { code: "01101", zip: "0600000", pref: "北海道", city: "札幌市中央区", town: "以下に掲載がない場合" });
  const chiyoda = rows.find((r) => r.zip === "1000001");
  assert.deepEqual(chiyoda, { code: "13101", zip: "1000001", pref: "東京都", city: "千代田区", town: "千代田" });
});

test("parseKenAll: 同じ郵便番号が複数の市区町村にまたがる行はそのまま別行で残る（0040000 は厚別区と清田区）", () => {
  const rows = parseKenAll(csvBytes).filter((r) => r.zip === "0040000");
  assert.deepEqual(rows.map((r) => r.city).sort(), ["札幌市厚別区", "札幌市清田区"]);
});

test("parseKenAll: 列数が 15 でない行は黙って落とさず失敗する", () => {
  assert.throws(() => parseKenAll(Buffer.from('01101,"060  ","0600000"\n')), /15 columns/);
});

test("parseKenAllUpdated: ダウンロードページの「YYYY年M月D日更新」を ISO 日付にする", () => {
  const html = readFileSync(fixture("japanpost-kogaki-zip.html"), "utf8");
  assert.equal(parseKenAllUpdated(html), "2026-07-31");
});

test("parseKenAllUpdated: 更新日が見つからなければ失敗する（as-of を推定しない）", () => {
  assert.throws(() => parseKenAllUpdated("<html></html>"), /更新/);
});
