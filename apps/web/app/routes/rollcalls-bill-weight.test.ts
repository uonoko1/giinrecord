import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 採決一覧の議案名（`.rollcalls-item a`）を**太字にしない**ことを守る。Issue 456 / 判断は #453。
 *
 * ## なぜテストで守るのか
 *
 * ここは「見た目の好み」ではなく**設計方針に戻した**変更である:
 *
 * - デザイン方向「台帳」の書体割り当ては「見出し・氏名・数字: Shippori Mincho、本文: BIZ UDPGothic」で、
 *   **議案名についての記述が無い**（＝太字にする根拠が無い）
 * - 承認済みワイヤーフレーム `design/wireframes/Votes.dc.html:52` の議案名は
 *   **ゴシックで `font-weight` の指定が無い（＝400）**。
 *   同じファイルは `.stamp` / 数字 / タブに **`font-weight: 700` を明示して 5 箇所書いている**ので、
 *   議案名の未指定は**書き忘れではなく、そう組む意図**と読める（#456 の PO 質問への回答）
 * - 現行の 700 は `git log -S` で追うと採決ページ初回実装（#33, `5b1a0d72`）から入っており、
 *   **設計判断ではなかった**
 *
 * ## 転送量（実測。推測ではない）
 *
 * 議案名は `/rollcalls` で最も字種が多い（763 字中 722 字）。太字をやめると
 * **BIZ UDPGothic 700 の 55 スライスが本文の 400 と丸ごと共有される**:
 *
 *     ゴシック 700（変更前）  82 件  1,190 KB
 *     ゴシック 400（変更後）  60 件    888 KB   **−302 KB（−25%）**
 *
 * **`font-weight: 700` を書き戻すと 300 KB 増える。** それが見た目からはほとんど分からないので、
 * **目視では守れない。**（#456 実測: 一覧 200 行のうち **197 行は幅・高さ・位置・行高が 1px も動かず**、
 * 変わるのは線の太さだけ。残り 3 行は 48 字の長い議案名で、400 のほうが字幅が狭いぶん
 * **3 行 → 2 行に収まる**。#453 は「行数も同一」と書いたが、それは画面の見えている範囲だけの話だった。
 * はみ出し・切れは before/after とも 0 件。）
 *
 * ## 検査の形
 *
 * `target-size.test.ts` と同じく **jsdom の CSSOM に解析させる**。
 * 自前の正規表現だと、まとめ書き（`.a, .b { … }`）や後勝ちの打ち消しを取りこぼす。
 * **`font-weight` が「無い」ことだけでなく、「効いている値が 400 相当であること」**を見る——
 * どこかに `.rollcalls-item a` を含むまとめ書きで 700 を足されても捕まえるため。
 *
 * ## このファイルが守る範囲は狭い（#464）。番人は隣のブラウザ版
 *
 * **ここは `.rollcalls-item a` という「セレクタ文字列が完全一致する規則」しか見ない。**
 * #464 でレビュアーが実ブラウザで測ったところ、**6 通りの書き方が素通り**した——
 * 親（`.rollcalls-item` / `.rollcalls-list`）からの継承、ショートハンド（`font:`）、
 * 子結合子（`.rollcalls-item > a`）、型セレクタ付き（`li.rollcalls-item a`）、`@media` の中。
 * どれも本番では議案名の computed `font-weight` を **400 → 700 に戻す**（＝ +302 KB が復活する）のに、
 * このファイルは緑のままだった。
 *
 * **その 6 通りを捕まえるのは `rollcalls-bill-weight.browser.test.tsx`**（実ブラウザの computed style）。
 * こちらは**ブラウザ無しで走る速い検査**として残してある:
 *
 * - 直接書き戻す / まとめ書き（`.a, .rollcalls-item a { … }`）/ 別ルールで後から足す
 *   ——この 3 通りは**ここでも捕まる**（#456 で守ると宣言した範囲）
 * - `.members-item__name`（議員名の明朝 700。**別ページ**）は、ブラウザ版が
 *   `/rollcalls` の 1 ページしか描かないので**ここだけが守っている**
 *
 * **`font-weight` の退行を止める番人はブラウザ版のほう。**
 * ここが緑であることは「破られていない」の証明にならない（#464 がまさにそれだった）。
 */
const app = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(app, p), "utf8");

/**
 * そのセレクタに当たる宣言を、**後勝ちを解決した 1 つの宣言ブロック**として返す。
 * `target-size.test.ts` の `declarationsFor` と同じ流儀（同じ理由でブラウザに解析させる）だが、
 * こちらは**最終的に効く値**が要るので、集めた宣言をもう一度 CSSOM に食わせて畳む。
 */
