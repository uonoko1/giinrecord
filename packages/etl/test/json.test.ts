import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { stableJson, jsonKeyOrderViolations } from "../src/json.ts";

/**
 * 期待値の出どころ（#1226）: この describe の中では **`stableJson` を期待値側に使わない**。
 * 逐語の文字列だけで照合する。
 * `text === stableJson(JSON.parse(text))` は両辺が同じ関数を通るので恒真になり得る（#1226 の病気）。
 * さらに `JSON.parse` 自体が整数様キーを数値昇順に並べ替えるため、
 * **パースした物の `Object.keys` もキーの並びの証拠にはならない**。
 */
describe("stableJson: data/ 配下の JSON 書式（docs/DATA_CONTRACT.md）", () => {
  test("キーを再帰的にソートし、末尾改行を付ける", () => {
    const out = stableJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 0 } });
    assert.equal(out, '{\n "a": {\n  "c": 0,\n  "d": [\n   {\n    "y": 2,\n    "z": 1\n   }\n  ]\n },\n "b": 1\n}\n');
  });
  test("配列の順序は変えない", () => {
    assert.equal(stableJson([3, 1, 2]), "[\n 3,\n 1,\n 2\n]\n");
  });
  test("空配列は [] に末尾改行", () => {
    assert.equal(stableJson([]), "[]\n");
  });

  // #1226: 整数様キー（"1000000"）は Object.fromEntries が数値昇順に並べ替えるので、
  // .sort() の結果が捨てられていた。期待値は逐語（実装を一切通さない）。
  test("整数様キーも辞書順に並べる（#1226。先頭 0 のキーが先に来る）", () => {
    assert.equal(
      stableJson({ "1000000": "b", "0010000": "a", "0010010": "c" }),
      '{\n "0010000": "a",\n "0010010": "c",\n "1000000": "b"\n}\n',
    );
  });
  test("整数様キーだけの object でも「辞書順」と「数値昇順」が分かれる（#1226）", () => {
    // 辞書順: "10" < "9"（数値昇順なら 9 が先）。従来実装はここで "9" を先に出していた。
    assert.equal(stableJson({ "9": 1, "10": 2 }), '{\n "10": 2,\n "9": 1\n}\n');
  });
  test("整数様キーと通常のキーが混ざっても辞書順（#1226）", () => {
    assert.equal(stableJson({ a: 1, "2": 2, "10": 3, B: 4 }), '{\n "10": 3,\n "2": 2,\n "B": 4,\n "a": 1\n}\n');
  });
  test("入れ子の object の整数様キーも辞書順（#1226）", () => {
    assert.equal(stableJson({ x: { "1000000": 1, "0010000": 2 } }), '{\n "x": {\n  "0010000": 2,\n  "1000000": 1\n }\n}\n');
  });
  test("配列の中の object の整数様キーも辞書順（#1226）", () => {
    assert.equal(stableJson([{ "1000000": 1, "0010000": 2 }]), '[\n {\n  "0010000": 2,\n  "1000000": 1\n }\n]\n');
  });

  test("値の形は JSON.stringify と同じ（null / 真偽 / 数値 / エスケープ / Date / undefined / toJSON）", () => {
    assert.equal(
      stableJson({ n: null, t: true, f: false, i: 0, d: -1.5, e: 1e21 }),
      '{\n "d": -1.5,\n "e": 1e+21,\n "f": false,\n "i": 0,\n "n": null,\n "t": true\n}\n',
    );
    assert.equal(stableJson({ s: 'a"b\\c\nd\tef' }), '{\n "s": "a\\"b\\\\c\\nd\\tef"\n}\n');
    assert.equal(stableJson("あ"), '"あ"\n');
    assert.equal(stableJson(1), "1\n");
    assert.equal(stableJson(null), "null\n");
    assert.equal(stableJson({ d: new Date("2026-10-08T00:00:00.000Z") }), '{\n "d": "2026-10-08T00:00:00.000Z"\n}\n');
    assert.equal(stableJson({ a: undefined, b: 1, c: () => 1 }), '{\n "b": 1\n}\n');
    assert.equal(stableJson([undefined, 1]), "[\n null,\n 1\n]\n");
    assert.equal(stableJson({ o: { toJSON: () => ({ b: 1, a: 2 }) } }), '{\n "o": {\n  "a": 2,\n  "b": 1\n }\n}\n');
    assert.equal(stableJson({}), "{}\n");
  });

  test("インデントは深さ 1 文字ずつ（JSON.stringify(_, _, 1) と同じ）", () => {
    assert.equal(stableJson({ a: { b: { c: [1] } } }), '{\n "a": {\n  "b": {\n   "c": [\n    1\n   ]\n  }\n }\n}\n');
  });
});

