import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Issue #533: テストは4つの glob で走っている。deploy/test/*.test.sh は #513/#526 が別レイヤ
// （このファイルと同じ deploy-test-inventory.test.ts）から数えたが、残り3つは誰も数えていなかった。
//
//   apps/web の vitest（vitest.config.ts の include: ["app/**/*.test.{ts,tsx}"]） — 実測 85 本
//   packages/etl/test/*.test.ts（etl 自身の package.json の test スクリプト）    — 実測 83 本（このファイルを置く前）
//   scripts/ci/test/*.test.sh（ci.yml のインラインな for ループ）              — 実測 6 本
//
// 実測（このテストを入れる前、origin/main で再現）:
//   apps/web/app/lib/font-subset-coverage.test.ts を削除
//     → pnpm --filter web test: 85 files → 84 files、84 passed（無言で緑）
//   packages/etl/test/dataset.test.ts を削除
//     → pnpm --filter etl test: 946 pass 相当 → 減った分だけ減って 0 fail（無言で緑）
//   scripts/ci/test/audit.test.sh を削除
//     → ci.yml の `for t in scripts/ci/test/*.test.sh ...` は ran 6→5 / loop exit 0（無言で緑）
//
// **なぜ etl の中に置けるか**（deploy-test-inventory.test.ts と同じ理由）:
//   apps/web のテストは vitest、scripts/ci/test は bash＋ci.yml のループで、
//   どちらも「このファイルが置かれている node:test（etl）」とは別ランナー・別プロセス。
//   apps/web 側や scripts/ci/test 側からこのファイルごと消しても、etl のテストは影響を受けない。
//
// **なぜ「本数を数える」だけでは足りないか**（#504 と同型）:
//   本数だけの下限は、消したぶん空ファイルを1本足せば通る。だから
//   (a) ファイル名の集合を git 管理下の一覧（`git ls-files`）と突き合わせ、
//   (b) その集合の大きさにハードコードした絶対下限を置く（#499/#564: 対象から計算しない）。
//
// **`git ls-files` の pathspec に `**` を使わない**（このテストを書く途中で実測した罠）:
//   `apps/web/app/**/*.test.ts` は `apps/web/app/root.test.tsx` のような
//   **1階層目**のファイルを 2本 取りこぼす（このリポジトリの git のバージョンで実測、
//   `**` は0階層にマッチしない）。単一の `*` を複数パターンで列挙するか、
//   ここでやっているように readdirSync で自前に再帰する。
//
// **このファイル自身の削除は、このファイルでは守れない**（#513 の deploy-test-inventory.test.ts と
// 同じ限界。#544/#564 の docblock にも同型の記述がある）。
//   `packages/etl/package.json` の test も glob（`node --test --import tsx test/*.test.ts`）なので、
//   このファイルごと消せば etl のテストから「自分がいなくなったこと」を言う主体が消える。
//   実測: このファイルを削除 → `pnpm --filter etl test` は無言で減る（このファイル自身の3テストぶん）。
//   レイヤをこれ以上 etl の内側では上げられない。止めるのは ci.yml 側——
//   下の「#533: pnpm test の実行後、テスト総数が下限を割らない」で、
//   ci.yml の `check` ジョブに件数の絶対下限チェックを1行足してある（このファイルより外側）。

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