function computedDeclarations(css: string, selector: string): CSSStyleDeclaration {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  const sheet = style.sheet!;
  const collected: string[] = [];
  for (const r of sheet.cssRules) {
    if (!(r instanceof CSSStyleRule)) continue;
    // `.a, .b` の形も、その中に目的のセレクタがあれば拾う
    if (r.selectorText.split(",").map((t) => t.trim()).includes(selector)) collected.push(r.style.cssText);
  }
  style.remove();

  /*
   * **`cssText` は末尾に `;` を含む。** そのまま `";"` で繋ぐと `…none; ;font-weight: 700;` になり、
   * 空の宣言のところで jsdom のパーサが**以降を丸ごと捨てる**——後から足された 700 が
   * 「無い」ことになり、**検査が素通りする**。実際、変異 M3/M4（別ルール／まとめ書きで 700 を足す）が
   * これで生き残った。**落ちなかったときに疑うのは実装ではなく、まずこの fixture 側**（#456）。
   */
  const folded = document.createElement("style");
  folded.textContent = `x { ${collected.map((t) => t.replace(/;\s*$/, "")).join(";")} }`;
  document.head.appendChild(folded);
  const rule = folded.sheet!.cssRules[0] as CSSStyleRule;
  const out = rule.style;
  folded.remove();
  return out;
}

/** BIZ UDPGothic 400 のスライスと共有できる指定か。`normal` と `400` は同じ意味。 */
const IS_REGULAR = (v: string) => v === "" || v === "normal" || v === "400";

describe("採決一覧の議案名は太字にしない（#456 / 判断は #453）", () => {
  const rollcall = read("routes/rollcall.css");

  it(".rollcalls-item a に太字の指定が無い", () => {
    const decl = computedDeclarations(rollcall, ".rollcalls-item a");

    // まずセレクタ自体が生きていることを確かめる。空振りで通るテストにしない
    expect(decl.getPropertyValue("font-size"), ".rollcalls-item a のルールが見つからない").toBe("14.5px");

    expect(
      IS_REGULAR(decl.getPropertyValue("font-weight")),
      `.rollcalls-item a の font-weight が 400 相当でない: ${JSON.stringify(decl.getPropertyValue("font-weight"))}\n` +
        "議案名を太字にする設計根拠は無く（ワイヤーフレーム Votes.dc.html:52 はゴシック 400）、\n" +
        "太字にすると BIZ UDPGothic 700 のスライスを別に読むので /rollcalls が +302 KB になる（#453 実測）",
    ).toBe(true);
  });

  it("議案名の行の見た目（大きさ・行高）は変えていない", () => {
    // 太さ以外を一緒に触ると「ほとんど変わらない」という #453 の判断の前提が崩れる。
    // 改行位置・行数・行高を決めるのはこの 2 つなので、ここを固定して守る。
    const decl = computedDeclarations(rollcall, ".rollcalls-item a");
    expect(decl.getPropertyValue("font-size")).toBe("14.5px");
    expect(decl.getPropertyValue("line-height")).toBe("1.5");
  });

  it("日付行（.rollcalls-meta time）の太字は残っている", () => {
    /*
     * #453 は「議案名の構造は太さではなく**真鍮色の日付行との対比**で出ている」と判断した。
     * 議案名を 400 にしたうえで**日付行まで 400 にすると、その対比が消える**ので、
     * ここは一緒に外してはいけない。**この PBI の範囲外**であることを検査で固定する。
     */
    const decl = computedDeclarations(rollcall, ".rollcalls-meta time");
    expect(decl.getPropertyValue("font-weight")).toBe("700");
  });

  it("議員名（.members-item__name）の明朝 700 は変えていない", () => {
    /*
     * #453 は議員名について「**変えるべきでない**」と判断している。
     * デザイン方向「台帳」に「見出し・**氏名**・数字: Shippori Mincho」と明文があり、
     * 承認済みワイヤーフレーム `Search.dc.html:43` も明朝 700 で組んでいる。
     * 転送量を追ってここまで 400 にする変更が入らないよう、隣のページも一緒に守る。
     */
    const decl = computedDeclarations(read("routes/members.css"), ".members-item__name");
    expect(decl.getPropertyValue("font-family")).toBe("var(--font-head)");
    expect(decl.getPropertyValue("font-weight")).toBe("700");
  });
});
