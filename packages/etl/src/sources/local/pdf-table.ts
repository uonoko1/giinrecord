import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { CMAP_OPTIONS } from "./pdf-cmap.ts";

/**
 * 地方議会の表決 PDF に共通の幾何（Issue #157 宮城、#183 徳島）。
 * 文字層のアイテム（位置つき）と、罫線（PDF に細い矩形として描かれている縦線・横線）を読むだけ。
 * 表の復元（どの線が列・行の境界か）は議会ごとのレイアウトに依るので各 votes-pdf.ts が行う。
 * 方針: 文字の位置を推定で並べ替えない。罫線で区切られたセルに文字の中心が入るかだけで置く。
 */
export interface Item { str: string; x: number; y: number; w: number; h: number; cx: number; cy: number }
export interface VLine { x: number; y0: number; y1: number }
export interface HLine { y: number; x0: number; x1: number }
/** ページの文字と罫線。オペレータ列だけから作れる部分（`kochi/glyphs.ts` / `mie/glyphs.ts` が作る）。 */
export interface PageGeometry { items: Item[]; vlines: VLine[]; hlines: HLine[] }

/**
 * `readPages` が返すページ。**`rotate` と `view` は青森（#750）で足した**。
 * **既存 8 県は 1 つも読んでいない**（`items` / `vlines` / `hlines` の値は 1 バイトも変わらない）。
 *
 * **なぜ要るか**——**青森の 56 本のうち 11 本 / 27 ページが `/Rotate 90`**（#743 が実測）。
 * `it.transform[4]/[5]` は回転を打ち消す前の座標なので、**そのまま読むと縦書きの氏名が横に並び、
 * 行が縦に並ぶ**（#743: 行 2,445 → 2,000、対 113,911 → 92,901、氏名なし 20,864）。
 * **打ち消す計算は共通層には置かない**（既存 8 県の出力が変わるため。#743 と同じ判断）。
 * **ここは「ページがそう宣言している」という事実だけを渡し、直すかどうかは議会ごとに決める。**
 *
 * **`PageGeometry` と分けてあるのは、`kochi/glyphs.ts` / `mie/glyphs.ts` が
 * ページを持たずにオペレータ列だけから幾何を組み立てるため**（そちらは `/Rotate` を知りようがない）。
 */
export interface RotatedPageGeometry extends PageGeometry {
  /** ページの `/Rotate`（度。0 / 90 / 180 / 270）。**座標には反映していない** */
  rotate: number;
  /** ページの MediaBox（`page.view`。`[x0, y0, x1, y1]`）。回転を打ち消すときに幅・高さが要る */
  view: readonly [number, number, number, number];
}

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
 * `readLines` の振る舞いの切り替え（Issue #867）。
 */
export interface ReadLinesOptions {
  /**
   * **1 回の `constructPath` に入った複数のサブパスを、1 本ずつの線として読むか**（既定 `false`）。
   *
   * **既定を `false` にしてある。** これは「安全側だから」ではなく、
   * **`true` にすると既存 11 県のうち 2 県の出力が実際に変わる**ためである
   * （2026-09-21 に 107 本のフィクスチャを前後で突き合わせて実測）:
   *
   * | フィクスチャ | `true` にすると |
   * |---|---|
   * | `saga/3_111805_349057_up_7elgmado.pdf` | **議員の列が 37 → 11、`unknownCells` が 0 → 792**。**セルのハッシュが変わる**（＝票が別の列に落ちる） |
   * | `aomori/32{2,3,4}teirei_sanpi.pdf` | 罫線が 0 → 230 本に増える。**セルのハッシュは変わらない**（青森はこの罫線を使っていない）が、出力は変わる |
   *
   * **佐賀で壊れる理由**: 佐賀の PDF は**字の輪郭を `fill` のパスで描いており**、
   * 1 回の `constructPath` に 2〜13 個のサブパスが入っている（実測: 6,417 回 / 29,725 サブパス）。
   * 割ると **字の縦棒・横棒が「長さ 5〜12pt の罫線」として拾われ**、列の境界が汚れる。
   * **`minMax` 1 つで読んでいたときは、字の輪郭は「太い塊」に見えて罫線検査に当たらなかった。**
   * **つまり `minMax` は、意図せず「字を罫線と読み違えない」働きをしていた。**
   *
   * **`fill` / `stroke` の別では分けられない**（実測）——
   * 佐賀の輪郭も三重の上下反転 9 本の罫線も、どちらも塗りのパスで来る
   * （三重 9 本は `eoFill`、佐賀の輪郭は `fill` と `eoFill` の両方）。
   *
   * **だから議会ごとに選ばせる。** 今これを `true` にしているのは三重だけである。
   */
  splitBatchedPaths?: boolean;
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
export function readLines(fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>, options: ReadLinesOptions = {}): { vlines: VLine[]; hlines: HLine[] } {
  const { splitBatchedPaths = false } = options;
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
    // **1 回の `constructPath` に複数のサブパスが入っていることがある**（Issue #867）。
    // その場合 `minMax` は「全部を囲む 1 つの外接矩形」なので、これだけ見ると
    // **数千本の罫線が 1 つの大きな矩形に潰れ、「細い」検査に当たらず 1 本も拾われない。**
    // サブパスに割れたときはそちらを使い、割れなければ今までどおり `minMax` を使う。
    for (const rect of (splitBatchedPaths ? splitSubpaths(args[1]) : undefined) ?? [minMax]) {
      const [x0, y0, x1, y1] = applyMatrix(ctm, rect);
      const w = x1 - x0;
      const h = y1 - y0;
      if (w < 2 && h > 5) vlines.push({ x: (x0 + x1) / 2, y0, y1 });
      else if (h < 2 && w > 5) hlines.push({ y: (y0 + y1) / 2, x0, x1 });
    }
  }
  return { vlines, hlines };
}

