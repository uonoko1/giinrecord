// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dynamicImports, entriesReaching, metaGlobs, reachableFrom, valueImports } from "./value-imports";

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

/**
 * 辿り着くモジュールの一覧。**これは「基準」ではなく「表示のための一覧」**（#514）。
 *
 * #507 まで、件数一致・顔ぶれ一致・無罪判決の引き直しが**すべてこの変数を基準**にしていた。
 * だから**この 1 行を絞るだけ**で、全部が痩せた基準に対して整合した:
 *
 *     const reached = reachableFrom(entries).filter((r) => !r.file.includes("assemblies"));
 *
 * → 本物の違反（`tsx sitemap.ts` が `glob is not a function` で落ちる状態）を植えたまま **6/6 緑**。
 * **一覧を基準にしている限り、一覧を痩せさせる変異は基準ごと痩せる。**
 *
 * そこで判定は `entriesReaching`（**一覧を作らない 2 本目の経路**）に持たせ、
 * この変数は「一覧が痩せていないか」を**逆に見張られる側**にした（`auditedOffenders` を参照）。
 *
 * さらに**一覧の作り方そのものを関数にして、対照でも同じ関数を通す。**
 * `const reached = reachableFrom(entries).filter(...)` と書くと、対照は素の
 * `reachableFrom` を呼ぶので絞りを素通りしてしまう。`reachedWith` を経由させれば、
 * ここに足した述語は**対照にも同じように効く**（＝対照が陰性になって落ちる）。
 */
const reachedWith = (readFile?: (f: string) => string): { file: string; via: string[] }[] => reachableFrom(entries, readFile);
const reached = reachedWith();
const rel = (file: string): string => path.relative(webRoot, file);
const trail = (via: string[]): string => via.map(rel).join(" → ");

/**
 * **陽性対照のソース。** 検査器が生きていることを、判定を下す `it` の中で毎回確かめるために使う。
 * 実ファイルではなく文字列にしてあるのは、実ファイルの中身が変わって
 * **対照が黙って陰性になる**（＝対照が対照でなくなる）のを避けるため。
 */
const GLOB_POSITIVE = 'const m = import.meta.glob("./x/*.json", { eager: true });';
const DYNAMIC_POSITIVE = 'const m = await import("./x.js");';

/**
 * **辿り着いた全モジュールに検査器を当て、「無罪だと言い切った件数」まで返す（#507）。**
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
 * **数え上げでは足りない**（この PBI で 2 通り試して 2 通りとも破れた。実測）:
 *
 * - 「読んだファイルを `scanned` に積んで `reached` と突き合わせる」
 *   → **判定の側にだけ** `!file.includes("assemblies") &&` を足せば `scanned` は一致したまま黙る（**6 / 6 緑**）
 * - 「1 件ごとの判定を表にして、表が `reached` を覆っているか見る」
 *   → **表の中身**（`findings`）を `assemblies` だけ `[]` にすれば、表は覆ったまま黙る（**glob 検査は素通り**）
 *
 * どちらも「何件通ったか」を数えていて、**「何件について無罪だと言い切ったか」を数えていない**。
 * 見逃しとは**無罪判決**であって、素通りではない。
 *
 * そこで**無罪判決を数える**。`cleared` は「検査器に掛けた結果、違反 0 件だった」ものだけが増える。
 * 呼び出し側は同じ `it` の中で **`cleared.length + offenders.length === reached.length`** を見る。
 * 絞り込みを**どこに足しても**（ループ・判定式・違反者リスト）、
 * その 1 件は無罪にも有罪にも数えられないので**必ず落ちる**。
 * **別の `it` に置かない**——`it` ごと消せば黙るから（#500 の N5 完全版で実測）。
 */
function judge(find: (source: string, file: string) => unknown[]): { offenders: string[]; cleared: string[] } {
  const offenders: string[] = [];
  const cleared: string[] = [];
  for (const r of reached) {
    const found = find(readFileSync(r.file, "utf8"), r.file);
    if (found.length > 0) offenders.push(`${rel(r.file)}（辿った道: ${trail(r.via)}）`);
    else cleared.push(rel(r.file)); // **無罪だと言い切った**。素通りはここに入らない
  }
  return { offenders, cleared };
}

