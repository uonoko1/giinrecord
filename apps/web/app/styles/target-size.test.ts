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
 *                              ※ 現在は padding 5px。**大きさ 22px のままで、間隔 36px で合格している**
 *
 * 指で押す操作では、小さい対象は隣を誤って押す。フッターは「利用規約」と
 * 「プライバシーポリシー」が縦に並ぶので、押し間違いが起きやすい配置だった。
 *
 * **axe はこれを検出しない**（`target-size` は既定のルールセットに入っていない）。
 * 本番10ページで違反0件のときに、手で測って見つけた。
 *
 * 検査は**ソース（CSS と inline style）に対して**行う。ブラウザでの実測は
 * フォント読み込みのタイミングで値が変わる（実際、途中の値を見て誤報を出しかけた）。
 *
 * ## 読む前に: この達成基準は「大きさ **または** 間隔」である
 *
 * **24×24 未満＝違反ではない。** 2.5.8 には例外があり、小さくても隣のターゲットの中心まで
 * 24px 以上離れていれば **Spacing 例外**で合格する（文の中のリンクは **Inline 例外**）。
 * 判断の記録は `docs/research/target-size-inline.md` と `docs/research/target-size-rows.md`。
 *
 * このファイルの検査は 2 種類あり、**混ぜないこと**:
 *
 *     `sizeOnlyHeight` を使うもの   大きさで合格しているもの（フッター・元職チェック）を、
 *                                  大きさが縮まないように守る
 *     `centerDistance` を使うもの   間隔で合格しているもの（.row / 表 / テーマ切替）を、
 *                                  間隔が詰まらないように守る
 *
 * **`sizeOnlyHeight` が 24 を割ることは、それ自体では違反の証明にならない**（テーマ切替がその例:
 * 大きさ 22px だが間隔 36px で合格）。ヘルパの doc コメントに「見えないもの」を列挙してある。
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
  // **`cssText` は末尾に `;` を含む**（jsdom 26 で確認: `"color: red;"`）。そのまま `";"` で
  // 繋ぐと `"color: red;;font-weight: 700;"` と**空の宣言**ができ、**CSSOM に食わせ直したとき
  // それ以降が丸ごと捨てられる**（実測で `font-weight` が `""` になる）。#456 では実際に
  // これで変異 M3・M4 が生き残った。**空白で繋ぐ**——`;` は各 `cssText` が既に持っている。
  return out.map((t) => t.trim()).filter(Boolean).join(" ");
}

/**
 * **このサイトのフォントでの `line-height: normal`。実測 1.0。**
 *
 * `--font-body` は自サイト配信の `BIZ UDPGothic`（`public/fonts/`, #168）で、CSS に
 * `line-height: 1` の指定は無い。にもかかわらず行の箱は**文字の大きさそのまま**になる。
 * Chromium で実測した値（`font-size` 11/12/13/14/15/16/17/18px、weight 400/700 の全てで比 1.0。
 * 14.5px だけ 15px に丸められる）:
 *
 *     font-family                                  13px での箱
 *     BIZ UDPGothic（実際に使われる）                    13px  ← 比 1.0
 *     フォント未読み込み時のフォールバック                  18px  ← 比 1.385
 *
 * 以前ここは 1.2 と見積もっていた。**実物を 20% 過大に見る**ので、足りていない箱を
 * 「足りている」と通してしまう（#431）。**小さく見積もるほうへ倒す**——見積もりが実物より
 * 甘くならないほうが安全なため。
 *
 * **フォントを変えるときは、この値を測り直すこと。** 大きくなるぶんには安全側だが、
 * フォールバックのほうが箱が大きいので「フォントが落ちると通る」向きの誤差は残る。
 */
const LINE_HEIGHT_NORMAL = 1;

/**
 * ## 実物を測るときの落とし穴（#431 で 2 つとも踏んだ。測る前に読むこと）
 *
 * `docs/research/target-size-inline.md` は「`document.fonts.ready` を待つ」までしか
 * 書いていない。**それだけでは足りない。**
 *
 * 1. **ページごとに新しいタブを開く。**
 *    1 つのタブで SPA 遷移しながら測ると、**フォント適用途中の値が混ざる**
 *    （テーマ切替で 22px と 27px が混在した）。新しいタブなら 8/8 で 22px に揃う。
 *    `document.fonts.ready` は**遷移後の再適用までは待ってくれない**。
 *
 * 2. **本番と同じフォントを全部読み込ませる。**
 *    再現用の小さな HTML に woff2 を数枚だけ読ませて測ると、
 *    **`unicode-range` に無い文字がフォールバックに落ちて別の数字が出る。**
 *    実際に「昼」「夜」（U+663C / U+591C）を含むスライスを読み忘れ、
 *    フォールバック（比 1.385）の 27px を「実測」と誤って報告した。
 *    **必ず `CSS.getPlatformFontsForNode` で「実際に描画に使われた face」を確認する。**
 *    face が `BIZ UDPGothic` 単独でなければ、その数字は本番の値ではない。
 */

