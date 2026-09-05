import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { FONT_FAMILIES } from "../lib/self-hosted-fonts";

/**
 * 見出し家族（Shippori Mincho）に無いウェイトを要求すると、**書いていない face が読まれる**（#452 → #454）
 *
 * `FONT_FAMILIES` の Shippori Mincho は **700 / 800** しか持たない（#452 で 500 を外した）。
 * CSS のフォントマッチング規則（CSS Fonts 4 §5.2）は、要求が 400 のとき
 * **まず 400 以下を降順、無ければ 400 より上を昇順**に探す。400 以下が無いので
 * **一番軽い上のウェイトが選ばれる**。#454 の時点では 500、**500 を外した今は 700** である。
 *
 * **落ち先が太くなったぶん、この検査は前より効いている。**
 * #454 のときは「書いていない 500 が読まれる（転送量が増える）」だったが、
 * 500 が無い今は **700 に落ちて字が太くなる＝見た目が変わる**。
 *
 * 実際に起きていたこと（本番実測、390px、`document.fonts.ready` + 2.3s、`response.body().length`）:
 *
 *     .member-session-head  font-family: var(--font-head); font-weight: 700   ← 親
 *       └ .member-session-count  font-weight: 400                            ← 子。family を**継承**する
 *
 *     /members/m_003005   shippori-mincho-500.latin.woff2 + .114.woff2  2件 / 38 KB
 *     CSS.getPlatformFontsForNode → "Shippori Mincho Medium" が 3〜4 glyph を描画
 *
 * #452 で 500 を外す前に、全 15 ページ + タブ切替・`<details>` 展開・「さらに表示」まで押して
 * 実測し直し、**`shippori-mincho-500` は 0 件・`Medium` の描画も 0**（3回とも一致）を確認している。
 *
 * **`font-weight: 500` と書いた箇所はリポジトリに1件も無い。** grep では見つからない経路である。
 * 子が `font-family` を書いていないと、**CSS を読むだけでは親が誰か分からない**のがこの罠の本体。
 *
 * だからここで守るのは「継承しているか」ではなく、**もっと強い不変条件**にする:
 *
 *     `font-weight` に「見出し家族が持たないウェイト」を書く規則は、
 *     **必ず `font-family` も同じ規則で書く**（＝どの家族を要求しているか、その規則だけで決まる）。
 *
 * こうしておけば、親が `--font-head` でも `--font-body` でも、
 * **書いていない face が呼ばれることはない**。継承の追跡が要らないので、規則を CSS だけで検査できる。
 *
 * 検査は**ソースの CSS に対して**行う。ブラウザでの実測（`getComputedStyle` の全要素走査）は
 * #454 で 19 ページ + タブ切替・折りたたみ展開・「さらに表示」まで押して行い、
 * **`.member-session-count` 以外に同じ経路は 1 件も無い**ことを確認済み。
 * ただし実測は「今あるページ」しか見ないので、**退行を止める番人はこちら**。
 *
 * **この検査は `.css` しか読まない。TSX の inline style は下半分（#472）が見る。**
 * `Stamp` / `Cover` / `DateHeading` / `Tabs` は CSS ファイルを持たず inline style で書かれているので、
 * **ここが緑であることは「破られていない」の証明にならない**（#472 で実際に素通りしていた）。
 */
const app = join(import.meta.dirname, "..");

/** 見出し家族が持つウェイト。`FONT_FAMILIES` を単一の情報源にする（増減したら検査もついてくる） */
const headWeights = FONT_FAMILIES.find((f) => f.family === "Shippori Mincho")?.weights ?? [];

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...cssFiles(full));
    else if (entry.name.endsWith(".css")) out.push(full);
  }
  return out;
}

interface Rule {
  file: string;
  selector: string;
  body: string;
}

function rules(): Rule[] {
  const out: Rule[] = [];
  for (const file of cssFiles(app)) {
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // @media などのネストは持たないので、素朴な { } の対で足りる（持ち込んだら here が壊れて気づく）
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      out.push({ file: file.slice(app.length + 1), selector: selector.trim(), body: body ?? "" });
    }
  }
  return out;
}

/**
 * **CSS 全体で有効なキーワード**（CSS Cascade 5 §7）。`font` にも `font-weight` にも書ける。
 *
 * これらは**どの家族にも face を要求しない**——親から継ぐ（`inherit`）か、
 * カスケードを巻き戻す（`initial` / `unset` / `revert` / `revert-layer`）だけである。
 * だから**検査の対象外**であって、「読めなかった」ではない。**この区別が #484 の本体。**
 *
 * `revert-layer` は今このリポジトリでは意味を持たない（`@layer` が **0 件**、grep で確認）が、
 * **書かれれば他の4つとまったく同じ**に誤検出される。含めない理由が無いので含める。
 */
const CSS_WIDE_KEYWORDS = /^(inherit|initial|unset|revert|revert-layer)$/;

/**
 * `font-weight` の値から**要求されるウェイト**を読む。
 *
 * **`undefined` には 2 つの意味がある**（#484 で分けた。混ぜると誤検出になる）:
 *
 * - `CSS_WIDE_KEYWORDS`  → **要求しない**。検査の対象外。呼び出し側は**読み飛ばす**
 * - `lighter` / `bolder` → **親の computed weight からの相対**（CSS Fonts 4 §2.7）。
 *   親を知らないと決まらないので、**「静的に読めない」で正しい**。`undefined` のまま報告に出す
 *
 * **同じ `undefined` を CSS 側は「読み飛ばす」・TSX 側は「読めない」と解釈していた**のが
 * #484 の誤検出の原因なので、**戻り値で区別する**（`"skip"` は対象外の印）。
 */
