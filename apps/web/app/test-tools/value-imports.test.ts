// @vitest-environment node
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dynamicImports, metaGlobs, reachableFrom, resolveRelative, valueImports } from "./value-imports";

/**
 * **検査そのものを検査する。**（#451 の最大の学び: 検査器自身のテストが無かったので、
 * 検査が 3 度壊れて 3 度とも緑だった）
 *
 * 「落ちるべきものが落ちる」と「通るべきものが通る」の両方を、ソースを差し替えて確かめる。
 * 禁止の検査は**厳しすぎても壊れる**——`export type * from` や複数行の `import type` を
 * 落とすようになったら、正しい書き方ができなくなる。
 *
 * この 20 形 / 14 形は #451 で 4 度やり直して固まったもの。#490 で
 * `data-files.test.ts` から `value-imports.ts` に移したが、**中身は変えていない**。
 */
const labels = (code: string): string[] => valueImports(code).map((v) => v.label);

describe("valueImports: 値を引き込む書き方は、どう書かれていても検出する", () => {
  const bad: Record<string, string> = {
    "1行 export ... from": 'export { isDietAssemblyId } from "./assemblies";',
    "複数行 import（Prettier が名前2つ以上で必ず生成する形）": 'import {\n  isDietAssemblyId,\n  assemblyPath,\n} from "./assemblies";',
    行頭セミコロン: ';import { isDietAssemblyId } from "./assemblies";',
    "同じ行に import type と値 import": 'import type { A } from "./t"; import { b } from "./assemblies";',
    "空白なし import": 'import{a}from"./assemblies";',
    "空白なし export": 'export{a}from"./assemblies";',
    "副作用 import": 'import "./assemblies";',
    "export * from": 'export * from "./assemblies";',
    "export * as ns from": 'export * as ns from "./assemblies";',
    "default import": 'import d from "./assemblies";',
    "namespace import": 'import * as ns from "./assemblies";',
    "export { x as default } from": 'export { a as default } from "./assemblies";',
    "export { default } from": 'export { default } from "./assemblies";',
    "default と named の混在": 'import d, { a } from "./assemblies";',
    "default と namespace の混在": 'import d, * as ns from "./assemblies";',
    "import assertion（with）": 'import data from "./a.json" with { type: "json" };',
    "named の一部だけ値（残りは type）": 'import { type A, b } from "./assemblies";',
    "ASI（セミコロン省略）": 'import type { A } from "./t"\nimport { b } from "./assemblies"',
    "改行を挟んだ from": 'import { a }\n  from "./assemblies";',
    シングルクォート: "import { a } from './assemblies';",
  };

  it("20 形すべてを検出する", () => {
    const missed = Object.entries(bad)
      .filter(([, code]) => labels(code).length === 0)
      .map(([name]) => name);
    expect(missed, "検出できていない形があります").toEqual([]);
    expect(Object.keys(bad)).toHaveLength(20);
  });

  /**
   * **どのモジュールを引き込んだか**まで返す（#490）。ここが空文字だと、
   * 入口から辿る検査が**どこにも行けなくなり、静かに何も見なくなる**。
   */
  it("引き込む先の指定子を返す（辿るために要る）", () => {
    const wrong = Object.entries(bad)
      .filter(([, code]) => !valueImports(code).some((v) => v.specifier !== ""))
      .map(([name]) => name);
    expect(wrong, "指定子（moduleSpecifier の中身）を返していない形があります").toEqual([]);
    expect(valueImports('export { a } from "./assemblies";')[0]?.specifier).toBe("./assemblies");
  });
});

describe("valueImports: 型だけの形と、コメント・文字列の中の import は通す（厳しすぎて壊さない）", () => {
  const good: Record<string, string> = {
    "import type 1行": 'import type { A } from "./a";',
    "import type 複数行（Prettier の既定）": 'import type {\n  A,\n  B,\n} from "./a";',
    "export type { A } from": 'export type { A } from "./a";',
    "export type * from": 'export type * from "./a";',
    "export type * as ns from": 'export type * as ns from "./a";',
    "export type {} from": 'export type {} from "./a";',
    "インライン import { type A }": 'import { type A } from "./a";',
    "インライン 複数の type のみ": 'import { type A, type B } from "./a";',
    "コメント内の import": '// import { a } from "./assemblies";\n/* export { b } from "./b"; */',
    "文字列リテラル内の import（正規表現版はここで誤検出した）": "export const help = 'import { a } from \"./assemblies\"';",
    "テンプレートリテラル内の import": 'export const help = `import { a } from "./assemblies"`;',
    "束縛が空（TS が消すのでビルドは落ちない。実測で確認）": 'import {} from "./assemblies";\nexport {} from "./assemblies";',
    "from の無いローカル export": "export const x = 1;\nexport { x };",
    "import が 1 つも無い": "export function f() { return 1; }",
  };

  it("14 形すべてを通す", () => {
    const wrong = Object.entries(good)
      .filter(([, code]) => labels(code).length > 0)
      .map(([name, code]) => `${name}: ${labels(code).join(" / ")}`);
    expect(wrong, "誤って検出している形があります").toEqual([]);
    expect(Object.keys(good)).toHaveLength(14);
  });
});

