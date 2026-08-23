import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * 地方議会の表決 PDF に共通の幾何（Issue #157 宮城、#183 徳島）。
 * 文字層のアイテム（位置つき）と、罫線（PDF に細い矩形として描かれている縦線・横線）を読むだけ。
 * 表の復元（どの線が列・行の境界か）は議会ごとのレイアウトに依るので各 votes-pdf.ts が行う。
 * 方針: 文字の位置を推定で並べ替えない。罫線で区切られたセルに文字の中心が入るかだけで置く。
 */
export interface Item { str: string; x: number; y: number; w: number; h: number; cx: number; cy: number }
export interface VLine { x: number; y0: number; y1: number }
export interface HLine { y: number; x0: number; x1: number }
export interface PageGeometry { items: Item[]; vlines: VLine[]; hlines: HLine[] }

/** 境界からこの距離以内にある文字は「どちらのセルか分からない」として置かない。 */
export const EDGE = 1.0;
/** 罫線の座標をまとめる（同じ線が二重に描かれている）距離。 */
export const EPS = 1.5;

export async function readPages(bytes: Buffer): Promise<PageGeometry[]> {
  const loadingTask = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const doc = await loadingTask.promise;
  const out: PageGeometry[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const items: Item[] = [];
      for (const it of content.items) {
        if (!("str" in it)) continue;
        // 私用領域（外字）は読めないので 〓 にする（原文に無い文字を作らない）
        const str = it.str.replace(/[-]/g, "〓");
        if (str.trim() === "") continue;
        const x = it.transform[4];
        const y = it.transform[5];
        items.push({ str, x, y, w: it.width, h: it.height, cx: x + it.width / 2, cy: y + it.height / 2 });
      }
      const ops = await page.getOperatorList();
      const vlines: VLine[] = [];
      const hlines: HLine[] = [];
      for (let k = 0; k < ops.fnArray.length; k++) {
        if (ops.fnArray[k] !== OPS.constructPath) continue;
        const args = ops.argsArray[k] as unknown[];
        const minMax = args[2] as ArrayLike<number> | undefined;
        if (!minMax || minMax.length < 4) continue;
        const [x0, y0, x1, y1] = [minMax[0], minMax[1], minMax[2], minMax[3]];
        const w = x1 - x0;
        const h = y1 - y0;
        if (w < 2 && h > 5) vlines.push({ x: (x0 + x1) / 2, y0, y1 });
        else if (h < 2 && w > 5) hlines.push({ y: (y0 + y1) / 2, x0, x1 });
      }
      out.push({ items, vlines, hlines });
    }
  } finally {
    await loadingTask.destroy();
  }
  return out;
}

/** 近い値（eps 以内）をまとめて昇順に。二重線・分割して描かれた線を 1 本にする。 */
export function cluster(values: number[], eps = EPS): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length && Math.abs(out[out.length - 1] - v) <= eps) out[out.length - 1] = (out[out.length - 1] + v) / 2;
    else out.push(v);
  }
  return out;
}

/** 区間 [lo, hi] のどこに値があるか。境界の EDGE 以内なら undefined（置かない）。 */
export function bandIndex(bounds: number[], v: number): number | undefined {
  for (let i = 0; i + 1 < bounds.length; i++) {
    const lo = Math.min(bounds[i], bounds[i + 1]);
    const hi = Math.max(bounds[i], bounds[i + 1]);
    if (v > lo + EDGE && v < hi - EDGE) return i;
  }
  return undefined;
}

export const within = (v: number, lo: number, hi: number): boolean => v > Math.min(lo, hi) && v < Math.max(lo, hi);

/** 縦書きの文字列を上から順に結合。1 文字ぶん以上空いていれば半角空白 1 つ（連続する空きは 1 つに）。 */
export function joinVertical(chars: Item[]): string {
  const sorted = [...chars].sort((a, b) => b.y - a.y || a.x - b.x);
  let out = "";
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0) {
      const gap = sorted[i - 1].y - sorted[i].y;
      const step = Math.max(sorted[i].h, sorted[i - 1].h, 1);
      if (gap > step * 1.5) out += " ";
    }
    out += sorted[i].str;
  }
  return out.trim();
}