/**
 * #1226: 「キーはソート済み」を**テキストから**検査する。
 * `JSON.parse` を通さないのが要点——parse した時点で整数様キーの並びは失われる。
 */
describe("jsonKeyOrderViolations: 直列化されたテキストのキーの並びを見る（#1226）", () => {
  test("辞書順なら違反なし", () => {
    assert.deepEqual(jsonKeyOrderViolations('{\n "a": 1,\n "b": 2\n}\n'), []);
    assert.deepEqual(jsonKeyOrderViolations('{\n "0010000": 1,\n "1000000": 2\n}\n'), []);
    assert.deepEqual(jsonKeyOrderViolations('{\n "10": 1,\n "9": 2\n}\n'), []);
    assert.deepEqual(jsonKeyOrderViolations("[]\n"), []);
    assert.deepEqual(jsonKeyOrderViolations("{}\n"), []);
    assert.deepEqual(jsonKeyOrderViolations('{\n "a": [\n  {\n   "x": 1,\n   "y": 2\n  }\n ]\n}\n'), []);
  });

  // 現物の by-zip.json が出している形（整数様キーが数値昇順＝辞書順ではない）
  test("整数様キーが数値昇順に並んだテキストを違反として挙げる（いまの by-zip.json の形）", () => {
    const v = jsonKeyOrderViolations('{\n "1000000": 1,\n "0010000": 2\n}\n');
    assert.equal(v.length, 1, v.join("\n"));
    assert.match(v[0], /"1000000" before "0010000"/);
  });
  test("入れ子・配列の中のキーの並びも見る", () => {
    assert.equal(jsonKeyOrderViolations('{\n "x": {\n  "b": 1,\n  "a": 2\n }\n}\n').length, 1);
    assert.equal(jsonKeyOrderViolations('[\n {\n  "b": 1,\n  "a": 2\n }\n]\n').length, 1);
  });
  test("キーに見える文字列が値の中にあっても誤検出しない", () => {
    assert.deepEqual(jsonKeyOrderViolations('{\n "a": "\\"z\\": 1, \\"b\\": 2",\n "b": "{}"\n}\n'), []);
    assert.deepEqual(jsonKeyOrderViolations('{\n "a": "}\\n \\"z\\":",\n "b": 1\n}\n'), []);
    // キーにエスケープが入っていたら、**解いた生の文字**で比べる（綴りのままで比べると判定が変わる）。
    // 解いた文字: "a\nb" (0x0A) < "a b" (0x20) → 順序は正しい＝違反 0。
    // 綴りのまま:  "a\\nb" の 2 文字目は "\\"(0x5C) > " "(0x20) → 誤って違反になる。
    // この 1 対は「エスケープを解く」行を外すと落ちる（380 対のうち 48 対がこの性質を持つ。残りは等価）。
    assert.deepEqual(jsonKeyOrderViolations('{\n "a\\nb": 1,\n "a b": 2\n}\n'), []);
    // \u 形式も解く（"U+0001" < "A" は解けば true、綴りのままなら "\\"(0x5C) > "A"(0x41) で false）
    assert.deepEqual(jsonKeyOrderViolations('{\n "\\u0001": 1,\n "A": 2\n}\n'), []);
    // 引用符のエスケープが入ったキーでも文字列の終わりを読み違えない（"a\"b" < "ab"）
    assert.deepEqual(jsonKeyOrderViolations('{\n "a\\"b": 1,\n "ab": 2\n}\n'), []);
  });
  test("同じキーが 2 度出てきたら違反（辞書順の厳密増加が崩れている）", () => {
    assert.equal(jsonKeyOrderViolations('{\n "a": 1,\n "a": 2\n}\n').length, 1);
  });

  // 恒真でないことの証: 期待値は stableJson から取らず、
  // stableJson の出力を「別実装の読み手」に通して違反 0 を確かめる。
  test("stableJson の出力は jsonKeyOrderViolations で違反 0（別実装どうしの照合）", () => {
    const cases: unknown[] = [
      { b: 1, a: { d: [{ z: 1, y: 2 }], c: 0 } },
      { "1000000": 1, "0010000": 2, "9": 3, "10": 4 },
      { x: { "1440052": { shugiin: ["東京4"], municipalities: ["東京都大田区"], sangiin: ["東京"] } } },
      [{ "2": 1, "1": 2 }, { b: 1, a: 2 }],
      { "a\"b": 1, ab: 2, "}": 3, "{": 4, '"': 5 },
    ];
    for (const c of cases) assert.deepEqual(jsonKeyOrderViolations(stableJson(c)), [], JSON.stringify(c));
  });
});
