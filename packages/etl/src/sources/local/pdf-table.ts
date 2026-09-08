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

/** PDF の変換行列 [a, b, c, d, e, f]。 */
export type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/**
 * 行列の合成。`cm` 演算子（`OPS.transform`）は「今の CTM の *前* に掛ける」ので、
 * 新しい CTM は `m` を `ctm` に右から掛けたものになる（PDF 仕様 8.3.3）。
 */
export function multiplyMatrix(ctm: Matrix, m: ArrayLike<number>): Matrix {
  return [
    m[0] * ctm[0] + m[1] * ctm[2],
    m[0] * ctm[1] + m[1] * ctm[3],
    m[2] * ctm[0] + m[3] * ctm[2],
    m[2] * ctm[1] + m[3] * ctm[3],
    m[4] * ctm[0] + m[5] * ctm[2] + ctm[4],
    m[4] * ctm[1] + m[5] * ctm[3] + ctm[5],
  ];
}

/**
 * 矩形 [x0, y0, x1, y1] に行列を掛け、軸に沿った外接矩形（左下・右上の順）を返す。
 *
 * **4 隅すべてを見る**。回転やせん断が入ると、外接矩形の左端・右端を決めるのが
 * 対角の 2 隅とは限らない（せん断 c=2 を [0,0,4,3] に掛けると 4 隅の x は 0,4,10,6 になり、
 * 対角の (0,0) と (4,3) だけでは右端 10 を取り落とす）。
 */
export function applyMatrix(m: Matrix, rect: ArrayLike<number>): [number, number, number, number] {
  const [a, b, c, d, e, f] = m;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [px, py] of [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]]) {
    xs.push(a * px + c * py + e);
    ys.push(b * px + d * py + f);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * オペレータ列から罫線（細い矩形）を読む。**CTM を持ち回るのはここだけ**（Issue #693）。
 *
 * `OPS.constructPath` の `minMax` は **その時点の CTM を掛ける前** のローカル座標である。
 * `q`（save）/ `Q`（restore）/ `cm`（transform）を辿って CTM を作り、
 * 掛けて初めてページ上の位置になる。掛けないと、罫線を `q … cm … 矩形 … Q` で置いている PDF で
 * 全部の線が同じ位置に潰れ、**その潰れた線で列を割ると別人の票が出る。**
 *
 * **`OPS.setTransform` は見ない。pdfjs 6.2.108 の `OPS` にそんなキーは無い**（実測: `undefined`。
 * `OPS` の 91 キーのうち `transform` を含むものは `transform` 1 つだけ）。
 * Issue #693 の本文は `OPS.setTransform` も辿るよう書いているが、**存在しないものは辿れない。**
 * 書くと `fn === undefined` という恒真になりかねない枝ができるだけで、実際は害になる
 * （最初この枝を書いたとき、テストの `OPS.setTransform` も `undefined` になり、
 *   `undefined === undefined` で通ってしまった。tsc が `TS2551` で教えてくれた）。
 * pdfjs が将来 CTM を「置き換える」演算子を足したら、ここに枝を足すこと。
 *
 * `getOperatorList()` を渡さず配列 2 本で受けるのは、PDF を用意しなくても
 * 入れ子の `q`/`Q` を直接テストできるようにするため（実物のフィクスチャは深さ 2 までしか無い）。
 */
export function readLines(fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>): { vlines: VLine[]; hlines: HLine[] } {
  const vlines: VLine[] = [];
  const hlines: HLine[] = [];
  let ctm: Matrix = IDENTITY;
  const stack: Matrix[] = [];
  for (let k = 0; k < fnArray.length; k++) {
    const fn = fnArray[k];
    if (fn === OPS.save) { stack.push(ctm); continue; }
    if (fn === OPS.restore) { ctm = stack.pop() ?? IDENTITY; continue; }
    if (fn === OPS.transform) { ctm = multiplyMatrix(ctm, argsArray[k] as ArrayLike<number>); continue; }
    if (fn !== OPS.constructPath) continue;
    const args = argsArray[k] as unknown[];
    const minMax = args[2] as ArrayLike<number> | undefined;
    if (!minMax || minMax.length < 4) continue;
    const [x0, y0, x1, y1] = applyMatrix(ctm, minMax);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 2 && h > 5) vlines.push({ x: (x0 + x1) / 2, y0, y1 });
    else if (h < 2 && w > 5) hlines.push({ y: (y0 + y1) / 2, x0, x1 });
  }
  return { vlines, hlines };
}

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
      const { vlines, hlines } = readLines(ops.fnArray, ops.argsArray);
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

/**
 * 縦書きの文字列を上から順に結合。1 文字ぶん以上空いていれば半角空白 1 つ（連続する空きは 1 つに）。
 *
 * 並べ替え（y の大きい順、同じ y なら x の小さい順）は、**現在の 7 県では no-op である**（Issue #640）。
 * 呼び出し側（高知の joinVerticalColumns、島根の colX ごとの filter など）が
 * 既に列を分けて順序どおりに渡すので、この関数に届く時点で並んでいる。
 *
 * 実測（2026-09-08、フィクスチャ 7 県 24 本のうち parseVotePdf が通る 22 本。
 * 残り 2 本は島根の文字コード崩れ #232 で既知の例外）:
 *   joinVertical の呼び出しに probe を入れ、渡ってきた chars が既に
 *   (b.y - a.y || a.x - b.x) の順に並んでいるかを毎回検査した。
 *   → 呼び出し 1,650 回すべてで既に並んでいた（並べ替えが順序を変えた回数 0）。
 *   内訳: 宮城 468 / 徳島 396 / 三重 329 / 奈良 209 / 高知 178 / 島根 70 / 鳥取 0（未使用）。
 *   そのため、この行を消しても県ごとの PDF テストは 988 pass / 0 fail のまま落ちない。
 *   （対比: すぐ下の空白挿入の行を消すと 978 pass / 10 fail になる。あちらは守られている）
 *
 * **いつ効き始めるか**: 新しい県を足したとき、呼び出し側が列に分けず、
 * 順序も整えずに chars を渡すなら、この行が実際に効き始める。
 * 実データでは守れないので、代わりに test/pdf-table.test.ts が直接この順序を固定している。
 */
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
