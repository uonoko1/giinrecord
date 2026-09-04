/**
 * 明朝 700 のサブセットを作り直す（Issue #477）。**手で実行する。ビルドでは動かない。**
 *
 *   pnpm --filter web build           # 先にビルドしておく（HTML から字を集めるため）
 *   pnpm --filter web font-subset     # 収録する字を数え直し、woff2 と fonts.css を書き換える
 *
 * `pnpm --filter web fonts`（#168）が Google から 122 面を取ってきた**あと**に走らせる。
 * 生成物（woff2・字の一覧・fonts.css）は**リポジトリにコミットする**ので、
 * **CI もリリースも外部サービスにも `pyftsubset` にも依存しない**（PO の判断1、#477）。
 *
 * ## 依存
 *
 * `pyftsubset`（fonttools）が要る。**手元にだけ**入れればよい:
 *
 *   python3 -m venv .venv && .venv/bin/pip install 'fonttools[woff]'
 *   PYFTSUBSET=.venv/bin/pyftsubset pnpm --filter web font-subset
 *
 * `text=` を使う道（Google Fonts の URL 引数）は**採らない**。#468 の実測で
 * **URL 引数が約 7.2 KB を超えると、エラーにならず 122 スライスの CSS が返る**（800 字は通り 810 字で戻る）。
 * 対象は既に 800 字を超えているので、`text=` は**回避策ありきの道具**になる。
 *
 * ## 収録する字をどう決めるか（ここが本体）
 *
 * **2 つの出どころの和集合**を取る。片方だけでは必ず漏れる:
 *
 * 1. **ビルド済みの全 HTML**（`build/client/**.html`）に CSS を当てて、明朝 700 が当たる要素のテキスト。
 *    静的な語（`.tag` の「事実」「推定」、`.section__title` の見出しなど）はここでしか取れない。
 *    #468 の調査は議員名の字だけで作って `/` `/coverage` `/assemblies` を
 *    **システムフォントに落とした**。人が「議員名のクラス」を数えると必ず漏れる。
 * 2. **`data/` の該当欄**（氏名・会派・選挙区・発言の役職・採決の会派名・地方議会の判）。
 *    `/members` は 200 件で折りたたまれ（#340）、議員ページのタブも折りたたまれるので、
 *    **HTML には全員ぶんが入っていない**（実測: `/members` の HTML には 229 名。全体は 1,057 名）。
 *    発言の役職（`.member-position`）は #242 により **HTML に一切焼き込まれない**。
 *
 * `pnpm --filter web test` の `font-subset-coverage.test.ts` が、コミット済みの字の一覧が
 * **`data/` の 2 を全部覆っている**ことを検査する（新しい議員で字が増えたら落ちる）。
 * 1 は HTML が要るので、そちらは `smoke` ではなくこのスクリプトの再実行で見る。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { dataHeadChars } from "../app/lib/head-font-data-chars";
import { readHeadFontDataSource } from "../app/lib/head-font-data-source";
import { headFontChars } from "../app/lib/head-font-chars";
import { formatSubsetChars, SUBSET_CHARS_FILE, SUBSET_FAMILY, SUBSET_FILE, SUBSET_WEIGHT, subsetFace } from "../app/lib/font-subset";
import { defaultDataDir } from "../app/lib/data-files";
import { parseFontsCss, renderFontsCss } from "../app/lib/self-hosted-fonts";

const fontsDir = process.env.FONTS_DIR ?? path.resolve(process.cwd(), "public/fonts");
const buildDir = process.env.BUILD_DIR ?? path.resolve(process.cwd(), "build/client");
const dataDir = defaultDataDir();
const pyftsubset = process.env.PYFTSUBSET ?? "pyftsubset";
/** 字形・ヒンティング・メトリクスを Google が配るスライスと同じにするため、上流の TTF から作る。 */
const SOURCE_TTF_URL = "https://raw.githubusercontent.com/google/fonts/main/ofl/shipporimincho/ShipporiMincho-Bold.ttf";

/** ビルド済みの全 HTML に CSS を当てて、明朝 700 が描く字を集める。 */
async function readBuiltHtmlChars(): Promise<Set<string>> {
  const assets = path.join(buildDir, "assets");
  const cssNames = (await readdir(assets).catch(() => [] as string[])).filter((f) => f.endsWith(".css"));
  if (cssNames.length === 0) throw new Error(`font-subset: no CSS in ${assets} — run \`pnpm --filter web build\` first`);
  const css = (await Promise.all(cssNames.map((f) => readFile(path.join(assets, f), "utf8")))).join("\n");

  const pages: string[] = [];
  for (const e of await readdir(buildDir, { recursive: true, withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".html")) pages.push(path.join(e.parentPath, e.name));
  }
  if (pages.length === 0) throw new Error(`font-subset: no HTML in ${buildDir} — run \`pnpm --filter web build\` first`);

  const out = new Set<string>();
  let n = 0;
  for (const p of pages) {
    for (const ch of headFontChars(new JSDOM(await readFile(p, "utf8")).window.document, css, SUBSET_WEIGHT)) out.add(ch);
    if (++n % 200 === 0) console.log(`font-subset: ${n}/${pages.length} pages -> ${out.size} chars`);
  }
  console.log(`font-subset: ${pages.length} built pages -> ${out.size} chars`);
  return out;
}

