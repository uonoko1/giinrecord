import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FONT_FAMILIES } from "../lib/self-hosted-fonts";

/**
 * 見出し家族（Shippori Mincho）に無いウェイトを要求すると、**書いていない face が読まれる**（#452 → #454）
 *
 * `FONT_FAMILIES` の Shippori Mincho は **500 / 700 / 800** しか持たない。
 * CSS のフォントマッチング規則（CSS Fonts 4 §5.2）は、要求が 400 のとき
 * **まず 400 以下を降順、無ければ 400 より上を昇順**に探す。400 以下が無いので **500 が選ばれる**。
 *
 * 実際に起きていたこと（本番実測、390px、`document.fonts.ready` + 2.3s、`response.body().length`）:
 *
 *     .member-session-head  font-family: var(--font-head); font-weight: 700   ← 親
 *       └ .member-session-count  font-weight: 400                            ← 子。family を**継承**する
 *
 *     /members/m_003005   shippori-mincho-500.latin.woff2 + .114.woff2  2件 / 38 KB
 *     CSS.getPlatformFontsForNode → "Shippori Mincho Medium" が 3〜4 glyph を描画
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

function weightOf(body: string): number | undefined {
  const m = /(?:^|[;\s])font-weight\s*:\s*([^;]+)/.exec(body);
  if (!m) return undefined;
  const v = m[1]!.trim();
  if (v === "normal") return 400;
  if (v === "bold") return 700;
  if (v === "inherit" || v === "initial" || v === "unset" || v === "lighter" || v === "bolder") return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

describe("見出し家族が持たないウェイトを、家族を書かずに要求しない（#454）", () => {
  const all = rules();

  it("CSS の規則を読めている", () => {
    expect(all.length).toBeGreaterThan(100);
    expect(headWeights).toEqual([500, 700, 800]);
  });

  it("Shippori Mincho に無いウェイトを書く規則は、font-family も同じ規則で書く", () => {
    const offenders = all
      .filter((r) => {
        const w = weightOf(r.body);
        if (w === undefined || headWeights.includes(w)) return false;
        return !/(?:^|[;\s])font-family\s*:/.test(r.body) && !/(?:^|[;\s])font\s*:/.test(r.body);
      })
      .map((r) => `${r.file}: ${r.selector}`);
    expect(offenders).toEqual([]);
  });

  it("件数（.member-session-count）は本文家族を明示する", () => {
    const rule = all.find((r) => r.selector === ".member-session-count");
    expect(rule, ".member-session-count の規則が無い").toBeDefined();
    expect(rule!.body).toMatch(/font-family\s*:\s*var\(--font-body\)/);
  });
});
