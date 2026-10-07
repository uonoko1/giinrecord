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

/**
 * **そのソースが書いているモジュール指定子を、種類を問わず全部**集める（#500）。
 *
 * `valueImports` と違い、**型だけの import も、動的 import も、副作用 import も**数える。
 * 用途が違うため: `valueImports` は「実行時に何を引き込むか」を見るのに対し、こちらは
 * 「**どんな書き方の指定子が書かれているか**」を見る。`~/` のように
 * **どの実行環境でも解決できない指定子**は、型だけの import でも `tsc` を通ってしまい、
 * vitest / Vite ビルド / tsx のいずれかで読み込みが失敗する。
 *
 * コメントと文字列リテラルは AST なので最初から対象外（`"~/lib/x"` という**ただの文字列**は拾わない）。
 */
export function moduleSpecifiers(code: string, fileName = "x.ts"): string[] {
  // **`setParentNodes` は立てない（#1242）。** この関数は `.parent` も `node.getText()` も
  // 使わない（指定子は `StringLiteralLike.text` から直に取る）。立てると親リンクを張る分だけ
  // 遅くなる。**実測は同一プロセスで true / false を交互に 8 回ずつ回した median**:
  // **637ms（true）対 505ms（false）＝ 1.26 倍**（195 ファイル、load 28）。
  // **別プロセスで測ると順番の効果に埋もれる**——先に走ったほうが必ず遅く出て、
  // 順番を入れ替えると差が逆転した（JIT の暖機。最初これを 1.3 倍の根拠にして間違えた）。
  // 答えは 1 件も変わらない（195 ファイルと 20 形の fixture すべてで突き合わせ済み・差 0 件）。
  // **`valueImports` / `dynamicImports` / `metaGlobs` は `node.getText(sf)` を呼ぶので
  // そちらは `true` のままでなければならない**（false にすると空文字が返って静かに黙る）。
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, false);
  const found: string[] = [];
  const walk = (node: ts.Node): void => {
    // import / export ... from（型だけ・副作用・再エクスポートを含む）
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    }
    // 動的 import("...")
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) found.push(arg.text);
    }
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

/**
 * **入口 1 本ずつについて、「その入口から `find` が当たるソースに辿り着くか」だけを答える（#514）。**
 *
 * `reachableFrom` と**答えの形が違う**のが要点。こちらは**モジュールの一覧を作らない**——
 * 入口ごとに `true` / `false`（＋辿った道）を返すだけ。
 *
 * なぜ 2 本目が要るか（#514 で実測した穴）:
 * 検査が `reachableFrom(entries)` の結果を**一覧として変数に受け**、
 * 件数・顔ぶれ・無罪判決をすべてその変数と突き合わせていると、
 * **その変数を 1 行絞るだけ**（`.filter((r) => !r.file.includes("assemblies"))`）で
 * **全部が痩せた基準に対して整合し、6/6 緑になる**（本物の違反を植えたまま。実測）。
 * 一覧を基準にしている限り、一覧を痩せさせる変異は基準ごと痩せる。
 *
 * そこで**一覧を経由しない経路**を用意する。返すのは入口の名前なので、
 * **モジュールのパスに対する述語（`assemblies` を除く等）が引っ掛かる場所が無い。**
 * 入口を絞るなら `entries` を絞ることになるが、それは
 * 「入口の顔ぶれ」と `package.json` の突き合わせが捕まえる（#490）。
 *
 * 探索は `reachableFrom` と**独立に書く**（深さ優先・訪問済み集合も別）。
 * 同じ実装を呼び直すと、実装を 1 箇所壊しただけで両方黙るため。
 */
