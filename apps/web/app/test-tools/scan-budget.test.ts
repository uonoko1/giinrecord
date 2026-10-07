// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { moduleSpecifiers, scanSources } from "./value-imports";

/**
 * **`no-path-alias.test.ts` の実所要が共有の `testTimeout` を食い潰さないことを、計器で固定する（#1242）。**
 *
 * 2026-10-07、**2 人の実装者が独立に踏んだ**——`apps/web` を 1 行も触っていない枝で
 * `no-path-alias.test.ts` が `20000ms` で timeout した。**単独実行では 9/9 緑**なので、
 * 単独で測っている限り見えない。
 *
 * **内訳を測った結果**（vitest の worker 内、load average 28〜43、`performance.now()`）:
 *
 *     sources()（tsconfig の解析と走査）        54ms    ← 走査は問題ではない
 *     readFileSync x195（1.25MB）               22ms    ← **I/O は問題ではない**
 *     moduleSpecifiers x195（1 回目・cold）   1,754ms   ← **ここが全部**
 *     moduleSpecifiers x195（2 回目・warm）   1,148ms   ← **同じものをもう一度**
 *
 * **#538 の手（`Promise.all` での I/O 並列化）はここでは効かない。** I/O は 22ms で、
 * 残りは `ts.createSourceFile` の CPU 時間である。並列化する I/O が無い。
 *
 * **直し方は #501 と同じ「2 回読むのをやめる」。** ただし `no-path-alias.test.ts` の設計は
 * 走査を `it` の中に置くことを要求している（**`beforeAll` や module scope に上げると
 * `testTimeout` の管轄外に移るだけで速くならない**——#520 / #556）。
 * そこで**内容をキーにした memo** にして、`it` は従来どおり自分で全ファイルを走査しつつ、
 * **同じ内容を 2 度パースしない**ようにした。
 *
 * **この検査が無いと、memo を外しても `no-path-alias.test.ts` は緑のまま遅くなる**
 * （遅くなっても誰も鳴らさない。負荷が上がった日に他人の枝で落ちる）。
 */
const webRoot = path.resolve(fileURLToPath(import.meta.url), "../../..");

