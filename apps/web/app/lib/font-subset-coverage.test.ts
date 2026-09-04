/**
 * **コミット済みのサブセットが、いまの `data/` を覆っているか**（#477）。
 *
 * PO の判断1により、サブセットは**リポジトリにコミットする**（ビルド時に Google から取らない）。
 * その代わり「議員が入れ替わって字が増えたとき、**サブセットが古くなる**」ことが起こる。
 *
 * **それ自体は許容されている。** #468 の実測どおり、サブセットに無い字は
 * **表示されなくなるのではなく、書体がシステムの明朝に落ちるだけ**である
 * （`getPlatformFontsForNode` で確認済み。箱の幅も変わらない）。
 * 「記録が出ない」ではないので、このプロジェクトの原則には抵触しない。
 *
 * **許容されていないのは「気づけないこと」。** 転送量も箱も変わらないので、
 * **この検査が無ければ誰も気づかない。** だからここで落とす。
 *
 * 落ちたときにやること:
 *
 *     pnpm --filter web build
 *     PYFTSUBSET=.venv/bin/pyftsubset pnpm --filter web font-subset
 *
 * （手順は `docs/ops/fonts.md`。`pyftsubset` は手元にだけ入れればよい。CI では走らない）
 *
 * **この検査が見るのは `data/` 側だけ**である。静的な語（`.tag` の「事実」など）が増える経路は
 * HTML が要るので見ていない。そちらは `head-font-chars.test.ts` が関数を、
 * `scripts/font-subset.ts` の再実行が実物を守る。**強い主張をしない**ためにここに書いておく。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultDataDir } from "./data-files";
import { dataHeadChars } from "./head-font-data-chars";
import { readHeadFontDataSource } from "./head-font-data-source";
import { parseSubsetChars, SUBSET_CHARS_FILE, SUBSET_FILE } from "./font-subset";

const fontsDir = path.resolve(import.meta.dirname, "../../public/fonts");
const dataDir = defaultDataDir();

const hasData = (() => {
  try {
    return statSync(path.join(dataDir, "members", "index.json")).isFile();
  } catch {
    return false;
  }
})();

describe("明朝700 のサブセットが data/ を覆っている（#477）", () => {
  const committed = parseSubsetChars(readFileSync(path.join(fontsDir, SUBSET_CHARS_FILE), "utf8"));

  it("サブセットの woff2 と、収録した字の一覧がコミットされている", () => {
    expect(statSync(path.join(fontsDir, SUBSET_FILE)).size).toBeGreaterThan(1024);
    expect(committed.size).toBeGreaterThan(700);
  });

  it("差し替えた 122 面が public/fonts/ に残っていない（消し忘れは転送量ではなくリポジトリの重さ）", () => {
    const leftovers = readdirSync(fontsDir).filter((n) => /^shippori-mincho-700\..*\.woff2$/.test(n) && n !== SUBSET_FILE);
    expect(leftovers).toEqual([]);
  });

  it("fonts.css の Shippori Mincho 700 はサブセットの 1 面だけ", () => {
    const css = readFileSync(path.join(fontsDir, "fonts.css"), "utf8");
    const faces = [...css.matchAll(/url\((shippori-mincho-700\.[^)]+)\)/g)].map((m) => m[1]);
    expect(faces).toEqual([SUBSET_FILE]);
  });

  it.runIf(hasData)("いまの data/ に出る字が、1 字残らずサブセットに入っている", () => {
    const needed = dataHeadChars(readHeadFontDataSource(dataDir));
    const missing = [...needed].filter((c) => !committed.has(c)).sort();
    // 落ちたら: pnpm --filter web build && PYFTSUBSET=.venv/bin/pyftsubset pnpm --filter web font-subset
    expect(missing, `明朝700 のサブセットに ${missing.length} 字足りない: ${missing.join("")}（docs/ops/fonts.md の手順で作り直す）`).toEqual([]);
  });

  it.runIf(hasData)("全角空白（U+3000）が入っている — 落とすと 218 名が 1 グリフだけ書体が変わる", () => {
    // #468 の失敗2。箱の比較では 997 件すべて 0 差で、検出できなかった
    expect(committed.has("　")).toBe(true);
  });
});