describe("dynamicImports / metaGlobs", () => {
  it("動的 import を検出し、コメント内は誤検出しない", () => {
    expect(dynamicImports('await import("./assemblies");'), "動的 import を検出できていない").not.toEqual([]);
    expect(dynamicImports('// await import("./assemblies");'), "コメント内を誤検出している").toEqual([]);
  });

  it("import.meta.glob を式として検出し、コメント内は誤検出しない", () => {
    expect(metaGlobs('const f = import.meta.glob("./x/*.json");'), "import.meta.glob を検出できていない").not.toEqual([]);
    expect(metaGlobs("// import.meta.glob に触らないこと"), "コメント内を誤検出している（この検査の元の失敗）").toEqual([]);
  });
});

describe("resolveRelative", () => {
  it("拡張子なし・index つき・.tsx を解決し、パッケージ名は辿らない", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "giin-resolve-"));
    await writeFile(path.join(dir, "a.ts"), "");
    await writeFile(path.join(dir, "b.tsx"), "");
    const from = path.join(dir, "entry.ts");
    expect(resolveRelative(from, "./a")).toBe(path.join(dir, "a.ts"));
    expect(resolveRelative(from, "./b")).toBe(path.join(dir, "b.tsx"));
    expect(resolveRelative(from, "typescript"), "パッケージ名を辿ってはいけない").toBeNull();
    expect(resolveRelative(from, "./missing")).toBeNull();
  });
});

/**
 * **#490 の中身。** 入口から**推移的に**辿れること。
 * 1 段だけ見る実装（入口の直接の import だけ）では、`data-files.ts → linked-counts.ts → assemblies.ts`
 * のような 2 段目以降を見落とす。**実際に踏んだ罠が 2 段目**（`linked-counts.ts`）だったので、
 * ここが効いていないと検査の意味が無い。
 */
describe("reachableFrom: 入口から推移的に辿る", () => {
  const tree = async (): Promise<{ dir: string; entry: string }> => {
    const dir = await mkdtemp(path.join(tmpdir(), "giin-reach-"));
    await writeFile(path.join(dir, "entry.ts"), 'import { a } from "./one";\nimport type { T } from "./typeonly";\n');
    await writeFile(path.join(dir, "one.ts"), 'export { b } from "./two";\nexport const a = 1;\n');
    await writeFile(path.join(dir, "two.ts"), 'import type { T } from "./typeonly";\nexport const b = 2;\n');
    await writeFile(path.join(dir, "typeonly.ts"), "export type T = 1;\n");
    await writeFile(path.join(dir, "unused.ts"), "export const c = 3;\n");
    return { dir, entry: path.join(dir, "entry.ts") };
  };

  it("2 段目（入口が直接 import していないもの）まで辿る", async () => {
    const { dir, entry } = await tree();
    const files = reachableFrom([entry]).map((r) => path.basename(r.file));
    expect(files, "2 段目の two.ts を見落としている（1 段だけ見る実装）").toContain("two.ts");
    expect(files).toEqual(["one.ts", "two.ts"]);
    expect(dir).toBeTruthy();
  });

  it("型だけの import は辿らない（実行時には存在しないので glob に繋がらない）", async () => {
    const { entry } = await tree();
    expect(reachableFrom([entry]).map((r) => path.basename(r.file))).not.toContain("typeonly.ts");
  });

  it("どこからも辿られないファイルは含めない", async () => {
    const { entry } = await tree();
    expect(reachableFrom([entry]).map((r) => path.basename(r.file))).not.toContain("unused.ts");
  });

  it("辿った道（via）を返す——失敗のとき「どれが」を出すため", async () => {
    const { entry } = await tree();
    const two = reachableFrom([entry]).find((r) => path.basename(r.file) === "two.ts");
    expect(
      two?.via.map((f) => path.basename(f)),
      "入口からの道を返していない",
    ).toEqual(["entry.ts", "one.ts", "two.ts"]);
  });

  it("循環（a → b → a）でも止まる", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "giin-cycle-"));
    await writeFile(path.join(dir, "entry.ts"), 'import { a } from "./a";\nexport const e = a;\n');
    await writeFile(path.join(dir, "a.ts"), 'import { b } from "./b";\nexport const a = b;\n');
    await writeFile(path.join(dir, "b.ts"), 'import { a } from "./a";\nexport const b = 1;\n');
    expect(reachableFrom([path.join(dir, "entry.ts")]).map((r) => path.basename(r.file))).toEqual(["a.ts", "b.ts"]);
  });
});
