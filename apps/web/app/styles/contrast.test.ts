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
  it("計算そのものが正しい（白と黒は 21、同じ色は 1）", () => {
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 1);
    expect(contrast("#26364a", "#26364a")).toBeCloseTo(1, 5);
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
