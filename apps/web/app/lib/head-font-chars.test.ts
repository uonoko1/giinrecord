/**
 * 見出し家族（Shippori Mincho）700 が**実際に描く字**を、ビルド済み HTML から集める（#477）。
 *
 * #468 の調査（`docs/research/font-subset-member-names.md`）が踏んだ失敗そのもの:
 * 議員名の字だけ（678 字）でサブセットを作ったら、`/` `/coverage` `/assemblies` が
 * **システムフォントに落ちた**。明朝 700 は `.tag` `.section__title` `.zip__title` にも使われており、
 * 「議員名」だけを見ていると **議員名以外の字が抜ける**。
 *
 * だから字集めは**「どのクラスが議員名か」を人が数える**のではなく、
 * **プリレンダー済みの HTML 全ページに CSS を当てて、700 が当たる要素のテキストを全部取る**。
 * 新しいクラスが増えても、そのクラスが `--font-head` + 700 なら自動で入る。
 *
 * jsdom の `getComputedStyle` は使えない（実測: `var(--font-head)` を解決せず、
 * `font-family` の**継承もしない**。`.x{font-family:var(--font-head)}` の子は `""` を返す）。
 * ここでは必要な2プロパティ（font-family / font-weight）だけを自前でカスケードする。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HEAD_FONT_VAR, headFontChars, headFontShorthandRules, headFontWeightRules } from "./head-font-chars";

/** app/ 以下の CSS を全部集める（font-weight-match.test.ts と同じ集め方） */
function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...cssFiles(full));
    else if (e.name.endsWith(".css")) out.push(full);
  }
  return out;
}

const css = `
:root { --font-head: "Shippori Mincho", serif; --font-body: "BIZ UDPGothic", sans-serif; }
body { font-family: var(--font-body); font-weight: 400; }
.name { font-family: var(--font-head); font-size: 17px; font-weight: 700; }
.title { font-family: var(--font-head); font-weight: 800; }
.count { font-family: var(--font-body); font-weight: 400; }
.plain { font-weight: 700; }
`;

/** テストは vitest の jsdom 環境の `DOMParser` を使う（ライブラリ側は DOM を作らない）。 */
function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function chars(html: string, sheet = css): string[] {
  return [...headFontChars(parse(html), sheet, 700)].sort();
}

describe("headFontChars（明朝700 が描く字を HTML から集める）", () => {
  it("--font-head + 700 の要素のテキストだけを取る", () => {
    expect(chars(`<body><p class="name">阿達</p><p class="title">雅志</p><p class="count">12</p></body>`)).toEqual(["達", "阿"]);
  });

  it("font-family を書いていない子は親から継承する（#454 と同じ経路）", () => {
    // .plain は font-weight:700 しか書いていないが、親が --font-head なので明朝 700 で描かれる
    expect(chars(`<body><div class="name">親<span class="plain">子</span></div></body>`)).toEqual(["子", "親"]);
  });

  it("子が本文家族を明示したら、その字は入らない", () => {
    expect(chars(`<body><div class="name">親<span class="count">子</span></div></body>`)).toEqual(["親"]);
  });

  it("style 属性（インライン）も見る（Stamp / Cover / DateHeading はインライン style）", () => {
    const html = `<body><span style="font-family:var(--font-head);font-weight:700">賛成</span></body>`;
    expect(chars(html)).toEqual(["成", "賛"]);
  });

  it("インライン style はクラスより強い（同じ要素で家族を本文に上書きしたら入らない）", () => {
    const html = `<body><p class="name" style="font-family:var(--font-body)">阿達</p></body>`;
    expect(chars(html)).toEqual([]);
  });

  it("全角空白のような「見えない字」を落とさない（調査の失敗2）", () => {
    // 218 名が 1 グリフだけフォールバックした原因。箱の比較では見えない
    expect(chars(`<body><p class="name">阿達　雅志</p></body>`)).toContain("　");
  });

  it("script / style / head の中身は字ではない", () => {
    const html = `<head><title>題</title></head><body><div class="name">名<script>var x="脚"</script><style>.z{content:"飾"}</style></div></body>`;
    expect(chars(html)).toEqual(["名"]);
  });

  it("属性（aria-label / alt）は描かれないので入らない", () => {
    expect(chars(`<body><span class="name" aria-label="読み" title="題">名</span></body>`)).toEqual(["名"]);
  });

  it("別のウェイトを求めれば別の字が返る（800 は見出しの大字）", () => {
    expect([...headFontChars(parse(`<body><p class="name">阿</p><p class="title">雅</p></body>`), css, 800)].sort()).toEqual(["雅"]);
  });

  it("font-weight: bold / normal も数字に直す", () => {
    const sheet = `${css}\n.b { font-family: var(--font-head); font-weight: bold; }\n.n { font-family: var(--font-head); font-weight: normal; }`;
    expect(chars(`<body><p class="b">太</p><p class="n">細</p></body>`, sheet)).toEqual(["太"]);
  });
});

