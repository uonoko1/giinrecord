import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_URL } from "./site";

/**
 * Issue 406: `dataset.ts` は `import.meta.glob(..., { eager: true })` で `data/` の JSON を
 * 5つ**同期で丸ごと**取り込む。そこから定数を1つ import しただけで、
 * **データセット全体が同じチャンクに引きずり込まれる**。
 *
 * 実際に起きていたこと: `SiteFooter.tsx`（全ページのフッター）が `REPO_URL`
 * （文字列1つ）のために `dataset.ts` を import していたため、
 * **データを使わないページまで 1MB（gzip 144KB）のチャンクを読んでいた**。
 *
 *     /terms     228 KB → 113 KB
 *     /privacy   229 KB → 113 KB
 *     /rollcalls 265 KB → 150 KB
 *
 * 検査は**ソースに対して**行う（バンドルの結果は環境で変わるが、import は変わらない）。
 * `stable-order.test.ts` が `.localeCompare(` を禁じるのと同じ流儀。
 */
const app = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(app, p), "utf8");

/** データを使わない（使うべきでない）ファイル。ここが dataset.ts に触れると全ページが重くなる */
const DATA_FREE = [
  "components/SiteFooter.tsx", // 全ページのフッター。ここが一番効く
  "components/about/VerifySection.tsx",
  "routes/terms.tsx",
  "routes/privacy.tsx",
  "lib/site.ts",
];

describe("データを使わないファイルは dataset.ts を import しない（Issue 406）", () => {
  it.each(DATA_FREE)("%s", (path) => {
    const src = read(path);
    // `from "../lib/dataset"` / `from "./dataset"` などをすべて拾う
    expect(src).not.toMatch(/from\s+"[^"]*\/dataset"/);
    expect(src).not.toMatch(/from\s+"\.\/dataset"/);
  });

  it("REPO_URL は site.ts が持つ（dataset.ts ではない）", () => {
    expect(REPO_URL).toBe("https://github.com/uonoko1/giinrecord");
    expect(read("lib/site.ts")).toContain("export const REPO_URL");
  });

  it("dataset.ts は eager glob を持つ（この検査が要る理由そのもの）", () => {
    // ここが lazy になったら、上の禁止は緩めてよい。**変わったことに気づけるように**固定する
    expect(read("lib/dataset.ts")).toMatch(/import\.meta\.glob<[^>]*>\([^)]*eager:\s*true/);
  });

  it("archive-path.ts の重複した REPO_URL が site.ts と一致する", () => {
    // 同じ理由（dataset.ts を import できない）で複製されている定数。ずれると出典リンクが割れる
    const m = read("lib/archive-path.ts").match(/REPO_URL\s*=\s*"([^"]+)"/);
    expect(m?.[1]).toBe(REPO_URL);
  });
});
