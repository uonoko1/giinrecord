/**
 * 改名（#84 → #192）の回帰防止：旧サービス名（歴代の和名）が app/・public/・brand/ に残っていないこと。
 * test-fixtures/ は実 HTML のスナップショットなので対象外（about テストで内容を別途検証）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { SITE_NAME } from "./seo";

const APP_DIR = join(__dirname, "..");
const WEB_DIR = join(APP_DIR, "..");
// 旧名は文字コードから組み立て、このファイル自身が検査に引っかからないようにする
const OLD_NAMES = [
  String.fromCodePoint(0x653f, 0x6cbb, 0x8a18, 0x9332), // 初代（#84 で改名）
  String.fromCodePoint(0x8b70, 0x4f1a, 0x30ed, 0x30b0), // 2代目（#192 で改名。gikailog.com と同名のため）
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "test-fixtures") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css|md|html|svg|webmanifest)$/.test(name)) out.push(p);
  }
  return out;
}

describe("サービス名", () => {
  it("サイト名は「議員レコード」", () => {
    expect(SITE_NAME).toBe("議員レコード");
  });

  it("app/（test-fixtures を除く）・public/・brand/ に旧サービス名が残っていない", () => {
    const files = [...walk(APP_DIR), ...walk(join(WEB_DIR, "public")), ...walk(join(WEB_DIR, "brand"))];
    const offenders = files
      .filter((p) => {
        const text = readFileSync(p, "utf8");
        return OLD_NAMES.some((name) => text.includes(name));
      })
      .map((p) => relative(WEB_DIR, p));
    expect(offenders).toEqual([]);
  });
});