describe("速さのための近道が、結果を変えない", () => {
  /**
   * 全要素 × 全規則を歩くと実測 3.5 秒/ページ（1,466 ページで 85 分）。
   * 「見出し家族を要求する要素より上に、見出し家族の字は無い」ので部分木だけ歩いている。
   * これは「家族を書く規則が同じ規則でウェイトも書く」（#454 の規律）に**依存している**。
   * 破られたときに黙って取りこぼさないよう、全走査に落ちること。
   */
  it("家族だけ書いてウェイトを書かない規則があると、祖先のウェイトを継いだ字も拾う", () => {
    const sheet = `${css}\n.headonly { font-family: var(--font-head); }`;
    // .bold700 が 700 を決め、その子 .headonly が家族だけ変える。近道だと .headonly の
    // 起点より上（= 700）が見えないので取りこぼす
    const withBold = `${sheet}\n.bold700 { font-weight: 700; }`;
    const html = `<body><div class="bold700"><span class="headonly">継</span></div></body>`;
    expect([...headFontChars(parse(html), withBold, 700)]).toEqual(["継"]);
  });
});

describe("headFontWeightRules（どの規則が明朝700 を要求しているか）", () => {
  it("--font-head と 700 を同じ規則に書いた セレクタを返す", () => {
    expect(headFontWeightRules(css, 700)).toEqual([".name"]);
  });

  it("見出し家族の CSS 変数名は tokens.css と同じ", () => {
    expect(HEAD_FONT_VAR).toBe("--font-head");
  });
});

describe("読まない書き方が増えたら、黙って取りこぼさずに落ちる", () => {
  /**
   * `font:` ショートハンドは family も weight も一度に決めるので、
   * `font-family` / `font-weight` だけを見るこの実装からは**見えない**。
   * #472 が CSS と TSX の両方で同じ穴を実際に踏んでいる
   * （`font: 13px/1.4 var(--font-head)` は **400 と 1 文字も書かずに** 400 を要求する）。
   *
   * **サブセットにとって、見えない指定は「その字が集まらない」＝黙ってシステム書体になることを意味する。**
   * だから「対応していない」ではなく「**増えたら落ちる**」にしておく。
   */
  it("`font:` ショートハンドを拾える（inherit は親と同じなので数えない）", () => {
    expect(headFontShorthandRules(".a { font: 700 13px/1.5 var(--font-head); }")).toEqual([".a"]);
    expect(headFontShorthandRules(".b { font: inherit; }")).toEqual([]);
  });

  it("いまのアプリの CSS に `font:` ショートハンドは無い（増えたら head-font-chars の対応が要る）", () => {
    const css = cssFiles(join(import.meta.dirname, "..")).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(css.length).toBeGreaterThan(10_000);
    expect(
      headFontShorthandRules(css),
      "`font:` ショートハンドが増えた。headFontChars はこれを読まないので、その要素の字がサブセットから漏れる（#472 と同じ穴）",
    ).toEqual([]);
  });
});
