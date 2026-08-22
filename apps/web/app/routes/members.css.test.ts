import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "members.css"), "utf8");

/** コメントを除いた各ルールのセレクタ部分（`{` の手前）を列挙する */
function selectors(src: string): string[] {
  return [...src.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)].flatMap((m) =>
    m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

describe("members.css は /members の外に漏れない", () => {
  it("すべてのセレクタが .members- または .members で始まる（.num のようなグローバルを持たない）", () => {
    const leaked = selectors(css).filter((s) => !/^\.members(-|\b)/.test(s));
    expect(leaked).toEqual([]);
  });
});
