import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
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

/** `background: transparent` の目印。地が透けるので、実際の地は `--paper` になる */
const TRANSPARENT = "transparent";

/** `:root { … }`（ライト）の中の `--name` を読む。ダークは別ブロックなので拾わない */
function lightToken(name: string): string {
  const root = tokens.slice(tokens.indexOf(":root {"), tokens.indexOf("@media"));
  const m = root.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`));
  if (!m) throw new Error(`--${name} が :root に無い`);
  return m[1];
}

/**
 * ダークで実際に効く `--name` を読む。
 *
 * ダークのブロックは**全部のトークンを書き直してはいない**。書いていないものは
 * `:root`（ライト）の値がそのまま残る（CSS のカスケード）。実測すると `--brass-on-cover` が
 * それで、ダークでも `#d8b86a` のまま使われる。**ダークのブロックだけ見ると取り落とす**ので、
 * 無ければライトに落とす。
 */
function darkToken(name: string): string {
  const root = tokens.slice(tokens.indexOf(':root[data-theme="dark"] {'));
  const m = root.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`));
  if (m) return m[1];
  if (new RegExp(`--${name}:\\s*transparent`).test(root)) return TRANSPARENT;
  return lightToken(name); // ダークで上書きしていない ＝ ライトの値が残る
}

/** `@media (prefers-color-scheme: dark)` 側の `--name`。darkToken と同じ落とし方をする */
function mediaDarkToken(name: string): string {
  const block = tokens.slice(tokens.indexOf("@media"), tokens.indexOf(':root[data-theme="dark"] {'));
  const m = block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`));
  if (m) return m[1];
  if (new RegExp(`--${name}:\\s*transparent`).test(block)) return TRANSPARENT;
  return lightToken(name);
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

/* ==========================================================================
 * 入れ子の地を「CSS のテキスト」ではなく **CSSOM に解かせて**求める。Issue 483
 * ========================================================================== */

/**
 * **自前で CSS を解析しない。** #483 の穴はここだった:
 *
 *     expect(member).toMatch(/^\.member-tab \{[^}]*background:\s*none[^}]*color:\s*var\(--muted\)/m)
 *
 * この正規表現は `background: none` が `color` より**前**にあることを要求するだけで、
 * **後ろに足された宣言も、別規則からの上書きも見ない**。レビュアーが実測した素通り（63 件緑のまま）:
 *
 *     .member-tab の宣言の末尾に background: var(--paper) を足す      → 素通り（後勝ち）
 *     .member-tab { background: var(--paper) } をファイル末尾に追記    → 素通り（後勝ち）
 *     .member-tabs .member-tab { background: var(--paper) } を追記    → 素通り（詳細度で勝つ）
 *     .member-tab に box-shadow: inset 0 0 0 100px var(--paper)      → 素通り
 *
 * `target-size.test.ts` の `declarationsFor` が既にこう書いていた:
 * 「**自前で CSS を解析しない**——実際に正規表現を 2 回書き直して 2 回とも取りこぼした」。
 * **#472 / #481 / #483 が 1 日に 3 件、同じ理由で素通りして、それを 3 度目に証明した**
 * （`docs/WORKING_AGREEMENT.md`「CSS や TS を『テキストとして』正規表現で読まない」）。
 *
 * そこで**本物の CSS を jsdom に食わせ、本物と同じ形の DOM を組み、`getComputedStyle` に聞く**。
 * 後勝ち・詳細度・継承は**ブラウザと同じ実装**が解く。実測（jsdom 26）:
 *
 *     .member-tab（素のまま）  background = "rgba(0, 0, 0, 0)"   ← 塗らない。親の地が透ける
 *     上の変異 1・2・3 のどれか  background = "var(--paper)"      ← **どれでも見える**
 *
 * ## ここで見ないもの（塞がない形は「なぜ見ていないか」を書く。#451 の学び）
 *
 * - **`box-shadow` の実効色**。`inset 0 0 0 100px var(--paper)` は実 UI では地を塗り潰すが、
 *   これは**どの実装の `getComputedStyle` でも解けない**——影は `background` に合成されず、
 *   `boxShadow` が影の指定をそのまま返すだけで、それが箱を覆うかは**実際に描いて画素を見ないと**
 *   決まらない（#464 の Playwright を持ち込んでも `getComputedStyle` のままでは同じ。
 *   スクリーンショットの画素を読むところまで行けば解けるが、**そこまでの重さは要らない**）。
 *   **代わりに `box-shadow` が付いていたら答えを返さず落とす**——「地は --est-bg だ」と
 *   言い切れなくなったことを黙って通さないため。**「答えられない」と言えれば守りとしては足りる。**
 * - **at-rule の中の上書き**。jsdom の `getComputedStyle` は at-rule の中身を評価しない。
 *   `@media` だけの話ではなく、**`@supports` も `@layer` も同じ**（Issue 498。#492 は
 *   `@media` しか挙げていなかったが、レビュアーが 3 形とも 72 件緑で素通りすることを実測した）。
 *   **いまは「見ない」ではなく「入ってきたら落とす」**——`mount` が `assertAllCssReadable` を
 *   呼び、`CSSStyleRule` 以外に出会ったら答えを返さずに落とす（`box-shadow` と同じ流儀）。
 *   `tokens.css` の `@media (prefers-color-scheme: dark)` だけは**実在するので通す**が、
 *   「`tokens.css` だから」ではなく「**`:root` にカスタムプロパティしか設定していないから**」通す。
 *   これはトークンの値の話で、**どの箱が地を敷くかは変えない**（値は `darkToken` 側で別に固定）。
 * - **inline style**。ここで組む DOM は `className` だけを持つ。`member.tsx` / `compare.tsx` の
 *   該当箇所に `style=` は無い（`grep -c 'style=' member.tsx compare.tsx` → 0 / 0）。
 */
