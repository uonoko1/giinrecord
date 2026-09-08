import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { multiplyMatrix, readLines, type Matrix, type PageGeometry, type Item } from "../pdf-table.ts";

/**
 * オペレータ列からの文字と罫線の読み出し（Issue #220 高知）。
 *
 * pdf-table.ts の readPages（getTextContent）は、別々の描画命令（Tm ＋ Tj）で置かれた文字を 1 つのテキストに
 * まとめることがあり、まとめられた 2 文字目以降の位置が失われる。高知の会期 PDF では、賛否の 1 行ぶん
 * （議員 36 人ぶんの「○」「×」「議」）が丸ごと 1 つのテキスト（「○ ○ ○ … 議 … ○」）になる回があり、
 * どの列がどの値かが分からなくなる（令和7年6月定例会分。令和8年6月定例会分は 1 文字ずつ別テキスト）。
 * この PDF は 1 文字ずつ setTextMatrix（位置の明示）＋ showText で置いているので、オペレータ列を歩けば
 * 1 文字ごとの正確な位置が取れる（推定・等間隔の割り付けではない）。
 *
 * 三重の glyphs.ts と同じ考え方だが、こちらの PDF は行送りに moveText（Td）も使うので、
 * Td/TD/T* は「直前の行頭からの相対移動」として仕様どおり畳み込む（三重は Tm だけを前提に例外にしている）。
 * 回転・拡縮の入った text matrix、単位行列でない CTM の下の文字が出たら例外（黙って読み間違えない）。
 * 罫線は pdf-table.ts の readLines に任せる（CTM を掛ける。Issue #693 / #700）。
 */
export async function readGlyphPages(bytes: Buffer): Promise<PageGeometry[]> {
  const loadingTask = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const doc = await loadingTask.promise;
  const out: PageGeometry[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const ops = await page.getOperatorList();
      out.push(readGlyphPageOps(ops.fnArray, ops.argsArray, i));
    }
  } finally {
    await loadingTask.destroy();
  }
  return out;
}

/** 単位行列（q/Q/cm を辿るときの初期値）。 */
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** CTM が単位行列か（文字の位置を Tm / Td だけで決められるか）。 */
const isIdentity = (m: Matrix): boolean => m.every((v, i) => v === IDENTITY[i]);

/**
 * 1 ページぶんのオペレータ列を読む（Issue #700 でここに切り出した）。
 *
 * **罫線は pdf-table.ts の readLines に任せる**（Issue #693 / #700）。
 * `OPS.constructPath` の `minMax` は **その時点の CTM を掛ける前** のローカル座標なので、
 * `q`（save）/ `Q`（restore）/ `cm`（transform）を辿って掛けないと、
 * 罫線を `q … cm … 矩形 … Q` で置いている PDF で線が全部同じ位置に潰れる。
 * **潰れた線で列を割ると、賛否の記号が別の議員の列に入る**（高知は 1 人 1 列なので直撃する。
 * 利用者からは検出できない）。掛け方（4 隅を見る外接矩形、cm の合成の向き）は
 * 1 か所に置きたいので readLines を呼ぶ。
 *
 * **文字のほうは CTM を掛けていない**（この読み方は Tm / Td の値をそのままページ座標として使う）。
 * 掛けないまま `cm` の下で文字が置かれたら黙って別の位置に読むので、
 * **showText が単位行列でない CTM の下に来たら例外にする**（黙って読み間違えない、と同じ方針）。
 * 実測（2026-09-09、フィクスチャ 2 本）: 高知の PDF の showText は 5,004 回すべて CTM が単位行列。
 *
 * `getOperatorList()` ではなく配列 2 本で受けるのは、PDF を作らずに
 * `q`/`Q` の入れ子を直接テストできるようにするため（高知のフィクスチャは
 * 変換ありの constructPath が 0 本で、掛けても掛けなくても同じ値になり違いを見せられない）。
 */