function tsconfigSources(): string[] {
  const raw = ts.readConfigFile(path.join(webRoot, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, webRoot);
  return parsed.fileNames.filter((f) => /\.tsx?$/.test(f));
}

describe("走査の予算: `~/` 検査が testTimeout を食い潰さない（#1242）", () => {
  const files = tsconfigSources();

  it("前提: 測る対象が空振りしていない（195 件規模のファイルと 100 件超の指定子）", () => {
    expect(files.length, "tsconfig が .ts / .tsx を返していない（この検査が空振り）").toBeGreaterThan(100);
    const total = files.reduce((n, f) => n + scanSources([f]).get(f)!.length, 0);
    expect(total, "指定子が 1 つも読めていない").toBeGreaterThan(100);
  });

  /**
   * **2 回目の走査がパースを繰り返さない。**
   *
   * `no-path-alias.test.ts` は 2 つの `it`（「前提」と「`~/` を書かない」）が
   * **同じ 195 ファイルをそれぞれ走査する**。memo が効いていれば 2 回目はパースを 1 件もしない。
   *
   * 時間ではなく**パースした回数**で見る。時間は負荷で 3 倍以上ぶれるので、
   * 「速くなった」を時間で固定すると負荷の高い日に誤って落ちる（#538 の教訓）。
   */
  it("同じファイルを 2 度走査しても、パースは 1 回しか起きない", () => {
    // **memo はプロセス全体で共有されるので、実ファイルで数えると
    // 先に走った `it` が温めた分だけ 1 回目が 0 件になる**（最初この検査自身がそれで落ちた）。
    // だから**この検査だけが使う内容**を作って数える。`readFile` を差し替えるので I/O もしない。
    const names = Array.from({ length: 40 }, (_, i) => `/scan-budget/only-here-${i}.ts`);
    const body = (i: number): string => `import { a${i} } from "./dep-${i}";\nexport const v${i} = a${i};\n`;
    const read = (f: string): string => body(Number(f.match(/-(\d+)\.ts$/)![1]));

    const before = scanSources.parsed;
    const first = scanSources(names, read);
    const firstPass = scanSources.parsed - before;
    expect(firstPass, "1 回目でパースが起きていない（memo が初回から空振り？）").toBe(names.length);
    expect(first.get(names[0]), "1 回目の答えが取れていない").toEqual(["./dep-0"]);

    const mid = scanSources.parsed;
    const second = scanSources(names, read);
    const secondPass = scanSources.parsed - mid;
    expect(
      secondPass,
      "2 回目の走査でパースが起きています。**同じ内容を 2 度パースすると、" +
        "負荷の高い日に `no-path-alias.test.ts` が共有の testTimeout 20000ms を超えます**（#1242）",
    ).toBe(0);
    // 2 周目も**同じ答え**（パースを省いた代わりに空を返していない）
    expect([...second.keys()], "2 周目が全ファイル分を返していない").toEqual(names);
    expect(second.get(names[39]), "2 周目が違う答えを返している").toEqual(["./dep-39"]);
  });

  /**
   * **memo は「同じ内容なら同じ答え」でなければならない。**
   * キーを間違えて（例: ファイル名だけ・内容の先頭だけ）取り違えると、
   * **別のファイルの指定子を返して検査が黙る**——`~/` を書いても気づかれなくなる。
   */
  it("memo を通した答えが、素のパースと 1 件も違わない", () => {
    const memoized = scanSources(files);
    const mismatches = files.filter((f) => {
      const direct = moduleSpecifiers(readFileSync(f, "utf8"), f);
      const viaMemo = memoized.get(f) ?? [];
      return JSON.stringify(direct) !== JSON.stringify(viaMemo);
    });
    expect(mismatches.map((f) => path.relative(webRoot, f)), "memo が素のパースと違う答えを返しています").toEqual([]);
    expect(memoized.size, "memo が全ファイル分の答えを返していない").toBe(files.length);
  });

  /**
   * **内容が変わったら作り直す。** mtime やファイル名でキャッシュすると、
   * 書き換えたのに古い答えを返す。**`~/` を足したのに緑**という最悪の形になる。
   */
  it("内容が変わったら、新しい内容の答えを返す（名前でキャッシュしていない）", () => {
    const fake = path.join(webRoot, "app", "__scan-budget-fixture__.ts");
    const a = scanSources([fake], () => 'import { a } from "./alpha";');
    expect(a.get(fake), "1 回目の答えが取れていない").toEqual(["./alpha"]);
    const b = scanSources([fake], () => 'import { b } from "~/beta";');
    expect(b.get(fake), "同じ名前で内容が変わったのに古い答えを返しています（名前でキャッシュしている）").toEqual(["~/beta"]);
  });

  /**
   * **`setParentNodes` を立てない。** `moduleSpecifiers` は `.parent` も `.getText()` も
   * 使っていないので要らない。実測で**パースが約 1.3 倍**になる（195 ファイルで
   * median 756ms → 566ms）。立て直されたら気づけるように固定する。
   *
   * **`valueImports` / `dynamicImports` / `metaGlobs` は `node.getText(sf)` を呼ぶので、
   * そちらは `true` のままでなければならない**（混同して全部 false にすると、
   * `getText` が空文字を返して検査が静かに黙る）。
   */
  it("moduleSpecifiers は setParentNodes を立てない（parent も getText も使わないため）", () => {
    const source = readFileSync(path.join(webRoot, "app", "test-tools", "value-imports.ts"), "utf8");
    const fn = source.slice(source.indexOf("export function moduleSpecifiers"));
    // **コメントを落としてから見る。** 落とさないと、この直し方を説明した
    // `node.getText()` という**散文**に下の `not.toContain("getText")` が当たる
    // （最初そうなって落ちた）。見たいのはコードの側。
    const body = fn
      .slice(0, fn.indexOf("\n}\n"))
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(body, "moduleSpecifiers の中で createSourceFile を呼んでいない").toContain("ts.createSourceFile");
    expect(
      body,
      "moduleSpecifiers が setParentNodes=true でパースしています（.parent も .getText() も使わないので不要。実測で約 1.3 倍遅い）",
    ).toMatch(/ts\.createSourceFile\([^)]*false[^)]*\)/);
    expect(body, "moduleSpecifiers が getText を使っています（使うなら setParentNodes が必要になります）").not.toContain("getText");
  });
});
