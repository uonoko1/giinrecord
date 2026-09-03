import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WCAG 2.2 の 2.5.8（Target Size (Minimum)、AA）: 押せる範囲は **24×24 CSS px** 以上。Issue 413
 *
 * 本番（390px 幅）で測ったところ、8箇所が足りていなかった:
 *
 *     フッターのリンク5つ      高さ 12px（font-size 12px、padding 0）
 *     「元職も含める」のラベル  高さ 13px
 *     テーマ切替「昼」「夜」    高さ 20px（padding 4px + font-size 12px）
 *
 * 指で押す操作では、小さい対象は隣を誤って押す。フッターは「利用規約」と
 * 「プライバシーポリシー」が縦に並ぶので、押し間違いが起きやすい配置だった。
 *
 * **axe はこれを検出しない**（`target-size` は既定のルールセットに入っていない）。
 * 本番10ページで違反0件のときに、手で測って見つけた。
 *
 * 検査は**ソース（CSS と inline style）に対して**行う。ブラウザでの実測は
 * フォント読み込みのタイミングで値が変わる（実際、途中の値を見て誤報を出しかけた）。
 */
const app = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(app, p), "utf8");

/**
 * そのセレクタに当たる宣言を集める。**自前で CSS を解析しない**——
 * まとめ書き（`.a, .b { … }`）や後勝ちの打ち消しを正しく扱うのは難しく、
 * 実際に正規表現を2回書き直して2回とも取りこぼした。
 * ブラウザと同じ実装（jsdom の CSSOM）に解析させる。
 */
function declarationsFor(css: string, selector: string): string {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  const sheet = style.sheet!;
  const out: string[] = [];
  for (const r of [...sheet.cssRules]) {
    if (!(r instanceof CSSStyleRule)) continue;
    // `.a, .b` の形も、その中に目的のセレクタがあれば拾う
    if (r.selectorText.split(",").map((t) => t.trim()).includes(selector)) out.push(r.style.cssText);
  }
  style.remove();
  return out.join(";");
}

/** 押せる高さ（px）。padding-block と min-height の大きいほうを見る */
function targetHeight(decls: string, fontSize: number): number {
  const min = Number(decls.match(/min-height:\s*(\d+)px/)?.[1] ?? 0);
  const pb = Number(decls.match(/padding-(?:block|top):\s*(\d+)px/)?.[1] ?? 0);
  return Math.max(min, pb * 2 + fontSize * 1.2); // line-height normal ≒ 1.2
}

const MINIMUM = 24;

describe("押せる範囲は 24×24 px 以上（WCAG 2.5.8・Issue 413）", () => {
  const pages = read("styles/pages.css");

  it("フッターのリンクが 24px を満たす", () => {
    expect(targetHeight(declarationsFor(pages, ".site-footer__links a"), 12)).toBeGreaterThanOrEqual(MINIMUM);
  });

  it("「ホーム画面に追加」のボタンも満たす（リンクと同じ見た目だが button）", () => {
    expect(targetHeight(declarationsFor(pages, ".install-link__button"), 12)).toBeGreaterThanOrEqual(MINIMUM);
  });

  it("議員一覧の「元職も含める」が満たす", () => {
    expect(targetHeight(declarationsFor(read("routes/members.css"), ".members-check"), 13)).toBeGreaterThanOrEqual(MINIMUM);
  });

  it("テーマ切替の選択肢が満たす（inline style なので padding を見る）", () => {
    // ThemeToggle.tsx は CSS ファイルを持たず inline style で書かれている
    const src = read("components/ThemeToggle.tsx");
    const padding = src.match(/padding:\s*"(\d+)px (\d+)px"/);
    expect(padding, "label の padding が読めない").toBeTruthy();
    const vertical = Number(padding![1]);
    const fontSize = Number(src.match(/fontSize:\s*(\d+)/)?.[1] ?? 12);
    // padding 上下 + 文字の高さ（line-height normal ≒ font-size × 1.2）
    expect(vertical * 2 + fontSize * 1.2).toBeGreaterThanOrEqual(24);
  });
});

/**
 * 会派名が長い議員だと、`.members-item__meta` が 328px になり、
 * 350px の行の中で**名前のリンクが 17px まで潰れて縦一列**になっていた（229名中2名で実測）。
 *
 * 原因は `.members-item__meta` の `flex-shrink: 0`——「絶対に縮まない」ので、
 * 隣のリンクが全部の圧縮を引き受けていた。**折り返しを許す**ことで、情報を削らずに直る。
 *
 * これは #412（320px で横スクロール）と**同じ原因**で、`/members` の 377px はみ出しも消えた。
 */
