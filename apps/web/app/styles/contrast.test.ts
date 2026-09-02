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

/** `:root { … }`（ライト）の中の `--name` を読む。ダークは別ブロックなので拾わない */
function lightToken(name: string): string {
  const root = tokens.slice(tokens.indexOf(":root {"), tokens.indexOf("@media"));
  const m = root.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`));
  if (!m) throw new Error(`--${name} が :root に無い`);
  return m[1];
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

describe("表紙の上の文字はトークンで扱う（Issue 394）", () => {
  const pages = readFileSync(join(import.meta.dirname, "pages.css"), "utf8");

  it(".cover の中の .note は表紙用の色を使う", () => {
    expect(pages).toMatch(/\.cover\s+\.note\s*\{[^}]*var\(--muted-on-cover\)/);
  });

  it(".cover の中のリンクも表紙用の色を使う", () => {
    expect(pages).toMatch(/\.cover\s+\.note\s+a\s*\{[^}]*var\(--link-on-cover\)/);
  });
});
