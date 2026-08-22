/**
 * 改名（#84）の回帰防止：旧サービス名「政治記録」が app/ に残っていないこと。
 * test-fixtures/ は実 HTML のスナップショットなので対象外（about テストで内容を別途検証）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { SITE_NAME } from "./seo";

const APP_DIR = join(__dirname, "..");
const OLD_NAME = "政治記録";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "test-fixtures") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css|md|html)$/.test(name)) out.push(p);
  }
  return out;
}

describe("サービス名", () => {
  it("サイト名は「議会ログ」", () => {
    expect(SITE_NAME).toBe("議会ログ");
  });

  it("app/ 配下（test-fixtures を除く）に旧名「政治記録」が残っていない", () => {
    const offenders = walk(APP_DIR)
      .filter((p) => readFileSync(p, "utf8").includes(OLD_NAME))
      .map((p) => relative(APP_DIR, p));
    expect(offenders).toEqual([]);
  });
});
