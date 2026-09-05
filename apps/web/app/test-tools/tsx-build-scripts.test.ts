// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dynamicImports, metaGlobs, reachableFrom, valueImports } from "./value-imports";

/**
 * **tsx で直に走るビルドスクリプトから辿れるモジュールは、`import.meta.glob` に触らない。**
 *
 * `apps/web/package.json` の `build` は `react-router build` のあと **tsx でスクリプトを直に走らせる**。
 * tsx には `import.meta.glob` が無いので、辿れる先が 1 本でも
 * `assemblies.ts` / `dataset.ts` のような glob 持ちに繋がると
 * `import.meta.glob is not a function` でビルドが落ちる（#441 の担当者が実際に踏んだ）。
 *
 * **#490 まで、この検査は `linked-counts.ts` 1 ファイルにしか当たっていなかった。**
 * レビュアーの実測: `data-files.ts` に `export { isDietAssemblyId } from "./assemblies";` を足すと
 * **テストは 0 件落ちるのにビルドは落ちる**。CI の `pnpm build` が実際に tsx を走らせるので
 * 静かには壊れないが、**落ちる場所が遠い**（テストではなくビルドで、しかも
 * `glob is not a function` という原因の見えないメッセージ）。
 *
 * **対象は手で並べない。** 並べると増えたときに漏れる。
 * `scripts/*.ts` を全部入口にして、**値として引き込まれるものだけ**を推移的に辿って集める。
 * 数え方も結果もこのテストが持つ（下の「入口と対象の数」を参照）。
 */
const webRoot = path.resolve(fileURLToPath(import.meta.url), "../../.."); // app/test-tools/x.test.ts → apps/web
const scriptsDir = path.join(webRoot, "scripts");

/** tsx で走る入口。`scripts/*.ts` を**列挙ではなく走査**で集める（新しいスクリプトが自動で入る） */
const entries = readdirSync(scriptsDir)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
  .map((name) => path.join(scriptsDir, name))
  .sort();

const reached = reachableFrom(entries);
const rel = (file: string): string => path.relative(webRoot, file);
const trail = (via: string[]): string => via.map(rel).join(" → ");

/**
 * **辿り着いた全モジュールに、1 つ残らず判定を下す（#507）。**
 *
 * #500 の Z2 と同じ形が、この検査にも残っていた: `reached` の中身（入口）は固定していたが、
 * **各 `it` が `reached` を全部見たか（出口）は誰も検査していなかった。**
 *
 * 実測（本物の違反 `data-files.ts` に `export { isDietAssemblyId } from "./assemblies";` を
 * 植えた状態。`npx tsx apps/web/scripts/sitemap.ts` が実際に
 * `TypeError: (intermediate value).glob is not a function` で落ちる）:
 *
 *     A. 変異なし                                → 4 / 6 落ちる（正しく捕まえる）
 *     B. glob 検査の絞り込み述語だけ狭める       → 3 / 6（**狙った検査だけ黙る**）
 *     C. 3 つ狭めて、一覧も辻褄を合わせる        → **6 / 6 全部緑（見逃し）**
 *
 * **C は「意図して辻褄を合わせた」特殊な操作ではない。** この検査自身が失敗時に
 * 「**増えた分が `import.meta.glob` に触らないことを確かめて、この一覧を更新してください**」
 * と指示しており、**その手順から「確かめて」を落とすとちょうど C になる**。
 * 更新を指示する検査が更新の副作用で黙るなら、**指示のほうが罠**。
 *
 * **「読んだファイルを数え上げる」だけでは足りない**（この PBI の最初の実装がそうで、実測で破れた）。
 * ループは全件回して `scanned` に積みつつ、**判定の側にだけ** `!file.includes("assemblies") &&` を
 * 足せば、`scanned` は `reached` と一致したまま検査だけが黙る——**B 相当で 3 / 6、C 相当で 6 / 6 緑**。
 * 数えていたのは「通り過ぎた回数」であって「判定した件数」ではなかった。
 *
 * そこで**判定そのものを表にする**。`verdicts` は `reached` の 1 件ごとに
 * 「検査器が何を見つけたか」を持ち、**offenders はその表からしか作らない**。
 * 判定を狭めれば表の中身が変わり、表の網羅性と中身の両方を**同じ `it` の中で**突き合わせる。
 * **別の `it` に置かない**——`it` ごと消せば黙るから（#500 の N5 完全版で実測）。
 */
/**
 * **陽性対照のソース。** 検査器が生きていることを、判定表を作る `it` の中で毎回確かめるために使う。
 * 実ファイルではなく文字列にしてあるのは、実ファイルの中身が変わって
 * **対照が黙って陰性になる**（＝対照が対照でなくなる）のを避けるため。
 */
