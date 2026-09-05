// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { moduleSpecifiers } from "./value-imports";

/**
 * **`~/` エイリアスを書かない（#500）。どの実行環境でも解決できないから。**
 *
 * `apps/web/tsconfig.json` には `paths: {"~/*": ["./app/*"]}` があった。
 * **`tsc` はこれを解決するが、実際にコードを走らせるものは 1 つも解決しない**——
 * 2026-09-05 に `export { isDietAssemblyId } from "~/lib/assemblies";` を
 * `data-files.ts` に入れて実測した結果:
 *
 *     npx tsc --noEmit                    → exit 0（通ってしまう）
 *     #490 の検査（tsx-build-scripts）    → 17 件全部緑（素通り）
 *     npx tsx apps/web/scripts/sitemap.ts → TypeError: (intermediate value).glob is not a function
 *     npx react-router build              → Cannot find module '~/lib/assemblies'
 *     npx vitest run data-files.test.ts   → Cannot find module '~/lib/assemblies'（テストが読み込めない）
 *
 * **typecheck は通り、検査も通り、走らせるところだけが落ちる。**
 * #451 / #490 が塞ごうとした形そのものが、`~/` 経由で再現していた。
 *
 * **直し方は 2 つあった:**
 * (a) #490 の走査に `~/` → `app/` の解決を足す
 * (b) `~/` の使用そのものを禁じ、`tsconfig` から `paths` / `baseUrl` を消す ← **こちらを採った**
 *
 * (a) を採らなかった理由: **`~/` は Vite の本番ビルドでも解決できない**（上の実測）。
 * 「走査が辿れるようにする」のは、**動かない書き方を検査だけが理解できるようにする**ことで、
 * `import.meta.glob` に繋がらない `~/` は依然としてどこでも動かないのに誰も止めない。
 * **使えないエイリアスが tsconfig に残っているほうが罠**なので、機能ごと落とす。
 *
 * `baseUrl` も一緒に消してある。`baseUrl` に依る非相対 import は `~/` と同じ問題
 * （`tsc` は解決するが vite / vitest / tsx がどう扱うかは別）を持ち、
 * **将来書かれたら同じ穴がもう一度開く**。消しても現行ソースは何も壊れない（実測）。
 */
const webRoot = path.resolve(fileURLToPath(import.meta.url), "../../.."); // app/test-tools/x.test.ts → apps/web

/**
 * **検査対象は `tsconfig.json` 自身に決めさせる。**
 *
 * 手で歩くと、**除外を 1 つ足して、それを見張っているアサーションも一緒に消せば黙る**
 * （実際に変異で確かめた: `scripts` を SKIP に足して前提の 1 行を消すと、
 * `scripts/sitemap.ts` の `~/` を**6 件全部緑のまま見逃した**）。
 * #490 で「対象を手で並べると漏れる」と学んだのと同じ形。
 *
 * `tsc` が型検査するファイルと、この検査が見るファイルが**同じ集合**であるべきなので、
 * TypeScript に `include` を展開させてそれを使う。**狭めるには tsconfig を書き換えるしかなく、
 * そのときは型検査の対象も一緒に狭まるので、黙って狭めることはできない。**
 *
 * 生成物（`node_modules` / `build` / `.react-router`）だけ外す。
 * **テストファイルも fixture も含める**——`~/` はテストファイル自身の読み込みも壊す（実測）。
 */
/**
 * **検査対象は `tsconfig.json` 自身に決めさせる。除外リストを持たない。**
 *
 * 手で歩くと、**除外を 1 つ足して、それを見張っているアサーションも一緒に消せば黙る**
 * （変異で実際に確かめた: `scripts` を除外して前提の 1 行を消すと、
 * `scripts/sitemap.ts` の `~/` を**全部緑のまま見逃した**）。
 * #490 で「対象を手で並べると漏れる」と学んだのと同じ形。
 *
 * `tsc` が型検査するファイルと、この検査が見るファイルを**同じ集合**にする。
 * **狭めるには tsconfig を書き換えるしかなく、そのときは型検査の対象も一緒に狭まる**ので、
 * 黙って狭めることはできない。
 *
 * 除外は 1 つも書かない。TypeScript が既定で `node_modules` を外し、
 * `build` / `.react-router` にはこの条件に合う自作ソースが無い（実測で 0 件）。
 * **テストファイルも fixture も含める**——`~/` はテストファイル自身の読み込みも壊す（実測）。
 */
