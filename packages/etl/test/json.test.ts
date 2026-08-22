import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { stableJson } from "../src/json.ts";

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
});