/** `12px` のような長さを読む。px 以外の単位（rem/em/%）は**読めないものとして扱う**（0 とみなさない） */
function px(value: string): number | undefined {
  const m = /^(-?[\d.]+)px$/.exec(value.trim());
  if (m) return Number(m[1]);
  return /^0$/.test(value.trim()) ? 0 : undefined;
}

/**
 * 宣言列から、最後に効く宣言の値を取る（**後勝ち**。CSS の上書きと同じ）。
 * `padding: 8px 0; padding-bottom: 0` のような打ち消しを取りこぼさないため。
 */
function lastValue(decls: string, prop: string): string | undefined {
  let found: string | undefined;
  for (const d of decls.split(";")) {
    const m = new RegExp(`^\\s*${prop}\\s*:\\s*(.+)$`).exec(d);
    if (m) found = m[1].trim();
  }
  return found;
}

/**
 * **`line-height` は継承する。** だから「その要素に書いてあるか」だけを見てはいけない。
 *
 * ここが #470 の穴だった。`.row` の行の高さは `.row` と `.row a` からしか `line-height` を
 * 読んでおらず、しかも **`.row a` という規則は `pages.css` に 1 つも無い**。よって
 * `.rows { line-height: 0.5 }` を足して**実物の行が半分に潰れても、検査は緑のまま**だった。
 *
 * `.assembly-sessions td` 側が `line-height: 0.1` を捕まえていたのは継承を解いていたからではなく、
 * **たまたま変異を td 自身（= 読んでいる規則）に入れたから**である。親の
 * `.assembly-sessions { line-height: 0.1 }` は**そちらも同じく素通りしていた**（実際に確認した）。
 * つまり「`.row` だけの非対称」ではなく、**全ての呼び出しに共通の穴**だった。
 *
 * 引数は**内側から外側の順**にセレクタを並べたもの（`[".row a", ".row", ".rows"]`）。
 * CSS の継承と同じく、**最も内側で宣言されているものが勝つ**。どこにも無ければ `undefined` を
 * 返し、呼び出し側が `LINE_HEIGHT_NORMAL` に倒す。
 *
 * **セレクタが 1 つも当たらない場合も `undefined`** になる。存在しないセレクタ（`.row a`）を
 * 鎖に混ぜても壊れないが、**それに気づけないのが元の穴**なので、鎖には必ず
 * 「実際に font-size を継承している親」を含めること。
 *
 * 見えないままなのは**メディアクエリの中の上書き**（`declarationsFor` が `CSSStyleRule` しか
 * 見ないため）と、`line-height: inherit` のような明示的な継承値。
 */
function inheritedLineHeight(css: string, chain: readonly string[]): string | undefined {
  for (const selector of chain) {
    const lh = lastValue(declarationsFor(css, selector), "line-height");
    if (lh !== undefined) return lh;
  }
  return undefined;
}

/**
 * 宣言列のうしろに 1 つ宣言を足す（**後勝ちさせる**ため）。
 *
 * **`;` で素朴に繋がない**——#465（PR #467）と**同じ穴**を自分で作ることになる。
 * `declarationsFor` が返す文字列は `cssText` 由来で**末尾に `;` が付いている**ので、
 * `decls + ";line-height: 0.5"` は `…tabular-nums;;line-height: 0.5` と**空の宣言**を挟む。
 * これを CSSOM に食わせ直すと**それ以降が丸ごと捨てられる**（実測: 再パースすると
 * `line-height` が `""` になり、足したはずの値が消える）。
 *
 * いまの `sizeOnlyHeight` は正規表現の `lastValue` で読むので**たまたま**動くが、
 * **読み手が CSSOM に替わった瞬間に静かに壊れる**類の書き方なので、ここで直しておく。
 */
