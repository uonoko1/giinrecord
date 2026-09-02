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

  /*
   * Issue 408: `bills/index.json` は5つのデータのうち**いちばん大きく**（gzip 60KB）、
   * **使うのは /coverage だけ**。`dataset` に入れると5つが1チャンクにまとまるので、
   * `/about`（meta の 1KB だけが要る）まで 60KB を読むことになっていた。
   *
   *     /          238 KB → 181 KB
   *     /about     230 KB → 173 KB
   *     /members   245 KB → 188 KB
   *     /coverage  249 KB → 249 KB   ← 実際に使うので変わらない（これは正しい）
   */
  it("dataset.ts は bills を eager に読まない（lib/bills.ts の担当）", () => {
    const src = read("lib/dataset.ts");
    expect(src).not.toMatch(/import\.meta\.glob[^;]*bills\/index\.json/);
  });

  it("bills を読むのは lib/bills.ts だけ", () => {
    const importers = ["lib/bills.ts", "lib/dataset.ts", "routes/coverage.tsx", "routes/home.tsx", "routes/members.tsx", "routes/about.tsx"]
      .filter((f) => /import\.meta\.glob[^;]*bills\/index\.json/.test(read(f)));
    expect(importers).toEqual(["lib/bills.ts"]);
  });

  it("/coverage 以外のページは lib/bills.ts を import しない", () => {
    for (const f of ["routes/home.tsx", "routes/members.tsx", "routes/about.tsx", "routes/assemblies.tsx", "routes/compare.tsx", "components/SiteFooter.tsx"]) {
      expect(read(f), f).not.toMatch(/from\s+"[^"]*\/bills"/);
    }
  });

  /*
   * Issue 408: `/coverage` のテストは**全部 `data` を明示的に渡す**ので、
   * **既定の経路（本番が通る道）を誰も通っていなかった**。
   * `withBills` を外して bills が黙って 0 件になる変異を入れても、46件すべて緑のままだった。
   *
   * 「記録が出ない」は利用者から見えない失敗なので、**既定の値そのもの**を検査する。
   */
  it("bundled な bills が空でない（/coverage の既定が黙って 0 件にならない）", async () => {
    const { bills } = await import("./bills");
    expect(Array.isArray(bills)).toBe(true);
    expect(bills.length).toBeGreaterThan(0);
    expect(bills[0]).toHaveProperty("house");
  });

  it("dataset には bills が入っていない（入れると全ページが読む）", async () => {
    const { dataset } = await import("./dataset");
    expect(dataset.bills).toBeUndefined();
  });

  it("archive-path.ts の重複した REPO_URL が site.ts と一致する", () => {
    // 同じ理由（dataset.ts を import できない）で複製されている定数。ずれると出典リンクが割れる
    const m = read("lib/archive-path.ts").match(/REPO_URL\s*=\s*"([^"]+)"/);
    expect(m?.[1]).toBe(REPO_URL);
  });
});
