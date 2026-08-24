import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PageGeometry, Item, VLine, HLine } from "../pdf-table.ts";

/**
 * オペレータ列からの文字と罫線の読み出し（Issue #203 三重）。
 *
 * pdf-table.ts の readPages（getTextContent）は、別々の描画命令（Tm ＋ Tj）で置かれた文字を 1 つのテキストにまとめることがあり、
 * まとめられた 2 文字目以降の位置が失われる（三重の令和8年5月分 PDF では、縦書きの氏名の列で
 * 「中川正美」の末尾の「美」と隣の列の先頭の「辻󠄀」（異体字セレクタ付き）が「美辻󠄀」の 1 テキストになり、
 * 「辻󠄀」が隣の列の位置で読めなくなる）。
 * この PDF はすべての文字を setTextMatrix（位置の明示）＋ showText で置いているので、オペレータ列を歩けば
 * 1 文字ごとの正確な位置が取れる（推定ではない）。ここでは showText 1 回を 1 アイテムにする
 * （見出しの「令和８年定例会（２月）」のような 1 行のテキストは 1 回の showText、氏名・セルの 1 文字は 1 文字ずつ）。
 * 位置の前提が崩れる命令（moveText 系・回転や拡縮の入った text matrix）が出たら例外（黙って読み間違えない）。
 * 罫線の読み方は readPages と同じ。
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
      let tx = 0;
      let ty = 0;
      for (let k = 0; k < ops.fnArray.length; k++) {
        const fn = ops.fnArray[k];
        const args = ops.argsArray[k] as unknown[];
        if (fn === OPS.setFont) {
          fontSize = args[1] as number;
        } else if (fn === OPS.setCharSpacing) {
          charSpacing = args[0] as number;
        } else if (fn === OPS.setHScale) {
          hScale = (args[0] as number) / 100;
        } else if (fn === OPS.beginText) {
          tx = 0;
          ty = 0;
        } else if (fn === OPS.setTextMatrix) {
          // argsArray の形は [a,b,c,d,e,f] のことも、行列 1 つ（Array / Float32Array）を包んだ形のこともある
          const first = args[0] as unknown;
          const matrix = (args.length === 1 && typeof first === "object" && first !== null && "length" in (first as object) ? first : args) as ArrayLike<number>;
          const [a, b, c, d, e, f] = Array.from(matrix);
          if (a !== 1 || b !== 0 || c !== 0 || d !== 1) throw new Error(`page ${i}: rotated/scaled text matrix [${a},${b},${c},${d}] not supported`);
          tx = e;
          ty = f;
        } else if (fn === OPS.moveText || fn === OPS.setLeadingMoveText || fn === OPS.nextLine) {
          // 相対移動（Td/TD/T*）を使う PDF はこの読み方の前提（位置は Tm で明示）が崩れる
          throw new Error(`page ${i}: unsupported text-positioning op (moveText/nextLine)`);
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