function sources(): string[] {
  const configPath = path.join(webRoot, "tsconfig.json");
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(raw.error, "tsconfig.json が読めない").toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, webRoot);
  // 並びはコードポイント順（`localeCompare` はロケールで変わる。#244 の事故）
  return parsed.fileNames.filter((f) => /\.tsx?$/.test(f)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const files = sources();

/**
 * その指定子が `~` エイリアスかどうか。**独立した関数にして、直接検査する。**
 * 判定を式のまま `for` の中に書くと、**判定を殺しても現に違反が 0 件なので全部緑になる**
 * （変異で実際にそうなった。「違反を書けば落ちる」は検査が生きている証明にならない——#484）。
 */
export function isTildeAlias(specifier: string): boolean {
  return specifier === "~" || specifier.startsWith("~/");
}
const rel = (file: string): string => path.relative(webRoot, file);

describe("`~/` エイリアスを書かない（#500）", () => {
  /**
   * **走査が空振りしていないこと。** 0 件なら何も見ていない。
   * ここは `tsconfig` 由来なので、**狭めるには型検査の対象も狭めるしかない**。
   */
  it("前提: tsc が型検査するファイルと同じ集合を見ている", () => {
    expect(files.length, "走査したファイルが少なすぎる（tsconfig の読み方が壊れている）").toBeGreaterThan(100);
    const names = files.map(rel);
    // 種類の違うものが入っていること（app/ だけ・scripts/ だけを見ていない）
    expect(names, "app/lib を見ていない").toContain("app/lib/data-files.ts");
    expect(names, "scripts/ を見ていない").toContain("scripts/sitemap.ts");
    expect(names, "ルート直下の設定ファイルを見ていない").toContain("vite.config.ts");
    expect(names, "テストファイルを見ていない（~/ はテスト自身の読み込みも壊す）").toContain("app/lib/data-files.test.ts");
    // 実際に指定子を読めている（空文字を見ていない）
    const total = files.reduce((n, f) => n + moduleSpecifiers(readFileSync(f, "utf8"), f).length, 0);
    expect(total, "モジュール指定子が 1 つも読めていない").toBeGreaterThan(100);
  });

  /**
   * **`tsc` が見るものを 1 つも取りこぼしていない。**
   * 除外リストを持たない設計なので、ここは「tsconfig の結果をそのまま使っているか」を見る。
   * フィルタを足して黙らせようとすると、この件数が合わなくなる。
   */
  it("tsc が型検査する .ts / .tsx を 1 つも外していない", () => {
    const configPath = path.join(webRoot, "tsconfig.json");
    const raw = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, webRoot);
    const everything = parsed.fileNames.filter((f) => /\.tsx?$/.test(f));
    expect(everything.length, "tsconfig が .ts / .tsx を 1 つも返していない").toBeGreaterThan(100);
    const missing = everything.filter((f) => !files.includes(f)).map(rel);
    expect(missing, "tsc が型検査するのに、この検査が見ていないファイルがあります").toEqual([]);
  });

  it("`~/` で始まる import を書かない（どの実行環境でも解決できない）", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of moduleSpecifiers(readFileSync(file, "utf8"), file)) {
        if (isTildeAlias(spec)) offenders.push(`${rel(file)}: "${spec}"`);
      }
    }
    expect(
      offenders,
      "`~/` は tsc だけが解決し、vitest も Vite ビルドも tsx も解決できません" +
        "（`Cannot find module '~/...'`）。**typecheck が通るのに実行だけ落ちます。**" +
        "相対パス（`./` / `../`）で書いてください",
    ).toEqual([]);
  });

  /**
   * **禁止しただけでは足りない。** `tsconfig` に `paths` が残っていると、
   * `tsc` は `~/` を受理し続ける——**この検査を消した瞬間に穴が戻る**。
   * `paths` が無ければ `tsc` 自身が `error TS2307` で弾く（実測）ので、
   * **最も早い時点で落ちる**。この検査は二重の保険。
   */
  it("tsconfig に `paths` / `baseUrl` を持たない（tsc 自身に弾かせる）", () => {
    const tsconfig = readFileSync(path.join(webRoot, "tsconfig.json"), "utf8");
    const parsed = JSON.parse(tsconfig) as { compilerOptions?: Record<string, unknown> };
    const options = parsed.compilerOptions ?? {};
    // 読めていることの確認（空オブジェクトを見て緑になっていない）
    expect(Object.keys(options), "compilerOptions が読めていない").toContain("strict");
    expect(
      options.paths,
      "`paths` を戻すと `~/` が tsc を通ってしまいます（実行時はどこでも解決できないまま）。" +
        "戻すなら vite.config.ts / vitest.config.ts の resolve.alias も一緒に足してください",
    ).toBeUndefined();
    expect(options.baseUrl, "`baseUrl` に依る非相対 import は `~/` と同じ問題（tsc は解決するが vite / vitest / tsx は別）を持ちます").toBeUndefined();
  });
});