function weightOf(body: string): number | undefined | "skip" {
  const m = /(?:^|[;\s])font-weight\s*:\s*([^;]+)/.exec(body);
  if (!m) return undefined;
  const v = m[1]!.trim();
  if (v === "normal") return 400;
  if (v === "bold") return 700;
  if (CSS_WIDE_KEYWORDS.test(v)) return "skip"; // 継承・巻き戻し。face を要求しない
  if (v === "lighter" || v === "bolder") return undefined; // 親に依存する。読めないものとして報告に出す
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

describe("見出し家族が持たないウェイトを、家族を書かずに要求しない（#454）", () => {
  const all = rules();

  it("CSS の規則を読めている", () => {
    expect(all.length).toBeGreaterThan(100);
    expect(headWeights).toEqual([700, 800]);
  });

  it("Shippori Mincho に無いウェイトを書く規則は、font-family も同じ規則で書く", () => {
    const offenders = all
      .filter((r) => {
        const w = weightOf(r.body);
        // `"skip"` は継承・巻き戻し（face を要求しない）、`undefined` は読めなかった値。
        // **CSS 側はどちらも従来どおり読み飛ばす**——ここの振る舞いは #484 で変えていない。
        if (w === undefined || w === "skip" || headWeights.includes(w)) return false;
        return !/(?:^|[;\s])font-family\s*:/.test(r.body) && !/(?:^|[;\s])font\s*:/.test(r.body);
      })
      .map((r) => `${r.file}: ${r.selector}`);
    expect(offenders).toEqual([]);
  });

  /**
   * **CSS 側にも同じ穴があった**（#472 の調査で、TSX の書き方を数えていて気づいた形）。
   *
   * 上の検査は「`font:` を書いていれば family も供給される」とみなして**素通りさせる**。
   * だが `font` ショートハンドは **weight を省くと初期値（400）に戻す**（CSS Fonts 4 §5.6）ので、
   * `font: 13px/1.4 var(--font-head)` は **400 と 1 文字も書かずに Mincho に 400 を要求する**。
   * このブランチで実測し、旧検査が素通りさせることを確認したうえで足した。
   *
   * **`font: inherit` は安全**（親のウェイトをそのまま継ぐ。初期値には戻さない）。
   * 本番で使われている 9 箇所はすべてこの形なので、**そこを誤検出しないこと**が条件になる。
   */
  it("font ショートハンドで自サイト配信の家族を指すなら、その家族が持つウェイトだけを要求する", () => {
    const offenders: string[] = [];
    for (const r of all) {
      for (const [, value] of r.body.matchAll(/(?:^|[;\s])font\s*:\s*([^;]+)/g)) {
        const v = value.trim();
        if (CSS_WIDE_KEYWORDS.test(v)) continue; // 継承・巻き戻しは 400 を要求しない（`revert-layer` も #484 で入れた）
        const parsed = parseFontShorthand(v);
        if (parsed === undefined) continue; // caption/menu などのシステム指定。家族も自前ではない
        const family = parsed.family === undefined ? undefined : familyOfValue(parsed.family);
        if (family === undefined) continue; // 自サイト配信の家族を指していない
        const has = FONT_FAMILIES.find((f) => f.family === family)?.weights ?? [];
        const w = parsed.weight ?? 400; // **省略は 400 要求**。ここが穴だった
        if (!has.includes(w)) offenders.push(`${r.file}: ${r.selector} { font: ${v} } → ${family} に ${w} は無い`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * **キーワードの集合そのものを釘で打つ**（#484 の変異テストで見つけた穴）。
   *
   * 上の検査群は「違反をソースに書いたら落ちる」ことは示すが、**`CSS_WIDE_KEYWORDS` が広すぎても
   * 気づかない**。実際「**何にでも当たる正規表現**」に変えても 9 tests は緑のままで、
   * そのとき `fontWeight: "500"` を `--font-head` に書いても**ウェイトの検査は落ちなくなる**
   * （落ちるのは件数の assertion だけ＝**別の理由で偶然落ちている**）。だからここで直接固定する。
   *
   * **通すもの**: face を要求しない CSS 全体キーワード（CSS Cascade 5 §7）。
   * **通さないもの**: 実際のウェイト（`400`）・`normal` / `bold`・
   * **親に依存する `lighter` / `bolder`**（CSS Fonts 4 §2.7。**静的には読めないので報告に出すのが正しい**）。
   */
  it("CSS 全体キーワードだけを対象外にする（広すぎても狭すぎても駄目）", () => {
    const skipped = ["inherit", "initial", "unset", "revert", "revert-layer"];
    const notSkipped = ["400", "500", "700", "normal", "bold", "lighter", "bolder", "13px/1.4 var(--font-head)", "caption"];
    expect(skipped.filter((v) => !CSS_WIDE_KEYWORDS.test(v)), "対象外にすべきキーワードを検査してしまう").toEqual([]);
    expect(notSkipped.filter((v) => CSS_WIDE_KEYWORDS.test(v)), "検査すべき値を対象外にしている（守りが緩む）").toEqual([]);

    // `lighter` / `bolder` は `inherit` と**同じ `undefined` に見えても意味が違う**。
    // 「読めない」として報告に出す側であることを固定する（#484 でここを分けた）。
    expect(weightOf("font-weight: inherit"), "継承は対象外の印を返す").toBe("skip");
    expect(weightOf("font-weight: lighter"), "相対指定は『読めない』のままにする").toBeUndefined();
    expect(weightOf("font-weight: bolder"), "相対指定は『読めない』のままにする").toBeUndefined();
    expect(weightOf("font-weight: bold")).toBe(700);
    expect(weightOf("font-weight: normal")).toBe(400);
  });

  it("件数（.member-session-count）は本文家族を明示する", () => {
    const rule = all.find((r) => r.selector === ".member-session-count");
    expect(rule, ".member-session-count の規則が無い").toBeDefined();
    expect(rule!.body).toMatch(/font-family\s*:\s*var\(--font-body\)/);
  });
});

/* ============================================================================
 * ここから下: **TSX の inline style**（#472）
 *
 * 上の検査は `.css` しか読まない。**同じ事故が TSX で書かれると止まらなかった**——
 * このブランチで実際に確かめた（`DateHeading` の子に `fontWeight: 400` を入れても 3 tests 緑のまま）。
 *
 * ## なぜブラウザ版（#464 / PR #469）に合流させず、こちらの形にそろえたか
 *
 * `rollcalls-bill-weight.browser.test.tsx` は**実ブラウザの computed style** を読むので、
 * inline style も継承も自動で入る——**表現力はあちらが上**。それでもここを allowlist 型で足したのは:
 *
 * 1. **守りたいものが「1 ページに出る要素」ではない。** 素通りしていた `Stamp` / `Cover` /
 *    `DateHeading` / `Tabs` は CSS ファイルを持たない**共通部品**で、複数のページに出る。
 *    ブラウザ版と同じ形にすると**ページの数だけテストを書く**ことになり、
 *    しかも**まだ無いページ**は永久に守られない（あちらの docblock 自身が
 *    「`/rollcalls` 1 ページしか描かないので `.members-item__name` は旧テストだけが守っている」と書いている）。
 * 2. **allowlist 型は「書かれた瞬間」に落ちる。** ブラウザ版は「その要素がそのページに描かれる」ことが条件で、
 *    条件分岐の下に隠れた分岐・空データのときだけ出る要素は描かれない。
 *    ソースを走査する形なら**描かれるかどうかに依らない**。
 * 3. **番人の性格が違うので、片方に寄せると守備範囲が減る。** 両方使う。
 *    こちらは**全ソースを浅く**、あちらは**1 ページを深く**（継承・カスケード・`@media` の実解決）。
 *    #464 の 6 通り（親からの継承・祖父・子結合子・型セレクタ・`@media`）は
 *    **ここでは見ない**——見なくてよい理由は下の B7。
 *
 * なお **PR #469 はこのブランチを切った時点では未マージだった**（作業中に main に入った）。
 * 仮に合流させる判断をしていても、**別の PR の上に積むことになるので取れなかった**。
 * ============================================================================ */

/**
 * ## 「同じことをする別の書き方」を数えた（#451 の学び: 構文の形で禁止すると裏口から破られる）
 *
 * #451 では `/^\s*import\s/` という**行単位の正規表現**に対し、Prettier が名前 2 つ以上で必ず作る
 * **複数行 import** が素通りした。同じ轍を踏まないよう、**「TSX から font-weight が要素に届く経路」を
 * 先に列挙してから**、どれを見てどれを見ていないかを決めた。数え方は grep で全件（手で数えていない）。
 *
 * ### A. いま見ている形
 *
 * | # | 形 | 例 | 見る手段 |
 * |---|---|---|---|
 * | A1 | `style` にオブジェクトリテラル直書き | `style={{ fontWeight: 400 }}` | JSX 属性を AST でたどる |
 * | A2 | `style` に**識別子**を渡す | `const style = {…}; style={style}` | 同一ファイル内の `const` を解決（**`Stamp.tsx` が現にこの形**） |
 * | A3 | 値が**変数** | `const w = 400; fontWeight: w` | 同一ファイル内の `const` を解決 |
 * | A4 | 値が**条件式** | `fontWeight: selected ? 700 : 400` | 三項の**両枝**を要求値として数える |
 * | A5 | 値が**文字列** | `fontWeight: "400"` / `"normal"` / `"bold"` | CSS 側と同じ `weightOf` に通す |
 * | A6 | **`font` ショートハンド** | `font: "400 14px/1.5 var(--font-body)"` | 値を CSS 宣言として解く（family も同時に供給されることを見る） |
 * | A6b | **weight を省いた `font` ショートハンド** | `font: "13px/1.5 var(--font-head)"` | **400 と書いていないのに 400 を要求する**（省略された下位項目は初期値に戻る）。**一度素通りさせて実測で見つけた形。CSS 側にも同じ穴があったので、上にも検査を足した** |
 * | A7 | オブジェクトを**外で組む**（モジュール直下の `const`） | `const base: CSSProperties = { fontWeight: 400 }` | A2 と同じ解決。**`style=` に届いていなくても、宣言の時点で数える** |
 * | A8 | スプレッドでの合成 | `style={{ ...base, fontWeight: 400 }}` | スプレッド元を**展開して混ぜず**、**両方を別々の宣言集合として数える**（安全側） |
 *
 * ### B. 見ていない形と、**なぜ見ていないか**
 *
 * | # | 形 | なぜ見ていないか |
 * |---|---|---|
 * | B1 | **別ファイルから import した style オブジェクト** | 解決していない。**このリポジトリに 1 件も無い**（`style={…}` は 19 件すべて同一ファイル内で解決できる）。増えても A7 の検査が**import 元のファイルで**捕まえるので、素通りするのは「family だけ別ファイル・weight だけこのファイル」に**分けて書いた場合**に限られる |
 * | B2 | **実行時にしか決まらない値**（props・`useState`・関数呼び出しの戻り） | 静的には値が無い。**読めない値は「読めない」として報告に出す**（0 とみなして通さない）。下の `unresolved` の検査がこれで、**新しい形が入ったら気づく**ための番人 |
 * | B3 | **`className` 経由**（`clsx` など） | **この形は存在しない**。`clsx` / `classnames` / `cva` は依存に無く、`className` が指すのは `.css` のクラスなので**上の CSS 側の検査がそのまま効く**。依存を足したらここが嘘になるので、下で検査する |
 * | B4 | **CSS-in-JS**（`styled-components` / emotion） | 依存に無い。入れば B3 と同じく「CSS を生成する経路」が増えるので、その時に足す。下で検査する |
 * | B5 | **`el.style.fontWeight = …` / `setProperty`** の命令的な代入 | 0 件。React を使っている以上ここには来ない。下で検査する |
 * | B6 | **`<style>` タグ / `dangerouslySetInnerHTML` で CSS を流す** | `root.tsx` の 2 件はどちらも `<script>`（テーマ初期化とインストール導線）で、CSS ではない。下で検査する |
 * | B7 | **継承の追跡そのもの**（親が誰か） | **意図的に見ない。** CSS 側と同じ理由——「継承しているか」より強い不変条件（*weight を書くなら family も同じ宣言に書く*）で守るので、親を知らなくてよい。#454 の罠の本体は「子が family を書いていないと CSS だけでは親が分からない」ことで、TSX でも同じ。**実解決が要るものは `rollcalls-bill-weight.browser.test.tsx` の担当** |
 */

/** `.tsx` を全部集める（テストは除く。テストの中の inline style は本番に出ない） */
function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

/** camelCase の CSS プロパティ名を CSS の綴りに戻す（`fontWeight` → `font-weight`） */
const dashed = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * inline style の**1 つの宣言集合**（= 1 つのオブジェクトリテラル）から読み取ったもの。
 * `weights` が複数あるのは三項（A4）のため——**両枝とも要求されうる**ので両方数える。
 */
interface InlineStyle {
  file: string;
  where: string;
  /** 要求されうる font-weight の値。`undefined` の要素は「静的に読めなかった」印（B2） */
  weights: (number | undefined)[];
  /** その宣言集合が font-family（または font ショートハンド）を書いているか */
  hasFamily: boolean;
  /** 明示された family の中で、自サイト配信の家族に当たるもの（`var(--font-head)` → Shippori Mincho） */
  namedFamily?: string;
}

/** `var(--font-head)` / `var(--font-body)` が指す自サイト配信の家族。tokens.css の定義と対応する */
const TOKEN_FAMILY: Record<string, string> = {
  "--font-head": "Shippori Mincho",
  "--font-body": "BIZ UDPGothic",
};

/** family 値が自サイト配信の家族を指すか。指さない（`sans-serif` など）なら `undefined` */
function familyOfValue(value: string): string | undefined {
  const token = /var\(\s*(--font-[a-z]+)/.exec(value)?.[1];
  if (token) return TOKEN_FAMILY[token];
  // 直書きの家族名（`"Shippori Mincho", serif`）。**先頭の家族だけ**を見る（実際に最初に試される家族）
  const first = value.split(",")[0]?.trim().replace(/^['"]|['"]$/g, "");
  return FONT_FAMILIES.some((f) => f.family === first) ? first : undefined;
}

/**
 * `font` ショートハンドから weight と family を取る（A6・A6b）。
 * 文法は `[style|variant|weight|stretch]* size[/line-height] family` なので、
 * **`<size>` より前に現れる数値／`normal`／`bold` が weight**、`<size>` の後ろが family。
 *
 * **解けない形は `undefined` を返す**——0 とみなして通さない（呼び出し側が `weights` に
 * `undefined` を入れるので、「静的に読めない値は無い」の検査で必ず表に出る）。
 *
 * 実測した端の形（このブランチで全部通した）:
 *
 *     "400 14px/1.5 var(--font-body)"                       weight 400  family var(--font-body)
 *     "300 13px/1.4"                                        weight 300  family 無し ← ショートハンドでも family を供給しない形がある
 *     "italic small-caps 700 14px/1.2 \"Shippori Mincho\""   weight 700  family Shippori Mincho
 *     "normal 12px sans-serif"                              weight 400  ← `normal` は style/variant/weight のどれにも当たるが、
 *                                                                         省略された下位項目は初期値に**戻る**ので 400 で正しい
 *     "13px/1.4 var(--font-head)"                           weight 400  ← **どこにも 400 と書いていない**が、
 *                                                                         ショートハンドが weight を初期値に戻すので 400 を要求する（A6b）
 *     "caption" / "menu"（システムフォント指定）               undefined  ← `<size>` が無い。**読めないものとして報告に出す**
 */
function parseFontShorthand(value: string): { weight: number | undefined; family: string | undefined } | undefined {
  const sizeAt = /(^|\s)(-?[\d.]+(?:px|rem|em|%)|larger|smaller|x?x-(?:small|large)|small|medium|large)(\/|\s|$)/.exec(value);
  if (!sizeAt) return undefined;
  const before = value.slice(0, sizeAt.index);
  const after = value.slice(sizeAt.index + sizeAt[0].length - (sizeAt[3] === "/" ? 1 : 0));
  const family = after.replace(/^\/\s*[^\s]+/, "").trim();
  let weight: number | undefined;
  for (const token of before.trim().split(/\s+/).filter(Boolean)) {
    const w = weightOf(`font-weight: ${token}`);
    // ショートハンドの内側に CSS 全体キーワードは書けない（単独でしか使えない）ので `"skip"` は来ない。
    // 来ても weight としては数えない。
    if (w !== undefined && w !== "skip") weight = w;
  }
  return { weight, family: family === "" ? undefined : family };
}

/**
 * `.tsx` の inline style を AST で集める。
 *
 * **正規表現で書かない理由**: `Stamp.tsx` は `style={style}` と**識別子を渡す形**（A2）で、
 * `Tabs.tsx` の値は**三項**（A4）。ソース文字列に対する行単位の正規表現ではどちらも取りこぼす——
 * まさに #451 で複数行 import に破られたのと同じ失敗をする。**TypeScript の parser に読ませる。**
 */
/**
 * **1 ファイル分の TSX ソースから inline style を読む。**
 *
 * `inlineStyles()` から**走査（どのファイルを読むか）と解析（1 ファイルをどう読むか）を割った**もの。
 * こうしておくと、**素通りする書き方の見本をディスクに置かずに**検査できる——
 * `app/` に fixture を置くと `tsxFiles(app)` の走査に混ざり、**本番の検査対象そのものが変わる**。
 *
 * `app` にも `readFileSync` にも依存しない**純関数**なので、実行環境にも依存しない。
 */
function readInlineStyles(rel: string, text: string): InlineStyle[] {
  const out: InlineStyle[] = [];
  {
    const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    /** 同一ファイル内の `const x = …` を引くための表（A2・A3・A7） */
    const consts = new Map<string, ts.Expression>();
    const collectConsts = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) consts.set(node.name.text, node.initializer);
      node.forEachChild(collectConsts);
    };
    collectConsts(source);

    /** 識別子を 1 段だけたどる。循環しないよう深追いしない（実在するのは 1 段だけ） */
    /**
     * **式を包んでいるだけの構文を、不動点まで剥がす**（N8・N9・M7・M8）。
     * `({ fontWeight: 400 } as CSSProperties)` のように**重なる**ので、1 回では足りない。
     * 剥がさないと `style={` の直後に丸括弧が 1 つ入るだけで検査が全部無効になる。
     */
    const unwrap = (e: ts.Expression): ts.Expression => {
      for (;;) {
        if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) {
          e = e.expression;
          continue;
        }
        return e;
      }
    };

    /**
     * 識別子を 1 段だけたどる。**多段は追わない**（N10）。
     *
     * 追わない理由: 2 段目の識別子は下の `unreadable` で**「読めない」として番人に出る**ので、
     * **素通りはしない**——「見なかったものを黙って捨てない」という原則は満たす。
     * 多段は循環参照の危険があり、**本番に該当箇所が 0 件**なので入れない。
     */
    const deref = (expr: ts.Expression): ts.Expression => {
      const e = unwrap(expr);
      return ts.isIdentifier(e) ? unwrap(consts.get(e.text) ?? e) : e;
    };

    /** **読めなかったことを 1 件として記録する。** 黙って捨てない（この PBI の本体） */
    const unreadable = (where: string) => {
      out.push({ file: rel, where, weights: [undefined], hasFamily: false });
    };

    /** `style={cond && x}` の偽枝など、**style を渡さないことが確実な**値。落とす必要がない */
    const isNoStyle = (e: ts.Expression) =>
      e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || (ts.isIdentifier(e) && e.text === "undefined");

    /** 両枝とも style になりうる演算子 */
    const BRANCHY = [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken];

    /**
     * その式が要求しうる font-weight。三項は**両枝**、識別子は 1 段たどる。読めなければ `undefined` を混ぜる。
     *
     * **`fontWeight: "inherit"` は face を要求しないので、何も返さない**（#484）。
     * ここが `undefined` を返していたため、**正しい書き方が「静的に読めない値」として落ちていた**——
     * CSS 側は同じ `undefined` を読み飛ばしていたので、**CSS に書けば通り TSX に書くと落ちる**非対称だった。
     */
    const weightsOf = (expr: ts.Expression): (number | undefined)[] => {
      const e = deref(expr);
      if (ts.isConditionalExpression(e)) return [...weightsOf(e.whenTrue), ...weightsOf(e.whenFalse)];
      if (ts.isNumericLiteral(e)) return [Number(e.text)];
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
        const w = weightOf(`font-weight: ${e.text}`);
        return w === "skip" ? [] : [w]; // 継承・巻き戻しは**要求として数えない**
      }
      return [undefined]; // B2: props / useState / 関数呼び出しなど、静的には読めない
    };

    /** 1 つのオブジェクトリテラルを 1 つの宣言集合として読む。スプレッドは**混ぜずに別集合として**再帰する（A8） */
    const readObject = (obj: ts.ObjectLiteralExpression, where: string) => {
      const entry: InlineStyle = { file: rel, where, weights: [], hasFamily: false };
      for (const prop of obj.properties) {
        if (ts.isSpreadAssignment(prop)) {
          const spread = deref(prop.expression);
          // **展開して 1 つに混ぜない。** 混ぜると「別の場所で family が書いてあるから安全」と
          // 読んでしまい、スプレッド元が別の条件で外れたときに嘘になる。**安全側に倒して別々に数える。**
          if (ts.isObjectLiteralExpression(spread)) readObject(spread, `${where} (spread)`);
          else unreadable(`${where} (spread) 読めない`); // N13: `{ ...base(), … }`。**黙って捨てない**
          continue;
        }
        // M12: **短縮プロパティ** `const fontWeight = 400; style={{ fontWeight }}`。
        // Prettier もエディタも短縮形を勧めるので、**普通に書かれうる形**。名前を値として解決する。
        if (ts.isShorthandPropertyAssignment(prop)) {
          if (dashed(prop.name.text) === "font-weight") entry.weights.push(...weightsOf(prop.name));
          continue;
        }
        if (!ts.isPropertyAssignment(prop)) continue; // メソッド・getter は style に来ない
        const name = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined;
        // M5・M6: **計算プロパティ** `{ [k]: 400 }`。キーが読めない以上 `font-weight` **かもしれない**ので、
        // 落とす側に倒す。**解いて 400 と読むこともできるが、やらない**——
        // 「読めないものは読めないと言う」ほうが原則に忠実で、**本番に 0 件**なので解く必要が無い。
        // 解く特例を作ると「**どのキーなら解けるか**」が新しい暗黙のルールになる。
        if (name === undefined) {
          unreadable(`${where} 読めないキー`);
          continue;
        }
        const css = dashed(name);
        if (css === "font-weight") entry.weights.push(...weightsOf(prop.initializer));
        else if (css === "font-family") {
          entry.hasFamily = true;
          const v = deref(prop.initializer);
          if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) entry.namedFamily = familyOfValue(v.text);
        } else if (css === "font") {
          // A6: ショートハンド。**family を供給するかどうかまで見る**（供給しないなら hasFamily を立てない）
          const v = deref(prop.initializer);
          const text = ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v) ? v.text : undefined;
          // **#484: `font: "inherit"` は完全に正しい書き方**（CSS では 11 箇所使っている）。
          // `parseFontShorthand` は `<size>` を見つけられず `undefined` を返すので、
          // ここで読み飛ばさないと**「静的に読めない値」として落ちる**。CSS 側と同じ扱いにそろえる。
          if (text !== undefined && CSS_WIDE_KEYWORDS.test(text.trim())) continue;
          const parsed = text === undefined ? undefined : parseFontShorthand(text);
          if (parsed === undefined) {
            entry.weights.push(undefined); // 読めないショートハンドは読めないものとして報告に出す
          } else {
            // **A6b: weight を省いたショートハンドは 400 を要求する**（省略された下位項目は初期値に戻る。
            // CSS Fonts 4 §5.6）。`font: 13px/1.4 var(--font-head)` はどこにも 400 と書いていないのに
            // Mincho に 400 を要求する。**このブランチで一度素通りさせて、実測で見つけた形。**
            entry.weights.push(parsed.weight ?? 400);
            if (parsed.family !== undefined) {
              entry.hasFamily = true;
              entry.namedFamily = familyOfValue(parsed.family);
            }
          }
        }
      }
      if (entry.weights.length > 0) out.push(entry);
    };

    /**
     * **`style={…}` に渡された式を読む。オブジェクトリテラルでなければ「読めない」として記録する。**
     *
     * PR #480 はここで `if (ts.isObjectLiteralExpression(expr))` と書いており、
     * **当たらなかった式を何も記録せずに捨てていた**。`weights` に 1 件も積まれないので、
     * 「静的に読めない値は落とす」番人も鳴らず、**16 通りの書き方が素通りしていた**（#485）。
     *
     * 三項・`&&`・`||`・`??` は**両枝とも読む**——潰して「読めない」にせず、
     * **`fontWeight: 400` の違反として正しく落とす**ため（M1・M2・M3）。
     */
    const readStyleExpr = (expr: ts.Expression, where: string): void => {
      const e = deref(expr);
      if (ts.isObjectLiteralExpression(e)) return readObject(e, where);
      if (ts.isConditionalExpression(e)) {
        readStyleExpr(e.whenTrue, `${where} (?)`);
        readStyleExpr(e.whenFalse, `${where} (:)`);
        return;
      }
      if (ts.isBinaryExpression(e) && BRANCHY.includes(e.operatorToken.kind)) {
        readStyleExpr(e.left, `${where} (左)`);
        readStyleExpr(e.right, `${where} (右)`);
        return;
      }
      if (isNoStyle(e)) return;
      unreadable(`${where} 読めない`); // N1・N2・N17・M4 など
    };

    /**
     * **N3: `<span {...extra} />`。** JSX スプレッドは `style` を運びうる**別の入口**で、
     * `style=` の属性名を見るだけの検査には掛からない。
     *
     * **「スプレッドがあれば読めない」と雑にやってはいけない**——本番に JSX スプレッドは
     * **実在する**（`routes/member.tsx` の 2 件。どちらも `aria-*` を条件で足すだけ）。
     * 雑にやると**この 2 件が誤検出になる**ので、**再帰して `style` キーの有無まで見る**。
     */
    const readSpreadAttr = (expr: ts.Expression, where: string): void => {
      const e = deref(expr);
      if (ts.isObjectLiteralExpression(e)) {
        for (const prop of e.properties) {
          if (ts.isSpreadAssignment(prop)) {
            readSpreadAttr(prop.expression, `${where} (spread)`);
            continue;
          }
          if (ts.isShorthandPropertyAssignment(prop)) {
            if (prop.name.text === "style") unreadable(`${where} style 読めない`);
            continue;
          }
          if (!ts.isPropertyAssignment(prop)) continue;
          const n = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined;
          if (n === "style") readStyleExpr(prop.initializer, `${where} style`);
          else if (n === undefined) unreadable(`${where} 読めないキー`); // キーが読めない = style かもしれない
        }
        return;
      }
      if (ts.isConditionalExpression(e)) {
        readSpreadAttr(e.whenTrue, `${where} (?)`);
        readSpreadAttr(e.whenFalse, `${where} (:)`);
        return;
      }
      if (ts.isBinaryExpression(e) && BRANCHY.includes(e.operatorToken.kind)) {
        readSpreadAttr(e.left, `${where} (左)`);
        readSpreadAttr(e.right, `${where} (右)`);
        return;
      }
      if (isNoStyle(e)) return;
      unreadable(`${where} 読めない`);
    };

    const walk = (node: ts.Node) => {
      // N3: JSX スプレッド属性も style の入口
      if (ts.isJsxSpreadAttribute(node)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        readSpreadAttr(node.expression, `${rel}:${line} {...}`);
      }
      // A1・A2: `style={…}` に渡された式
      if (ts.isJsxAttribute(node) && node.name.getText() === "style" && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        readStyleExpr(node.initializer.expression, `${rel}:${line} style=`);
      }
      // A7: `style=` に届いていなくても、**CSSProperties として宣言された時点で**数える。
      // `const s: CSSProperties = {…}` は style に渡る想定の型なので、宣言だけで検査できる。
      if (ts.isVariableDeclaration(node) && node.type?.getText().includes("CSSProperties") && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        readObject(node.initializer, `${rel}:${line} CSSProperties`);
      }
      node.forEachChild(walk);
    };
    walk(source);
  }
  return out;
}

/** `.tsx` を全部読む。**走査はここだけ**（解析は `readInlineStyles`） */
function inlineStyles(): InlineStyle[] {
  return tsxFiles(app).flatMap((file) => readInlineStyles(file.slice(app.length + 1), readFileSync(file, "utf8")));
}

describe("TSX の inline style も同じ規則で守る（#472）", () => {
  const styles = inlineStyles();

  it("inline style の font-weight を読めている", () => {
    // grep での実測（このブランチ時点）: `fontWeight` を書いているのは 5 箇所。
    // **`Stamp` は `style={style}`（A2）・`Tabs` は三項（A4）** なので、
    // 素朴な正規表現ではここに届かない。届いていることを数で押さえる。
    expect(styles.length).toBeGreaterThanOrEqual(5);
    expect(styles.map((s) => s.file)).toContain("components/Stamp.tsx"); // A2 が解けている
    const tabs = styles.find((s) => s.file === "components/Tabs.tsx");
    expect(tabs, "Tabs.tsx の inline style が読めていない").toBeDefined();
    expect([...tabs!.weights].sort(), "三項の両枝を数えていない（A4）").toEqual([400, 700]); // A4 が解けている
  });

  /**
   * **CSS 側とまったく同じ不変条件**（親を追跡しないで済むほうの、強いやつ）。
   * `--font-head` を継承した子に `fontWeight: 400` と書く #454 の形は、ここで落ちる。
   */
  it("Shippori Mincho に無いウェイトを書く inline style は、font-family も同じ宣言に書く", () => {
    const offenders = styles
      .filter((s) => !s.hasFamily && s.weights.some((w) => w !== undefined && !headWeights.includes(w)))
      .map((s) => `${s.where}: font-weight ${s.weights.join(" / ")}`);
    expect(offenders).toEqual([]);
  });

  /**
   * family を**明示している**なら、その家族が持たないウェイトを要求していないこと。
   *
   * **`Tabs.tsx` はここを通る**——`--font-body`（BIZ UDPGothic, 400/700）に 400 も 700 もあるため。
   * **正しい書き方なので落としてはいけない。** 逆に `--font-head` に 400 や 500 を要求すれば落ちる
   * （#452 が 500 を外したので、**Issue #472 が挙げた `--font-head` + 500 は今や本当の違反**）。
   */
  it("font-family を明示した inline style は、その家族が持つウェイトだけを要求する", () => {
    const offenders: string[] = [];
    for (const s of styles) {
      if (s.namedFamily === undefined) continue;
      const has = FONT_FAMILIES.find((f) => f.family === s.namedFamily)?.weights ?? [];
      for (const w of s.weights) if (w !== undefined && !has.includes(w)) offenders.push(`${s.where}: ${s.namedFamily} に ${w} は無い（持つのは ${has.join("/")}）`);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * **B2 の番人。** 静的に読めない値（props・`useState`・関数呼び出し）で font-weight を書いた箇所は、
   * 上の 2 つを**すり抜ける**。すり抜けたことに気づけるよう、**0 件であることを検査する**。
   * ここが落ちたら「新しい形が入った」合図——値を読める形に直すか、
   * その箇所を実ブラウザで測る側（`rollcalls-bill-weight.browser.test.tsx` の形）に回すかを、そのとき判断する。
   */
  it("font-weight に、静的に読めない値を書いている箇所は無い", () => {
    const unresolved = styles.filter((s) => s.weights.includes(undefined)).map((s) => s.where);
    expect(unresolved, "この形は上の検査をすり抜ける。読める形に直すか、実ブラウザで測る側に回すこと").toEqual([]);
  });

  /** B3・B4・B5・B6 の前提が崩れていないこと。**崩れたら上の表が嘘になる** */
  it("CSS を生む別経路（CSS-in-JS / className ライブラリ / 命令的な代入 / <style> 流し込み）は無い", () => {
    const found: string[] = [];
    for (const file of tsxFiles(app)) {
      const [rel, text] = [file.slice(app.length + 1), readFileSync(file, "utf8")];
      if (/\bclsx\b|\bclassnames\b|\bcva\(/.test(text)) found.push(`${rel}: className ライブラリ（B3）`);
      if (/styled\.[a-z]|@emotion|\bcss`/.test(text)) found.push(`${rel}: CSS-in-JS（B4）`);
      if (/\.style\.[a-zA-Z]|setProperty\(|\.cssText\s*=/.test(text)) found.push(`${rel}: 命令的な style 代入（B5）`);
      if (/dangerouslySetInnerHTML/.test(text) && /<style/i.test(text)) found.push(`${rel}: <style> の流し込み（B6）`);
    }
    expect(found, "見ていない経路が入った。docblock の B 表を更新し、検査を足すこと").toEqual([]);
  });
});

/**
 * **素通りしていた書き方を、名前を付けて 1 つずつ釘で打つ**（#485）。
 *
 * PR #480 は `style={…}` の中身が**オブジェクトリテラルのときだけ**読み、
 * **当たらなかった式を何も記録せずに捨てていた**。`weights` に 1 件も積まれないので、
 * 「静的に読めない値は落とす」番人（B2）も鳴らず、**下の 16 通りが全部素通りしていた**
 * （レビュアーが 7 通り・担当者が数え直して 9 通り追加。いずれも `entries: 0` を実測）。
 *
 * **#451 の再演**——構文の形で禁止すると裏口から破られる。#480 は parser を使っており
 * **道具は正しい**が、**「どのノードを見るか」の選び方で同じ穴が空いた**というのが学び。
 *
 * **見本をディスクに置かない理由**: `app/` に `.tsx` を置くと `tsxFiles(app)` の走査が拾い、
 * **本番の検査対象そのものが変わる**。だから `inlineStyles()` を
 * **走査と解析（`readInlineStyles`）に割って**、ソース文字列で検査する。
 */
describe("style= に渡された読めない式を、黙って捨てない（#485）", () => {
  /** 値が**解けて**違反として落ちる（狙った検査で落ちる） */
  const 解ける = "落ちる（family 無しで持たないウェイト）";
  /** 値が**読めない**ので番人に出る */
  const 読めない = "落ちる（静的に読めない）";

  /**
   * **落ちなければならない**書き方と、**落ちるべき理由**。
   * `fontWeight: 400` を family 無しで書く = #454 と同じ事故の形。
   *
   * **理由まで固定する。** 「落ちた」だけを見ると、
   * **値を解けなくなった（＝守りが緩んだ）のに落ち続ける**変化を見逃す——
   * 実際、`unwrap` を壊すと N8/N9/M7/M8 は
   * 「400 の違反」から「静的に読めない」に**格下げされるのに、落ちること自体は変わらない**。
   * **この穴は変異テストで見つけた。**
   */
  const MUST_FAIL: Record<string, [string, string]> = {
    "N1 関数の返り値": ["const makeStyle = () => ({ fontWeight: 400 });\nconst A = () => <span style={makeStyle()}>x</span>;", 読めない],
    "N2 配列から": ["const styles = [{ fontWeight: 400 }];\nconst A = () => <span style={styles[0]}>x</span>;", 読めない],
    "N3 JSX スプレッド": ["const extra = { style: { fontWeight: 400 } };\nconst A = () => <span {...extra} />;", 解ける],
    "N8 型アサーション": ["const A = () => <span style={{ fontWeight: 400 } as CSSProperties}>x</span>;", 解ける],
    "N9 丸括弧で包んだリテラル": ["const A = () => <span style={({ fontWeight: 400 })}>x</span>;", 解ける],
    "N13 関数呼び出しの spread": ["const base = () => ({ fontWeight: 400 });\nconst A = () => <span style={{ ...base(), fontSize: 13 }}>x</span>;", 読めない],
    "N17 メンバアクセス": ["const T = { label: { fontWeight: 400 } };\nconst A = () => <span style={T.label}>x</span>;", 読めない],
    "M1 style 自体が三項": ["const A = ({ on }) => <span style={on ? { fontWeight: 400 } : { fontWeight: 700 }}>x</span>;", 解ける],
    "M2 && の右辺": ["const base = { fontWeight: 400 };\nconst A = ({ on }) => <span style={on && base}>x</span>;", 解ける],
    "M3 ?? の右辺": ["const base = { fontWeight: 400 };\nconst A = ({ p }) => <span style={p ?? base}>x</span>;", 解ける],
    "M4 Object.assign": ["const A = () => <span style={Object.assign({}, { fontWeight: 400 })}>x</span>;", 読めない],
    "M5 計算プロパティ（リテラル）": ['const A = () => <span style={{ ["fontWeight"]: 400 }}>x</span>;', 読めない],
    "M6 計算プロパティ（識別子）": ['const k = "fontWeight";\nconst A = () => <span style={{ [k]: 400 }}>x</span>;', 読めない],
    "M7 as never": ["const A = () => <span style={{ fontWeight: 400 } as never}>x</span>;", 解ける],
    "M8 non-null assertion": ["const A = () => <span style={{ fontWeight: 400 }!}>x</span>;", 解ける],
    "M12 短縮プロパティ": ["const fontWeight = 400;\nconst A = () => <span style={{ fontWeight }}>x</span>;", 解ける],
  };

  /** **通らなければならない**書き方。ここが落ちたら**正しいコードを落としている**（誤検出） */
  const MUST_PASS: Record<string, string> = {
    "font: inherit（#484）": 'const A = () => <span style={{ font: "inherit" }}>x</span>;',
    "fontWeight: inherit（#484）": 'const A = () => <span style={{ fontWeight: "inherit" }}>x</span>;',
    "--font-body + 400": 'const A = () => <span style={{ fontFamily: "var(--font-body)", fontWeight: 400 }}>x</span>;',
    "sans-serif + 300": 'const A = () => <span style={{ fontFamily: "sans-serif", fontWeight: 300 }}>x</span>;',
    "Tabs.tsx の形（--font-body + 三項）": 'const A = ({ s }) => <span style={{ fontFamily: "var(--font-body)", fontWeight: s ? 700 : 400 }}>x</span>;',
  };

  /** その見本が**この検査群のどれに捕まるか**。捕まらなければ「素通り」 */
  const verdictOf = (name: string, src: string): string => {
    const got = readInlineStyles(`${name}.tsx`, src);
    const noFamily = got.filter((s) => !s.hasFamily && s.weights.some((w) => w !== undefined && !headWeights.includes(w)));
    const namedBad = got.filter((s) => {
      if (s.namedFamily === undefined) return false;
      const has = FONT_FAMILIES.find((f) => f.family === s.namedFamily)?.weights ?? [];
      return s.weights.some((w) => w !== undefined && !has.includes(w));
    });
    if (noFamily.length > 0) return 解ける;
    if (namedBad.length > 0) return "落ちる（明示した family が持たないウェイト）";
    if (got.some((s) => s.weights.includes(undefined))) return 読めない;
    return "素通り";
  };

  it("16 通りの書き方が、どれも素通りしない", () => {
    // **素通りした形の名前を出す。**「何件」ではなく「どれが」でないと直す場所が分からない
    const slipped = Object.entries(MUST_FAIL)
      .filter(([name, [src]]) => verdictOf(name, src) === "素通り")
      .map(([name]) => name);
    expect(slipped, "この書き方で fontWeight: 400 を family 無しに書くと、Shippori Mincho の 700 が読まれる（#454 と同じ事故）").toEqual([]);
  });

  it("落ちる理由が、狙ったものであること", () => {
    // **値が解けるはずの形が「読めない」に格下げされていたら、守りが緩んでいる。**
    // 落ちること自体は変わらないので、**理由を見ないと気づけない**（変異テストで見つけた穴）
    const wrongReason = Object.entries(MUST_FAIL)
      .map(([name, [src, want]]) => ({ name, want, got: verdictOf(name, src) }))
      .filter((r) => r.got !== r.want)
      .map((r) => `${r.name}: ${r.got}（期待: ${r.want}）`);
    expect(wrongReason, "値を解けなくなっている。落ちてはいるが、狙った検査で落ちていない").toEqual([]);
  });

  it("正しい書き方を落としていない（誤検出を増やしていない）", () => {
    const falsePositives = Object.entries(MUST_PASS)
      .filter(([name, src]) => verdictOf(name, src) !== "素通り")
      .map(([name, src]) => `${name}: ${verdictOf(name, src)}`);
    expect(falsePositives, "正しい書き方を落としている。CSS に書けば通るのに TSX で落ちる、という非対称を作らないこと").toEqual([]);
  });

  it("lighter / bolder は『静的に読めない』のまま（#484 の区別を保つ）", () => {
    // 親の computed weight からの相対（CSS Fonts 4 §2.7）。**`"skip"` に混ぜてはいけない**
    expect(verdictOf("lighter", 'const A = () => <span style={{ fontWeight: "lighter" }}>x</span>;')).toBe(読めない);
    expect(verdictOf("bolder", 'const A = () => <span style={{ fontWeight: "bolder" }}>x</span>;')).toBe(読めない);
  });

  it("本番に、読めない style 式は無い", () => {
    // **番人。** 上の 16 通りが本番に入ったら、ここか既存の unresolved 検査が鳴る
    const unreadable = inlineStyles()
      .filter((s) => s.where.includes("読めない"))
      .map((s) => s.where);
    expect(unreadable, "読める形に直すか、実ブラウザで測る側（rollcalls-bill-weight.browser.test.tsx）に回すこと").toEqual([]);
  });
});