export function readGlyphPageOps(fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>, pageNo: number): PageGeometry {
  const items: Item[] = [];
  const { vlines, hlines } = readLines(fnArray, argsArray);
  let ctm: Matrix = IDENTITY;
  const ctmStack: Matrix[] = [];
  let fontSize = 0;
  let charSpacing = 0;
  let hScale = 1;
  /**
   * 行送り（T* が使う）。**初期値 0 は PDF 32000-1 の 9.3.5 が定める既定値**（Issue #703）。
   *
   * **実データでは、この初期値も leading 自体も一度も読まれない。**
   * 実測（2026-09-09、高知 2 本・三重 5 本のフィクスチャ）: **`T*` も `TD` も `TL` も 0 回**。
   * 高知は行送りに `Td`（1109 回 / 1042 回）を使い、`Td` は行頭を置き直すので leading を読まない。
   * （Issue #703 は当初「`T*` の前に必ず `TD`/`TL` を出すから初期値が読まれない」としていたが、
   * 追試の結果それは誤りで、**`T*` 自体が 1 回も出てこない**のが本当の理由だった。）
   *
   * **だから、この値を守るテストは実物の PDF では書けない。**
   * `test/local-glyphs-leading.test.ts` が readGlyphPageOps にオペレータ列を直接渡して固定している
   * （初期値を 999 に変えると、そこの 2 件が落ちる。実測: 変えても県ごとの PDF テスト 13 件は全部通る）。
   * **この段落を消すと、あちらのテストが「実データに無い形を守る不要なもの」に見えて消される。**
   */
  let leading = 0;
  // 現在のテキスト位置（tx, ty）と行頭（lx, ly）。Td/TD/T* は行頭からの相対移動
  let tx = 0;
  let ty = 0;
  let lx = 0;
  let ly = 0;
  for (let k = 0; k < fnArray.length; k++) {
    const fn = fnArray[k];
    const args = argsArray[k] as unknown[];
    if (fn === OPS.save) {
      ctmStack.push(ctm);
    } else if (fn === OPS.restore) {
      ctm = ctmStack.pop() ?? IDENTITY;
    } else if (fn === OPS.transform) {
      ctm = multiplyMatrix(ctm, args as ArrayLike<number>);
    } else if (fn === OPS.setFont) {
      fontSize = args[1] as number;
    } else if (fn === OPS.setCharSpacing) {
      charSpacing = args[0] as number;
    } else if (fn === OPS.setLeading) {
      leading = args[0] as number;
    } else if (fn === OPS.setHScale) {
      hScale = (args[0] as number) / 100;
    } else if (fn === OPS.beginText) {
      tx = 0;
      ty = 0;
      lx = 0;
      ly = 0;
    } else if (fn === OPS.setTextMatrix) {
      // argsArray の形は [a,b,c,d,e,f] のことも、行列 1 つ（Array / Float32Array）を包んだ形のこともある
      const first = args[0] as unknown;
      const matrix = (args.length === 1 && typeof first === "object" && first !== null && "length" in (first as object) ? first : args) as ArrayLike<number>;
      const [a, b, c, d, e, f] = Array.from(matrix);
      if (a !== 1 || b !== 0 || c !== 0 || d !== 1) throw new Error(`page ${pageNo}: rotated/scaled text matrix [${a},${b},${c},${d}] not supported`);
      tx = e;
      ty = f;
      lx = e;
      ly = f;
    } else if (fn === OPS.moveText || fn === OPS.setLeadingMoveText) {
      // Td / TD: 行頭から (dx, dy) 動かして新しい行頭にする。TD は同時に leading を設定する
      const dx = args[0] as number;
      const dy = args[1] as number;
      if (fn === OPS.setLeadingMoveText) leading = -dy;
      lx += dx;
      ly += dy;
      tx = lx;
      ty = ly;
    } else if (fn === OPS.nextLine) {
      // T*: 行送りぶん下げて行頭へ
      ly -= leading;
      tx = lx;
      ty = ly;
    } else if (fn === OPS.showText) {
      // 文字の位置は Tm / Td の値をそのままページ座標として使う。cm の下ではその前提が崩れる（#700）
      if (!isIdentity(ctm)) throw new Error(`page ${pageNo}: text under non-identity CTM [${ctm.join(",")}] not supported`);
      // showText 1 回 = 1 アイテム。配列の数値は字送りの調整（thousandths）
      let x = tx;
      let str = "";
      let x0: number | undefined;
      for (const g of args[0] as (number | { unicode?: string; width?: number } | null)[]) {
        if (typeof g === "number") {
          x -= (g / 1000) * fontSize * hScale;
          continue;
        }
        if (!g || typeof g !== "object") continue;
        const w = ((g.width ?? 0) / 1000) * fontSize * hScale;
        const u = (g.unicode ?? "").replace(/[\uE000-\uF8FF]/g, "〓"); // 私用領域（外字）は読めない（原文に無い文字を作らない）
        if (u.trim() !== "") {
          x0 ??= x;
          str += u;
        }
        x += w + charSpacing * hScale;
      }
      if (str !== "" && x0 !== undefined) {
        const w = x - x0;
        items.push({ str, x: x0, y: ty, w, h: fontSize, cx: x0 + w / 2, cy: ty + fontSize / 2 });
      }
      tx = x;
    }
  }
  return { items, vlines, hlines };
}