/**
 * **検査そのものを検査する。**（#451 の最大の学び: 検査器自身のテストが無かったので、
 * 検査が 3 度壊れて 3 度とも緑だった）
 */
/**
 * **判定そのものを検査する。** これが無いと、判定を殺しても
 * （現に `~/` が 0 件なので）全部緑のまま通る——**実際に変異で確認した**。
 */
describe("isTildeAlias: `~` エイリアスの判定（#500）", () => {
  it("`~/` で始まるもの と `~` そのものを true と言う", () => {
    const yes = ["~/lib/assemblies", "~/lib/a.ts", "~/", "~"];
    expect(
      yes.filter((s) => !isTildeAlias(s)),
      "`~` エイリアスを見落としている",
    ).toEqual([]);
  });

  it("相対パス・パッケージ名・`~` を含むだけの文字列は false と言う（厳しすぎて壊さない）", () => {
    const no = ["./lib/a", "../lib/a", "typescript", "@seiji-kiroku/shared", "node:fs", "lib/~/a", "a~b", "~~/a", "~lib/a"];
    expect(
      no.filter((s) => isTildeAlias(s)),
      "`~` エイリアスでないものを誤って拾っている",
    ).toEqual([]);
  });
});

describe("moduleSpecifiers: 指定子を種類を問わず集める（#500）", () => {
  const bad: Record<string, string> = {
    "値 import": 'import { a } from "~/lib/a";',
    "型だけ import（tsc は通すが vitest は読み込めない）": 'import type { A } from "~/lib/a";',
    "副作用 import": 'import "~/lib/a";',
    "default import": 'import d from "~/lib/a";',
    "namespace import": 'import * as ns from "~/lib/a";',
    "export ... from": 'export { a } from "~/lib/a";',
    "export * from": 'export * from "~/lib/a";',
    "export type ... from": 'export type { A } from "~/lib/a";',
    "動的 import": 'const m = await import("~/lib/a");',
    "束縛が空（TS は消すが、指定子としては書かれている）": 'import {} from "~/lib/a";',
    "複数行 import": 'import {\n  a,\n  b,\n} from "~/lib/a";',
    シングルクォート: "import { a } from '~/lib/a';",
    空白なし: 'import{a}from"~/lib/a";',
  };

  it("13 形すべてから `~/` の指定子を拾う", () => {
    const missed = Object.entries(bad)
      .filter(([, code]) => !moduleSpecifiers(code).some((s) => s.startsWith("~/")))
      .map(([name]) => name);
    expect(missed, "`~/` を拾えていない形があります").toEqual([]);
    expect(Object.keys(bad)).toHaveLength(13);
  });

  const good: Record<string, string> = {
    コメント内: '// import { a } from "~/lib/a";\n/* export { b } from "~/lib/b"; */',
    文字列リテラル内: "export const help = 'import { a } from \"~/lib/a\"';",
    テンプレートリテラル内: "export const help = `~/lib/a`;",
    "ただの文字列（パスに見えるだけ）": 'export const home = "~/Documents";',
    "相対 import": 'import { a } from "./lib/a";',
    パッケージ名: 'import ts from "typescript";',
    "動的 import に変数を渡す（文字列でない）": "const p = './a'; const m = await import(p);",
  };

  it("コメント・文字列・相対パス・パッケージ名は拾わない（厳しすぎて壊さない）", () => {
    const wrong = Object.entries(good)
      .filter(([, code]) => moduleSpecifiers(code).some((s) => s.startsWith("~")))
      .map(([name, code]) => `${name}: ${moduleSpecifiers(code).join(" / ")}`);
    expect(wrong, "誤って `~/` として拾っている形があります").toEqual([]);
    expect(Object.keys(good)).toHaveLength(7);
  });

  it("相対 import とパッケージ名は（`~/` でなくても）指定子として拾う", () => {
    expect(moduleSpecifiers('import { a } from "./lib/a";')).toEqual(["./lib/a"]);
    expect(moduleSpecifiers('import ts from "typescript";')).toEqual(["typescript"]);
    // 拾えていないと、上の「拾わない」テストが空振りで緑になる
    expect(moduleSpecifiers('export const home = "~/Documents";'), "ただの文字列を拾ってはいけない").toEqual([]);
  });
});