const NOT_PAINTED = new Set(["", "none", "transparent", "rgba(0, 0, 0, 0)"]);

/** 本番と同じ CSS を全部読む。地は別のファイルの規則から敷かれることがあるので**まとめて**食わせる */
const TOKENS_FILE = "styles/tokens.css";
const CSS_FILES = [TOKENS_FILE, "styles/pages.css", "routes/member.css", "routes/compare.css"] as const;
const CSS_TEXTS: readonly (readonly [string, string])[] = CSS_FILES.map((p) => [p, readFileSync(join(import.meta.dirname, "..", p), "utf8")] as const);
const ALL_CSS = CSS_TEXTS.map(([, text]) => text).join("\n");

/* --------------------------------------------------------------------------
 * `getComputedStyle` が見ない領域に規則が入ったことを知る（Issue 498）
 * -------------------------------------------------------------------------- */

/**
 * **jsdom の `getComputedStyle` は at-rule の中身を評価しない。**
 * 実測（jsdom 26。下の「素通りする形」の検査が同じことを毎回測り直す）:
 *
 *     @media (min-width: 1px)   { .member-tab { background: var(--paper) } }  → 素通りした
 *     @supports (display: flex) { .member-tab { background: var(--paper) } }  → 素通りした
 *     @layer x                  { .member-tab { background: var(--paper) } }  → 素通りした
 *
 * **実 UI では地が紙になるのに、72 件が緑のままだった**（#492 のレビュアーが実測）。
 * ここは #481 のような実ブラウザを持ち込まない——知りたいのは
 * 「**この検査が見ていない領域に規則が入ったか**」だけで、それは CSSOM で足りる
 * （実ブラウザは +14 秒。`docs/WORKING_AGREEMENT.md` の「見ない範囲を残すのは構わない。書かないのが問題」）。
 *
 * **allowlist にする。** 「`CSSStyleRule` 以外を弾く」ではなく
 * 「**`CSSStyleRule` だけを許す**」と書く。`@media` / `@supports` / `@layer` を名指しで
 * 除ける形（暗黙の denylist）だと、`@container` / `@scope` のような**新しい at-rule が来るたびに穴が増える**
 * （#333 / #499 の学び）。実測で `CSSContainerRule` も `CSSScopeRule` も存在するので、これは机上の心配ではない。
 */
const UNDERSTOOD_RULE_TYPES: ReadonlySet<string> = new Set(["CSSStyleRule"]);

/**
 * `tokens.css` の `@media (prefers-color-scheme: dark)` は**実在するので落としてはいけない**。
 *
 * ただし「`tokens.css` なら何でも許す」にはしない——それだと
 * `@media` の中身を `.member-tab { background: var(--paper) }` にすり替えたときに黙る
 * （**allowlist は「痩せたら落とす」だけでなく「中身が入れ替わったら落とす」まで**。#499 の学び）。
 * 許すのは「**`:root` にカスタムプロパティだけを設定する規則**」に限る。
 * これはトークンの**値**の話で、**どの箱が地を敷くかは変えない**ので、
 * `backgroundTokenOf` が解く「実効背景がどのトークンか」には影響しない
 * （ダークの値そのものは `darkToken` / `mediaDarkToken` 側で別に固定してある）。
 */
function onlyRedefinesRootTokens(rule: CSSStyleRule): boolean {
  if (!/^:root\b/.test(rule.selectorText.trim())) return false;
  /*
   * 宣言は**名前を列挙して**見る（`cssText` を正規表現で読まない。#465 → #470 の罠）。
   * jsdom の `CSSStyleDeclaration` は `item()` を持たないが**反復可能**で、実測すると
   * `--paper` / `--ink` のようなカスタムプロパティ名がそのまま出る（`background` なども同様）。
   */
  const names = Array.from(rule.style as Iterable<string>);
  if (names.length === 0) return false; // 空の規則を「無害」と数えない
  return names.every((name) => name.startsWith("--"));
}

/**
 * その CSS の中で、**この検査が読めない規則**を全部集めて名前で返す（空なら全部読めた）。
 *
 * `cssText` を繋いで正規表現で見ない（#465 → #470 の罠）。**CSSOM のオブジェクトを歩く**。
 * `@media` の中に `@supports` が入る形があるので**再帰**する——トップレベルだけ見ると
 * 一段包むだけで素通りする。
 */
function unreadableRules(css: string, allowRootTokenAtRules: boolean): string[] {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  try {
    const sheet = style.sheet;
    /*
     * **`sheet` が `null` になることがある。** 実測: `@scope (.x) { … }` と CSS の入れ子（`& …`）は
     * jsdom が**シートまるごと落とす**（`document.styleSheets.length` が 0 になる）。
     * そうなると `mount` した CSS が**一つも効かない**まま `getComputedStyle` が答えるので、
     * 「読めなかった」ではなく「読んだ結果」に見えてしまう。**黙って空集合を返さない。**
     */
    if (!sheet) return ["シートを jsdom が解析できなかった（@scope や CSS の入れ子など。CSS が一つも効かない状態になる）"];
    const unreadable: string[] = [];
    const walk = (rules: CSSRuleList): void => {
      for (const rule of Array.from(rules)) {
        const kind = rule.constructor.name;
        if (UNDERSTOOD_RULE_TYPES.has(kind)) continue;
        if (allowRootTokenAtRules && kind === "CSSMediaRule") {
          const inner = (rule as CSSMediaRule).cssRules;
          // 中身が「:root にカスタムプロパティだけ」なら、地の話に影響しないので通す
          if (inner.length > 0 && Array.from(inner).every((r) => r.constructor.name === "CSSStyleRule" && onlyRedefinesRootTokens(r as CSSStyleRule))) continue;
        }
        unreadable.push(`${kind}: ${firstLine(rule)}`);
        if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules);
      }
    };
    walk(sheet.cssRules);
    return unreadable;
  } finally {
    style.remove();
  }
}