function withDeclaration(decls: string, prop: string, value: string | undefined): string {
  if (value === undefined) return decls;
  const head = decls.trim().replace(/;$/, "");
  return head === "" ? `${prop}: ${value}` : `${head}; ${prop}: ${value}`;
}

/**
 * **上下の padding を両方**返す。jsdom の CSSOM はまとめ書きを**展開しない**
 * （`padding: 8px 8px 0 8px` はそのまま `padding: 8px 8px 0 8px` で入っている）ので、
 * ここで自分で解く。2値・4値記法で**片方だけ読んで倍にする**のが #431 の穴だった:
 *
 *     padding-block: 6px 0      上 6 下 0 → 6px。片方だけ見て 12px と誤る
 *     padding: 8px 8px 0 8px    上 8 下 0 → 8px。同上
 *
 * 読めない単位（`rem` など）が混じったら `undefined` を返す——**0 とみなして
 * 「足りている」側に倒すことをしない**。
 *
 * **宣言は出現順にたどる**（= カスケードの後勝ち）。プロパティ種別ごとの固定順で解決すると、
 * `.install-link__button` のように `padding-block: 6px` … `padding: 0` … `padding-block: 6px`
 * と 3 つのルールに分かれている場合に**後勝ちを取り違える**（最後の行を消しても緑のままだった。
 * 実測では 29px → 17px に落ちる）。
 */
function paddingBlockPair(decls: string): { top: number; bottom: number } | undefined {
  let top = 0;
  let bottom = 0;
  let unreadable = false;

  /** まとめ書きから上下を取る。padding: 上 右 下 左 / 上 左右 下 / 上下 左右 / 全部 */
  const topBottom = (parts: string[]): [string, string] =>
    parts.length === 1 ? [parts[0], parts[0]]
      : parts.length === 2 ? [parts[0], parts[0]]
      : [parts[0], parts[2]];

  // **宣言の出現順にたどる**（= カスケードの後勝ち）。プロパティ種別ごとの固定順で
  // 解決すると、`padding-block: 6px` … `padding: 0` … の並びで後ろの `padding: 0` を
  // 先に潰してしまい、**後勝ちを取り違える**（#431 のレビューで発覚）。
  for (const d of decls.split(";")) {
    const m = /^\s*(padding(?:-block(?:-start|-end)?|-top|-bottom)?)\s*:\s*(.+)$/.exec(d);
    if (m === null) continue;
    const [prop, value] = [m[1], m[2].trim()];
    // `var(...)` / `calc(...)` は解けない
    if (/[(),]/.test(value)) { unreadable = true; continue; }
    const parts = value.split(/\s+/).filter(Boolean);
    if (parts.length < 1 || parts.length > 4) { unreadable = true; continue; }

    if (prop === "padding" || prop === "padding-block") {
      const [t, b] = prop === "padding"
        ? topBottom(parts)
        : (parts.length === 1 ? [parts[0], parts[0]] : [parts[0], parts[1]]);
      const [pt, pb] = [px(t), px(b)];
      if (pt === undefined || pb === undefined) { unreadable = true; continue; }
      top = pt; bottom = pb;
    } else {
      const n = px(parts[0]);
      if (n === undefined || parts.length !== 1) { unreadable = true; continue; }
      if (prop === "padding-top" || prop === "padding-block-start") top = n;
      else bottom = n;
    }
  }

  return unreadable ? undefined : { top, bottom };
}

