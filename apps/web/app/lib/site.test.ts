import { readdirSync, readFileSync } from "node:fs";
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

/** app/ 配下の .ts / .tsx を全部読む（テストと型定義は除く）。列挙漏れを作らないため */
function sources(): { rel: string; src: string }[] {
  const out: { rel: string; src: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(app, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push({ rel, src: read(rel) });
    }
  };
  walk("");
  return out;
}

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

  /*
   * **allowlist で検査する**（レビュー指摘）。最初はファイル名を6つ列挙していたが、
   * `app/routes/` には14ファイルあり、一覧に無い `member.tsx` が `bills` を import しても
   * 誰も文句を言わなかった。**denylist は書き漏れたものを素通しする**（#333 の学び）。
   *
   * 動的 import・再エクスポート・`import * as` も拾う（3つとも素通りしていた）。
   */
  it("bills を参照してよいのは lib/bills.ts と routes/coverage.tsx だけ", () => {
    const ALLOWED = new Set(["lib/bills.ts", "routes/coverage.tsx"]);
    // `from "…/bills"` / `import("…/bills")` / `require("…/bills")` を拾う
    const REF = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'][^"']*\/bills["']/;
    const offenders = sources().filter(({ rel, src }) => !ALLOWED.has(rel) && REF.test(src));
    expect(offenders.map((o) => o.rel)).toEqual([]);
  });

  it("bills/index.json を eager に読むのは lib/bills.ts だけ", () => {
    const GLOB = /import\.meta\.glob[^;]*bills\/index\.json/;
    const readers = sources().filter(({ src }) => GLOB.test(src)).map(({ rel }) => rel);
    expect(readers).toEqual(["lib/bills.ts"]);
  });

  it("archive-path.ts の重複した REPO_URL が site.ts と一致する", () => {
    // 同じ理由（dataset.ts を import できない）で複製されている定数。ずれると出典リンクが割れる
    const m = read("lib/archive-path.ts").match(/REPO_URL\s*=\s*"([^"]+)"/);
    expect(m?.[1]).toBe(REPO_URL);
  });
});
