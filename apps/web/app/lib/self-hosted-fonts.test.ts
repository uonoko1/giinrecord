/**
 * 自サイト配信フォント（Issue #168）の仕様。
 * Google Fonts の CSS（unicode-range 分割済み）を読んで、
 * 1) 各 @font-face を「ローカルのファイル名 + unicode-range」に写し、
 * 2) 自サイト用の fonts.css を生成する。外部 URL は一切残さない。
 * 取得（HTTP）は scripts/fonts.ts が行い、ここは純粋関数だけを試験する。
 */
import { describe, expect, it } from "vitest";
import { FONT_FAMILIES, parseGoogleFontsCss, renderFontsCss, sliceFileName } from "./self-hosted-fonts";

const css = `
/* [0] */
@font-face {
  font-family: 'BIZ UDPGothic';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/bizudpgothic/v16/abc.0.woff2) format('woff2');
  unicode-range: U+25ee8, U+25f23;
}
/* [1] */
@font-face {
  font-family: 'BIZ UDPGothic';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/bizudpgothic/v16/def.1.woff2) format('woff2');
  unicode-range: U+3000-303f, U+ff01-ff5e;
}
@font-face {
  font-family: 'Shippori Mincho';
  font-style: normal;
  font-weight: 800;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/shipporimincho/v14/ghi.119.woff2) format('woff2');
  unicode-range: U+4e00-4e0f;
}
/* latin */
@font-face {
  font-family: 'Shippori Mincho';
  font-style: normal;
  font-weight: 800;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/shipporimincho/v14/latin.woff2) format('woff2');
  unicode-range: U+0000-00ff;
}
`;

describe("parseGoogleFontsCss", () => {
  it("family・weight・slice（番号 or latin 等のサブセット名）・unicode-range・取得元 URL を @font-face ごとに取り出す", () => {
    const faces = parseGoogleFontsCss(css);
    expect(faces).toEqual([
      { family: "BIZ UDPGothic", weight: 400, slice: "0", unicodeRange: "U+25ee8, U+25f23", sourceUrl: "https://fonts.gstatic.com/s/bizudpgothic/v16/abc.0.woff2" },
      { family: "BIZ UDPGothic", weight: 700, slice: "1", unicodeRange: "U+3000-303f, U+ff01-ff5e", sourceUrl: "https://fonts.gstatic.com/s/bizudpgothic/v16/def.1.woff2" },
      { family: "Shippori Mincho", weight: 800, slice: "119", unicodeRange: "U+4e00-4e0f", sourceUrl: "https://fonts.gstatic.com/s/shipporimincho/v14/ghi.119.woff2" },
      { family: "Shippori Mincho", weight: 800, slice: "latin", unicodeRange: "U+0000-00ff", sourceUrl: "https://fonts.gstatic.com/s/shipporimincho/v14/latin.woff2" },
    ]);
  });
  it("番号もサブセット名も無い slice は名前が付けられないので拒否する", () => {
    const anon = "@font-face { font-family: 'Shippori Mincho'; font-weight: 700; src: url(https://a/b.woff2) format('woff2'); unicode-range: U+0000; }";
    expect(() => parseGoogleFontsCss(anon)).toThrow(/slice/);
  });
  it("woff2 以外や unicode-range の無い @font-face は受け付けない（分割前提が崩れる）", () => {
    const ttf = "@font-face { font-family: 'Shippori Mincho'; font-weight: 700; src: url(https://a/b.ttf) format('truetype'); }";
    expect(() => parseGoogleFontsCss(ttf)).toThrow(/woff2|unicode-range/);
  });
  it("想定外の family や weight が混ざっていれば拒否する", () => {
    const other = css.replace("'Shippori Mincho'", "'Noto Sans JP'");
    expect(() => parseGoogleFontsCss(other)).toThrow(/Noto Sans JP/);
    expect(() => parseGoogleFontsCss(css.replace("font-weight: 800", "font-weight: 300"))).toThrow(/300/);
  });
});

describe("sliceFileName", () => {
  it("family を小文字ハイフン区切りにし、weight と slice 番号を付ける", () => {
    expect(sliceFileName({ family: "Shippori Mincho", weight: 700, slice: "12" })).toBe("shippori-mincho-700.12.woff2");
    expect(sliceFileName({ family: "BIZ UDPGothic", weight: 400, slice: "latin-ext" })).toBe("biz-udpgothic-400.latin-ext.woff2");
  });
});

describe("renderFontsCss", () => {
  const faces = parseGoogleFontsCss(css);
  const out = renderFontsCss(faces);

  it("外部 URL を含まず、同じディレクトリの woff2 だけを参照する", () => {
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).toContain('url(biz-udpgothic-400.0.woff2) format("woff2")');
    expect(out).toContain('url(shippori-mincho-800.119.woff2) format("woff2")');
  });
  it("font-display: swap と unicode-range を各 @font-face に残す", () => {
    expect(out.match(/font-display: swap;/g)).toHaveLength(4);
    expect(out).toContain("unicode-range: U+3000-303f, U+ff01-ff5e;");
  });
  it("同じ slice 番号の face を隣接させる（unicode-range が重複して並び gzip が効く）", () => {
    const many = [
      { family: "Shippori Mincho", weight: 700, slice: "latin", unicodeRange: "U+0000-00ff", sourceUrl: "" },
      { family: "Shippori Mincho", weight: 700, slice: "10", unicodeRange: "U+0001", sourceUrl: "" },
      { family: "BIZ UDPGothic", weight: 400, slice: "2", unicodeRange: "U+0000", sourceUrl: "" },
      { family: "Shippori Mincho", weight: 800, slice: "2", unicodeRange: "U+0000", sourceUrl: "" },
    ];
    const order = [...renderFontsCss(many).matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]);
    expect(order).toEqual(["shippori-mincho-800.2.woff2", "biz-udpgothic-400.2.woff2", "shippori-mincho-700.10.woff2", "shippori-mincho-700.latin.woff2"]);
  });
  it("ライセンス（SIL OFL）の所在をコメントで示す", () => {
    expect(out).toMatch(/OFL\.txt/);
  });
});

describe("FONT_FAMILIES", () => {
  /**
   * #452: 500 は**サイトのどこからも要求されていない**ので外した（全 15 ページ + タブ/折りたたみ展開で実測、
   * `shippori-mincho-500` の woff2 は 0 件、`CSS.getPlatformFontsForNode` にも `Medium` は出ない）。
   * 外したことで `--font-head` に 400 を書いたときの落ち先が **500 から 700 に変わる**ので、
   * `app/styles/font-weight-match.test.ts` の不変条件（家族を書かないウェイト指定を禁じる）が
   * **前より効いている**。ここを増やすときは向こうの検査も一緒に読むこと。
   */
  it("見出しは Shippori Mincho 700/800、本文は BIZ UDPGothic 400/700", () => {
    expect(FONT_FAMILIES).toEqual([
      { family: "Shippori Mincho", weights: [700, 800] },
      { family: "BIZ UDPGothic", weights: [400, 700] },
    ]);
  });
});