/** 指定ディレクトリ配下を再帰的に歩き、pred に合うファイルの相対パスを返す（node_modules は除く）。 */
function walk(rel: string, pred: (name: string) => boolean): string[] {
  const out: string[] = [];
  const rec = (r: string) => {
    for (const e of readdirSync(resolve(root, r), { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = `${r}/${e.name}`;
      if (e.isDirectory()) rec(p);
      else if (pred(e.name)) out.push(p);
    }
  };
  rec(rel);
  return out.sort();
}

/** apps/web/app 配下の vitest 対象（vitest.config.ts の include と同じ拡張子）。 */
const webTestFiles = (): string[] =>
  walk("apps/web/app", (n) => n.endsWith(".test.ts") || n.endsWith(".test.tsx"));

/** packages/etl/test 直下の *.test.ts（package.json の test スクリプトの glob と同じ）。 */
const etlTestFiles = (): string[] =>
  readdirSync(resolve(root, "packages/etl/test"))
    .filter((n) => n.endsWith(".test.ts"))
    .map((n) => `packages/etl/test/${n}`)
    .sort();

/** scripts/ci/test 直下の *.test.sh（ci.yml のループの glob と同じ）。 */
const ciTestFiles = (): string[] =>
  readdirSync(resolve(root, "scripts/ci/test"))
    .filter((n) => n.endsWith(".test.sh"))
    .map((n) => `scripts/ci/test/${n}`)
    .sort();

// **ハードコードした絶対下限**（#499/#564: 対象から計算しない。実測値を書く）。
// 増やす分には自動で通る。減らすときは、なぜ減らしてよいかをここに書いてから数字を書き換える。
//
// ## 下限は実数から離れたぶんだけ守っていない（#720、2026-09-13）
//
// **#593 で置いてから一度も更新しておらず、ETL は実数 100 に対して下限 84 だった**
// （**16 本消しても落ちない**）。#711 の担当者が `guards.md` の `MIN_ROWS` で
// 同じことに気づいて実数に合わせたのが起点。
//
// **「実数ちょうど」にはしない。** ETL は 13 日で 80 → 100 本に増えており
// （2026-09-01 に 80、09-07 に 85、09-09 に 98、09-13 に 100。**一度も減っていない**）、
// ちょうどにするとテストを 2 本に分けただけで落ちる。**それは邪魔な検査である。**
//
// **代わりに「実数 − 3」を置く**（CI は母数が小さいので実数 − 1）。
// **3 本は「1 本を 2 本に分ける」「2 本を 1 本に統合する」を数回やっても当たらない幅**であり、
// **16 本のような「気づかずに消せる幅」ではない。**
// **この 3 という数字に根拠はない**——**測れるのは「今どれだけ離れているか」だけで、
// 「どれだけ離れていてよいか」は測れない。** だから**小さく取る**。
//
// **更新のしかた**: **floor を更新する PR を別に立てない。**
// **テストを増やした PR が、そのついでにここを上げる**——
// **「後でまとめて上げる」にすると #593 から 6 日で 16 本ぶん離れたのと同じことが起きる。**
//
// **下げる方向には使わない。** WEB は実数 87 なので「実数 − 3 = 84」は今の 85 より低い。
// **その場合は今の値を据え置く**（この規則は「離れすぎを詰める」ためのもので、
// **緩める口実にしてはいけない**）。
const WEB_TEST_FILES_MIN = 85; // 実測 2026-09-13: walk() で 87。**下げないので 85 のまま**（実数 − 3 = 84 は今より低い）
const ETL_TEST_FILES_MIN = 156; // 実測 2026-09-20: readdirSync で 159（− 3。#720 の規則）。#928 が 156 → 157、**#901 が local-sessions-default.test.ts と local-cli-sessions.test.ts を足して 157 → 159**。**139 のままだと 18 本消しても落ちなかった**（#720 が詰めた「実数から離れたぶんだけ守っていない」がまた開いていた）
const CI_TEST_FILES_MIN = 6; // 実測 2026-09-13: readdirSync で 7（− 1。母数が小さいので幅も小さく）

test("#533: apps/web のテストファイル集合が下限を割らない（vitest の include glob を消しても足しても検出する）", () => {
  const files = webTestFiles();
  assert.ok(
    files.length >= WEB_TEST_FILES_MIN,
    `apps/web/app 配下の *.test.ts(x) が ${files.length} 本しか無い（下限 ${WEB_TEST_FILES_MIN}）。
vitest.config.ts の include（"app/**/*.test.{ts,tsx}"）が拾うファイルが減っていないか確認すること。
まず疑うのは対象のほう——ファイルが消えた／リネームされた／拡張子が変わった、のいずれか。
本当に減らしてよいなら、理由をこのファイルに書いてから WEB_TEST_FILES_MIN を書き換えること。`,
  );
});

test("#533: packages/etl のテストファイル集合が下限を割らない（package.json の test glob を消しても足しても検出する）", () => {
  const files = etlTestFiles();
  assert.ok(
    files.length >= ETL_TEST_FILES_MIN,
    `packages/etl/test/*.test.ts が ${files.length} 本しか無い（下限 ${ETL_TEST_FILES_MIN}）。
packages/etl/package.json の test スクリプト（node --test --import tsx test/*.test.ts）が
拾うファイルが減っていないか確認すること。
本当に減らしてよいなら、理由をこのファイルに書いてから ETL_TEST_FILES_MIN を書き換えること。`,
  );
});

test("#533: scripts/ci/test のテストファイル集合が下限を割らない（ci.yml のループの glob を消しても足しても検出する）", () => {
  const files = ciTestFiles();
  assert.ok(
    files.length >= CI_TEST_FILES_MIN,
    `scripts/ci/test/*.test.sh が ${files.length} 本しか無い（下限 ${CI_TEST_FILES_MIN}）。
.github/workflows/ci.yml の \`for t in scripts/ci/test/*.test.sh ...\` が
拾うファイルが減っていないか確認すること。
本当に減らしてよいなら、理由をこのファイルに書いてから CI_TEST_FILES_MIN を書き換えること。`,
  );
});

test("#533: ci.yml は scripts/ci/test/*.test.sh を今も走らせている（走らせるのをやめても落ちる）", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.ok(
    ci.includes("scripts/ci/test/*.test.sh"),
    "ci.yml が scripts/ci/test/*.test.sh を走らせていない。下限を守っても、走らなければ意味がない。",
  );
});

test("#533: package.json は apps/web を pnpm -r test の対象に含めている（pnpm test が web を走らせなくなっても落ちる）", () => {
  const root_ = read("package.json");
  assert.ok(
    root_.includes('"test": "pnpm -r test"'),
    "ルートの package.json の test スクリプトが変わっている（pnpm -r test でなくなると、" +
      "apps/web や packages/etl の test が pnpm test から呼ばれなくなる可能性がある）。",
  );
  const web = read("apps/web/package.json");
  assert.ok(
    web.includes('"test": "vitest run"'),
    "apps/web/package.json の test スクリプトが vitest run でなくなっている。",
  );
  const etl = read("packages/etl/package.json");
  assert.ok(
    etl.includes("node --test --import tsx test/*.test.ts"),
    "packages/etl/package.json の test スクリプトの glob が変わっている。" +
      "変えたなら webTestFiles / etlTestFiles の数え方も合わせて直すこと。",
  );
});

// **実測した穴**（このテストを書く途中で見つけた。webTestFiles() だけでは塞げない）:
//   webTestFiles() は apps/web/app 配下を readdirSync で自前に再帰するので、
//   `vitest.config.ts` の include を絞っても（例 `"app/**/[a-c]*.test.{ts,tsx}"`）、
//   ディスク上のファイルは変わらないため webTestFiles().length は 85 のまま下限を割らない。
//   実測: include を上のとおり書き換えた状態でこのファイルを走らせても 5 pass / 0 fail（緑）。
//   だから vitest が**実際に読む include の文字列そのもの**を別に固定する。
test("#533: vitest.config.ts の include が app 配下の *.test.ts(x) を今も拾う形のまま（絞っても落ちる）", () => {
  const cfg = read("apps/web/vitest.config.ts");
  assert.ok(
    cfg.includes('include: ["app/**/*.test.{ts,tsx}"]'),
    `vitest.config.ts の include が変わっている（いま: ${
      cfg.match(/include:\s*\[[^\]]*\]/)?.[0] ?? "見つからない"
    }）。
webTestFiles() はディスク上のファイルを直接数えるので、include を絞ってファイルを実行しなくしても
その数は減らない（実測: include を "app/**/[a-c]*.test.{ts,tsx}" に絞っても 5 pass / 0 fail）。
本当に include の形を変えるなら、この逐語文字列も書き換えること。`,
  );
});

/**
 * Issue #720: **下限は 2 か所にある。片方だけ直すともう片方が古いまま残る。**
 *
 * `.github/workflows/ci.yml` の「Test file count floor」ステップが、同じ 2 つの下限を
 * シェルの中にハードコードしている。**1 か所にまとめてはいけない**——
 * **役目が違う**（ci.yml のコメントが理由を書いている）:
 *
 *   このファイル自身が etl の glob に含まれるので、**消すと「減った」と言う者がいなくなる。**
 *   **ci.yml はテストファイルではないので、テストを消しても残る層である。**
 *
 * **だから 2 か所あるのは正しい。ずれるのが問題である。**
 * ここでは **ci.yml を読んで、この定数と同じ値であることだけを見る。**
 *
 * **実際にずれていた**（#720 の実測、2026-09-13）: 両方 84 のまま、実数は 100 だった。
 */
test("#720 ci.yml の下限が、このファイルの定数とずれていない（片方だけ直すのを防ぐ）", () => {
  const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
  // `[ "$web" -ge 85 ]` / `[ "$etl" -ge 99 ]` の数字を取る
  const pick = (name: string): number | null => {
    const m = new RegExp(`\\[ "\\$${name}" -ge (\\d+) \\]`).exec(ci);
    return m ? Number(m[1]) : null;
  };
  assert.deepEqual(
    { web: pick("web"), etl: pick("etl") },
    { web: WEB_TEST_FILES_MIN, etl: ETL_TEST_FILES_MIN },
    `.github/workflows/ci.yml の下限が test-file-inventory.test.ts の定数とずれている。
**2 か所あるのは正しい**（ci.yml はテストファイルではないので、テストを消しても残る層）。
**両方を同じ値に直すこと。** 片方だけ直すと、もう片方が古い下限で通してしまう。`,
  );
  // 表示用の echo も同じ値であること（ログだけ古い数字を出すのを防ぐ）
  assert.match(ci, new RegExp(`apps/web test files: \\$web \\(floor ${WEB_TEST_FILES_MIN}\\)`),
    "ci.yml の echo が古い下限を表示している");
  assert.match(ci, new RegExp(`packages/etl test files: \\$etl \\(floor ${ETL_TEST_FILES_MIN}\\)`),
    "ci.yml の echo が古い下限を表示している");
});

/**
 * Issue #855: **本数の下限は、特定のファイルを名指しできない。**
 *
 * `published-data-validate.test.ts`（**コミット済み `data/` に不変条件を当てる唯一のもの**）を消しても、
 * **別のテストファイルが 1 本でも増えていれば ETL_TEST_FILES_MIN は満たされる。**
 * **実測: このファイルを消すと etl は 1,581 → 1,578 テストで 0 fail（無言で緑）。**
 *
 * **だから ci.yml 側に `test -f` を置いた**（`test -f scripts/ci/stale-base.sh` と同じ #504 の形）。
 * **そして「ci.yml がそれを今も要求していること」を、ci.yml ではないファイルから固定する**
 * ——`scripts/ci/test/stale-base.test.sh` の `t_net_deletions_is_wired_into_ci` と同じ形である
 * （**そこの実測: ci.yml から `--net-deletions` の行を消しても 1,542 の etl テストが全部緑だった**）。
 *
 * **名前が在ることだけを見ない**（`pr-closes` のテストが記録している罠——
 * `test -f` の行がファイル名を生かし続けるので、名前の存在は検査にならない）。
 * **本番 `data/` に実際に当てている行**を見る。
 */
test("#855 ci.yml が「本番 data/ に不変条件を当てるテスト」の存在を要求している（消しても無言で緑にならない）", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.ok(
    ci.includes("test -f packages/etl/test/published-data-validate.test.ts"),
    "ci.yml が published-data-validate.test.ts の存在を要求していない（#855／#504）",
  );
  // **消されたら ENOENT ではなく理由を出す**（読めない理由が「無い」なのか「壊れた」なのかを分ける）
  let body: string;
  try { body = read("packages/etl/test/published-data-validate.test.ts"); } catch {
    assert.fail(`packages/etl/test/published-data-validate.test.ts が無い（#855）。
**本数の下限では止まらない**（実測 2026-09-14: 消しても 134 → 133 本で、下限 131 を上回るので通る）。
コミット済み data/ に不変条件を当てる唯一のものなので、消すなら理由をここに書くこと。`);
  }
  // **本番の data/ を指していること。** 一時ディレクトリに当てても、コミット済みの data/ は見ていない。
  assert.ok(
    body.includes('fileURLToPath(new URL("../../../data/", import.meta.url))'),
    "published-data-validate.test.ts がコミット済み data/ を読んでいない（#855）",
  );
  // validateDataset は validateLocalAssemblies を内側で呼ぶ厳密な上位集合（理由はテスト本体の docblock）
  assert.ok(body.includes("validateDataset(DATA)"), "validateDataset を本番 data/ に当てていない（#855）");
});