/**
 * 押せる範囲の**高さ**（px）。名前のとおり **「大きさ」しか見ない。**
 *
 * ## この検査で見えないもの（過信しないこと・#431）
 *
 * 1. **間隔を見ていない。** WCAG 2.5.8 は「大きさ **または** 間隔」で、
 *    小さくても隣のターゲットの中心まで 24px 以上あれば **Spacing 例外で合格**する。
 *    **ここが 24 を割ること＝違反、ではない。** 実際、テーマ切替のラベルは
 *    **大きさ 22px（足りない）・間隔 36px（合格）** で、間隔のほうで合格している。
 *    「大きさが足りない」と出たら、`docs/research/target-size-inline.md` の判断基準に沿って
 *    間隔を測ること。間隔まで自動で見たいなら (C) の実測しかない（下記）。
 * 2. **ソースの CSS を読んでいるだけで、描画された箱ではない。** よって:
 *    - **親の flex / grid による引き伸ばし**が見えない（`align-items: stretch` なら
 *      兄弟の高さに揃う）。**このサイトで現に起きてはいない**——テーマ切替の `fieldset` に
 *      `align-items` の指定は無く、computed も `normal`。見積もり 22px と実測 22px は一致する。
 *    - **継承が自動では解けない。** `font-size` は呼ぶ側が「どの親から継承するか」を選んで
 *      CSS から読んで渡している（数値の決め打ちはしない。#431）。継承元を取り違えても気づけない。
 *    - **折り返し**が見えない。2行になれば箱は倍近くなる（安全側なので許容している）。
 *    - **フォントが替われば比も替わる**のが見えない。`LINE_HEIGHT_NORMAL` は
 *      BIZ UDPGothic の 1.0 なので、配信スライスに無い文字でフォールバックが混ざると
 *      行の箱は**これより大きく**なる（比 1.385）。**安全側にずれる**ので通す側には倒れない。
 *      なお `OS に合わせる` の和欧混在は実際には face が替わらない（latin スライスも配信している）。
 *    - `border` / `box-sizing` / メディアクエリの中の上書きが見えない。
 * 3. **ここに書いたセレクタしか見ていない。** 新しく押せるものが増えても自動では気づかない。
 *
 * ## なぜソース検査のままにしたか（#431 の選択肢 A/B/C）
 *
 * - **(B) jsdom に計算させる**: jsdom はフォントを持たないので `line-height: normal` を
 *   1.0 で再現できず（そもそもレイアウトをしない）、**この検査の肝がまさに再現できない**。
 * - **(C) Playwright で実測**: 最も確実で、間隔も測れる。ただしフォント読み込み待ちが
 *   不安定（#400 で flaky に苦しみ、`docs/research/target-size-inline.md` でも
 *   「待たずに測ると 7 箇所を違反と誤って数えた」と記録がある）。
 * - **(A) ソースを正しく読む**（採用）: 安いが、上の「見えないもの」が残る。
 *   **残る穴を書いておくほうが、守れているつもりで漏らすより安全**という判断。
 */
function sizeOnlyHeight(decls: string, fontSize: number): number {
  const min = px(lastValue(decls, "min-height") ?? "") ?? 0;
  const pad = paddingBlockPair(decls);
  if (pad === undefined) return Number.NaN; // 読めない値は「通す」のではなく落とす
  // line-height: 数値なら font-size 倍、px ならそのまま、無指定なら normal（このフォントで 1.0）
  const lh = lastValue(decls, "line-height");
  let lineBox: number;
  if (lh === undefined || lh === "normal") lineBox = fontSize * LINE_HEIGHT_NORMAL;
  else if (px(lh) !== undefined) lineBox = px(lh)!;
  else if (/^[\d.]+$/.test(lh)) lineBox = fontSize * Number(lh);
  else return Number.NaN; // rem / % / calc は読めない
  return Math.max(min, pad.top + pad.bottom + lineBox);
}

const MINIMUM = 24;