const GLOB_POSITIVE = 'const m = import.meta.glob("./x/*.json", { eager: true });';
const DYNAMIC_POSITIVE = 'const m = await import("./x.js");';

type Verdict = { file: string; via: string[]; findings: string[] };

/** `reached` の**全件**に検査器を当て、1 件ごとの結果を表にして返す（間引きも早抜けもしない） */
function verdicts(find: (source: string, file: string) => unknown[]): Verdict[] {
  return reached.map((r) => ({
    file: rel(r.file),
    via: r.via,
    findings: find(readFileSync(r.file, "utf8"), r.file).map(String),
  }));
}

/**
 * **判定表が `reached` を漏れなく覆っていることを、検査と同じ `it` の中で確かめる。**
 *
 * 「全件に判定が付いているか」だけでなく、**その判定が本当に検査器を通ったか**まで見る。
 * 検査器を通さずに `findings: []` を置く（＝実質の読み飛ばし）と、
 * 下の「既知の陽性が陽性のまま」で落ちる。
 */
function expectJudgedEverything(table: Verdict[], find: (source: string, file: string) => unknown[], positiveSource: string): void {
  expect(table.length, "1 件も判定していない（走査が空）").toBeGreaterThan(0);
  expect(
    table.map((v) => v.file),
    "辿り着いたモジュールの一部に判定が付いていません（filter / continue / 早期 return で絞っていませんか）",
  ).toEqual(reached.map((r) => rel(r.file)));
  /*
   * **陽性対照**: **呼び出し側が渡してきた検査器そのもの**を、確実に陽性になるソースに当てる。
   * これが無いと、検査器が常に `[]` を返す変異でも判定表は「全件に判定あり」のまま緑になる
   * （#451 の学び: 検査器自身を検査しないと、検査が死んでも緑）。
   */
  expect(find(positiveSource, "positive-control.ts"), "検査器が既知の陽性ソースに何も見つけない（検査器が死んでいる）").not.toEqual([]);
}

/** 判定表から違反者を作る。**offenders はここ以外から作らない**（絞り込みを別経路で足させない） */
function offendersOf(table: Verdict[]): string[] {
  return table.filter((v) => v.findings.length > 0).map((v) => `${v.file}（辿った道: ${trail(v.via)}）`);
}