/**
 * Issue #865: **`skip: !hasData` は、`data/` が消えたら黙って全部を緑にする経路である。**
 *
 * ## 何が問題か
 *
 * **7 本の `*-published-data.test.ts` は、先頭に同じ形の門番を置いている:**
 *
 * ```ts
 * const hasData = (() => { try { return statSync(join(DIR, "meta.json")).isFile(); } catch { return false; } })();
 * test("...", { skip: !hasData }, () => { ... });
 * ```
 *
 * **`meta.json` が 1 つ消えると、その県の検査（6〜9 本）が全部 `skipped` になり、`fail 0` で通る。**
 * **`node --test` は skip を赤にしない。** **本数の下限（このファイルの上の 3 本）も止められない**——
 * **ファイルは在るし、テストも「走っている」ことになっているから。**
 *
 * **PO は「今は効いていない」ことを実測している**（佐賀 `tests 6 / pass 6 / skipped 0`）。
 * **だが「今は skip されていない」は「今後も skip されない」ではない。**
 *
 * ## **なぜ「skip された本数を数える」形にしないか**（先に検討して捨てた案）
 *
 * **テストの中から、そのテスト自身の実行結果（skipped の本数）は見えない。**
 * 見るには `node --test` の reporter か、`pnpm test` の出力を親プロセスから読む層が要る。
 * **それは「テストを走らせるためにテストを走らせる」形**で、
 * **#542 が禁じている「自前のハーネス」に近づく。**
 *
 * **代わりに、門番の前提そのものを別の層から要求する**——
 * **「`*-published-data.test.ts` が在る県には、`data/assemblies/<id>/meta.json` が必ず在る」。**
 * **これが成り立つ限り `hasData` は常に真で、`skip` は一度も発火しない。**
 * **つまり「skip された本数が 0」と同値である**（`skip: !hasData` **以外**の skip が
 * 混ざらないことも下で見る）。
 *
 * ## **このファイルに置く理由**
 *
 * **このファイルは `skip` を 1 つも使っていない**（使ったら同じ穴が開く。下でそれも見る）。
 * **既存の形がこれだから**でもある——`deploy-test-inventory.test.ts` / 上の 3 本と同じ層。
 *
 * **限界**（上の docblock と同型）: **このファイルごと消せば、この検査も消える。**
 * **止めるのは ci.yml 側の「Test file count floor」と、#855 が足した存在の要求である。**
 */

