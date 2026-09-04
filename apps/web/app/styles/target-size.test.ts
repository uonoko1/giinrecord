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

/**
 * 一覧の行の中のリンク 49 箇所の判断（Issue 424・#413 第3段階）。判断の記録は `docs/research/target-size-rows.md`。
 *
 * **49 箇所は 1 箇所も直していない。全部が WCAG 2.5.8 の Spacing 例外に当たる。**
 *
 * 2.5.8 は「24×24 未満を全部大きくしろ」ではない。**小さくても隣と離れていれば合格する**
 * （Spacing 例外: 24px 直径の円を各ターゲットの中心に置いて重ならなければよい ＝ 隣の中心まで 24px 以上）。
 * ビルドした本体を 390px で実測した結果:
 *
 *     /            .row a           27箇所  134〜191×13px    最も近いターゲットの中心まで 30px
 *     /rollcalls   .rollcalls-item a 13箇所  350×21.75px      〃 62.75px
 *     /assemblies  .list__item a      9箇所  350×21px         〃 58px
 *
 * **Spacing 例外を満たさないものは 0 箇所。** よって行の高さを変える必要は無い。
 *
 * ここで守るのは**大きさではなく間隔**である。一度は `padding-block` + 負の `margin-block` で
 * 49 箇所を 25px 以上にする実装を入れたが、revert した——隣の行の文字の上に不可視の当たり判定が
 * かぶさり（`.rows` の箱のすき間が 17px → 5px に縮んだ）、**今より押し間違えやすくなる**ため。
 */
describe("一覧の行の中のリンクは Spacing 例外に当たるので直さない（WCAG 2.5.8・Issue 424）", () => {
  const pages = read("styles/pages.css");
  const rollcall = read("routes/rollcall.css");

  /** 宣言から px の値を読む */
  const px = (decls: string, prop: string): number | undefined => {
    const m = decls.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*(-?[\\d.]+)px`));
    return m ? Number(m[1]) : undefined;
  };
  /** `padding: 8px 0` のまとめ書きと `padding-block` 単独指定の両方から上下の padding を読む */
  const paddingBlock = (decls: string): number | undefined =>
    px(decls, "padding-block") ?? px(decls, "padding-top") ?? px(decls, "padding");

  /**
   * 行の高さ ＝ 上下の padding + 文字の高さ。縦に並ぶリンクの中心間距離はこれと等しい。
   * `line-height` は**このフォントでの実測 1.0**で見積もる（ファイル冒頭の `targetHeight` は 1.2 と
   * 見積もるのでここでは使わない。1.2 で計算すると余裕を過大に見て、詰めすぎを見逃す）。
   */
  const centerDistance = (rowDecls: string, fontSize: number, lineHeight = 1) =>
    (paddingBlock(rowDecls) ?? 0) * 2 + fontSize * lineHeight;

  /**
   * **一番余裕が無いのがここ**。`/` の「出典と更新」は `.row` が縦に密に並び、
   * 中心間が **30px**（必要な 24px に対して余裕 6px）。
   * `padding: 8px 0` を上下あわせて 6px 以上詰めると Spacing 例外を外れて**本当に違反になる**。
   */
  it(".row の行間が 24px を割らない（Spacing 例外の根拠・余裕は 6px しかない）", () => {
    const pad = paddingBlock(declarationsFor(pages, ".row"));
    expect(pad, ".row の上下 padding が読めない").toBeDefined();
    // `.rows { font-size: 13px }` を継承する。line-height は normal（実測 1.0）
    const fontSize = px(declarationsFor(pages, ".rows"), "font-size");
    expect(fontSize, ".rows の font-size が読めない").toBe(13);
    expect(centerDistance(declarationsFor(pages, ".row"), fontSize!)).toBeGreaterThanOrEqual(MINIMUM);
  });

  it(".rollcalls-item の行間が 24px を割らない", () => {
    const link = declarationsFor(rollcall, ".rollcalls-item a");
    const fontSize = px(link, "font-size");
    expect(fontSize, ".rollcalls-item a の font-size が読めない").toBe(14.5);
    expect(centerDistance(declarationsFor(rollcall, ".rollcalls-item"), fontSize!, 1.5)).toBeGreaterThanOrEqual(MINIMUM);
  });

  it(".list__item の行間が 24px を割らない", () => {
    const link = declarationsFor(pages, ".list__item a");
    const fontSize = px(link, "font-size");
    expect(fontSize, ".list__item a の font-size が読めない").toBe(14);
    expect(centerDistance(declarationsFor(pages, ".list__item"), fontSize!, 1.5)).toBeGreaterThanOrEqual(MINIMUM);
  });

  /**
   * **例外に当たるものを「直す」と受け入れない**（Issue 424）。
   * 行の中のリンクに `padding-block` を足すと、行が伸びて一覧が間延びするか、
   * 負の `margin-block` で押し戻して当たり判定が隣の行にかぶるかのどちらかになる。
   * どちらも `docs/research/target-size-rows.md` で「やらない」と決めた。
   */
  it("行の中のリンクに padding / min-height / 負の margin を足していない", () => {
    const offenders: string[] = [];
    for (const [name, css] of [["pages.css", pages], ["rollcall.css", rollcall]] as const) {
      const style = document.createElement("style");
      style.textContent = css;
      document.head.appendChild(style);
      for (const r of style.sheet!.cssRules) {
        if (!(r instanceof CSSStyleRule)) continue;
        for (const sel of r.selectorText.split(",").map((t) => t.trim())) {
          // 「行の中のリンク」を狙ったルールだけを見る。`.links a`（#423）は別の担当なので除く
          if (!/^\.(row|rollcalls-item|list__item)\s+a\b/.test(sel)) continue;
          if (/padding|min-height|margin-block:\s*-/.test(r.style.cssText)) offenders.push(`${name}: ${sel} { ${r.style.cssText} }`);
        }
      }
      style.remove();
    }
    expect(offenders, "行の中のリンクは WCAG 2.5.8 の Spacing 例外に当たる。docs/research/target-size-rows.md を読むこと").toEqual([]);
  });
});
