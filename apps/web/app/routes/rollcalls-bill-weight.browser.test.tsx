import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RollCallSummary } from "../lib/data-contract";
import index from "../test-fixtures/data/rollcalls/index.json";
import meta from "../test-fixtures/meta";
import { RollCallsPage } from "./rollcalls";

/**
 * 採決一覧の議案名（`.rollcalls-item a`）を**太字にしない**ことを、
 * **実ブラウザの computed style で**守る。Issue 464（穴の指摘）/ #456（元の変更）/ 判断は #453。
 *
 * ## なぜ隣に `rollcalls-bill-weight.test.ts` があるのにこれを足すのか
 *
 * 隣の CSSOM 版は **`.rollcalls-item a` という「セレクタ文字列が完全一致する規則」しか見ない。**
 * #464 でレビュアーが実ブラウザで測ったところ、**6通りの書き方が素通り**した——
 * どれも本番では議案名の computed `font-weight` を **400 → 700 に戻す**（＝ +302 KB が復活する）のに、
 * テストは緑のままだった:
 *
 *     .rollcalls-item { font-weight: 700 }        親からの継承
 *     .rollcalls-list { font-weight: 700 }        さらに上の親からの継承
 *     .rollcalls-item a { font: 700 14.5px/… }    ショートハンド
 *     .rollcalls-item > a { font-weight: 700 }    子結合子
 *     li.rollcalls-item a { font-weight: 700 }    型セレクタ付き
 *     @media (…) { .rollcalls-item a { … } }      @media の中（CSSMediaRule は CSSStyleRule ではない）
 *
 * 「セレクタがこう書かれているか」を見るかぎり、書き方を変えれば必ず抜けられる。
 * **見るべきは「その要素に実際に効く値がいくつか」**なので、ここではブラウザに解かせる。
 *
 * ## jsdom は使えない（#464 で実測。次に同じことを試す人へ）
 *
 * 「jsdom の `getComputedStyle` に解決させる」案を**先に試して、駄目だと分かった。**
 * 上の 6 通りを jsdom で測った結果（`environment: "jsdom"` のまま `getComputedStyle`）:
 *
 *     親からの継承          font-weight = ""     ← 検出できない
 *     祖父からの継承        font-weight = ""     ← 検出できない
 *     ショートハンド        font-weight = "700"
 *     子結合子              font-weight = "700"
 *     型セレクタ付き        font-weight = "700"
 *     @media の中          font-weight = ""     ← 検出できない
 *
 * **jsdom の `getComputedStyle` は継承を実装しておらず、`@media` も評価しない。**
 * 6 通り中 3 通りしか捕まえられないので、**この PBI の受け入れ条件を満たせない。**
 * （`font-size` は `.rollcalls-item a` に直接書いてあるので jsdom でも読める。
 * 「何か値が返る」ことを継承が効いている証拠と読み違えないこと。）
 *
 * ## なぜサーバを立てないのか（CI を重くしない）
 *
 * 本番のページを HTTP で開く形（`browser-check.ts` の経路）にすると、
 * ビルド + docker compose を待つジョブにしか置けない。ここで要るのは
 * **「この DOM に、この CSS を当てたとき何 px / 何 weight になるか」**だけなので:
 *
 * - DOM は**本番の React コンポーネント `RollCallsPage` をそのまま**
 *   `renderToStaticMarkup` した markup を使う（手書きの DOM を置くと本番と食い違う）
 * - CSS は `app/**\/*.css` を**全部**読んで当てる（本番が読む集合の上位集合。
 *   どのファイルから 700 を足されても効いてしまうので、**足された側を漏らさない**。
 *   CSS ファイルが増えても自動でついてくる）
 * - ブラウザは **1 回だけ起動**し、`page.setContent` で測る。サーバも `goto` も要らない
 *
 * 実測（このファイル単体）: **約 4 秒 / ブラウザ起動 1 回**。
 *
 * ## web フォントは読み込んでいない（ここで測るものには要らない）
 *
 * `@font-face` は当てていないので、描画に使われる face はフォールバックである。
 * ここで見るのは **CSS が要求する `font-weight` の値**であって、
 * 「どの face が実際に描いたか」ではない（それは #453 / #456 が
 * `CSS.getPlatformFontsForNode` で本番のページに対して測った話で、
 * 退行の番人としてはここの値で足りる——**700 を要求しなければ 700 のスライスは読まれない**）。
 * だから `document.fonts.ready` の待ちも要らない。
 *
 * ## TSX の inline style を見ているか（#464 のコメントより）
 *
 * **見ている。** ここで測るのはブラウザが解いた computed style なので、
 * `style={{ fontWeight: 700 }}` を `rollcalls.tsx` の `<Link>` に足しても
 * （CSS には 1 文字も出ないが）**この検査は落ちる**。#461 は CSS の `font-weight` だけを
 * grep して `Tabs.tsx:79` の inline style を数え落としたが、その経路はここでは漏れない。
 * ただし**このページに描かれる要素だけ**が対象である（他ページの inline style は見ていない）。
 */

