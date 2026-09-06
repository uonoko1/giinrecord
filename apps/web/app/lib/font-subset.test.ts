/**
 * 明朝 700 の**実測サブセット**（#477）。
 *
 * Google の unicode-range 分割は「1 字のために 66 KB」を実在させる（#468 の実測。
 * `/members` の展開後は 1 字しか使わないスライスが 20 件・1,033 KB で、明朝 700 の転送量の約半分）。
 * 出る字だけの 1 面に置き換えると `/members` 展開後は 3,017 → 1,033 KB になる。
 *
 * ここは純粋関数だけ。`pyftsubset` の実行と `data/` の読み取りは `scripts/font-subset.ts`。
 */
import { describe, expect, it } from "vitest";
import { parseGoogleFontsCss, renderFontsCss } from "./self-hosted-fonts";
import { SUBSET_FAMILY, SUBSET_FILE, SUBSET_WEIGHT, formatSubsetChars, parseSubsetChars, subsetFace, subsetUnicodeRange } from "./font-subset";

describe("subsetUnicodeRange（サブセットが持つ字を unicode-range にする）", () => {
  it("連続するコードポイントは範囲にまとめる", () => {
    expect(subsetUnicodeRange(new Set(["a", "b", "c", "z"]))).toBe("U+61-63, U+7A");
  });

  it("1 字だけなら範囲にしない", () => {
    expect(subsetUnicodeRange(new Set(["A"]))).toBe("U+41");
  });

  it("全角空白（U+3000）が落ちない", () => {
    expect(subsetUnicodeRange(new Set(["　"]))).toBe("U+3000");
  });

  it("空なら空文字（@font-face を書かないための目印）", () => {
    expect(subsetUnicodeRange(new Set())).toBe("");
  });

  it("BMP 外（サロゲートペア）も 1 つのコードポイントとして扱う", () => {
    expect(subsetUnicodeRange(new Set(["𠮟"]))).toBe("U+20B9F");
  });
});

describe("formatSubsetChars / parseSubsetChars（コミットする字の一覧）", () => {
  it("コードポイント順に並べて書き、読み戻すと同じ集合になる（再生成が冪等）", () => {
    const chars = new Set(["雅", "阿", "　", "A"]);
    const text = formatSubsetChars(chars);
    expect(text).toBe("A　阿雅\n");
    expect(parseSubsetChars(text)).toEqual(chars);
  });

  it("読み戻しは改行を字として数えない（ファイル末尾の改行で 1 字増えない）", () => {
    expect(parseSubsetChars("阿雅\n")).toEqual(new Set(["阿", "雅"]));
    expect(parseSubsetChars("阿雅")).toEqual(new Set(["阿", "雅"]));
  });

  it("同じ集合なら並べ替えても同じ本文になる（md5 が一致する条件）", () => {
    expect(formatSubsetChars(new Set(["c", "a", "b"]))).toBe(formatSubsetChars(new Set(["b", "c", "a"])));
  });
});

describe("subsetFace（fonts.css に置く 1 面）", () => {
  it("Shippori Mincho 700 を、サブセットの字だけの 1 面にする", () => {
    const face = subsetFace(new Set(["阿", "達"]));
    expect(face).toEqual({
      family: SUBSET_FAMILY,
      weight: SUBSET_WEIGHT,
      slice: "subset",
      unicodeRange: "U+9054, U+963F",
      sourceUrl: "",
    });
    expect(SUBSET_FAMILY).toBe("Shippori Mincho");
    expect(SUBSET_WEIGHT).toBe(700);
    expect(SUBSET_FILE).toBe("shippori-mincho-700.subset.woff2");
  });
});

describe("fonts.css に差し替えたとき", () => {
  const google = `
/* [0] */
@font-face { font-family: 'Shippori Mincho'; font-style: normal; font-weight: 700; font-display: swap;
  src: url(https://fonts.gstatic.com/s/shipporimincho/v14/a.0.woff2) format('woff2'); unicode-range: U+4e00-4e0f; }
/* [0] */
@font-face { font-family: 'Shippori Mincho'; font-style: normal; font-weight: 800; font-display: swap;
  src: url(https://fonts.gstatic.com/s/shipporimincho/v14/b.0.woff2) format('woff2'); unicode-range: U+4e00-4e0f; }
/* [1] */
@font-face { font-family: 'Shippori Mincho'; font-style: normal; font-weight: 700; font-display: swap;
  src: url(https://fonts.gstatic.com/s/shipporimincho/v14/c.1.woff2) format('woff2'); unicode-range: U+4e10-4e1f; }
/* latin */
@font-face { font-family: 'BIZ UDPGothic'; font-style: normal; font-weight: 400; font-display: swap;
  src: url(https://fonts.gstatic.com/s/bizudpgothic/v16/d.latin.woff2) format('woff2'); unicode-range: U+0-ff; }
`;
  const faces = parseGoogleFontsCss(google);

  it("明朝700 の 122 面が消えて、サブセットの 1 面だけになる", () => {
    const kept = faces.filter((f) => !(f.family === SUBSET_FAMILY && f.weight === SUBSET_WEIGHT));
    const out = renderFontsCss([...kept, subsetFace(new Set(["一"]))]);
    expect(out).toContain(`url(${SUBSET_FILE}) format("woff2")`);
    expect(out).not.toContain("shippori-mincho-700.0.woff2");
    expect(out).not.toContain("shippori-mincho-700.1.woff2");
    // 800 と本文家族は 1 面も減らない（#453：見出しの大字は明朝のまま）
    expect(out).toContain("shippori-mincho-800.0.woff2");
    expect(out).toContain("biz-udpgothic-400.latin.woff2");
  });

  it("サブセット面にも font-display: swap と unicode-range が付く", () => {
    const out = renderFontsCss([subsetFace(new Set(["一"]))]);
    expect(out).toContain("font-display: swap;");
    expect(out).toContain("unicode-range: U+4E00;");
    expect(out).toContain("font-weight: 700;");
  });
});
