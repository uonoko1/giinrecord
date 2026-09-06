/**
 * `jsdom` の**このリポジトリが使う分だけ**の型（#477）。
 *
 * `jsdom` は devDependency に既にあるが（vitest の環境）、`@types/jsdom` は無い。
 * `scripts/font-subset.ts` が使うのは `new JSDOM(html).window.document` の 1 行だけなので、
 * **型パッケージを足す（＝依存の追加、PO の判断事項）より、必要な形だけをここに書く**。
 * 使い方を増やすときは、まずここを増やすことになる（＝増えたことが差分で見える）。
 */
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string);
    readonly window: { readonly document: Document };
  }
}