/**
 * **判決を、検査と同じ `it` の中で監査して「本当の違反者」を返す（#507）。**
 *
 * `judge` の結果をそのまま信じない。**戻り値を素通しせず、ここで作り直す**:
 *
 * 1. **全件に判決が出たか**（有罪 + 無罪 = 対象数。顔ぶれまで突き合わせる）
 * 2. **無罪判決の監査** — 無罪と言われた 1 件ずつを**検査器に掛け直す**。
 *    判定式を狭める変異は、その 1 件を有罪から**無罪に移す**だけなので
 *    件数も顔ぶれも変わらない（実測で素通りした）。引き直して初めて現れる。
 * 3. **陽性対照** — 検査器が常に `[]` を返す変異だと、全件が無罪で緑になる（#451）
 *
 * **返す違反者リストは、この監査の結果から作る。** `judge` が挙げた有罪に、
 * 監査で見つかった「無罪と偽られた違反」を足す。
 * こうすると**監査を消すことが検出そのものを消すことになる**ので、
 * 「見張りだけ消して黙らせる」ができない（#500 の N5 完全版で学んだ形）。
 */
function auditedOffenders(
  { offenders, cleared }: { offenders: string[]; cleared: string[] },
  find: (source: string, file: string) => unknown[],
  positiveSource: string,
): string[] {
  expect(reached.length, "辿り着いたモジュールが 0 件（走査が空）").toBeGreaterThan(0);
  expect(
    cleared.length + offenders.length,
    "辿り着いたモジュールの一部に判決が出ていません（filter / continue / 早期 return で絞っていませんか）",
  ).toBe(reached.length);
  // 無罪と有罪の顔ぶれを合わせると reached そのものか（件数だけだと重複で辻褄が合う）
  expect([...cleared, ...offenders.map((o) => o.replace(/（辿った道: .*$/, ""))].sort(), "無罪と有罪を合わせても reached にならない").toEqual(
    reached.map((r) => rel(r.file)).sort(),
  );
  // 陽性対照: 呼び出し側が渡してきた検査器そのものを、確実に陽性になるソースに当てる
  expect(find(positiveSource, "positive-control.ts"), "検査器が既知の陽性ソースに何も見つけない（検査器が死んでいる）").not.toEqual([]);
  /*
   * **監査は `judge` の申告ではなく `reached` を起点に回す（#507 の要）。**
   *
   * `cleared` を監査すると、**ループごと飛ばされた 1 件は `cleared` にも入らない**ので
   * 監査の目にも入らない（実測: ループに `continue` を足し、上の 2 つの見張りも殺すと **6 / 6 緑**）。
   * そこで「有罪として挙がってこなかった `reached` の全件」——つまり
   * **`judge` が何と言おうと、無罪扱いになる全部**——を検査器に掛け直す。
   * 飛ばしても、無罪に移しても、違反者リストから外しても、**すべてここに現れる**。
   */
  const accused = new Set(offenders.map((o) => o.replace(/（辿った道: .*$/, "")));
  const wronglyCleared = reached
    .map((r) => rel(r.file))
    .filter((f) => !accused.has(f))
    .filter((f) => find(readFileSync(path.join(webRoot, f), "utf8"), path.join(webRoot, f)).length > 0);

  /*
   * **2 本目の経路（#514）。一覧を経由せず、入口から直に答えを出す。**
   *
   * `offenders` / `cleared` / `wronglyCleared` は**どれも `reached` を基準にしている**ので、
   * `reached` の定義を 1 行絞ると 3 つとも同時に痩せる（実測 6/6 緑）。
   * `entriesReaching` は**モジュールの一覧を作らない**——入口 1 本ごとに
   * 「`find` が当たるソースに辿り着いたか」だけを返す。返り値に載るのは**入口の名前**なので、
   * `assemblies` のようなモジュールパスの述語が引っ掛かる場所が無い。
   * 探索も `reachableFrom` とは別に書いてある（深さ優先・訪問済み集合も別）ので、
   * 走査の実装を 1 箇所壊しても両方は黙らない。
   *
   * **結果は見張りとして脇に置かず、返す違反者リストに合流させる**（#507 で学んだ形）。
   * この行を消すと検出そのものが減るので、「見張りだけ消す」ができない。
   */
  // **呼び出しは 1 回だけにする。** 2 回呼ぶと、片方だけ絞る変異が書けてしまう
  const byEntry = entriesReaching(entries, find);
  const viaEntries = byEntry.map(({ entry, hit, via }) => `${rel(hit)}（入口 ${path.basename(entry)} から辿った道: ${trail(via)}）`);

  /*
   * **一覧（`reached`）が 2 本目の経路より痩せていないか。**
   * `entriesReaching` が当てたファイルは、定義どおりなら `reached` にも入っているはず。
   * 入っていなければ `reached` が絞られている。
   * この見張りを消しても、上の `viaEntries` が違反者として残るので黙らない。
   */
  const hidden = byEntry.map(({ hit }) => rel(hit)).filter((f) => !reached.some((r) => rel(r.file) === f));
  expect(hidden, "入口から辿ると届くのに、`reached` の一覧に入っていないモジュール（`reached` が絞られています）").toEqual([]);

  /*
   * **経路まるごとの陽性対照（#514 の要）。**
   *
   * ここまでの見張りは 2 本とも「**モジュールのパス**」を答えに載せている。
   * だから **2 本とも同じ述語で絞れば**（`reached` に 1 行、`entriesReaching` の返り値に 1 行）
   * **合わせて 2 行・6/6 緑**で通ってしまう（実測）。
   * 「片方を基準に他方を見張る」形は、**両方を同じ向きに痩せさせる変異には無力**。
   *
   * そこで**答えを「見つかった件数」ではなく「見つけられるか」に変える。**
   * 実ファイルには手を触れず、`readFile` を差し替えて
   * **`data-files.ts` が glob 持ちを値で再エクスポートする世界**を合成し、
   * その世界で**この関数と同じ 2 本の経路が違反を挙げるか**を確かめる。
   *
   * 経路のどこか（`entries` / 走査 / 判定 / 返り値 / `reached`）に
   * **`assemblies` を除く述語を 1 つでも足すと、この対照が陰性になって落ちる。**
   * 絞る側は「本物の違反は隠したいが、対照は通したい」を同時に満たす必要があり、
   * それには**述語を対照だけ避けるように書く**しかない——それは 1 行では書けず、
   * レビューで目に見える改変になる。
   *
   * **対照は「隠したい当のファイル」を通す。** 合成する違反は、受け入れ条件そのものの 1 行——
   * `data-files.ts` に `export { isDietAssemblyId } from "./assemblies";` を足した世界で、
   * `assemblies.ts` が違反として挙がるか。`assemblies` を除く述語は
   * **本物の違反と対照を区別できない**ので、隠すと同時に対照も陰性にする。
   *
   * `find` は呼び出し側から渡ってきたものを使う（対照専用の検査器を持たない）。
   * `assemblies.ts` は実際に `import.meta.glob` を持つが、動的 import は持たないので、
   * **`positiveSource` を `assemblies.ts` の中身に混ぜて**、どちらの検査器でも陽性にする。
   */
  const controlHit = path.join(webRoot, "app/lib/assemblies.ts");
  const dataFiles = path.join(webRoot, "app/lib/data-files.ts");
  const contaminated = (f: string): string => {
    if (f === dataFiles) return `export { isDietAssemblyId } from "./assemblies";\n${readFileSync(f, "utf8")}`;
    if (f === controlHit) return `${positiveSource}\n${readFileSync(f, "utf8")}`;
    return readFileSync(f, "utf8");
  };
  expect(
    entriesReaching(entries, find, contaminated).map(({ hit }) => rel(hit)),
    "受け入れ条件の 1 行（`data-files.ts` → `assemblies.ts`）を合成した世界で、入口からの走査が違反を見つけられません。" +
      "`entries` / 走査 / 判定 / 返り値 のどこかが `assemblies` を避けるように絞られています",
  ).toContain(rel(controlHit));
  expect(
    reachedWith(contaminated).map((r) => rel(r.file)),
    "同じ世界で一覧の作り方（`reachedWith`）が `assemblies.ts` に辿り着きません（`reached` の作り方が絞られています）",
  ).toContain(rel(controlHit));

  return [...offenders, ...wronglyCleared.map((f) => `${f}（無罪扱いだが、検査器に掛け直すと違反が出る）`), ...viaEntries].sort();
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
    const offenders = auditedOffenders(judge(metaGlobs), metaGlobs, GLOB_POSITIVE);
    expect(
      offenders,
      "tsx で直に走るビルドスクリプトから `import.meta.glob` に辿り着きます。" +
        "`npx tsx apps/web/scripts/sitemap.ts` が `import.meta.glob is not a function` で落ちます。" +
        "値の import を切るか（型だけなら `import type` / `export type`）、glob を使う側に読み込みを移してください",
    ).toEqual([]);
  });

  it("辿り着くモジュールは動的 import も書かない（呼ばれたときに落ちる）", () => {
    const offenders = auditedOffenders(judge(dynamicImports), dynamicImports, DYNAMIC_POSITIVE);
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
     * 判決を監査してから使うので、判定を狭めれば `auditedOffenders` が落ちる。
     */
    const scan = judge(metaGlobs);
    const offenders = auditedOffenders(scan, metaGlobs, GLOB_POSITIVE);
    expect(
      [...offenders, ...scan.cleared.filter((f) => globOwners.includes(f))],
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
    // **素の `reachableFrom` ではなく `reachedWith` を通す**（#514）。
    // 素で呼ぶと `reached` の定義に足した絞りを素通りするので、この `it` は絞りに気づかない。
    const withBadLine = reachedWith(read).map((r) => rel(r.file));
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