const md5 = (buf: Buffer | string) => createHash("md5").update(buf).digest("hex");

// ---- 1. 収録する字を決める --------------------------------------------------
const fromHtml = await readBuiltHtmlChars();
const fromData = dataHeadChars(readHeadFontDataSource(dataDir));
const chars = new Set([...fromHtml, ...fromData]);
const onlyInData = [...fromData].filter((c) => !fromHtml.has(c));
console.log(`font-subset: HTML ${fromHtml.size} + data ${fromData.size} -> ${chars.size} chars (${onlyInData.length} only in data/, e.g. ${onlyInData.slice(0, 12).join("")})`);
if (chars.size === 0) throw new Error("font-subset: collected 0 characters — refusing to write an empty subset");

// ---- 2. 上流の TTF から woff2 を作る ----------------------------------------
const tmp = await mkdtemp(path.join(tmpdir(), "font-subset-"));
try {
  const ttf = path.join(tmp, "source.ttf");
  const res = await fetch(SOURCE_TTF_URL);
  if (!res.ok) throw new Error(`font-subset: ${SOURCE_TTF_URL} -> ${res.status}`);
  const ttfBuf = Buffer.from(await res.arrayBuffer());
  await writeFile(ttf, ttfBuf);
  console.log(`font-subset: source ${SOURCE_TTF_URL.split("/").pop()} ${(ttfBuf.length / 1024 / 1024).toFixed(2)} MB md5=${md5(ttfBuf)}`);

  const out = path.join(fontsDir, SUBSET_FILE);
  const unicodes = [...chars].map((c) => `U+${c.codePointAt(0)!.toString(16)}`).join(",");
  const args = [
    ttf,
    `--output-file=${out}`,
    "--flavor=woff2",
    `--unicodes=${unicodes}`,
    // Google のスライスと同じ扱いにする: レイアウト機能は縦組み・異体字を残し、名前表は最小限
    "--layout-features=*",
    "--no-hinting=false",
    "--desubroutinize",
    "--name-IDs=*",
    "--notdef-outline",
    "--drop-tables+=DSIG",
  ];
  const run = spawnSync(pyftsubset, args, { encoding: "utf8" });
  if (run.error) throw new Error(`font-subset: cannot run ${pyftsubset} (${run.error.message}). Install fonttools: python3 -m venv .venv && .venv/bin/pip install 'fonttools[woff]', then PYFTSUBSET=.venv/bin/pyftsubset`);
  if (run.status !== 0) throw new Error(`font-subset: ${pyftsubset} exited ${run.status}\n${run.stderr}`);
  const woff2 = await readFile(out);
  console.log(`font-subset: ${SUBSET_FILE} ${(woff2.length / 1024).toFixed(1)} KB (${chars.size} chars) md5=${md5(woff2)}`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

// ---- 3. 収録した字の一覧をコミットする -------------------------------------
await writeFile(path.join(fontsDir, SUBSET_CHARS_FILE), formatSubsetChars(chars));

// ---- 4. fonts.css の明朝700 122 面を、この 1 面に差し替える ------------------
const cssPath = path.join(fontsDir, "fonts.css");
const faces = parseFontsCss(await readFile(cssPath, "utf8"));
const kept = faces.filter((f) => !(f.family === SUBSET_FAMILY && f.weight === SUBSET_WEIGHT));
const dropped = faces.length - kept.length;
await writeFile(cssPath, renderFontsCss([...kept, subsetFace(chars)]));
console.log(`font-subset: fonts.css ${faces.length} -> ${kept.length + 1} faces (dropped ${dropped} ${SUBSET_FAMILY} ${SUBSET_WEIGHT} slices)`);

// ---- 5. 差し替えで用済みになった woff2 を消す --------------------------------
let removed = 0;
for (const name of await readdir(fontsDir)) {
  if (/^shippori-mincho-700\.(?!subset\.woff2$).*\.woff2$/.test(name)) {
    await rm(path.join(fontsDir, name));
    removed++;
  }
}
console.log(`font-subset: removed ${removed} superseded shippori-mincho-700 slices`);