describe("tsx で走るビルドスクリプトから import.meta.glob に繋がらない（#441 / #451 / #490）", () => {
  /**
   * **入口が 0 本・対象が 0 件なら、この検査は何も見ていない。**
   * 数を固定して、走査が壊れたことに気づけるようにする（#451 の 3 度目は
   * 「何も検出しなくなった」退行だった）。
   */
  it("入口と対象の数（走査が空振りしていないこと）", () => {
    expect(
      entries.map((e) => path.basename(e)),
      "scripts/*.ts の顔ぶれ",
    ).toEqual(["brand-assets.ts", "browser-check.ts", "build-archive.ts", "copy-member-data.ts", "fonts.ts", "shard-districts.ts", "sitemap.ts", "smoke.ts"]);
    // package.json が実際に tsx で走らせているものが、入口に全部入っていること。
    // 入口を手で並べると漏れる（それが #490 そのもの）ので、**走査の結果を宣言の側と突き合わせる**
    const pkg = readFileSync(path.join(webRoot, "package.json"), "utf8");
    const declared = [...pkg.matchAll(/tsx scripts\/([\w-]+\.ts)/g)].map((m) => m[1]);
    expect(declared.length, "package.json に `tsx scripts/*.ts` が 1 つも無い（読み方が壊れている）").toBeGreaterThan(0);
    const notCovered = declared.filter((name) => !entries.some((e) => path.basename(e) === name));
    expect(notCovered, "package.json が tsx で走らせているのに、入口に入っていないスクリプト").toEqual([]);

    /*
     * 辿り着く先。**増減したら気づく**（減っていたら走査が壊れている可能性がある）。
     *
     * **この検査は実際に働いた**: #479（JS 無効の検査）が後からマージされ、
     * `scripts/browser-check.ts` が `nojs.ts` を引き込んで **13 → 14** になり、CI が落ちた。
     * メッセージの指示どおり `nojs.ts` を確かめてから足している——
     * **値 import 0 件・`import.meta.glob` 0 件・動的 import 0 件**で、
     * そもそも**他のモジュールを 1 つも引き込まない**（型と純粋な関数だけのファイル）。
     * だから `nojs.ts` から先には伸びず、14 で止まる。
     */
    expect(
      reached.map((r) => rel(r.file)),
      "tsx から辿れるモジュールが増減しました。増えた分が `import.meta.glob` に触らないことを確かめて、" +
        "この一覧を更新してください（減っていたら走査が壊れている可能性があります）",
    ).toEqual([
      "app/lib/archive-path.ts",
      "app/lib/archive.ts",
      "app/lib/data-contract.ts",
      "app/lib/data-files.ts",
      "app/lib/districts.ts",
      "app/lib/icons.ts",
      "app/lib/linked-counts.ts",
      "app/lib/nojs.ts",
      "app/lib/prerender.ts",
      "app/lib/self-hosted-fonts.ts",
      "app/lib/seo.ts",
      "app/lib/sitemap.ts",
      "app/lib/smoke-url.ts",
      "app/lib/smoke.ts",
    ]);
  });

  it("辿り着くモジュールは import.meta.glob を式として書いていない", () => {
    const table = verdicts(metaGlobs);
    expectJudgedEverything(table, metaGlobs, GLOB_POSITIVE);
    const offenders = offendersOf(table);
    expect(
      offenders,
      "tsx で直に走るビルドスクリプトから `import.meta.glob` に辿り着きます。" +
        "`npx tsx apps/web/scripts/sitemap.ts` が `import.meta.glob is not a function` で落ちます。" +
        "値の import を切るか（型だけなら `import type` / `export type`）、glob を使う側に読み込みを移してください",
    ).toEqual([]);
  });

  it("辿り着くモジュールは動的 import も書かない（呼ばれたときに落ちる）", () => {
    const table = verdicts(dynamicImports);
    expectJudgedEverything(table, dynamicImports, DYNAMIC_POSITIVE);
    const offenders = offendersOf(table);
    expect(offenders, "動的 import（`import(...)`）は、その行が呼ばれたときに glob で落ちます。読み込みは呼び出し側に置いてください").toEqual([]);
  });

  /**
   * **前提の確認（この検査が空振りでないこと）。**
   * glob を持つモジュールが実在し、かつ「辿れる集合」に入っていないことを両方見る。
   * 片方だけだと、走査が何も返さなくても緑になる。
   */
  it("前提: glob を持つモジュールは実在し、辿れる集合の外にある", () => {
    const globOwners = ["app/lib/assemblies.ts", "app/lib/dataset.ts", "app/lib/members.ts", "app/lib/members-by-assembly.ts"];
    for (const owner of globOwners) {
      const file = path.join(webRoot, owner);
      expect(metaGlobs(readFileSync(file, "utf8"), file), `${owner} が glob を持たなくなった（この検査の前提が変わった）`).not.toEqual([]);
    }
    /*
     * **出口の固定（#507）**: 一覧との照合ではなく、**辿り着いた全件に glob 検査を当てた結果**で判定する。
     * 名前の一覧（`globOwners`）だけで見ると、一覧に無い glob 持ちが増えたときに素通りする。
     * 判定表を使うので、判定を狭めれば下の `expectJudgedEverything` が落ちる。
     */
    const table = verdicts(metaGlobs);
    expectJudgedEverything(table, metaGlobs, GLOB_POSITIVE);
    expect(
      table.filter((v) => globOwners.includes(v.file) || v.findings.length > 0).map((v) => `${v.file}（辿った道: ${trail(v.via)}）`),
      "glob を持つモジュールに辿り着いています",
    ).toEqual([]);
  });

  /**
   * **検査そのものを検査する。** 実ファイルは書き換えられないので、
   * `data-files.ts` に受け入れ条件の 1 行（`export { isDietAssemblyId } from "./assemblies";`）を
   * **足したソースを渡して**、`assemblies.ts` に辿り着くことを確かめる。
   */
  it('data-files.ts に `export { isDietAssemblyId } from "./assemblies";` を足すと assemblies.ts に辿り着く', () => {
    const dataFiles = path.join(webRoot, "app/lib/data-files.ts");
    const patched = `export { isDietAssemblyId } from "./assemblies";\n${readFileSync(dataFiles, "utf8")}`;
    const read = (f: string): string => (f === dataFiles ? patched : readFileSync(f, "utf8"));
    const withBadLine = reachableFrom(entries, read).map((r) => rel(r.file));
    expect(withBadLine, "この 1 行で assemblies.ts に辿り着くはず（辿り着かないなら走査が効いていない）").toContain("app/lib/assemblies.ts");
    // そのファイルは実際に glob を持つ＝ビルドが落ちる形
    expect(metaGlobs(readFileSync(path.join(webRoot, "app/lib/assemblies.ts"), "utf8"))).not.toEqual([]);
    // 元のソースでは辿り着かない（差が「足した 1 行」によるものであること）
    expect(reached.map((r) => rel(r.file))).not.toContain("app/lib/assemblies.ts");
  });

  it("前提: 入口のスクリプトは実際に値を引き込んでいる（ソースの読み込みに失敗して空を見ていない）", () => {
    const empty = entries.filter((e) => valueImports(readFileSync(e, "utf8"), e).length === 0).map((e) => path.basename(e));
    expect(empty, "値の import が 1 つも無いスクリプト（読み込みに失敗している可能性）").toEqual([]);
  });
});
