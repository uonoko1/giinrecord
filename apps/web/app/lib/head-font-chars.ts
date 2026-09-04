/**
 * 見出し家族（Shippori Mincho）の指定ウェイトが**実際に描く字**を、HTML から集める（#477）。
 *
 * `scripts/font-subset.ts` がプリレンダー済みの全ページに対してこれを回し、
 * 出てきた字だけの woff2 を `pyftsubset` で作る。
 *
 * **なぜ「議員名」ではなく「700 が当たる要素」で集めるのか。**
 * #468 の調査（`docs/research/font-subset-member-names.md` §3-1）は議員名の字だけ（678 字）で
 * 作って `/` `/coverage` `/assemblies` をシステムフォントに落とした。明朝 700 は `.tag`
 * `.section__title` `.zip__title` などにも使われており、**人が「議員名のクラス」を数えると漏れる**。
 * ここでは HTML と CSS だけを入力にして、**700 が当たった要素のテキストを全部**取る。
 * クラスが増えても、それが `--font-head` + 700 なら自動で入る。
 *
 * **jsdom の `getComputedStyle` は使えない。** 実測（2026-09-05）:
 * `.x{font-family:var(--font-head)}` の `getComputedStyle` は `"var(--font-head)"` を返し（未解決）、
 * その**子要素は `""`**（font-family を継承しない）。つまり #454 の「子が家族を継承する」経路が
 * jsdom では再現できない。だから必要な2プロパティだけを自前でカスケードする。
 * 対応するのは「クラス／要素／属性セレクタ + インライン style」で、
 * `@media` や `!important` は**このサイトの CSS が使っていない**（使い始めたら
 * `head-font-chars.test.ts` ではなく `font-subset-coverage.test.ts` が実物で落ちる）。
 *
 * HTML を DOM にするのは**呼ぶ側**。テストは vitest の jsdom 環境の `DOMParser`、
 * `scripts/font-subset.ts` は `jsdom` を直に使う。ここを純粋にしておくと
 * **`jsdom` の型（`@types/jsdom`）を足さずに済む**（依存の追加は PO の判断事項）。
 */
/** tokens.css の見出し家族の変数名。`font-family: var(--font-head)` が明朝を要求する唯一の書き方。 */
export const HEAD_FONT_VAR = "--font-head";

interface Rule {
  selector: string;
  family?: string;
  weight?: number;
}

const HEAD = `var(${HEAD_FONT_VAR})`;

/** `700` / `bold` / `normal` を数値に。解釈できないものは undefined（＝その規則はウェイトを決めない）。 */
export function parseWeight(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "normal") return 400;
  if (v === "bold") return 700;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

function declaration(body: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;]+)`).exec(body);
  return m?.[1]?.trim();
}

/** CSS 全文から「font-family か font-weight を決めている規則」だけを、書かれた順に取り出す。 */
function parseRules(css: string): Rule[] {
  const out: Rule[] = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, rawSelector, body] of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const family = declaration(body ?? "", "font-family");
    const weight = parseWeight(declaration(body ?? "", "font-weight"));
    if (family === undefined && weight === undefined) continue;
    for (const selector of (rawSelector ?? "").split(",")) {
      const s = selector.trim();
      if (!s || s.startsWith("@") || s.startsWith(":root")) continue;
      out.push({ selector: s, family, weight });
    }
  }
  return out;
}

/** `--font-head` と指定ウェイトを**同じ規則**に書いているセレクタ（#454 の検査と同じ見方）。 */
export function headFontWeightRules(css: string, weight: number): string[] {
  return parseRules(css)
    .filter((r) => r.family === HEAD && r.weight === weight)
    .map((r) => r.selector);
}

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "HEAD", "TITLE", "NOSCRIPT"]);

/**
 * `doc` のうち、見出し家族 + `weight` で描かれるテキストの**異なり字**を返す。
 * `css` は tokens.css を含むアプリの CSS 全文（複数ファイルを連結してよい）。
 */
export function headFontChars(doc: Document, css: string, weight: number): Set<string> {
  const rules = parseRules(css);
  const found = new Set<string>();

  /** この要素そのものに当たる規則とインライン style を畳んで、家族とウェイトを決める。 */
  const resolve = (el: Element, inheritedFamily: string | undefined, inheritedWeight: number | undefined) => {
    let family = inheritedFamily;
    let weightHere = inheritedWeight;
    for (const rule of rules) {
      let matches = false;
      try {
        matches = el.matches(rule.selector);
      } catch {
        matches = false; // jsdom が解釈できないセレクタ（:has() など）は当たらない扱い
      }
      if (!matches) continue;
      if (rule.family !== undefined) family = rule.family;
      if (rule.weight !== undefined) weightHere = rule.weight;
    }
    // インライン style は最後（クラスより強い）
    const inline = el.getAttribute("style");
    if (inline) {
      const f = declaration(inline, "font-family");
      const w = parseWeight(declaration(inline, "font-weight"));
      if (f !== undefined) family = f;
      if (w !== undefined) weightHere = w;
    }
    return { family, weightHere };
  };

  const walk = (el: Element, inheritedFamily: string | undefined, inheritedWeight: number | undefined) => {
    if (SKIP_TAGS.has(el.tagName)) return;
    const { family, weightHere } = resolve(el, inheritedFamily, inheritedWeight);
    if (family === HEAD && weightHere === weight) {
      for (const node of el.childNodes) {
        if (node.nodeType === 3 /* TEXT_NODE */) for (const ch of node.nodeValue ?? "") found.add(ch);
      }
    }
    for (const child of el.children) walk(child, family, weightHere);
  };

  // 1,466 ページ × 全要素 × 25 規則は実測 3.5 秒/ページで 85 分かかった（2026-09-05）。
  // 家族もウェイトも継承なので、**見出し家族を要求する規則に当たった要素より上には字が無い**。
  // その要素を起点に部分木だけ歩けば結果は同じで、実測 3.5 秒 -> 0.1 秒になる。
  //
  // **この近道が成り立つ条件**: 見出し家族を書く規則が**同じ規則でウェイトも書いている**こと。
  // 書いていないと、その要素のウェイトは**起点より上の祖先**から来るので部分木では決まらない。
  // `font-weight-match.test.ts`（#454）がこの規律を CSS 側で守っているが、
  // 破られたときに**黙って字を取りこぼす**のは最悪なので、ここでも見て、破られていたら全走査に落とす。
  const headRuleWithoutWeight = rules.some((r) => r.family === HEAD && r.weight === undefined);
  if (headRuleWithoutWeight) {
    const root = doc.body ?? doc.documentElement;
    if (root) walk(root, undefined, undefined);
    return found;
  }

  const starts = new Set<Element>();
  for (const rule of rules) {
    if (rule.family !== HEAD) continue;
    try {
      for (const el of doc.querySelectorAll(rule.selector)) starts.add(el);
    } catch {
      /* 解釈できないセレクタは当たらない扱い（上の matches と同じ） */
    }
  }
  // style 属性で家族を指定する要素（Stamp / Cover / DateHeading）も起点になる
  for (const el of doc.querySelectorAll("[style]")) if (declaration(el.getAttribute("style") ?? "", "font-family") === HEAD) starts.add(el);

  for (const el of starts) {
    // 祖先が既に起点なら二重に歩かない（結果は同じだが無駄）
    let covered = false;
    for (let p = el.parentElement; p; p = p.parentElement) if (starts.has(p)) covered = true;
    if (covered) continue;
    // 起点の**親から**継承する値は「見出し家族ではない」ので undefined で足りる
    walk(el, undefined, undefined);
  }
  return found;
}
