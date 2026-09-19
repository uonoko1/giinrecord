import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * pdfjs に「あらかじめ定義された CMap」（Adobe-Japan1 など）の置き場所を教える（Issue #867 B 群）。
 *
 * **なぜ要るか**: 三重の古い賛否 PDF は、フォントの `Encoding` に `UniJIS-UCS2-H` のような
 * **predefined CMap の名前**を書いている。pdfjs はその中身を自前で持たず、`cMapUrl` から読む。
 * 渡さないと `translateFont` が「Ensure that the `cMapUrl` API parameter is provided.」で失敗し、
 * **そのフォントの showText は「グリフ 0 個の配列」になる。例外は投げない。**
 * つまり **文字が黙って消える**——「読めなかった」ではなく「空の表が読めた」ことになる（#569）。
 *
 * 実測（2026-09-19、三重の index 151 本）: **拡大のみ 15 本は全 showText が空**（グリフ 0）。
 * **回転 11 本のうち 2 本も同じく空**だった（回転だけの問題ではない）。CMap を渡すと 35 本とも空が 0 になる。
 *
 * **`file://` URL を渡してはいけない**（実測で踏んだ）。Node では pdfjs が `NodeBinaryDataFactory` を使い、
 * `fs.readFile(url)` にこの文字列をそのまま渡すので、**OS のパスでなければ読めない**
 * （`Unable to load CMap data at: file:///…` になる。**ネットワークには出ない**ので、
 * 取得先の許可リストの話にはならない）。末尾の `/` が要る（pdfjs が CMap 名を連結する）。
 *
 * **パスは pdfjs の解決結果から作る**ので、pnpm の `.pnpm/<name>@<ver>/` の下でも、
 * hoist されていても同じように当たる（リポジトリに絶対パスを書かない）。
 */
const require = createRequire(import.meta.url);

/**
 * `pdfjs-dist/cmaps/`（末尾 `/` つきの OS パス）。
 * `require.resolve` は `…/pdfjs-dist/legacy/build/pdf.mjs` を返すので、2 つ上が package の root。
 */
export const CMAP_DIR: string = join(dirname(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")), "..", "..", "cmaps") + "/";

/** pdfjs が同梱する CMap は `.bcmap`（バイナリ圧縮形式）。 */
export const CMAP_PACKED = true;

/** `getDocument` に渡す CMap の設定（3 か所で同じものを使う）。 */
export const CMAP_OPTIONS = { cMapUrl: CMAP_DIR, cMapPacked: CMAP_PACKED } as const;