describe("議員一覧の行は、会派名が長くても名前のリンクを潰さない（Issue 413 / 412）", () => {
  const members = read("routes/members.css");

  it("行は折り返す（潰さずに次の行へ回す）", () => {
    expect(declarationsFor(members, ".members-item")).toMatch(/flex-wrap:\s*wrap/);
  });

  it("meta に flex-shrink: 0 を付けない（隣を潰す原因だった）", () => {
    expect(declarationsFor(members, ".members-item__meta")).not.toMatch(/flex-shrink:\s*0/);
  });

  it("名前のリンクは縮んでよいが、潰れない（min-width: 0 と flex 指定）", () => {
    const d = declarationsFor(members, ".members-item__link");
    expect(d).toMatch(/min-width:\s*0/);
    expect(d).toMatch(/flex:/);
  });
});

/**
 * WCAG 1.4.10（Reflow、AA）: 320px 相当の幅で**2方向のスクロールを要求しない**。Issue 412
 *
 * 320px は実機幅であると同時に、**400% 拡大時の 1280px と等価**（弱視の利用者の設定）。
 * 横スクロールが要ると、1行読むたびに左右に振らされる。
 *
 * `/coverage` は 8px はみ出していた。原因は `.figures` の `repeat(3, 1fr)` で、
 * **`1fr` は min-content を下限に持つ**ため、数字が長い（1,469 など）と
 * 3列の合計が親を超える。`minmax(0, 1fr)` で下限を外す。
 *
 * `.assemblies-table` は `overflow-x: auto` の箱に入っているので**対象外**
 * （ページ全体が横に動くのが問題で、表の中だけが動くのは許容される）。
 */
describe("320px 幅で横スクロールしない（WCAG 1.4.10・Issue 412）", () => {
  const pages = read("styles/pages.css");

  it(".figures の列は min-content を下限に持たない", () => {
    const d = declarationsFor(pages, ".figures");
    expect(d).toMatch(/grid-template-columns:[^;]*minmax\(/);
    // `repeat(3, 1fr)` のように下限が min-content のままだと、長い数字で溢れる
    expect(d).not.toMatch(/grid-template-columns:\s*repeat\(\s*\d+\s*,\s*1fr\s*\)/);
  });

  it("表は横スクロールできる箱に入っている（表の中だけが動くのは許容）", () => {
    expect(declarationsFor(read("routes/assemblies.css"), ".assemblies-table-wrap")).toMatch(/overflow-x:\s*auto/);
  });
});

/**
 * Issue 423（#413 の第2段階）: ページ下部の移動リンク（`.links` の中）。
 *
 * ビルドした本体を 390px で測ると **15箇所すべてが高さ 13px** だった
 * （`font-size: 13px`、padding 0。このフォントは line-height normal が 1.0 で、文字の高さがそのまま箱になる）。
 *
 * `.links a` に `padding-block: 6px` を足して 25px にする。**押せる範囲だけ**を広げ、行間は変えないため、
 * `.links` の縦の gap を padding の分（6px × 2）だけ減らす——フッター（#416）と同じやり方。
 *
 * ここでは line-height を 1.2 ではなく **1.0 とみなす**（実測どおり）。1.2 で見積もると padding 5px でも
 * 通ってしまうが、実物は 23px で足りない。
 */
describe("ページ下部の移動リンク（.links）が 24px を満たす（Issue 423）", () => {
  const pages = read("styles/pages.css");
  const FONT_SIZE = 13;
  const ORIGINAL_GAP = 16; // 直す前の `.links { gap: 16px }`。見た目の間隔はこれを保つ

  function paddingBlock(decls: string): number {
    return Number(decls.match(/padding-(?:block|top):\s*(\d+)px/)?.[1] ?? 0);
  }

  it("リンクの高さが 24px 以上（文字 13px + 上下の padding）", () => {
    const pb = paddingBlock(declarationsFor(pages, ".links a"));
    expect(pb * 2 + FONT_SIZE).toBeGreaterThanOrEqual(MINIMUM);
  });

  it("縦の gap を padding の分だけ減らしてあり、行と行の見た目の間隔は 16px のまま", () => {
    const pb = paddingBlock(declarationsFor(pages, ".links a"));
    const gap = declarationsFor(pages, ".links").match(/gap:\s*(\d+)px(?:\s+(\d+)px)?/);
    expect(gap, ".links の gap が読めない").toBeTruthy();
    const rowGap = Number(gap![1]);
    expect(rowGap + pb * 2).toBe(ORIGINAL_GAP);
  });
});
