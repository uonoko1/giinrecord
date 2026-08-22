import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = __dirname;
const sources = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

describe("components は生の色コードを書かず、tokens.css の変数だけを使う", () => {
  it("部品のソースが1つ以上ある", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it.each(sources)("%s に #xxxxxx / rgb() / hsl() / 色名が無い", (file) => {
    const src = readFileSync(join(dir, file), "utf8");
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/\b(rgb|hsl)a?\(/);
    expect(src).not.toMatch(/["'](white|black|red|green|blue|gray|grey)["']/);
  });
});
