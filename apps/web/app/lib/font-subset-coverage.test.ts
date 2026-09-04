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

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

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

  /**
   * #468 の失敗2: 氏名の間の空白を対象から外して、229 名中 **218 名が 1 グリフだけ**
   * フォールバックした。**箱の比較では検出できなかった**（997 件すべて 0 差）。
   *
   * **ただし、いまの `data/` の氏名の区切りは U+3000 ではなく U+0020 だった**（実測 2026-09-05、
   * `index.json` の 1,013 件すべて U+20。U+3000 は 1 件も無い）。
   * 調査は「全角空白」と書いているので、**字を名指しで固定すると、実態と違うものを守ることになる**。
   * だから名指しではなく「**目に見えない字が 1 つも欠けていない**」を検査する。
   */
  /**
   * **`data/` を見ずにビルド済み HTML だけで作ると、1,057 名中 204 名の氏名に欠けが出る**（実測 2026-09-05）。
   *
   *     HTML のみ  644 字 -> 欠けの出る議員 204 / 1057（衛藤 晟一・小沼 巧・片山 さつき …）
   *     data のみ  877 字 -> 0 / 1057
   *     和集合     943 字 -> 0 / 1057
   *
   * `/members` は 200 件で折りたたまれ（#340）、議員ページのタブも折りたたまれるので、
   * **HTML には 229 名ぶんしか入っていない**。#468 の調査は「20 件のサンプル + ページ走査」で
   * 字を集めており、**その方法では原理的に集まらない字がある**。
   *
   * 逆に **HTML にしか無い字も 66 字ある**（`.tag` の「事実」「推定」など、`data/` に無い静的な語）。
   * これが調査の「失敗1」（議員名の字だけで作って `/` `/coverage` `/assemblies` が
   * システムフォントに落ちた）の正体である。**どちらか片方では必ず足りない。**
   *
   * ここでは `data/` 側だけを検査する（HTML はビルドが要る）。この検査が守るのは
   * 「**新しい議員が入って字が増えたら落ちる**」ことであって、静的な語が増える経路ではない。
   * そちらは `scripts/font-subset.ts` の再実行が見る。**強い主張をしない。**
   */
  it.runIf(hasData)("議員 1,057 名全員の氏名が、1 字残らずサブセットに入っている", () => {
    const index = readJson<{ name?: string }[]>(path.join(dataDir, "members", "index.json")) ?? [];
    expect(index.length).toBeGreaterThan(1000);
    const incomplete = index.filter((m) => [...(m.name ?? "")].some((c) => !committed.has(c))).map((m) => m.name);
    expect(incomplete, `${incomplete.length} 名の氏名に、サブセットに無い字がある`).toEqual([]);
  });

  /**
   * **サブセットに「入れたのに収録されない字」が 1 つある。U+2FA7（⾧、康熙部首の『長』）。**
   *
   * 島根県議会の表決の判（`.member-stamp`、明朝700）に `議⾧` として入っている。
   * 通常の「長」U+9577 ではなく**部首の異体**で、一次資料の表記がそうなっている（丸めない）。
   *
   * **これはサブセットの不具合ではない。Shippori Mincho がこの字を持っていない**
   * （実測: 既存の 122 スライスのどれにも無く、上流 TTF にも無い。BIZ UDPGothic にも無い）。
   * **つまり差し替える前から、この 1 字はシステム書体で描かれていた。**
   *
   * ここで固定しておくのは、**将来これを見た人が「サブセットが壊れている」と誤解しないため**である。
   * 収録字数（`.txt`）と実際に font が持つ字数が 1 つずれるのは、この字のせい。
   */
  it("フォント自身が持たない字は、要求しても収録されない（U+2FA7 は差し替え前から明朝で描けていない）", () => {
    expect(committed.has("\u2FA7")).toBe(true); // 要求はしている（明朝700 の要素に出る字なので）
    const woff2 = readFileSync(path.join(fontsDir, SUBSET_FILE));
    expect(woff2.length).toBeGreaterThan(100_000); // 中身の検査は font-subset.ts の実行時に行う
  });

  it.runIf(hasData)("目に見えない字（空白の類）が 1 つも落ちていない", () => {
    const invisible = [...dataHeadChars(readHeadFontDataSource(dataDir))].filter((c) => /\s/u.test(c) || c === "　");
    expect(invisible.length, "data/ の明朝700 の欄に空白が 1 つも無い（区切りの取り方が変わった可能性）").toBeGreaterThan(0);
    expect(invisible.filter((c) => !committed.has(c))).toEqual([]);
  });
});
