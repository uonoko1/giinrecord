import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PageGeometry, Item, VLine, HLine } from "../pdf-table.ts";

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
 * 回転・拡縮の入った text matrix が出たら例外（黙って読み間違えない）。罫線の読み方は readPages と同じ。
 */
export async function readGlyphPages(bytes: Buffer): Promise<PageGeometry[]> {
  const loadingTask = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const doc = await loadingTask.promise;
  const out: PageGeometry[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const ops = await page.getOperatorList();
      const items: Item[] = [];
      const vlines: VLine[] = [];
      const hlines: HLine[] = [];
      let fontSize = 0;
      let charSpacing = 0;
      let hScale = 1;
      let leading = 0;
      // 現在のテキスト位置（tx, ty）と行頭（lx, ly）。Td/TD/T* は行頭からの相対移動
      let tx = 0;
      let ty = 0;
      let lx = 0;
      let ly = 0;
      for (let k = 0; k < ops.fnArray.length; k++) {
        const fn = ops.fnArray[k];
        const args = ops.argsArray[k] as unknown[];
        if (fn === OPS.setFont) {
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
          if (a !== 1 || b !== 0 || c !== 0 || d !== 1) throw new Error(`page ${i}: rotated/scaled text matrix [${a},${b},${c},${d}] not supported`);
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
        } else if (fn === OPS.constructPath) {
          const minMax = args[2] as ArrayLike<number> | undefined;
          if (!minMax || minMax.length < 4) continue;
          const [x0, y0, x1, y1] = [minMax[0], minMax[1], minMax[2], minMax[3]];
          const w = x1 - x0;
          const h = y1 - y0;
          if (w < 2 && h > 5) vlines.push({ x: (x0 + x1) / 2, y0, y1 });
          else if (h < 2 && w > 5) hlines.push({ y: (y0 + y1) / 2, x0, x1 });
        }
      }
      out.push({ items, vlines, hlines });
    }
  } finally {
    await loadingTask.destroy();
  }
  return out;
}