/** `packages/etl/test/*-published-data.test.ts` の一覧（県ごとの検査。glob と同じ数え方）。 */
const publishedDataTestFiles = (): string[] =>
  readdirSync(resolve(root, "packages/etl/test"))
    .filter((n) => n.endsWith("-published-data.test.ts"))
    .sort();

/**
 * **その検査が見ている議会 id** を、ファイルの中の `join(DATA, "assemblies", "pref-NN")` から取る。
 * **id をこのファイルに書き写さない**（#499/#564 と逆に見えるが、ここで固定したいのは
 * **「テストと `data/` の対応」であって id の一覧ではない**。id を写すと、
 * 県を足すたびに 2 か所を直すことになり、**片方が古いまま残る**——#720 で実際に起きた形）。
 */
const assemblyIdOf = (file: string): string | null => {
  const src = read(`packages/etl/test/${file}`);
  return /"assemblies",\s*"(pref-\d+)"/.exec(src)?.[1] ?? null;
};

test("#865 `skip: !hasData` が発火しない（県ごとの検査が在る県には meta.json が在る）", () => {
  const files = publishedDataTestFiles();
  // **母数**（#757）。**0 本を見て緑になったら、この検査は何も言っていない**
  assert.ok(files.length >= 7, `県ごとの検査が ${files.length} 本しか無い（実測 2026-09-14: 7 本）`);
  const checked: string[] = [];
  const missing: string[] = [];
  for (const f of files) {
    const id = assemblyIdOf(f);
    assert.ok(id !== null, `${f}: 議会 id（join(DATA, "assemblies", "pref-NN")）が読めない。
**書き方を変えたなら、この検査の取り出し方も合わせて直すこと。**
**読めないまま放っておくと、その県は一度も突き合わされない。**`);
    const meta = resolve(root, `data/assemblies/${id}/meta.json`);
    // **`catch` で握りつぶさない。** **この検査を書いている途中で実際に踏んだ**——
    // `statSync` を import し忘れていて `ReferenceError` が出ていたのに、
    // **`catch {}` がそれを「meta.json が無い」に化けさせ、7 県すべてが「無い」と出た。**
    // **原因が違えば直すところも違う**（#680）。**ENOENT 以外はそのまま投げる。**
    try {
      if (!statSync(meta).isFile()) missing.push(`${f} → data/assemblies/${id}/meta.json がファイルでない`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      missing.push(`${f} → data/assemblies/${id}/meta.json が無い`);
    }
    checked.push(`${f}:${id}`);
  }
  assert.equal(checked.length, files.length, "**すべての県ごとの検査を突き合わせた**（母数）");
  assert.deepEqual(missing, [], `**\`skip: !hasData\` が発火する県がある。**
その県の検査（6〜9 本）は **\`skipped\` になって、\`fail 0\` で黙って通る。**
**\`data/\` が消えたのか、検査が要らなくなったのかを確かめること。**
**要らなくなったなら、テストファイルごと消す**（\`skip\` で残すと「在るのに見ていない」状態になる）。
突き合わせた: ${checked.join(" / ")}`);
});

/**
 * **門番が `skip: !hasData` の形のままであること。**
 *
 * **上の検査は「`meta.json` が在る」しか見ていない。**
 * **別の条件で skip するようになったら（例: `{ skip: process.env.CI !== undefined }`）、
 * 上の検査は緑のまま、テストは一度も走らなくなる**——**#504 と同型の抜け道。**
 *
 * **だから「その 7 本に出てくる `skip:` は、`!hasData` 以外に無い」ことを逐語で見る。**
 * **`skip: true` / `todo` / `t.skip()` も同じ経路なので拾う。**
 */
test("#865 県ごとの検査の skip は `!hasData` だけ（別の条件で黙って止まらない）", () => {
  const files = publishedDataTestFiles();
  assert.ok(files.length >= 7, `県ごとの検査が ${files.length} 本しか無い`);
  const offenders: string[] = [];
  let skipCount = 0;
  for (const f of files) {
    const src = read(`packages/etl/test/${f}`);
    for (const m of src.matchAll(/skip:\s*([^,}]+)/g)) {
      skipCount++;
      if (m[1].trim() !== "!hasData") offenders.push(`${f}: skip: ${m[1].trim()}`);
    }
    // `t.skip()` / `test.skip(` / `{ todo` も同じ「黙って通る」経路
    for (const pat of [/\.skip\(/g, /todo:\s*true/g, /test\.todo\(/g]) {
      for (const _ of src.matchAll(pat)) offenders.push(`${f}: ${pat.source}`);
    }
  }
  // **母数**: **7 本あわせて 51 個の `skip:` を読んだ**（実測 2026-09-14）。
  // **0 個を読んで緑になったら、この検査は何も言っていない**（正規表現が空振りしても気づけるように）
  assert.ok(skipCount >= 40, `\`skip:\` を ${skipCount} 個しか読んでいない（実測 2026-09-14: 51 個）。
**正規表現が空振りしていないか、テストの書き方が変わっていないかを先に疑うこと**（#514）。`);
  assert.deepEqual(offenders, [], "**`!hasData` 以外の skip / todo が県ごとの検査に入っている**");
});

/**
 * **このファイル自身が `skip` を使っていないこと。**
 *
 * **上の 2 本は「県ごとの検査が skip で黙らないこと」を言っているが、
 * この検査自身が skip されたら、それも黙る。**
 * **入れ子の一番外側は、自分で自分を見るしかない**（それより外は ci.yml。上の docblock と同じ限界）。
 */
test("#865 このファイル自身は skip / todo を使っていない（門番が門番を黙らせない）", () => {
  const self = read("packages/etl/test/test-file-inventory.test.ts");
  // **自分のソースを読めていること**（読めなければ下の検査は空振りする）
  assert.ok(self.includes("#865 このファイル自身は skip"), "自分のソースを読めていない");
  // **docblock の中の例（`test("...", { skip: !hasData }, ...)`）を数えないように、
  // 行頭から始まる `test(` だけを見る**（docblock の行は必ず ` * ` で始まる）。
  // **これは「行頭の `test(`」という弱い近似である**——
  // **`  test(` のように字下げして書けばすり抜ける。** このファイルは今そう書いていない。
  const lines = self.split("\n");
  const testCalls = lines.filter((l) => /^test\(/.test(l));
  // **母数**: **このファイルの `test(` は 11 本**（実測 2026-09-16。#855 の配線検査が main で 1 本増えた）。**0 本を読んだら空振り**
  assert.ok(testCalls.length >= 11, `行頭の \`test(\` が ${testCalls.length} 本しか無い（実測 2026-09-16: 11 本）。
**字下げして書くようになったなら、この数え方も直すこと**（#514: 空振りに気づけるように）。`);
  // **options オブジェクト（`{ skip: ... }` を置ける位置）を取っている `test(` が 0 本**
  const withOptions = testCalls.filter((l) => /^test\(\s*"[^"]*",\s*\{/.test(l));
  assert.deepEqual(withOptions, [],
    `**このファイルの \`test(...)\` が options（\`{ skip: ... }\` を置ける位置）を取っている。**
**県ごとの検査を見張る側が skip できるようになったら、この階層はもう何も言っていない。**`);
});
