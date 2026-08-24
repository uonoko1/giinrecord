import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "member.css"), "utf8");
const tokens = readFileSync(join(__dirname, "..", "styles", "tokens.css"), "utf8");

/** tokens.css の :root ブロックから変数を読む。ダークは prefers-color-scheme のブロックで上書きする */
function palette(dark: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  const blocks = [...tokens.matchAll(/([^{}]*)\{([^{}]*)\}/g)];
  for (const [, selector, body] of blocks) {
    const isDarkBlock = /prefers-color-scheme: dark|\[data-theme="dark"\]/.test(selector);
    if (isDarkBlock && !dark) continue;
    if (!isDarkBlock && dark && !/:root/.test(selector)) continue;
    for (const [, name, value] of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[name] = value.trim();
  }
  return out;
}

function srgb(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * srgb(r!) + 0.7152 * srgb(g!) + 0.0722 * srgb(b!);
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("議員ページのタブは押せる文字が WCAG AA（4.5:1）を満たす（#238）", () => {
  for (const dark of [false, true]) {
    const theme = dark ? "ダーク" : "ライト";
    it(`${theme}: タブに使う文字色（--muted / --brass）は --paper に対し 4.5:1 以上`, () => {
      const p = palette(dark);
      for (const token of ["muted", "brass"]) {
        expect(p[token], `--${token} が tokens.css に無い`).toBeDefined();
        expect(contrast(p[token]!, p.paper!), `--${token} on --paper (${theme})`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  /**
   * opacity を掛けると背景に合成されて実効コントラストが下がる。--muted は素で 4.98:1（ライト）しかないので、
   * opacity 0.9 でも 4.06:1 まで落ちて AA を割る。0 件のタブは押せる要素なので、淡くするのではなく
   * 破線の下線（形）で区別する。ここは opacity による退行を止めるための番人。
   */
  it("タブに opacity を掛けない（0 件の区別は色の薄さではなく下線で付ける）", () => {
    const tabRules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector]) =>
      /\.member-tab(\b|-)/.test(selector),
    );
    expect(tabRules.length).toBeGreaterThan(0);
    const withOpacity = tabRules.filter(([, , body]) => /(^|[;\s])opacity\s*:/.test(body!)).map(([, s]) => s!.trim());
    expect(withOpacity).toEqual([]);
  });

  it("0 件のタブは下線で区別する（隠さない・disabled にもしない）", () => {
    expect(css).toMatch(/\.member-tab\[data-empty="true"\][^{]*\{[^}]*text-decoration:[^}]*underline[^}]*\}/);
  });
});