export function entriesReaching(
  entries: string[],
  find: (source: string, file: string) => unknown[],
  readFile: (f: string) => string = (f) => readFileSync(f, "utf8"),
): { entry: string; hit: string; via: string[] }[] {
  const hits: { entry: string; hit: string; via: string[] }[] = [];
  for (const entry of entries) {
    const visited = new Set<string>([entry]);
    const stack: { file: string; via: string[] }[] = [{ file: entry, via: [entry] }];
    let found: { file: string; via: string[] } | null = null;
    while (stack.length > 0 && !found) {
      const current = stack.pop();
      if (!current) break;
      // 入口自身は `find` に掛けない（入口は tsx が直に走らせるので、この検査の対象は「その先」）
      if (current.file !== entry && find(readFile(current.file), current.file).length > 0) {
        found = current;
        break;
      }
      for (const { specifier } of valueImports(readFile(current.file), current.file)) {
        if (!specifier) continue;
        const resolved = resolveRelative(current.file, specifier);
        if (!resolved || visited.has(resolved)) continue;
        visited.add(resolved);
        stack.push({ file: resolved, via: [...current.via, resolved] });
      }
    }
    if (found) hits.push({ entry, hit: found.file, via: found.via });
  }
  return hits;
}

/**
 * **同じ内容を 2 度パースしない形で、ファイル群の指定子を集める（#1242）。**
 *
 * なぜ要るか: `no-path-alias.test.ts` は 2 つの `it` が**同じ 195 ファイルをそれぞれ走査する**。
 * 2026-10-07 に**2 人の実装者が独立に**、`apps/web` を 1 行も触っていない枝で
 * この 1 ファイルが共有の `testTimeout: 20000` を超えて落ちるのを踏んだ。
 *
 * **内訳**（vitest の worker 内、load average 28〜43）:
 *
 *     tsconfig の解析と走査                      54ms   ← 走査は問題ではない
 *     readFileSync x195（1.25MB）                22ms   ← **I/O は問題ではない**
 *     ts.createSourceFile x195（1 回目）      1,754ms   ← **ここが全部**
 *     ts.createSourceFile x195（2 回目）      1,148ms   ← **同じものをもう一度**
 *
 * **#538 の手（`Promise.all` での I/O 並列化）は効かない**——並列化できる I/O が 22ms しか無く、
 * 残りはパースの CPU 時間である。**#501 の「2 回読むのをやめる」が当たる形。**
 *
 * **なぜ `beforeAll` や module scope に上げないか**（#520 / #556）:
 * `testTimeout` は `tests` にだけ効き、`collect`（import 時）は管轄外。上に上げると
 * **速くなるのではなく、誰も見ていない予算に荷重が移るだけ**になる。
 * それに `no-path-alias.test.ts` の設計は「走査を `it` の中に置き、読んだ顔ぶれを
 * その場で tsconfig と突き合わせる」ことで変異（ループ内の `continue` で絞る形）を捕まえている。
 * **上に上げるとその結合が切れる。** だから `it` は従来どおり自分で全ファイルを走査しつつ、
 * **パースだけを共有する。**
 *
 * **キーは内容そのもの**（ファイル名や mtime ではない）。名前でキャッシュすると
 * **書き換えたのに古い答えを返す**——`~/` を足したのに緑、という最悪の形になる。
 * `scan-budget.test.ts` が「同じ名前で内容を変えたら新しい答えを返す」ことを固定している。
 *
 * `parsed` は**実際にパースした回数**。時間ではなく回数で見るのは、
 * 時間が負荷で 3 倍以上ぶれるため（負荷の高い日に誤って落ちる検査にしない）。
 */
type ScanSources = {
  (files: string[], readFile?: (f: string) => string): Map<string, string[]>;
  /** 実際に `ts.createSourceFile` を通った回数（memo が効いていれば 2 周目は増えない） */
  parsed: number;
};

const specifierMemo = new Map<string, string[]>();

export const scanSources: ScanSources = Object.assign(
  (files: string[], readFile: (f: string) => string = (f) => readFileSync(f, "utf8")): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const file of files) {
      const code = readFile(file);
      const cached = specifierMemo.get(code);
      if (cached) {
        out.set(file, cached);
        continue;
      }
      const specs = moduleSpecifiers(code, file);
      scanSources.parsed += 1;
      specifierMemo.set(code, specs);
      out.set(file, specs);
    }
    return out;
  },
  { parsed: 0 },
);