const app = join(__dirname, "..");

/** `app/**\/*.css` を全部。本番が `/rollcalls` に読み込む集合の**上位集合**にする。 */
function allCss(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allCss(full));
    else if (entry.name.endsWith(".css")) out.push(full);
  }
  return out.sort();
}

const cssFiles = allCss(app);
const css = cssFiles.map((f) => `/* ${f.slice(app.length + 1)} */\n${readFileSync(f, "utf8")}`).join("\n");

/** 本番のコンポーネントそのままの markup。手書きの DOM にすると本番と食い違う。 */
const markup = renderToStaticMarkup(
  <MemoryRouter>
    <RollCallsPage rollcalls={index as RollCallSummary[]} session={undefined} onSessionChange={() => {}} meta={meta} />
  </MemoryRouter>,
);

interface Computed {
  /** その selector に当たった要素の数。0 なら**空振り**なので、検査が成立していない */
  count: number;
  /** 当たった要素の computed style（重複は畳まない。1 件でも違えば見える） */
  values: Record<string, string[]>;
}

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

/** `selector` に当たる**すべての**要素の computed style を読む。継承も `@media` もブラウザが解く。 */
async function computed(selector: string, props: string[]): Promise<Computed> {
  const page = await browser.newPage();
  try {
    await page.setContent(`<style>\n${css}\n</style>\n${markup}`, { waitUntil: "load" });
    return await page.evaluate(
      ([sel, ps]) => {
        const els = [...document.querySelectorAll(sel)];
        const values: Record<string, string[]> = {};
        for (const p of ps) values[p] = els.map((el) => getComputedStyle(el).getPropertyValue(p));
        return { count: els.length, values };
      },
      [selector, props] as const,
    );
  } finally {
    await page.close();
  }
}

/** その property の値が、当たった要素すべてで同じなら 1 つに畳んで返す（違えば全部見せる） */
const only = (vs: string[]) => (new Set(vs).size === 1 ? vs[0]! : `ばらばら: ${JSON.stringify(vs)}`);

describe("採決一覧の議案名は太字にしない — 実ブラウザの computed style で見る（#464 / #456 / 判断は #453）", () => {
  it("議案名が実際に描かれている（空振りで通るテストにしない）", async () => {
    const r = await computed(".rollcalls-item a", ["font-size"]);
    // fixture の 4 件がそのまま出る。0 件なら以降の検査は何も見ていない
    expect(r.count, ".rollcalls-item a が 1 つも描かれていない（fixture かコンポーネントが変わった）").toBeGreaterThan(0);
  }, 120_000);

  it("議案名に効く font-weight は 400（継承・ショートハンド・@media 経由でも）", async () => {
    const r = await computed(".rollcalls-item a", ["font-weight"]);
    expect(r.count).toBeGreaterThan(0);
    expect(
      only(r.values["font-weight"]!),
      "議案名の computed font-weight が 400 でない。\n" +
        "議案名を太字にする設計根拠は無く（ワイヤーフレーム Votes.dc.html:52 はゴシック 400）、\n" +
        "太字にすると BIZ UDPGothic 700 のスライスを別に読むので /rollcalls が +302 KB になる（#453 実測）。\n" +
        "**親（.rollcalls-item / .rollcalls-list）に書いた場合も、ショートハンド（font:）でも、\n" +
        "@media の中でも、inline style でも、ここに出る。** どこに書いたかを探すこと。",
    ).toBe("400");
  }, 120_000);

  it("議案名の大きさ・行高は変えていない（#453 の判断の前提）", async () => {
    // 太さ以外を一緒に触ると「ほとんど変わらない」という #453 の判断の前提が崩れる。
    // 改行位置・行数を決めるのはこの 2 つ。computed なので line-height は px に解決される（14.5 * 1.5）。
    const r = await computed(".rollcalls-item a", ["font-size", "line-height"]);
    expect(only(r.values["font-size"]!)).toBe("14.5px");
    expect(only(r.values["line-height"]!)).toBe("21.75px");
  }, 120_000);

  it("日付行（.rollcalls-meta time）の太字は残っている", async () => {
    /*
     * #453 は「議案名の構造は太さではなく**真鍮色の日付行との対比**で出ている」と判断した。
     * 議案名を 400 にしたうえで**日付行まで 400 にすると、その対比が消える**ので、
     * ここは一緒に外してはいけない。**この PBI の範囲外**であることを検査で固定する。
     */
    const r = await computed(".rollcalls-meta time", ["font-weight"]);
    expect(r.count).toBeGreaterThan(0);
    expect(only(r.values["font-weight"]!), "日付行の太字まで外している（#453 は残すと判断した）").toBe("700");
  }, 120_000);
});
