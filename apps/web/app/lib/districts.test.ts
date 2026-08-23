/**
 * 郵便番号 → 選挙区（Issue #112）の純粋ロジックの仕様。
 * 入力の正規化・分割ファイルの割り当て・/members へのリンク・分割市区町村の名前。評価や推定は一切しない。
 */
import type { DistrictsMeta, ZipDistricts } from "@seiji-kiroku/shared";
import { describe, expect, it } from "vitest";
import byZipJson from "../test-fixtures/districts/by-zip.json";
import metaJson from "../test-fixtures/districts/meta.json";
import { ZIP_NOT_FOUND, membersByDistrictUrl, normalizeZip, shardByZip, splitMunicipalityFor, zipShardUrl } from "./districts";

const byZip = byZipJson as Record<string, ZipDistricts>;
const meta = metaJson as DistrictsMeta;

describe("normalizeZip", () => {
  it("7桁の半角数字はそのまま", () => {
    expect(normalizeZip("1000001")).toBe("1000001");
  });
  it("ハイフン（半角・全角・長音・マイナス）と空白・〒を取り除く", () => {
    expect(normalizeZip("100-0001")).toBe("1000001");
    expect(normalizeZip("100ー0001")).toBe("1000001");
    expect(normalizeZip("100－0001")).toBe("1000001");
    expect(normalizeZip(" 100 − 0001 ")).toBe("1000001");
    expect(normalizeZip("〒100-0001")).toBe("1000001");
  });
  it("全角数字を半角に直す", () => {
    expect(normalizeZip("１００－０００１")).toBe("1000001");
  });
  it("7桁でなければ null（空・6桁・8桁・文字混じり）", () => {
    expect(normalizeZip("")).toBeNull();
    expect(normalizeZip("100000")).toBeNull();
    expect(normalizeZip("10000011")).toBeNull();
    expect(normalizeZip("100000a")).toBeNull();
  });
});

describe("zipShardUrl", () => {
  it("上3桁で分割したファイルを指す", () => {
    expect(zipShardUrl("1000001")).toBe("/data/districts/zip/100.json");
  });
});

describe("shardByZip", () => {
  it("上3桁ごとにまとめ、各分割ファイルの中身は元の値と同じ", () => {
    const shards = shardByZip(byZip);
    expect([...shards.keys()].sort()).toEqual(["100", "104", "498", "680"]);
    expect(shards.get("100")).toEqual({ "1000001": byZip["1000001"], "1000014": byZip["1000014"] });
    expect(shards.get("680")).toEqual({ "6800001": { sangiin: ["鳥取・島根"], shugiin: ["鳥取1"], municipalities: ["鳥取県鳥取市"] } });
  });
  it("分割ファイルは最大 1,000 個（上3桁 000〜999）", () => {
    const all: Record<string, ZipDistricts> = {};
    for (let i = 0; i < 1000; i++) all[`${String(i).padStart(3, "0")}0000`] = { sangiin: ["x"], shugiin: ["x1"] };
    all["0000001"] = { sangiin: ["x"], shugiin: ["x1"] };
    expect(shardByZip(all).size).toBe(1000);
  });
  it("空なら空", () => {
    expect(shardByZip({}).size).toBe(0);
  });
});

describe("membersByDistrictUrl", () => {
  it("/members?district=<名前> を URL エンコードして返す", () => {
    expect(membersByDistrictUrl("東京4")).toBe("/members?district=%E6%9D%B1%E4%BA%AC4");
    expect(membersByDistrictUrl("鳥取・島根")).toBe("/members?district=%E9%B3%A5%E5%8F%96%E3%83%BB%E5%B3%B6%E6%A0%B9");
  });
});

describe("splitMunicipalityFor", () => {
  it("候補の区の集合が meta.splitMunicipalities の1件と一致すれば、その市区町村を返す", () => {
    expect(splitMunicipalityFor(byZip["1040031"], meta)).toEqual({ code: "131024", pref: "東京都", city: "中央区", shugiin: ["東京1", "東京2"] });
  });
  it("順序が違っても同じ集合なら一致する", () => {
    expect(splitMunicipalityFor({ sangiin: ["東京"], shugiin: ["東京2", "東京1"] }, meta)?.city).toBe("中央区");
  });
  it("候補が1つ、または一致する分割市区町村が無い（都道府県をまたぐ郵便番号）なら null", () => {
    expect(splitMunicipalityFor(byZip["1000001"], meta)).toBeNull();
    expect(splitMunicipalityFor(byZip["4980000"], meta)).toBeNull();
  });
});

describe("ZIP_NOT_FOUND", () => {
  it("文言は「該当する郵便番号が見つかりません」", () => {
    expect(ZIP_NOT_FOUND).toBe("該当する郵便番号が見つかりません");
  });
});
