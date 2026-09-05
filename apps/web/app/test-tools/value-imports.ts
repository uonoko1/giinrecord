/**
 * **tsx で直に走るビルドスクリプトが、Vite 専用のモジュール（`import.meta.glob`）を
 * 引き込んでいないか**を、ソースの形（AST）で見るための道具。テストからだけ使う。
 *
 * なぜ要るか（#441 が実際に踏み、#451 で検査になった罠）:
 * `apps/web/package.json` の `build` は `react-router build` のあとに **tsx でスクリプトを直に走らせる**。
 * tsx には `import.meta.glob` が無いので、そこから辿れるモジュールが 1 本でも
 * `assemblies.ts` / `dataset.ts` のような glob 持ちに繋がると
 * `import.meta.glob is not a function` でビルドが落ちる。
 *
 * **#490 まで、この検査は `linked-counts.ts` 1 ファイルにしか当たっていなかった。**
 * `data-files.ts` に `export { isDietAssemblyId } from "./assemblies";` を足すと
 * **テストは 0 件落ちるのにビルドは落ちる**（レビュアーの実測）。
 * 対象を手で並べると増えたときに漏れるので、**入口（`scripts/*.ts`）から辿って集める。**
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * **そのソースが「読み込んだ時点で実行時に引き込むもの」**を数える。
 * 型だけの形（`import type` / `export type` / インラインの `{ type A }`）は
 * TypeScript が出力から消すので数えない。
 *
 * `import {} from "..."` / `export {} from "..."`（束縛が空）も数えない——
 * **実測で TS が消し、ビルドは落ちない**（対照として `import "..."` は落ちる）。
 * 実害の無いものを落とすと、正しい書き方ができなくなる。
 *
 * `require()` / `import a = require()` も見ない。**静かには壊れないから**——
 * 実測で `ERR_AMBIGUOUS_MODULE_SYNTAX` になり、その場で止まる。
 *
 * **束縛が空を通すのは、#490 で TS に実際に吐かせて確かめた**（`ts.transpileModule`）:
 *
 *     import {} from "./assemblies"; export const x = 1;  →  export const x = 1;   （消える）
 *     import "./assemblies";                              →  import "./assemblies";（残る）
 *     import { type A, b } from "./assemblies"; ... = b;  →  import { b } from "./assemblies";（残る）
 */
export function valueImports(code: string, fileName = "x.ts"): { label: string; specifier: string }[] {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  const found: { label: string; specifier: string }[] = [];
  const push = (kind: string, node: ts.Expression): void => {
    found.push({
      label: `${kind} ${node.getText(sf)}`,
      specifier: ts.isStringLiteralLike(node) ? node.text : "",
    });
  };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const clause = st.importClause;
      // `import "./x"`（束縛が無い）＝副作用だけの import。**必ず実行される**
      if (!clause) {
        push("副作用 import", st.moduleSpecifier);
        continue;
      }
      if (clause.isTypeOnly) continue; // import type { A } from "./x"
      if (clause.name) {
        push("default import", st.moduleSpecifier);
        continue;
      }
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) {
        push("namespace import", st.moduleSpecifier);
        continue;
      }
      // `import { a, type B }` は a が値なので数える。全部 type なら数えない
      if (nb && ts.isNamedImports(nb) && nb.elements.some((e) => !e.isTypeOnly)) push("値 import", st.moduleSpecifier);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
      if (st.isTypeOnly) continue; // export type { A } from / export type * from
      const clause = st.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        if (clause.elements.some((e) => !e.isTypeOnly)) push("値 export ... from", st.moduleSpecifier);
        continue;
      }
      // export * from / export * as ns from
      push("export * from", st.moduleSpecifier);
    }
  }
  return found;
}

/** 動的 import（`import(...)`）。式の中まで歩く。静的 import と違い**呼ばれたときだけ**落ちる */
export function dynamicImports(code: string, fileName = "x.ts"): string[] {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) found.push(node.getText(sf));
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return found;
}

/**
 * `import.meta.glob` が**式として**書かれている箇所。
 * 素の文字列検索だと「glob に触るな」と書いた doc コメント自身を拾って落ちる。
 * AST なら、コメントも文字列リテラルも最初から対象外。
 */
export function metaGlobs(code: string, fileName = "x.ts"): string[] {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "glob" && ts.isMetaProperty(node.expression)) found.push(node.getText(sf));
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return found;
}

/** 相対指定子をファイルに直す。解決できなければ null（パッケージ名などは辿らない） */
export function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** 1 モジュールが「誰から辿り着けたか」 */
export type Reached = {
  /** 絶対パス */
  file: string;
  /** 入口から辿った道（入口 → ... → このファイル）。絶対パス */
  via: string[];
};

/**
 * 入口のファイル群から、**値として引き込まれるもの**だけを辿って集める。
 * 型だけの import は辿らない（実行時には存在しないので、glob に繋がらない）。
 * 入口自身は結果に含めない。
 */
export function reachableFrom(entries: string[], readFile: (f: string) => string = (f) => readFileSync(f, "utf8")): Reached[] {
  const seen = new Map<string, Reached>();
  const queue: Reached[] = entries.map((file) => ({ file, via: [file] }));
  const entrySet = new Set(entries);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    for (const { specifier } of valueImports(readFile(current.file), current.file)) {
      if (!specifier) continue;
      const resolved = resolveRelative(current.file, specifier);
      if (!resolved || entrySet.has(resolved) || seen.has(resolved)) continue;
      const next: Reached = { file: resolved, via: [...current.via, resolved] };
      seen.set(resolved, next);
      queue.push(next);
    }
  }
  // 並びはコードポイント順（`localeCompare` はロケールで変わる。#244 の事故）
  return [...seen.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}
