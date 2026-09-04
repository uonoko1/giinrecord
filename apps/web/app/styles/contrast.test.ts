import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 表紙（`.cover`）の上に置く文字は、表紙の地色に対して WCAG AA（4.5:1）を満たすこと。Issue 394
 *
 * 本番 13 ページを axe-core で計測したとき、**違反はこれだけ**だった（critical 0 / serious 2）。
 * 2件とも同じ原因で、`.note`（`--muted`）を表紙の濃紺 `--cover` の上に置いていた:
 *
 *     /assemblies/pref-31  .note > a   #3a4a5e on #26364a  比 1.36（必要 4.5）
 *     /coverage            .note       #6b6860 on #26364a  比 2.21（必要 4.5）
 *
 * `--muted` も `--link` も**紙色の地を前提にした色**で、表紙の上に置くと沈む。
 * 目視で「読めるようになった」で済ませると、次にパレットを触ったとき静かに戻るので、
 * **比そのものをここで固定する**。
 */

const tokens = readFileSync(join(import.meta.dirname, "tokens.css"), "utf8");

/** `background: transparent` の目印。地が透けるので、実際の地は `--paper` になる */
const TRANSPARENT = "transparent";

/** `:root { … }`（ライト）の中の `--name` を読む。ダークは別ブロックなので拾わない */
function lightToken(name: string): string {
  const root = tokens.slice(tokens.indexOf(":root {"), tokens.indexOf("@media"));
  const m = root.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`));
  if (!m) throw new Error(`--${name} が :root に無い`);
  return m[1];
}

/**
 * ダークで実際に効く `--name` を読む。
 *
 * ダークのブロックは**全部のトークンを書き直してはいない**。書いていないものは
 * `:root`（ライト）の値がそのまま残る（CSS のカスケード）。実測すると `--brass-on-cover` が
 * それで、ダークでも `#d8b86a` のまま使われる。**ダークのブロックだけ見ると取り落とす**ので、
 * 無ければライトに落とす。
 */
function darkToken(name: string): string {
  const root = tokens.slice(tokens.indexOf(':root[data-theme="dark"] {'));
  const m = root.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`));
  if (m) return m[1];
  if (new RegExp(`--${name}:\\s*transparent`).test(root)) return TRANSPARENT;
  return lightToken(name); // ダークで上書きしていない ＝ ライトの値が残る
}

/** `@media (prefers-color-scheme: dark)` 側の `--name`。darkToken と同じ落とし方をする */
function mediaDarkToken(name: string): string {
  const block = tokens.slice(tokens.indexOf("@media"), tokens.indexOf(':root[data-theme="dark"] {'));
  const m = block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`));
  if (m) return m[1];
  if (new RegExp(`--${name}:\\s*transparent`).test(block)) return TRANSPARENT;
  return lightToken(name);
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG の相対輝度 */
export function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG のコントラスト比（1〜21） */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("コントラスト（Issue 394）", () => {
  /*
   * **この計算器が正しいことを、外の既知の値で確かめる。**
   * テストが自分の計算器で自分を検証するのは循環で、計算器が間違っていれば
   * 「通っているのに実際は違反」になる（axe を使わずに固定した以上、ここは自分で担保する）。
   * 下は WCAG の上限と、広く知られた AA の境界の組（#777 は 4.48 で落ち、#767676 は 4.54 で通る）。
   * sRGB のガンマ展開（c/12.92 と ((c+0.055)/1.055)^2.4 の分岐）を間違えると、この境界で外れる。
   */
  it.each([
    ["#ffffff", "#000000", 21.0, "白と黒（WCAG の上限）"],
    ["#777777", "#ffffff", 4.48, "#777 on 白（AA に届かない定番例）"],
    ["#767676", "#ffffff", 4.54, "#767676 on 白（AA をぎりぎり満たす定番例）"],
    ["#ffffff", "#767676", 4.54, "順序を入れ替えても同じ"],
    ["#0000ff", "#ffffff", 8.59, "青 on 白"],
    ["#ff0000", "#ffffff", 4.0, "赤 on 白"],
    ["#26364a", "#26364a", 1.0, "同じ色"],
    // 分岐の**閾値**（0.04045）を間違えても、明るい色どうしでは差が出ない。
    // 暗めの中間色を1つ入れて、そこも固定する（0.4 に取り違えると 8.19 → 14.19 になる）
    ["#4f4f4f", "#ffffff", 8.19, "暗めの灰 on 白（ガンマ分岐の閾値を見る）"],
  ])("計算器が既知の値と一致する: %s on %s = %s（%s）", (fg, bg, expected) => {
    expect(contrast(fg as string, bg as string)).toBeCloseTo(expected as number, 1);
  });

  it("表紙の上の muted は AA（4.5:1）を満たす", () => {
    expect(contrast(lightToken("muted-on-cover"), lightToken("cover"))).toBeGreaterThanOrEqual(4.5);
  });

  it("表紙の上のリンクは AA（4.5:1）を満たす", () => {
    expect(contrast(lightToken("link-on-cover"), lightToken("cover"))).toBeGreaterThanOrEqual(4.5);
  });

  it("表紙の本文（cover-fg）とブランド色（brass-on-cover）も満たす（既に満たしているが、戻さないため固定する）", () => {
    expect(contrast(lightToken("cover-fg"), lightToken("cover"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(lightToken("brass-on-cover"), lightToken("cover"))).toBeGreaterThanOrEqual(4.5);
  });

  // 「表紙の上でも --muted のままでよい」に戻すと落ちる。実際に本番で起きていた比を記録しておく
  it("紙色向けの muted / link を表紙に置くと AA に届かない（これが Issue 394 の中身）", () => {
    expect(contrast(lightToken("muted"), lightToken("cover"))).toBeLessThan(4.5);
    expect(contrast(lightToken("link"), lightToken("cover"))).toBeLessThan(4.5);
  });

  it("紙の上では muted も link も AA を満たす（表紙用を足したせいで元が壊れていない）", () => {
    expect(contrast(lightToken("muted"), lightToken("paper"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(lightToken("link"), lightToken("paper"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(lightToken("ink"), lightToken("paper"))).toBeGreaterThanOrEqual(4.5);
  });
});

/**
 * **文字色として使うトークンを、全部数えて固定する。Issue 471**
 *
 * #471 で見つかったのは「`--brass` だけが検査から抜けていた」ことだが、
 * 1つ足して終わりにすると同じ穴がまた開く（#357 の学び「先に全部数える」）。
 * そこで `tokens.css` のトークン 28 個（うち 2 個は `--font-*`、残り 26 個が色）を列挙し、
 * `color:` として使われている組を**全部**引き当てて、下の表に入れた。
 *
 * 数え方（apps/web、node_modules 除く）:
 *   1. トークンの列挙   `sed -n '/^:root {/,/^@media/p' tokens.css` → `--*:` が 28 個
 *   2. CSS の文字色     `grep -rnoE '[a-z-]*color:\s*var\(--[a-z-]+\)' --include='*.css'`
 *                       → `color:` は 116 件、使われている前景トークンは 15 種
 *                       （border-color / accent-color / text-decoration-color は文字色ではないので対象外）
 *   3. TSX の inline style   `grep -rnE 'var\(--[a-z-]+\)' --include='*.tsx'`
 *                       → Cover / CoverBrand / DateHeading / Tabs / SourceLine / ThemeToggle の 6 ファイル。
 *                       前景は --ink / --muted / --paper / --brass / --cover-fg / --brass-on-cover で、
 *                       いずれも 2. の 15 種の中に入っており、**新顔は無かった**
 *   4. 動的に組み立てるトークン名  `grep -rn 'var(--${' --include='*.tsx'`
 *                       → Stamp.tsx だけ。`var(--${t}-fg)` の `t` は yes|no|none|act の 4 つ
 *                       （StampValue → tone の対応表が閉じている）。3. の literal な grep では
 *                       **拾えない**ので別に数えた。4 つとも下の表の判の組に入っている
 *
 * 地の色は「その文字がどの箱の上に乗るか」で決めた。`background` の指定が無い（＝紙の上）ものと、
 * ダークで `background: transparent` になるものは、**地を `--paper` として測る**。
 */
describe("文字色として使うトークンは全部 AA（4.5:1）を満たす（Issue 471）", () => {
  /** [前景トークン, 地のトークン, どこで使われているか] */
  const textPairs: readonly (readonly [string, string, string])[] = [
    // 紙の上
    ["ink", "paper", "本文（pages.css ほか。color: var(--ink) は 23 件）"],
    ["muted", "paper", "注釈・補足（color: var(--muted) は 46 件で最多）"],
    ["link", "paper", "リンク（tokens.css の a { color: var(--link) }）"],
    // ★ #471 の本体。件数表示・五十音の行見出し・チップ・タブの分類見出し
    ["brass", "paper", "members.css:12,15,20,54 / member.css:35,44,56,71,101、DateHeading.tsx:7"],
    ["est-fg", "paper", "member.css:38 .member-tabcat（会派タブの分類見出し。背景を敷かないので紙の上）"],
    ["none-fg", "paper", "pages.css:75 .tag--estimate（背景を敷かないので紙の上）"],
    ["paper", "ink", "pages.css:24 .zip__button / :74 .tag--fact（墨を敷いて紙色で抜く）"],
    // 表紙（--cover）の上。#394 で入った分もここで一緒に数える
    ["cover-fg", "cover", "pages.css:4 .cover / member.css:7 / rollcall.css:7 / compare.css:6"],
    ["brass-on-cover", "cover", "member.css:8,10,22、Cover.tsx:34"],
    ["muted-on-cover", "cover", "pages.css の .cover .note"],
    ["link-on-cover", "cover", "pages.css の .cover .note a"],
    ["cover", "brass-on-cover", "member.css:23 .compare-add-button[aria-pressed=\"true\"]（前景と地が入れ替わる）"],
    // 判（member.css:85-92 / compare.css:35 / member.css:94）
    ["yes-fg", "yes-bg", "member.css:85 .member-stamp[data-tone=\"yes\"]"],
    ["no-fg", "no-bg", "member.css:86 .member-stamp[data-tone=\"no\"]"],
    ["none-fg", "none-bg", "member.css:87 .member-stamp[data-tone=\"none\"]"],
    ["act-fg", "act-bg", "member.css:88 .member-stamp[data-tone=\"act\"]"],
    ["est-fg", "est-bg", "member.css:92,94 / compare.css:35（推定の判）、member.css:45（.member-tabs が est-bg を敷く）"],
  ];

  /** ダークでは判の地が `transparent` になる。その場合は紙が透けるので地は --paper */
  function bgFor(token: (name: string) => string, name: string): string {
    const bg = token(name);
    return bg === TRANSPARENT ? token("paper") : bg;
  }

  describe.each([
    ["ライト", lightToken],
    ["ダーク", darkToken],
  ])("%s", (_name, token) => {
    it.each(textPairs)("%s on %s は AA を満たす（%s）", (fg, bg) => {
      expect(contrast(token(fg), bgFor(token, bg))).toBeGreaterThanOrEqual(4.5);
    });
  });

  /*
   * **余裕が無いものを名指しで記録する。**
   * ライトの `--brass` は紙の上で 4.5095 しかない（AA まで 0.0095）。
   * `#8a6a24` → `#8b6b25` と 1 段階明るくするだけで 4.4457 になって割る。
   * 「なんとなく明るくした」で静かに割らないよう、**現在の値そのもの**をここに書き留める。
   */
  it("ライトの brass は紙の上で 4.5095（AA まで余裕 0.0095 しかない）", () => {
    expect(contrast(lightToken("brass"), lightToken("paper"))).toBeCloseTo(4.5095, 3);
  });

  it("brass を 1 段階明るくすると（#8b6b25）AA を割る＝上の検査は本当に効いている", () => {
    expect(contrast("#8b6b25", lightToken("paper"))).toBeLessThan(4.5);
  });

  // ダークの brass は墨の上で 8.81。ライトだけ足してダークを忘れていないことを名指しで残す
  it("ダークの brass は墨色の上で十分（8.81）", () => {
    expect(contrast(darkToken("brass"), darkToken("paper"))).toBeCloseTo(8.81, 1);
  });

  /*
   * ダークは `@media (prefers-color-scheme: dark)` と `:root[data-theme="dark"]` に
   * **同じ値を二重に書いている**。片方だけ直すと、OS の設定で見ている人と
   * トグルで切り替えた人とで色が変わる。上の検査は `:root[data-theme="dark"]` 側しか見ないので、
   * 二つが一致していることをここで固定する。
   */
  it("ダークの二つの定義（@media と data-theme）が食い違っていない", () => {
    const names = [...new Set(textPairs.flatMap(([fg, bg]) => [fg, bg]))];
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(mediaDarkToken(name), `--${name}`).toBe(darkToken(name));
    }
  });
});

describe("表紙の上の文字はトークンで扱う（Issue 394）", () => {
  const pages = readFileSync(join(import.meta.dirname, "pages.css"), "utf8");

  it(".cover の中の .note は表紙用の色を使う", () => {
    expect(pages).toMatch(/\.cover\s+\.note\s*\{[^}]*var\(--muted-on-cover\)/);
  });

  it(".cover の中のリンクも表紙用の色を使う", () => {
    expect(pages).toMatch(/\.cover\s+\.note\s+a\s*\{[^}]*var\(--link-on-cover\)/);
  });
});
