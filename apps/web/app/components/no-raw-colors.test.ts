import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * **UI は design tokens（`app/styles/tokens.css`）だけを使い、生の色コードを書かない。**
 * `docs/WORKING_AGREEMENT.md` の Definition of Done の項目である。
 *
 * 守りたい理由は好みではなく**ダークテーマ**にある。`ThemeToggle`（Issue 16 / 365）は
 * `:root` と `[data-theme="dark"]` で同じ変数の中身を差し替えるので、
 * **変数を経由しない色だけがテーマの切り替えに追随しない**。
 * 白地に白文字のような組み合わせが、片方のテーマでだけ静かに生まれる。
 *
 * ## この検査は、判定を殺しても緑になっていた（#506）
 *
 * 元はここに `expect(src).not.toMatch(/…/)` を 3 本並べていただけで、
 * **判定を検査するテストが 1 つも無かった**。レビュアーが実測した変異:
 *
 *     3 本の正規表現をすべて `/$^/`（決してマッチしない）に差し替える → **14/14 全部緑**
 *
 *  現に違反が 0 件なので、判定が何を返そうと結果が変わらない。
 * 「違反を書けば落ちる」は、**検査が生きている証明にならない**（#484）。
 *
 * 直し方は #500（`app/test-tools/no-path-alias.test.ts` の `isTildeAlias`）に倣う:
 * **判定を名前付き関数に切り出し、その関数自体に yes / no の見本を当てる。**
 *
 * ## この検査が見ていないもの（過信しないこと）
 *
 * - **`.css` ファイルは見ない。** `tokens.css` は生の色を**定義する**場所なので当然だが、
 *   `pages.css` などに生の色が書かれてもここでは落ちない。
 *   色の実害（コントラスト）は `app/styles/contrast.test.ts` が別に見ている。
 * - **`app/components/` の外は見ない。** `app/routes/*.tsx` は対象外
 *   （実測: `rgb(` / `hsl(` / 色名リテラルは `app/` 全体で 0 件だが、
 *   `#[0-9a-f]{3,8}` は `# + Issue 番号`（`#218` など）と区別できないので広げていない）。
 *   広げるなら、まずコメントと文字列リテラルを分ける必要がある。
 * - **意味としての色を見ていない。** `filter: invert(1)` や SVG の `currentColor` 以外の
 *   属性など、色を変える別の書き方は拾わない。
 * - **`var()` の中身が tokens.css に実在するかを見ていない。**
 *   `var(--typo-name)` は素通りする（存在しない変数は無指定に落ちる）。
 */
const dir = __dirname;
const sources = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

/**
 * **生の色コードの書き方**。ここに 1 つでも当たれば違反。
 *
 * 3 本に分けてあるのは、**落ちたときにどの形かを名前で言える**ようにするため
 * （「何件」ではなく「どれが」でないと直す場所が分からない——#485）。
 */
const RAW_COLOR_FORMS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  /**
   * `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`。**16 進の桁数は 3 / 4 / 6 / 8 しか無い**が、
   * ここは 3〜8 桁を全部拾う——`#12345` のような書き損じも色の意図なので落としてよい。
   *
   * **`#` + 数字は Issue 番号と見分けが付かない**（`#191` は 3 桁 16 進としても読める）。
   * この検査はコメントも文字列も区別しないので、**`// Issue #191` と書くと落ちる**。
   * これは既知の過剰検出で、下の見本で**意図的な振る舞いとして固定してある**
   * （現に `app/components/` の非テストソースは `#` 無しの `Issue 167` 表記で統一されている。実測 0 件）。
   * 気づかず落ちる人のために、失敗メッセージで書き方を案内する。
   */
  { name: "16進（#rgb / #rrggbb など）", pattern: /$^/ },
  /** `rgb()` / `rgba()` / `hsl()` / `hsla()`。空白の有無・カンマ有無（CSS Color 4 記法）に依らず `(` の直前で見る */
  { name: "関数記法（rgb() / hsl()）", pattern: /\b(rgb|hsl)a?\(/ },
  /**
   * 引用符で囲まれた色名。**JSX / inline style は色を必ず文字列で書く**ので、引用符の中だけを見る。
   * 裸の `white` は変数名・prop 名・日本語の文中にも現れる（`background: white` のような CSS の
   * 裸書きは、この検査が `.tsx` しか読まないので対象外）。
   */
  { name: "色名リテラル（\"white\" など）", pattern: /["'](white|black|red|green|blue|gray|grey)["']/ },
];

/**
 * **そのソースに書かれている生の色コードを、形の名前付きで返す。**
 *
 * **判定を式のまま `expect` に並べない**（#500 / #506）。並べていたので、
 * **正規表現を全部殺しても 14/14 緑**だった。関数にすれば下の describe で直接検査できる。
 */
export function rawColorsIn(src: string): string[] {
  const found: string[] = [];
  for (const { name, pattern } of RAW_COLOR_FORMS) {
    // `g` を付け直して**全部**拾う（1 件目で止めると 2 件目以降が報告に出ない）
    for (const m of src.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))) {
      found.push(`${name}: ${m[0]}`);
    }
  }
  return found;
}