/**
 * pdfjs の path バッファ（`constructPath` の `args[1]`）の描画命令（`pdf.worker.mjs` の `DrawOPS`）。
 *
 * **公開 API に無いので実測値を写す**（2026-09-21、`pdfjs-dist` 6.2.108 の `pdf.worker.mjs:5832`）。
 * 後続の数値の個数（この値を間違えるとバイト境界がずれ、**座標でない数値を座標として読む**）:
 */
const DRAW_MOVE_TO = 0;
const DRAW_LINE_TO = 1;
const DRAW_CURVE_TO = 2;
const DRAW_QUADRATIC_CURVE_TO = 3;
const DRAW_CLOSE_PATH = 4;
/** 描画命令 → 後続の数値の個数。**ここに無い命令が来たらサブパスに割らない**（下記）。 */
const DRAW_OP_OPERANDS: ReadonlyMap<number, number> = new Map([
  [DRAW_MOVE_TO, 2], [DRAW_LINE_TO, 2], [DRAW_CURVE_TO, 6], [DRAW_QUADRATIC_CURVE_TO, 4], [DRAW_CLOSE_PATH, 0],
]);

/**
 * `constructPath` の path バッファを**サブパスごとの外接矩形**に割る（Issue #867 B 群「上下反転 9 本」）。
 *
 * **なぜ要るか**: pdfjs は `q / cm / constructPath / Q` の並びを 1 つの `constructPath` に畳み
 * （`pdf.worker.mjs` の path 最適化）、PDF 側が 1 つの path オペレータに複数のサブパスを
 * 書いていればそれも 1 回で届く。このとき `minMax` は畳まれた全部を囲む 1 つの矩形になる。
 * **三重の上下反転 9 本は、13,207 本の罫線が 92 回の `constructPath` に入っており、
 * `minMax` だけを見ると縦罫線 0 本・横罫線 0 本になる**（2026-09-21 実測）。
 * **例外は投げられない。黙って「罫線の無いページ」になる**（#569 の「途中まで読んだ表」と同じ形）。
 *
 * **既存 11 県には効かない**——**今読めている本の `constructPath` は 1 回 = 1 サブパスである**
 * （2026-09-21 実測: 読めている 10 本で 35,866 回 / 35,866 サブパス、三重の回転 11 本で
 * 11,557 回 / 11,557 サブパス。**サブパスが 2 つ以上の回は 0**）。
 * サブパスが 1 つなら、その外接矩形は `minMax` と同じものを指す。
 *
 * **知らない描画命令が来たら `undefined` を返して、呼び手を `minMax` に戻す。**
 * **後続の数値の個数が分からないまま進めると、バイト境界がずれて
 * 「座標でない数値を座標として読む」**——それは**潰れた線より重い**（別人の列に落ちる。#693）。
 * **読み違えるくらいなら拾わない側に倒す**（#569）。
 */
function splitSubpaths(raw: unknown): number[][] | undefined {
  // pdfjs は `[buffer]` の形（配列 1 つに包む）で渡す
  const wrapped = raw as ArrayLike<unknown> | undefined;
  if (!wrapped || wrapped.length !== 1) return undefined;
  const buf = wrapped[0] as ArrayLike<number> | undefined;
  if (!buf || typeof buf.length !== "number" || buf.length === 0) return undefined;
  const out: number[][] = [];
  let box: number[] | undefined;
  const add = (x: number, y: number): void => {
    if (!box) box = [x, y, x, y];
    else { box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y); }
  };
  for (let i = 0; i < buf.length;) {
    const op = buf[i++];
    const operands = DRAW_OP_OPERANDS.get(op);
    if (operands === undefined) return undefined; // 知らない命令: 進め方が分からないので諦める
    if (i + operands > buf.length) return undefined; // 途中で切れている
    // **`m`（moveTo）は新しいサブパスの始まり**なので、点を足す前にここで切る。
    // `h`（closePath）で閉じずに次の `m` で次の線を引く PDF があり、切らないと全部 1 つの箱になる。
    if (op === DRAW_MOVE_TO && box) { out.push(box); box = undefined; }
    // **制御点も外接矩形に入れる**（曲線の膨らみは制御点の凸包に収まるので、制御点を見れば足りる）
    for (let j = 0; j < operands; j += 2) add(buf[i + j], buf[i + j + 1]);
    i += operands;
    if (op === DRAW_CLOSE_PATH && box) { out.push(box); box = undefined; }
  }
  if (box) out.push(box);
  return out.length === 0 ? undefined : out;
}

/**
 * **あらかじめ定義された CMap を pdfjs に渡す**（Issue #922。`./pdf-cmap.ts` に理由を書いた）。
 * **11 県のうち 9 県がここを通る**（`glyphs.ts` を持つのは高知と三重だけ）。
 * 渡さないと、古い本のフォントで **getTextContent が 1 アイテムも返さず、文字が黙って消える**
 * （例外は投げられない。滋賀の `Kg265_250424` は 711 回の showText が全部「グリフ 0」だった）。
 */
export async function readPages(bytes: Buffer): Promise<RotatedPageGeometry[]> {
  const loadingTask = getDocument({ data: new Uint8Array(bytes), verbosity: 0, ...CMAP_OPTIONS });
  const doc = await loadingTask.promise;
  const out: RotatedPageGeometry[] = [];
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
      const view = page.view as number[];
      out.push({ items, vlines, hlines, rotate: page.rotate, view: [view[0], view[1], view[2], view[3]] });
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