/** 落ちたときにどの規則かを言えるように、前置き（`@media (…)`）だけを出す */
function firstLine(rule: CSSRule): string {
  return rule.cssText.split("{")[0].trim().slice(0, 80);
}

/** `var(--muted)` → `"muted"`。トークン 1 つでない値（`#fff`・`red`・複数）は `undefined` */
function tokenName(value: string): string | undefined {
  const m = /^var\(\s*--([a-z-]+)\s*\)$/.exec(value.trim());
  return m ? m[1] : undefined;
}

/**
 * 本物の CSS を敷いた上に、本物と同じ形の DOM を組む。
 *
 * **敷く前に、その CSS が全部読めることを確かめる**（Issue 498）。
 * `getComputedStyle` は at-rule の中身を評価しないので、読めない規則を含んだまま
 * 答えさせると「**規則が無い**」と「**規則はあるが見ていない**」が区別できない。
 * 別の `it` に置くと `it` ごと消して黙らせられるので、**実効背景を聞く経路そのものに置く**
 * （#500 の「入口を固定したら、出口も固定する」）。
 */
function mount(html: string): void {
  assertAllCssReadable();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  const style = document.createElement("style");
  style.textContent = ALL_CSS;
  document.head.appendChild(style);
  document.body.innerHTML = html;
}

/**
 * `mount` が食わせる CSS を**ファイルごとに**検査し、読めない規則があれば落とす。
 *
 * ファイルごとに見るのは、**`tokens.css` の `@media (prefers-color-scheme: dark)` だけ**を
 * 「`:root` のトークン再定義」として通すため（`unreadableRules` の doc コメント）。
 * まとめて 1 枚のシートにすると、`member.css` に足された `@media` も同じ緩めに乗ってしまう。
 */
function assertAllCssReadable(): void {
  for (const [file, text] of CSS_TEXTS) {
    const bad = unreadableRules(text, file === TOKENS_FILE);
    if (bad.length > 0) {
      throw new Error(
        `${file} に、この検査が読めない規則がある（getComputedStyle は中身を評価しないので、地を断定できない）:\n  ${bad.join("\n  ")}`,
      );
    }
  }
}

/**
 * その要素の文字が実際に乗る地のトークン名を、**祖先を遡って**求める。
 *
 * 地を塗らない（`none` / `transparent` / 未指定）要素は親の地が透けるので、そのまま上へ。
 * どこにも当たらなければ紙（`--paper`）。**「たぶん紙」で済ませない**ために、
 * 地を敷いているのにトークン 1 つで書かれていない要素に当たったら**落とす**
 * （`#fff` 直書きなどはこの検査の前提を崩すので、黙って通さない）。
 */
function backgroundTokenOf(el: Element): string {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const cs = getComputedStyle(n);
    const shadow = cs.boxShadow.trim();
    if (!NOT_PAINTED.has(shadow)) {
      // 上の doc コメント参照: 影の実効色は解けない。**答えられないことを落として示す**
      throw new Error(`${describe_(n)} に box-shadow がある（地を塗り潰しうるので、地を断定できない）: ${shadow}`);
    }
    /*
     * **`background` だけを読まない。** jsdom で実測すると `background-color: var(--paper)` を
     * 単独で書いた要素は `cs.background` が **`""`（空）**になり、`cs.backgroundColor` にしか出ない。
     * `background` だけ見ると**その 1 行で静かに素通りする**——#483 で直しているのと**同じ形の穴**を
     * 自分で作ることになる。ショートハンド・`background-color`・`background-image` を**全部**見る。
     */
    const painted = [cs.background, cs.backgroundColor, cs.backgroundImage].map((v) => v.trim()).filter((v) => !NOT_PAINTED.has(v));
    if (painted.length === 0) continue; // 塗らない ＝ 親の地が透ける
    // 同じ地が `background` と `background-color` の両方から出ることがあるので、種類で数える
    const kinds = new Set(painted.map((v) => tokenName(v) ?? `(トークンでない: ${v})`));
    if (kinds.size !== 1) throw new Error(`${describe_(n)} の地が 1 つに決まらない: ${[...kinds].join(" / ")}`);
    const [only] = kinds;
    if (only.startsWith("(")) throw new Error(`${describe_(n)} の地が var(--トークン) 1 つで書かれていない: ${only}`);
    return only;
  }
  return "paper"; // どの祖先も塗っていない ＝ 紙の上
}

/** その要素の文字色のトークン名（**継承も CSSOM が解く**） */
function colorTokenOf(el: Element): string {
  const c = getComputedStyle(el).color.trim();
  const t = tokenName(c);
  if (!t) throw new Error(`${describe_(el)} の文字色が var(--トークン) 1 つで書かれていない: ${c}`);
  return t;
}

/** 落ちたときにどの要素かを言えるようにする（`describe` は vitest のものと衝突するので別名） */
function describe_(el: Element): string {
  const cls = (el as HTMLElement).className;
  return cls ? `.${String(cls).split(/\s+/).join(".")}` : el.tagName.toLowerCase();
}