describe("押せる範囲の**大きさ**が 24px 以上（WCAG 2.5.8・Issue 413）", () => {
  const pages = read("styles/pages.css");

  /**
   * 継承元の `font-size` を CSS から読む。**数値を直接書かない**——
   * かつて `12` `13` と決め打ちしていたので、CSS 側で `font-size` を小さくされても
   * テストの計算は元の値のままで、**実物が 24px を割っても気づかなかった**（#431。
   * 例: `.members-check` を 13px → 11px にすると実物 23px だがテストは緑）。
   */
  const fontSizeOf = (css: string, selector: string): number => {
    const m = declarationsFor(css, selector).match(/font-size:\s*([\d.]+)px/);
    expect(m, `${selector} の font-size が読めない`).toBeTruthy();
    return Number(m![1]);
  };

  it("フッターのリンクが 24px を満たす", () => {
    // 文字の大きさは `.site-footer` から継承する
    const fontSize = fontSizeOf(pages, ".site-footer");
    expect(sizeOnlyHeight(declarationsFor(pages, ".site-footer__links a"), fontSize)).toBeGreaterThanOrEqual(MINIMUM);
  });

  it("「ホーム画面に追加」のボタンも満たす（リンクと同じ見た目だが button）", () => {
    // `font: inherit` なので同じくフッターの文字の大きさ
    const fontSize = fontSizeOf(pages, ".site-footer");
    expect(sizeOnlyHeight(declarationsFor(pages, ".install-link__button"), fontSize)).toBeGreaterThanOrEqual(MINIMUM);
  });

  it("議員一覧の「元職も含める」が満たす", () => {
    const members = read("routes/members.css");
    expect(sizeOnlyHeight(declarationsFor(members, ".members-check"), fontSizeOf(members, ".members-check")))
      .toBeGreaterThanOrEqual(MINIMUM);
  });

  /**
   * **テーマ切替は「大きさ」では通らない。「間隔」で通っている。**
   *
   * ここが 2.5.8 の「大きさ **または** 間隔」を一番はっきり示す例なので、判断ごと残す。
   * `ThemeToggle.tsx` は CSS ファイルを持たず inline style で書かれている。
   *
   *     大きさ（このソースから見積もれる値）  5px × 2 + 12px = 22px  ← 24 に**足りない**
   *     大きさ（本番・390px で実測）          32 × 22px            ← 見積もりと一致
   *     隣のラベルの中心までの距離（実測）      36px                 ← Spacing 例外に**合格**
   *
   * かつてここは `padding × 2 + fontSize × 1.2` = 24.4 で「24 を満たす」と通していた。
   * **1.2 が実物より 20% 大きいだけで、満たしているように見えていた**（#431）。
   * 実測 1.0 に直すと 22px になる。**だからといって違反ではない**——間隔 36px で合格する。
   *
   * よってここで守るのは「22px を 24px にすること」ではなく、
   * **合格の根拠である間隔（横に並ぶラベルの中心間 24px 以上）を壊さないこと**。
   * 間隔は「ラベルの幅 + `gap`」で決まるので、幅を痩せさせる padding と gap を見る。
   */
  it("テーマ切替は大きさでは 24px に足りないが、間隔で Spacing 例外に当たる", () => {
    const src = read("components/ThemeToggle.tsx");
    const padding = src.match(/padding:\s*"(\d+)px (\d+)px"/);
    expect(padding, "label の padding が読めない").toBeTruthy();
    const [vertical, horizontal] = [Number(padding![1]), Number(padding![2])];
    const fontSize = Number(src.match(/fontSize:\s*(\d+)/)?.[1] ?? 12);

    // 1. 大きさは足りていない。**この事実をそのまま書いておく**（「満たす」と偽らない）
    expect(vertical * 2 + fontSize * LINE_HEIGHT_NORMAL).toBeLessThan(MINIMUM);

    // 2. 合格の根拠は間隔。最も詰まっているのは「昼」「夜」（1文字 = fontSize 幅）が隣り合うところ。
    //    中心間 = ラベルの幅（左右 padding + 文字1つ）+ fieldset の gap。実測 36px と一致する。
    const gap = Number(src.match(/gap:\s*(\d+)/)?.[1] ?? 0);
    const centerDistance = horizontal * 2 + fontSize + gap;
    expect(centerDistance, "隣のラベルとの中心間が 24px を割ると Spacing 例外を外れて本当の違反になる")
      .toBeGreaterThanOrEqual(MINIMUM);
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
 * line-height は **1.0**（実測どおり。`LINE_HEIGHT_NORMAL`）。1.2 で見積もると padding 5px でも
 * 通ってしまうが、実物は 23px で足りない。
 */
describe("ページ下部の移動リンク（.links）が 24px を満たす（Issue 423）", () => {
  const pages = read("styles/pages.css");
  const FONT_SIZE = 13;
  const ORIGINAL_GAP = 16; // 直す前の `.links { gap: 16px }`。見た目の間隔はこれを保つ

  /**
   * 上下の padding の合計。**上下を別々に読む**——ここはかつて片方だけ読んで 2 倍しており、
   * `padding-block: 6px 0`（実物 19px）を 25px と誤って通していた（#431）。
   */
  const paddingSum = (decls: string): number => {
    const pad = paddingBlockPair(decls);
    expect(pad, ".links a の上下 padding が読めない").toBeDefined();
    return pad!.top + pad!.bottom;
  };

  it("リンクの高さが 24px 以上（文字 13px + 上下の padding）", () => {
    expect(sizeOnlyHeight(declarationsFor(pages, ".links a"), FONT_SIZE)).toBeGreaterThanOrEqual(MINIMUM);
  });

  it("縦の gap を padding の分だけ減らしてあり、行と行の見た目の間隔は 16px のまま", () => {
    const pb = paddingSum(declarationsFor(pages, ".links a"));
    const gap = declarationsFor(pages, ".links").match(/gap:\s*(\d+)px(?:\s+(\d+)px)?/);
    expect(gap, ".links の gap が読めない").toBeTruthy();
    const rowGap = Number(gap![1]);
    expect(rowGap + pb).toBe(ORIGINAL_GAP);
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
  /**
   * 上下の padding の合計。**まとめ書きの上下を別々に読む**（ファイル冒頭の共通の解析器を使う）。
   * かつてここは 1 値目だけを読んで 2 倍しており、`padding: 8px 0 0 0`（下を消す 4値記法）で
   * 実物が 30px → 22px に縮んでも素通りしていた（#431）。
   */
  const paddingBlock = (decls: string): number | undefined => {
    const pad = paddingBlockPair(decls);
    return pad === undefined ? undefined : pad.top + pad.bottom;
  };

  /**
   * 行の高さ ＝ 上下の padding + 文字の箱。縦に並ぶリンクの中心間距離はこれと等しい。
   *
   * **`line-height` は呼び出し側の決め打ちではなく CSS から読む**（#431）。
   * 以前は引数の既定値 1 を使っていたので、CSS に `line-height: 0.1` を足されても
   * テストの計算は 1 のままで、**実物が縮んでも気づかなかった**。
   *
   * さらに **`line-height` は継承する**（#470）。以前はリンク側の宣言 1 つしか見ておらず、
   * しかも `.row a` という規則は存在しないので、`.rows { line-height: 0.5 }` が素通りしていた。
   * いまは `lineHeightChain`（**内側から外側の順**）を渡し、`inheritedLineHeight` に
   * CSS の継承と同じ順で解かせる。どこにも宣言が無いときだけ `LINE_HEIGHT_NORMAL`
   * （このフォントの実測 1.0）に倒れる。
   *
   * padding は**行の箱のもの**を使う（リンクではなく行が中心間距離を決めるため）ので、
   * 継承で解いた `line-height` を行の宣言のうしろに足して**後勝ち**させる。
   */
  const centerDistance = (
    css: string,
    rowSelector: string,
    fontSize: number,
    lineHeightChain: readonly string[],
  ) => {
    const lh = inheritedLineHeight(css, lineHeightChain);
    const decls = withDeclaration(declarationsFor(css, rowSelector), "line-height", lh);
    return sizeOnlyHeight(decls, fontSize);
  };

  /**
   * **一番余裕が無いのがここ**。`/` の「出典と更新」は `.row` が縦に密に並び、
   * 中心間が **30px**（必要な 24px に対して余裕 6px）。
   * `padding: 8px 0` を上下あわせて 6px 以上詰めると Spacing 例外を外れて**本当に違反になる**。
   */
  it(".row の行間が 24px を割らない（Spacing 例外の根拠・余裕は 6px しかない）", () => {
    const pad = paddingBlock(declarationsFor(pages, ".row"));
    expect(pad, ".row の上下 padding が読めない").toBeDefined();
    // `.rows { font-size: 13px }` を継承する。line-height も**同じ鎖から**読む（#470）——
    // `.row a` は規則が存在しないので、ここを `.row a` だけにすると親の指定が届かない。
    const fontSize = px(declarationsFor(pages, ".rows"), "font-size");
    expect(fontSize, ".rows の font-size が読めない").toBe(13);
    expect(centerDistance(pages, ".row", fontSize!, [".row a", ".row", ".rows"])).toBeGreaterThanOrEqual(MINIMUM);
  });

  it(".rollcalls-item の行間が 24px を割らない", () => {
    const link = declarationsFor(rollcall, ".rollcalls-item a");
    const fontSize = px(link, "font-size");
    expect(fontSize, ".rollcalls-item a の font-size が読めない").toBe(14.5);
    expect(centerDistance(rollcall, ".rollcalls-item", fontSize!, [".rollcalls-item a", ".rollcalls-item", ".rollcalls-list"]))
      .toBeGreaterThanOrEqual(MINIMUM);
  });

  it(".list__item の行間が 24px を割らない", () => {
    const link = declarationsFor(pages, ".list__item a");
    const fontSize = px(link, "font-size");
    expect(fontSize, ".list__item a の font-size が読めない").toBe(14);
    expect(centerDistance(pages, ".list__item", fontSize!, [".list__item a", ".list__item", ".list"]))
      .toBeGreaterThanOrEqual(MINIMUM);
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

/**
 * 散文の中のリンク 46 箇所の判断（Issue 425・#413 第4段階）。判断の記録は `docs/research/target-size-inline.md`。
 *
 * **46 箇所は 1 箇所も直していない。全部が WCAG 2.5.8 の例外に当たる。**
 *
 * 2.5.8 は「24×24 未満を全部大きくしろ」ではない。**小さくても隣と離れていれば合格する**（Spacing 例外:
 * 24px 直径の円を各ターゲットの中心に置いて重ならなければよい ＝ 隣の中心まで 24px 以上）。
 * 実測した 46 箇所の**最小の間隔は 52px**（必要な 24px の 2 倍以上）。うち 14 箇所は文の中にあるので
 * Inline 例外（"inline targets in sentences"）にも当たる。
 *
 * ここで守るのは**大きさではなく間隔**である。行間を変えずに満たしているので、
 * 「24 にするための padding」を足す必要はない——足すと当たり判定が隣の行にかぶって**今より悪くなる**。
 */
describe("散文の中のリンクは例外に当たるので直さない（WCAG 2.5.8・Issue 425）", () => {
  const assemblies = read("routes/assemblies.css");
  const pages = read("styles/pages.css");

  /**
   * 一番余裕が無いのが `/coverage` と `/assemblies/pref-31` の「表決結果（公式）」で、
   * 縦に並ぶ間隔が **52px**。これは `.assembly-sessions` の td の padding と行の高さで決まる。
   * ここを詰めると Spacing 例外を外れて**本当に違反になる**ので、詰めさせない。
   *
   * **`padding` だけでなく `line-height` も見る**（#431）。かつてここは `padding` の 1 値目しか
   * 読んでおらず、次の 2 つを**どちらも素通り**させていた:
   *
   *     padding: 8px 8px 0 8px   4値記法。下 padding が消えても 1 値目 8px しか見ない
   *     line-height: 0.1         padding は 8px のままなので気づかない。実測 20.5px = 違反 14 件
   *
   * 行の高さ = 上下 padding + 文字の箱（`line-height` 無指定ならこのフォントの実測 1.0）。
   */
  it("表の行の間隔が 24px を割らない（Spacing 例外の根拠・padding と line-height の両方）", () => {
    const decls = declarationsFor(assemblies, ".assembly-sessions td");
    const pad = paddingBlockPair(decls);
    expect(pad, ".assembly-sessions td の上下 padding が読めない").toBeDefined();
    expect(pad!.top + pad!.bottom, ".assembly-sessions td の上下 padding が消えている").toBeGreaterThan(0);
    // `.assembly-sessions { font-size: 13px }` を継承する
    const fontSize = Number(declarationsFor(assemblies, ".assembly-sessions").match(/font-size:\s*([\d.]+)px/)?.[1]);
    expect(fontSize, ".assembly-sessions の font-size が読めない").toBe(13);
    // **`line-height` も同じ鎖から読む**（#470）。ここは td 自身の宣言だけを見ていたので、
    // `.assembly-sessions td { line-height: 0.1 }` は捕まえられても、
    // **親の `.assembly-sessions { line-height: 0.1 }` は素通りしていた**（実際に確認した）。
    const lh = inheritedLineHeight(assemblies, [".assembly-sessions td", ".assembly-sessions"]);
    // 1 行だけの行でも中心間が 24px 以上あること
    expect(sizeOnlyHeight(withDeclaration(decls, "line-height", lh), fontSize))
      .toBeGreaterThanOrEqual(MINIMUM);
  });

  /**
   * **例外に当たるものを「直す」と受け入れない**（Issue 425）。散文のリンクに padding や min-height を
   * 足すと行間が崩れて読みにくくなる。Understanding 文書も "It is more important to set the
   * line height to a value that improves readability" と書いている。
   * ここは CSSOM に全ルールを見せて、文章の中のリンクを狙った指定が増えていないかを見る。
   */
  it("文の中のリンク（.note / .card__body / .body）に padding や min-height を足していない", () => {
    const offenders: string[] = [];
    for (const css of [pages, assemblies]) {
      const style = document.createElement("style");
      style.textContent = css;
      document.head.appendChild(style);
      for (const r of [...style.sheet!.cssRules]) {
        if (!(r instanceof CSSStyleRule)) continue;
        // 「散文のブロック」の中の a を狙ったルールだけを見る（.links や .row は #423 #424 の担当なので除く）
        for (const sel of r.selectorText.split(",").map((t) => t.trim())) {
          if (!/\.(note|card__body|body)\b/.test(sel) || !/\ba\b|a$/.test(sel)) continue;
          if (/padding|min-height|display:\s*inline-block/.test(r.style.cssText)) offenders.push(`${sel} { ${r.style.cssText} }`);
        }
      }
      style.remove();
    }
    expect(offenders, "散文の中のリンクは WCAG 2.5.8 の Inline 例外に当たる。docs/research/target-size-inline.md を読むこと").toEqual([]);
  });
});

/**
 * `declarationsFor` そのものの検査（Issue 465）。
 *
 * **ここが静かに壊れると、上の検査すべてが素通りする。**
 * `r.style.cssText` は**末尾に `;` を含む**（jsdom 26 で確認: `"color: red;"`）。
 * それを `";"` で繋ぐと `"color: red;;font-weight: 700;"` になり、**空の宣言**ができる。
 * 空宣言に当たると **jsdom の CSSOM はそれ以降を丸ごと捨てる**
 * （実測: `font-weight` が `""` になる）。
 *
 * 現状の呼ばれ方では 1 つの規則しか当たらないので露見していないが、
 * **まとめ書きや後勝ちの打ち消しが増えた瞬間に**、2 つ目以降の宣言が消える。
 * #456 では実際にこれで変異 M3・M4 が生き残り、**原因は実装ではなくこのヘルパ**だった。
 */
describe("declarationsFor が複数の規則の宣言を落とさない（Issue 465）", () => {
  const CSS = `
    .two { font-size: 12px; }
    .two { padding-block: 6px; }
    .other { color: blue; }
  `;

  it("2 つの規則が当たったとき、両方の宣言が読める", () => {
    const decls = declarationsFor(CSS, ".two");
    expect(lastValue(decls, "font-size"), `1 つ目の規則が読めない: ${decls}`).toBe("12px");
    expect(lastValue(decls, "padding-block"), `2 つ目の規則が読めない: ${decls}`).toBe("6px");
  });

  it("結果に空の宣言が無い（あると CSSOM に食わせたとき以降が捨てられる）", () => {
    const decls = declarationsFor(CSS, ".two");
    const empties = decls.split(";").filter((d, i, a) => d.trim() === "" && i < a.length - 1);
    expect(empties, `空の宣言がある: ${JSON.stringify(decls)}`).toEqual([]);
  });

  /**
   * **CSSOM に往復させても両方残る。** #461 のレビュアーはこの形で穴を見つけた。
   * `split(";")` で読む現在の呼び出し側は空宣言に耐えるが、
   * ブラウザと同じ解析に戻した瞬間に**黙って落ちる**ので、ここで固定しておく。
   */
  it("CSSOM に食わせ直しても両方の宣言が生き残る", () => {
    const probe = document.createElement("div");
    probe.style.cssText = declarationsFor(CSS, ".two");
    expect(probe.style.getPropertyValue("font-size")).toBe("12px");
    expect(probe.style.getPropertyValue("padding-block"), "空宣言の後ろが捨てられている").toBe("6px");
  });

  /** 宣言どうしが**くっつかない**こと。`join("")` だと `…12px;padding-block` と繋がって読めなくなる */
  it("宣言どうしが区切られている（隣り合う値が繋がらない）", () => {
    const decls = declarationsFor(".s { color: red } .s { font-size: 12px }", ".s");
    expect(decls).toMatch(/;\s+font-size/);
  });

  /**
   * **中身が空の規則**（`.x { }` や、コメントだけの規則）が混ざっても空の宣言を作らない。
   * jsdom はこれを `cssText === ""` で返す（実測: `.e { } .e { color: red }` → `["", "color: red;"]`）ので、
   * 落としておかないと繋いだ結果の先頭に空宣言が残る。
   */
  it("中身が空の規則が混ざっても空の宣言を作らない", () => {
    const decls = declarationsFor(".e { } .e { color: red } .e { /* だけ */ }", ".e");
    expect(decls).toBe("color: red;");
    const probe = document.createElement("div");
    probe.style.cssText = decls;
    expect(probe.style.getPropertyValue("color")).toBe("red");
  });

  it("後勝ちの打ち消しが 2 つの規則にまたがっても正しく解ける", () => {
    const decls = declarationsFor(".p { padding-block: 6px; } .p { padding: 0; }", ".p");
    expect(paddingBlockPair(decls)).toEqual({ top: 0, bottom: 0 });
  });

  it("当たらないセレクタでは空文字を返す", () => {
    expect(declarationsFor(CSS, ".nope")).toBe("");
  });
});