describe("components は生の色コードを書かず、tokens.css の変数だけを使う", () => {
  it("部品のソースが1つ以上ある", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  /**
   * **走査が空振りしていないこと。** ファイル名だけでは「読めているか」が分からないので、
   * 実際に中身を読んで**色の指定そのものが存在する**ことまで確かめる。
   * `readFileSync` が空文字を返していれば、上の禁止検査は永久に緑になる。
   */
  it("前提: ソースを実際に読めていて、色の指定が現に書かれている", () => {
    const texts = sources.map((f) => readFileSync(join(dir, f), "utf8"));
    expect(texts.filter((t) => t.trim() === ""), "空のソースを読んでいる（走査が空振り）").toEqual([]);
    const withColor = sources.filter((f, i) => /(?:^|[;\s{,])(?:background|color|border)\s*:/.test(texts[i]!));
    // 実測（このブランチ時点）: Stamp / ThemeToggle など 4 ファイルが色を指定している
    expect(withColor.length, "色を指定している部品が 1 つも見つからない（読めていない可能性）").toBeGreaterThanOrEqual(2);
    // その色の指定が **tokens 経由**であること（変数を一度も使っていないなら、この検査の前提が崩れている）
    expect(texts.filter((t) => /var\(--/.test(t)).length, "tokens の変数を使っている部品が 1 つも無い").toBeGreaterThanOrEqual(2);
  });

  it.each(sources)("%s に #xxxxxx / rgb() / hsl() / 色名が無い", (file) => {
    const src = readFileSync(join(dir, file), "utf8");
    expect(
      rawColorsIn(src),
      "色は `app/styles/tokens.css` の変数（`var(--ink)` など）で書いてください。" +
        "生の色はダークテーマの切り替えに追随しません。" +
        "なお `#` + 数字は Issue 番号と見分けが付かないので、コメントでは `#191` ではなく `Issue 191` と書いてください",
    ).toEqual([]);
  });
});

/**
 * **判定そのものを検査する**（#500 の `isTildeAlias` と同じ処置）。
 *
 * これが無いと、**判定を殺しても（現に違反が 0 件なので）全部緑のまま通る**——
 * #506 で実測済み（正規表現 3 本を `/$^/` にして 14/14 緑）。
 */
describe("rawColorsIn: 生の色コードの判定（#506）", () => {
  /** **拾わなければならない**書き方。CSS Color 4 で書ける形を数え上げてある */
  const 違反: Record<string, string> = {
    "#rgb（3桁）": 'const s = { color: "#fff" };',
    "#rgba（4桁）": 'const s = { color: "#fff8" };',
    "#rrggbb（6桁）": 'const s = { color: "#1a1a1a" };',
    "#rrggbbaa（8桁）": 'const s = { color: "#1a1a1aff" };',
    大文字の16進: 'const s = { color: "#FFFFFF" };',
    "テンプレートリテラルの中の #": "const s = { border: `1px solid #ccc` };",
    "CSS の裸書き（.tsx の中の style 文字列）": 'const s = "color:#333";',
    "rgb()": 'const s = { color: "rgb(0, 0, 0)" };',
    "rgba()": 'const s = { color: "rgba(0,0,0,.5)" };',
    "hsl()": 'const s = { color: "hsl(0 0% 0%)" };',
    "hsla()": 'const s = { color: "hsla(0,0%,0%,.5)" };',
    "CSS Color 4 のカンマ無し記法": 'const s = { color: "rgb(0 0 0 / 50%)" };',
    "色名 white": 'const s = { background: "white" };',
    "色名 black": 'const s = { background: "black" };',
    "色名 red": 'const s = { color: "red" };',
    "色名 green": 'const s = { color: "green" };',
    "色名 blue": 'const s = { color: "blue" };',
    "色名 gray": 'const s = { color: "gray" };',
    "色名 grey（英国綴り）": 'const s = { color: "grey" };',
    "シングルクォートの色名": "const s = { color: 'white' };",
    "1ファイルに2件（両方拾う）": 'const a = "#fff"; const b = "rgb(0,0,0)";',
  };

  it("21 通りの生の色を、どれも見落とさない", () => {
    const missed = Object.entries(違反)
      .filter(([, src]) => rawColorsIn(src).length === 0)
      .map(([name]) => name);
    expect(missed, "生の色を見落としている（判定が死んでいる可能性）").toEqual([]);
    expect(Object.keys(違反)).toHaveLength(21);
    // **件数まで見る。** 1 件目で止めると 2 件目が報告に出ない
    expect(rawColorsIn(違反["1ファイルに2件（両方拾う）"]!), "2 件目を拾っていない").toHaveLength(2);
  });

  /** **落ちる理由が狙ったものであること。** 形の名前まで固定する（#485: 「落ちた」だけ見ると格下げに気づけない） */
  it("拾った理由（どの形か）が正しい", () => {
    expect(rawColorsIn('const s = { color: "#1a1a1a" };')).toEqual(["16進（#rgb / #rrggbb など）: #1a1a1a"]);
    expect(rawColorsIn('const s = { color: "rgba(0,0,0,.5)" };')).toEqual(["関数記法（rgb() / hsl()）: rgba("]);
    expect(rawColorsIn('const s = { background: "white" };')).toEqual(['色名リテラル（"white" など）: "white"']);
  });

  /** **通らなければならない**書き方。ここが落ちたら**正しいコードを落としている**（誤検出） */
  const 違反でない: Record<string, string> = {
    "tokens の変数": 'const s = { color: "var(--ink)" };',
    "テンプレートで組む変数名": "const s = { background: `var(--${t}-bg)` };",
    transparent: 'const s = { background: "transparent" };',
    currentColor: 'const s = { fill: "currentColor" };',
    inherit: 'const s = { color: "inherit" };',
    "色を書いていない": "export const A = () => <span>x</span>;",
    "引用符の外の色名（prop 名・文中の語）": "const whiteList = []; // black box という語",
    "URL 断片の #（16進に見えない）": 'const href = "/about#faq";',
    "SVG の url(#id)": 'const s = { fill: "url(#grad)" };',
    "Issue 番号（# 無しの表記）": "// Issue 167 で足した",
    "2桁の #（16進として短すぎる）": "// #16 は古い Issue",
    "色名を含むだけの識別子": "const blueprint = 1; const greenhouse = 2;",
    "algorithm など rgb を含む語": "const rgbaLike = 1; // not a color call",
  };

  it("正しい書き方・色でないものを拾わない（厳しすぎて壊さない）", () => {
    const wrong = Object.entries(違反でない)
      .filter(([, src]) => rawColorsIn(src).length > 0)
      .map(([name, src]) => `${name}: ${rawColorsIn(src).join(" / ")}`);
    expect(wrong, "色でないものを違反として拾っている（誤検出）").toEqual([]);
    expect(Object.keys(違反でない)).toHaveLength(13);
  });

  /**
   * **既知の過剰検出を、意図として固定する。**
   *
   * `#191` は「3 桁の 16 進」としても読めるので、この検査は Issue 番号を色と誤って拾う。
   * **直さない**——コメントと文字列リテラルを分ける（＝パーサを持ち込む）ほどの実害が無く、
   * `app/components/` の非テストソースは既に `Issue 167` の表記で統一されている（実測 0 件）。
   * **黙って過剰検出するのではなく、ここに書いて固定する**（気づかず落ちた人が理由を辿れるように）。
   */
  it("`#` + Issue 番号は色として拾う（既知の過剰検出。意図的）", () => {
    expect(rawColorsIn("// Issue #191 で足した"), "この振る舞いを変えたなら docblock も直すこと").toEqual([
      "16進（#rgb / #rrggbb など）: #191",
    ]);
  });

  /** **禁止の形が痩せていないこと**（#499: allowlist は「痩せたら落とす」まで固定する） */
  it("禁止する形が 3 つある（減らすと守りが緩む）", () => {
    expect(RAW_COLOR_FORMS.map((f) => f.name)).toEqual([
      "16進（#rgb / #rrggbb など）",
      "関数記法（rgb() / hsl()）",
      '色名リテラル（"white" など）',
    ]);
  });
});