/**
 * `.tsx` の JSX から「`className` にこのクラスを持つ要素」を **TypeScript の parser で**探し、
 * その**部分木の中に**目的のタグがあるかを見る。
 *
 * **窓つき正規表現（`className="x"[\s\S]{0,900}?<a href=`）を使わない。**
 * #483 で実際に破れた: `.member-notice` の中のリンクを 2 つとも `<span>` に替えても、
 * **窓が次の要素まで伸びて `<a href="/">← 議員レコード</a>`（member.tsx:525）を拾い**、
 * 検査は緑のままだった。窓は「どこで要素が終わるか」を知らないので、**必ずこうなる**
 * （`docs/WORKING_AGREEMENT.md`「CSS や TS を『テキストとして』正規表現で読まない」）。
 */
function jsxElementsWithClass(file: string, className: string): ts.JsxElement[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: ts.JsxElement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node)) {
      for (const attr of node.openingElement.attributes.properties) {
        if (!ts.isJsxAttribute(attr) || attr.name.getText() !== "className") continue;
        const v = attr.initializer;
        // `className="member-notice"` の形だけを見る（このリポジトリの該当箇所は全部この形）。
        // 動的（`className={…}`）になったら**見つからない ＝ 落ちる**ので、静かには通らない
        if (!v || !ts.isStringLiteral(v)) continue;
        if (v.text.split(/\s+/).includes(className)) found.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * その JSX 要素の**部分木の中**にリンクがあるか。
 *
 * `<a>` そのものだけでなく、**`<a>` を返すことがこのファイルで確かめられる小さな部品**も数える。
 * `member.tsx` の `ExternalLink` がそれで（`member.tsx:1039-1045` が `<a href target="_blank">` を返す）、
 * 最初の注記（`member.tsx:489`）は `<ExternalLink>` と `<a>` の両方を持つ。
 * **部品の中身は別に確かめる**（下の `rendersAnchor`）——名前だけで「リンクだろう」と決めない。
 *
 * 見ないままなのは、**別ファイルから import した部品**が `<a>` を返す場合。
 * `member.tsx` / `compare.tsx` の注記の中に、そういう部品は現時点で無い
 * （中身は `<a>` / `<ExternalLink>` / 素の文字列だけ）。増えたら**見つからない ＝ 落ちる**ので、
 * 静かに通ることはない。
 */
function hasLink(el: ts.JsxElement, localAnchorComponents: ReadonlySet<string>): boolean {
  let hit = false;
  const isLinkTag = (name: string) => name === "a" || localAnchorComponents.has(name);
  const visit = (node: ts.Node): void => {
    if (hit) return;
    if (node !== el && ts.isJsxElement(node) && isLinkTag(node.openingElement.tagName.getText())) hit = true;
    else if (ts.isJsxSelfClosingElement(node) && isLinkTag(node.tagName.getText())) hit = true;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(el, visit);
  return hit;
}

/**
 * そのファイルの中で定義されていて、**`<a>` を返す**部品の名前を集める。
 * 「`ExternalLink` という名前だからリンクだろう」で済ませず、**parser に中身を見せて確かめる**。
 */
function componentsThatRenderAnchor(file: string): Set<string> {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set<string>();
  const returnsAnchor = (node: ts.Node): boolean => {
    let hit = false;
    const visit = (n: ts.Node): void => {
      if (hit) return;
      if (ts.isJsxElement(n) && n.openingElement.tagName.getText() === "a") hit = true;
      else if (ts.isJsxSelfClosingElement(n) && n.tagName.getText() === "a") hit = true;
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(node, visit);
    return hit;
  };
  const visit = (node: ts.Node): void => {
    // 大文字始まりの関数宣言だけを部品とみなす（JSX の慣習。小文字は素の HTML タグ）
    if (ts.isFunctionDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text) && returnsAnchor(node)) names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
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

/**
 * **文字色として使うトークンを、全部数えて固定する。Issue 471**
 *
 * #471 で見つかったのは「`--brass` だけが検査から抜けていた」ことだが、
 * 1つ足して終わりにすると同じ穴がまた開く（#357 の学び「先に全部数える」）。
 * そこで `tokens.css` のトークン 28 個（うち 2 個は `--font-*`、残り 26 個が色）を列挙し、
 * `color:` として使われている組を**全部**引き当てて、下の表に入れた。
 *
 * 数え方（apps/web、node_modules 除く）:
 *   1. トークンの列挙   `sed -n '/^:root {/,/^@media/p' tokens.css` → `--*:` が 28 個
 *   2. CSS の文字色     `grep -rnoE '[a-z-]*color:\s*var\(--[a-z-]+\)' --include='*.css'`
 *                       → `color:` は 116 件、使われている前景トークンは 15 種
 *                       （border-color / accent-color / text-decoration-color は文字色ではないので対象外）
 *   3. TSX の inline style   `grep -rnE 'var\(--[a-z-]+\)' --include='*.tsx'`
 *                       → Cover / CoverBrand / DateHeading / Tabs / SourceLine / ThemeToggle の 6 ファイル。
 *                       前景は --ink / --muted / --paper / --brass / --cover-fg / --brass-on-cover で、
 *                       いずれも 2. の 15 種の中に入っており、**新顔は無かった**
 *   4. 動的に組み立てるトークン名  `grep -rn 'var(--${' --include='*.tsx'`
 *                       → Stamp.tsx だけ。`var(--${t}-fg)` の `t` は yes|no|none|act の 4 つ
 *                       （StampValue → tone の対応表が閉じている）。3. の literal な grep では
 *                       **拾えない**ので別に数えた。4 つとも下の表の判の組に入っている
 *
 * 地の色は「その文字がどの箱の上に乗るか」で決めた。`background` の指定が無い（＝紙の上）ものと、
 * ダークで `background: transparent` になるものは、**地を `--paper` として測る**。
 *
 * **入れ子の地を数え直した（Issue 476）。**
 * 上の 4 手順は前景しか数えておらず、**地を「紙」と決めつけていた**ので `--est-bg` の上の 3 組を落としていた。
 * 地の数え方（apps/web、node_modules 除く）:
 *   5. 地を敷く規則の全部   `grep -rnoE '(background|background-color|background-image)\s*:[^;]+' --include='*.css'`
 *                       → 29 件。うち `none`/`transparent` が 7 件で、**地を敷くのは 22 件**。
 *                       `background-color` は **0 件**、`linear-gradient`/`url()` も **0 件**（画像の地は無い）
 *   6. TSX の inline の地  `grep -rnE 'background[^-]' --include='*.tsx'` → 4 件。
 *                       Cover.tsx（--cover）／ThemeToggle.tsx（--ink か transparent）／
 *                       Tabs.tsx（none）／Stamp.tsx（`var(--${t}-bg)`）。**CSS だけ数えると 4. の Stamp と
 *                       ThemeToggle の --ink を落とす**ので別に数えた
 *   7. 擬似要素の地        `::before`/`::after` は member.css:56,57 の 2 件だけで、**地は敷かない**
 *                       （`content` と `color: var(--brass)` のみ。地は親の紙）
 *   8. 地のトークンは 10 種  --paper / --est-bg / --cover / --ink / --yes-bg / --no-bg / --none-bg /
 *                       --act-bg / --brass-on-cover の 9 種（CSS）＋ ThemeToggle の --ink（6. で重複）
 *   9. 各々の箱の中で `color` を上書きしない子を数える → 落ちていたのは **`--est-bg` の中の 3 組だけ**
 *
 * **本番実測でも確かめた**（getComputedStyle で親を遡って実効背景を求め、テキストノードを持つ全要素を走査）。
 * `/` `/about` `/coverage` `/members` `/members/h_41f223ac28` `/members/m_003005` `/compare`
 * `/rollcalls` `/assemblies` の 9 ページ × ライト/ダークで、実効背景として出たのは
 * HTML / cover / member-cover / compare-cover / rollcall-cover / skip-link（--cover）/
 * member-tabs・member-notice（--est-bg）/ member-stamp / zip__button・tag--fact・LABEL（--ink）/
 * members-select・SELECT（--paper）の 12 種だけで、**--est-bg 以外に表から漏れた地は無かった**。
 * **4.5 を下回る組は 1 件も無い**（最小は 4.5095 の `brass on paper`）。
 */
describe("文字色として使うトークンは全部 AA（4.5:1）を満たす（Issue 471）", () => {
  /** [前景トークン, 地のトークン, どこで使われているか] */
  const textPairs: readonly (readonly [string, string, string])[] = [
    // 紙の上
    ["ink", "paper", "本文（pages.css ほか。color: var(--ink) は 23 件）"],
    ["muted", "paper", "注釈・補足（color: var(--muted) は 46 件で最多）"],
    ["link", "paper", "リンク（tokens.css の a { color: var(--link) }）"],
    // ★ #471 の本体。件数表示・五十音の行見出し・チップ・タブの分類見出し
    ["brass", "paper", "members.css:12,15,20,54 / member.css:35,44,56,71,101、DateHeading.tsx:7"],
    ["est-fg", "paper", "member.css:38 .member-tabcat（会派タブの分類見出し。背景を敷かないので紙の上）"],
    ["none-fg", "paper", "pages.css:75 .tag--estimate（背景を敷かないので紙の上）"],
    ["paper", "ink", "pages.css:24 .zip__button / :74 .tag--fact（墨を敷いて紙色で抜く）"],
    // 表紙（--cover）の上。#394 で入った分もここで一緒に数える
    ["cover-fg", "cover", "pages.css:4 .cover / member.css:7 / rollcall.css:7 / compare.css:6"],
    ["brass-on-cover", "cover", "member.css:8,10,22、Cover.tsx:34"],
    ["muted-on-cover", "cover", "pages.css の .cover .note"],
    ["link-on-cover", "cover", "pages.css の .cover .note a"],
    ["cover", "brass-on-cover", "member.css:23 .compare-add-button[aria-pressed=\"true\"]（前景と地が入れ替わる）"],
    // 判（member.css:85-92 / compare.css:35 / member.css:94）
    ["yes-fg", "yes-bg", "member.css:85 .member-stamp[data-tone=\"yes\"]"],
    ["no-fg", "no-bg", "member.css:86 .member-stamp[data-tone=\"no\"]"],
    ["none-fg", "none-bg", "member.css:87 .member-stamp[data-tone=\"none\"]"],
    ["act-fg", "act-bg", "member.css:88 .member-stamp[data-tone=\"act\"]"],
    ["est-fg", "est-bg", "member.css:92,94 / compare.css:35（推定の判）、member.css:45（.member-tabs が est-bg を敷く）"],
    /*
     * **入れ子の地（--est-bg）の上に乗る文字。Issue 476**
     *
     * #471 で 17 組を数えたとき、**地は「紙」だと思い込んでいた**。実際には `--est-bg` を敷く箱の
     * 中に、地を上書きしない文字が入る（`.member-tab` は `background: none` なので親の地が透ける）。
     * 本番 `/members/h_41f223ac28` を getComputedStyle で走査すると `bgFrom` が `HTML` ではなく
     * `member-tabs` で出る:
     *
     *     .member-tab-label   fg rgb(107,104,96)  bg rgb(240,238,233)  比 4.7988
     *     .member-notice      fg rgb(27,26,24)    bg rgb(240,238,233)  比 14.9986
     *     .member-notice a    fg rgb(58,74,94)    bg rgb(240,238,233)  比 7.8032
     *
     * この 3 組が無いと **`--est-bg: #f0eee9` → `#cfcabf` にしても 53 件全部が緑のまま**通り、
     * 実 UI では `muted on est-bg` が 3.4057 に落ちて AA 違反が静かに入る。
     */
    ["muted", "est-bg", "member.css:43 .member-tab / :49 .member-tab-count（member.css:39 の .member-tabs[group] が est-bg を敷く）"],
    ["ink", "est-bg", "member.css:96 .member-notice / compare.css:16 .compare-note-est"],
    // 上の 2 つは #476 の本文にある。**この 1 つは追加で見つけたもの**:
    // .member-notice / .compare-note-est の**中にリンクがある**（member.tsx:494,501,513 / compare.tsx:154）。
    // `a { color: var(--link) }`（tokens.css:55）が効くので `link on est-bg` も実在する（本番実測 7.8032）
    ["link", "est-bg", "member.tsx:494,501,513 / compare.tsx:154 の <a>（tokens.css:55 の a { color: var(--link) }）"],
  ];

  /** ダークでは判の地が `transparent` になる。その場合は紙が透けるので地は --paper */
  function bgFor(token: (name: string) => string, name: string): string {
    const bg = token(name);
    return bg === TRANSPARENT ? token("paper") : bg;
  }

  describe.each([
    ["ライト", lightToken],
    ["ダーク", darkToken],
  ])("%s", (_name, token) => {
    it.each(textPairs)("%s on %s は AA を満たす（%s）", (fg, bg) => {
      expect(contrast(token(fg), bgFor(token, bg))).toBeGreaterThanOrEqual(4.5);
    });
  });

  /*
   * **余裕が無いものを名指しで記録する。**
   * ライトの `--brass` は紙の上で 4.5095 しかない（AA まで 0.0095）。
   * `#8a6a24` → `#8b6b25` と 1 段階明るくするだけで 4.4457 になって割る。
   * 「なんとなく明るくした」で静かに割らないよう、**現在の値そのもの**をここに書き留める。
   */
  it("ライトの brass は紙の上で 4.5095（AA まで余裕 0.0095 しかない）", () => {
    expect(contrast(lightToken("brass"), lightToken("paper"))).toBeCloseTo(4.5095, 3);
  });

  it("brass を 1 段階明るくすると（#8b6b25）AA を割る＝上の検査は本当に効いている", () => {
    expect(contrast("#8b6b25", lightToken("paper"))).toBeLessThan(4.5);
  });

  // ダークの brass は墨の上で 8.81。ライトだけ足してダークを忘れていないことを名指しで残す
  it("ダークの brass は墨色の上で十分（8.81）", () => {
    expect(contrast(darkToken("brass"), darkToken("paper"))).toBeCloseTo(8.81, 1);
  });

  /*
   * **入れ子の地の余裕を名指しで記録する（Issue 476）。**
   * `--est-bg` の上の `--muted` は 4.7988 で、AA まで 0.2988 しかない。
   * `--est-bg` を 1 段階暗くする（`#f0eee9` → `#efedE8`）と 4.7845 まで落ちる。
   * 本番実測（`/members/h_41f223ac28` の `.member-tab-label`）と同じ値をここに置いて、
   * 「地を暗くしたら静かに割る」を見えるようにする。
   */
  it("ライトの muted は est-bg の上で 4.7988（AA まで余裕 0.2988 しかない）", () => {
    expect(contrast(lightToken("muted"), lightToken("est-bg"))).toBeCloseTo(4.7988, 3);
  });

  it("est-bg を暗くすると（#cfcabf）muted が AA を割る＝上の検査は本当に効いている", () => {
    // #476 が挙げた変異そのもの。表に muted on est-bg が無かったときは、これでも 53 件が緑のままだった
    expect(contrast(lightToken("muted"), "#cfcabf")).toBeLessThan(4.5);
    expect(contrast(lightToken("muted"), "#cfcabf")).toBeCloseTo(3.4057, 3);
  });

  /*
   * **入れ子の地の前提そのものを、CSSOM に解かせて固定する（Issue 483）。**
   *
   * 上の 3 組は「`--est-bg` の箱の中に、地を上書きしない文字が入る」を前提にしている。
   * その前提が崩れたら（誰かが `.member-tab` に紙を敷いたら）**上の 3 組は測る意味を失う**——
   * `--est-bg` を暗くしても実 UI は紙のままなので、**検査は落ちるべきでないのに落ち**、
   * 逆に `--paper` を暗くしても**落ちるべきなのに落ちない**。
   *
   * #483 まではこれを正規表現で見ていて、**後勝ちの上書きを 1 つも見ていなかった**
   * （上の `backgroundTokenOf` の doc コメントに、素通りした変異 4 つを列挙してある）。
   * ここでは**本物の CSS を jsdom に食わせ、本物と同じ形の DOM を組み**、
   * 「この文字の地は結局どのトークンか」を `getComputedStyle` に答えさせる。
   *
   * DOM は `member.tsx:442-462` / `member.tsx:489,510` / `compare.tsx:152` の写しである。
   * **形が本番とずれたら検査は無意味になる**ので、下の「印が実在する」検査で
   * クラス名が `.tsx` に残っていることも一緒に固定する。
   */
  /** `member.tsx:435-464` の会派タブ（`data-category="group"` のとき `.member-tabs` が `--est-bg` を敷く） */
  const TABS_HTML = `
    <div class="member-tabgroup" data-category="group">
      <p class="member-tabcat">記録の種類</p>
      <div class="member-tabs" role="tablist">
        <button type="button" role="tab" class="member-tab" aria-selected="false">
          <span class="member-tab-label">本会議</span><span class="member-tab-count num">3件</span>
        </button>
      </div>
    </div>`;
  /** `member.tsx:489,510` の注記（中にリンクが入る）と `compare.tsx:152` の推定注記 */
  const NOTICE_HTML = `
    <p class="member-notice">この議会の記録です。<a href="/assemblies/pref-01">議会ページ</a></p>
    <p class="compare-note compare-note-est">推定の記録です。<a href="/about">記録の範囲について</a></p>`;

  /**
   * 表（`textPairs`）の `est-bg` の組が、実際の DOM でもその通りに出ること。
   * **[前景トークン, 地のトークン, その文字を持つ要素のセレクタ]**
   */
  const nested: readonly (readonly [string, string, string])[] = [
    ["muted", "est-bg", ".member-tab-label"],
    ["muted", "est-bg", ".member-tab-count"],
    ["ink", "est-bg", ".member-notice"],
    ["link", "est-bg", ".member-notice a"],
    ["ink", "est-bg", ".compare-note-est"],
    ["link", "est-bg", ".compare-note-est a"],
  ];

  it.each(nested)("%s on %s が実際に出る: %s（CSSOM が解いた実効背景）", (fg, bg, selector) => {
    mount(TABS_HTML + NOTICE_HTML);
    const el = document.querySelector(selector);
    expect(el, `${selector} が DOM に無い`).not.toBeNull();
    expect(colorTokenOf(el!), `${selector} の文字色`).toBe(fg);
    expect(backgroundTokenOf(el!), `${selector} の実効背景`).toBe(bg);
  });

  /*
   * **上の検査が「地が紙になった」を見逃さないことを、ここで示す。**
   * `backgroundTokenOf` は祖先を遡るだけなので、`.member-tab` 自身が地を敷けば `paper` を返す。
   * 検査の効きを言葉で主張せずに、**同じ関数に紙を敷いた CSS を食わせて確かめる**。
   */
  it("入れ子の中の要素が地を敷いたら、実効背景は est-bg ではなくなる（検査が効いている証明）", () => {
    mount(TABS_HTML);
    expect(backgroundTokenOf(document.querySelector(".member-tab-label")!)).toBe("est-bg");
    // 後勝ち（宣言の末尾に足す）でも、詳細度で勝つ別規則でも、同じように見える
    for (const extra of [".member-tab { background: var(--paper); }", ".member-tabs .member-tab { background: var(--paper); }"]) {
      const patch = document.createElement("style");
      patch.textContent = extra;
      document.head.appendChild(patch);
      expect(backgroundTokenOf(document.querySelector(".member-tab-label")!), extra).toBe("paper");
      patch.remove();
    }
  });

  /*
   * **at-rule に包むだけで素通りした 3 形が、いま落ちること（Issue 498）。**
   *
   * `mount` の中で検査するので**上の 6 件がそのまま落ちる**が、それだけだと
   * 「何が落としたか」が本文に残らない。ここで**同じ関数に食わせて、名指しで**固定する。
   *
   * **同時に「なぜこの検査が要るか」も毎回測り直す**——jsdom が将来 at-rule を評価するように
   * なったら、この検査は不要になる。`getComputedStyle` が**いまも見ていない**ことを
   * 一緒に確かめておかないと、「効いている」と思い込んだまま形骸化する（#484 の学び）。
   */
  it.each([
    ["@media", "@media (min-width: 1px) { .member-tab { background: var(--paper); } }", "CSSMediaRule"],
    ["@supports", "@supports (display: flex) { .member-tab { background: var(--paper); } }", "CSSSupportsRule"],
    ["@layer", "@layer x { .member-tab { background: var(--paper); } }", "CSSLayerBlockRule"],
    // 一段包むだけで逃げられないこと（`unreadableRules` は再帰する）
    ["入れ子の @supports", "@media (min-width: 1px) { @supports (display: flex) { .member-tab { background: var(--paper); } } }", "CSSMediaRule"],
    // 新しい at-rule。**名指しで除いていない**ので、知らないまま落ちるのが正しい（allowlist の効き目）
    ["@container", "@container (min-width: 1px) { .member-tab { background: var(--paper); } }", "CSSContainerRule"],
  ])("%s に包んだ上書きを「読めない」として落とす", (_name, css, kind) => {
    // (1) `getComputedStyle` はいまもこれを見ていない ＝ この検査が無ければ素通りする
    mount(TABS_HTML);
    const patch = document.createElement("style");
    patch.textContent = css;
    document.head.appendChild(patch);
    expect(backgroundTokenOf(document.querySelector(".member-tab-label")!), "getComputedStyle が at-rule を評価するようになったなら、この検査は作り直す").toBe("est-bg");
    patch.remove();
    // (2) それを allowlist が捕まえる
    const bad = unreadableRules(css, false);
    expect(bad.join(" ")).toContain(kind);
    // (3) `tokens.css` 向けの緩めを付けても、`:root` のトークン再定義でない限り通さない
    expect(unreadableRules(css, true).join(" ")).toContain(kind);
  });

  /*
   * **`tokens.css` の `@media (prefers-color-scheme: dark)` は実在する。落としてはいけない。**
   * 通す理由は「`tokens.css` だから」ではなく「**`:root` にカスタムプロパティしか設定していない**」
   * ことなので、**中身をすり替えたら落ちる**ところまで固定する（#499 の学び）。
   */
  it("tokens.css の @media (prefers-color-scheme: dark) は誤検出しない（ただし中身がすり替わったら落ちる）", () => {
    const real = CSS_TEXTS.find(([f]) => f === TOKENS_FILE)?.[1];
    expect(real, "tokens.css が読めていない").toBeDefined();
    // 本物をそのまま食わせて、読めない規則が 0 件であること
    expect(unreadableRules(real!, true)).toEqual([]);
    // その `@media` が**実在する**こと（消えたのに緑、を防ぐ）
    expect(unreadableRules(real!, false).some((r) => r.startsWith("CSSMediaRule:"))).toBe(true);
    // 中身のすり替え: 箱に地を敷く規則が 1 つ混ざれば落ちる
    const swapped = '@media (prefers-color-scheme: dark) { :root { --paper: #111; } .member-tab { background: var(--paper); } }';
    expect(unreadableRules(swapped, true).join(" ")).toContain("CSSMediaRule");
    // 空の `@media` を「無害」と数えない
    expect(unreadableRules("@media (prefers-color-scheme: dark) { :root { } }", true).join(" ")).toContain("CSSMediaRule");
  });

  /*
   * **jsdom がシートごと落とす形**（`@scope` と CSS の入れ子）。`sheet` が `null` になり、
   * `document.styleSheets.length` が **0** になる（実測）——**CSS が一つも効かない**状態で
   * `getComputedStyle` が答えるので、「規則が無い」と「シートが死んだ」が見分けられない。
   * **黙って空集合を返さない**ことをここで固定する。
   */
  it.each([
    ["@scope", "@scope (.member-tabs) { .member-tab { background: var(--paper); } }"],
    ["CSS の入れ子", ".member-tabs { & .member-tab { background: var(--paper); } }"],
  ])("%s のように jsdom が解析できない CSS は「読めなかった」として落とす", (_name, css) => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    expect(style.sheet, "jsdom が解析できるようになったなら、この検査は作り直す").toBeNull();
    style.remove();
    expect(unreadableRules(css, true).join(" ")).toContain("解析できなかった");
  });

  /**
   * **allowlist そのものを固定する**（#484: 通すこともテストしないと、緩めても気づけない）。
   * 期待値はハードコードする——`UNDERSTOOD_RULE_TYPES` から生成すると自己参照になり、
   * 緩めたときに期待値も一緒に緩む（#499）。
   */
  it("読めるとみなす規則は CSSStyleRule だけ（allowlist を広げたら落ちる）", () => {
    expect([...UNDERSTOOD_RULE_TYPES].sort()).toEqual(["CSSStyleRule"]);
    // 素の規則は通る（通すこともテストする）
    expect(unreadableRules(".member-tab { background: var(--paper); }", false)).toEqual([]);
  });

  it("box-shadow が付いたら「地を断定できない」として落とす（実効色は jsdom では解けない）", () => {
    mount(TABS_HTML);
    const patch = document.createElement("style");
    patch.textContent = ".member-tab { box-shadow: inset 0 0 0 100px var(--paper); }";
    document.head.appendChild(patch);
    expect(() => backgroundTokenOf(document.querySelector(".member-tab-label")!)).toThrow(/box-shadow/);
  });

  /*
   * **DOM の写しが本番とずれていないことを固定する。**
   * 上の検査は `mount` した写しに対して行うので、`.tsx` 側でクラス名が変わったり、
   * `.member-notice` の中からリンクが消えたりすると、**写しだけが緑のまま残る**。
   * そこで「この形が `.tsx` に実在する」を **TypeScript の parser で**別に確かめる。
   */
  it.each([
    ["member.tsx", "member-notice"],
    ["compare.tsx", "compare-note-est"],
  ])("%s の .%s が実在し、その中にリンクが入る（＝ link on est-bg が実在する）", (file, cls) => {
    const path = join(import.meta.dirname, "..", "routes", file);
    const els = jsxElementsWithClass(path, cls);
    expect(els.length, `${file} に className="${cls}" の要素が無い`).toBeGreaterThan(0);
    const linkComponents = componentsThatRenderAnchor(path);
    // **全部の**注記の中にリンクがあること（1 つでも残っていれば通る、にしない）
    for (const el of els) {
      const line = el.getSourceFile().getLineAndCharacterOfPosition(el.getStart()).line + 1;
      expect(hasLink(el, linkComponents), `${file}:${line} の .${cls} にリンクが無い`).toBe(true);
    }
  });

  it("会派タブの形（.member-tabs / .member-tab-label / .member-tab-count）が member.tsx に実在する", () => {
    const file = join(import.meta.dirname, "..", "routes", "member.tsx");
    // `.member-tabs` の中に `.member-tab` があり、その中にラベルと件数がある——写しと同じ入れ子
    const [tabs] = jsxElementsWithClass(file, "member-tabs");
    expect(tabs, "member.tsx に className=\"member-tabs\" が無い").toBeDefined();
    for (const cls of ["member-tab", "member-tab-label", "member-tab-count"]) {
      expect(jsxElementsWithClass(file, cls).length, `member.tsx に .${cls} が無い`).toBeGreaterThan(0);
    }
    // `--est-bg` を敷くのは `.member-tabgroup[data-category="group"]` なので、その属性も実在すること
    const [group] = jsxElementsWithClass(file, "member-tabgroup");
    expect(group, "member.tsx に .member-tabgroup が無い").toBeDefined();
    expect(group.openingElement.attributes.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText() === "data-category")).toBe(true);
  });

  /*
   * ダークは `@media (prefers-color-scheme: dark)` と `:root[data-theme="dark"]` に
   * **同じ値を二重に書いている**。片方だけ直すと、OS の設定で見ている人と
   * トグルで切り替えた人とで色が変わる。上の検査は `:root[data-theme="dark"]` 側しか見ないので、
   * 二つが一致していることをここで固定する。
   */
  it("ダークの二つの定義（@media と data-theme）が食い違っていない", () => {
    const names = [...new Set(textPairs.flatMap(([fg, bg]) => [fg, bg]))];
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(mediaDarkToken(name), `--${name}`).toBe(darkToken(name));
    }
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
