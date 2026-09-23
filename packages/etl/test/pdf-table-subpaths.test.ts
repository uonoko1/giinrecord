import { test } from "node:test";
import assert from "node:assert/strict";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readLines } from "../src/sources/local/pdf-table.ts";

// Issue #867 B 群「上下反転 9 本」。
//
// **Issue は「上下反転した text matrix が読めないから落ちている」と書いていたが、
// 実測では、この 9 本が読めない本当の原因は text matrix ではなかった。**
//
// **原因は `readLines` が `constructPath` を「1 回 = 1 本の線」と決めつけていることである。**
//
// pdfjs は `q / cm / constructPath / Q` の並びを **1 つの `constructPath` に畳む**
// （`pdf.worker.mjs` の path 最適化。`fnArray.splice(iFirstSave, 4, OPS.constructPath)`）。
// さらに PDF 側が **1 つの path オペレータに複数のサブパス**（`m … l … h m … l … h`）を
// 書いていると、それも 1 回の `constructPath` として届く。
// このとき **`args[2]`（`minMax`）は「畳まれた全部を囲む 1 つの外接矩形」**になる。
//
// **ここが危ない**: `readLines` は `minMax` しか見ない。
// 表の罫線が 1 回の `constructPath` にまとまって届くと、
// **数千本の線が「表全体を囲む 1 つの大きな矩形」に潰れる。**
// 大きな矩形は「細い」検査（`w < 2` / `h < 2`）に当たらないので **1 本も拾われず、
// 罫線が 0 本になる。** 例外は投げられない——**黙って「罫線の無いページ」になる。**
//
// ---------------------------------------------------------------------------
// 実測（2026-09-21、三重の index 151 本すべてを取得して数えた。母数を書く = #757）
// ---------------------------------------------------------------------------
//
// | 群 | 本数 | `constructPath` の回数 | その中のサブパスの総数 | サブパスが 2 つ以上の回 |
// |---|---:|---:|---:|---:|
// | **上下反転（FLIP）** | **9** | **92** | **13,207** | **74** |
// | 回転（ROT） | 11 | 11,557 | 11,557 | **0** |
// | 今読めている本から 10 本 | 10 | 35,866 | 35,866 | **0** |
//
// **つまり「1 回 = 1 本」という前提は、今読めている本では 100% 成り立っており、
// 上下反転の 9 本でだけ崩れている。**
// この 9 本では **13,207 本の罫線が 92 個の外接矩形に潰れ、縦罫線 0 本・横罫線 0 本**になる。
//
// **サブパスに割って読むと、9 本すべてで罫線が戻る**（実測。1 ページ目だけ）:
//   `001088734.pdf` 縦 154 / 横 11、`001088742.pdf` 縦 1236 / 横 33、`001088746.pdf` 縦 1285 / 横 34 …
// **戻った罫線の座標の範囲は、同じページの文字の範囲と重なる**
//   （`001088734.pdf`: 罫線 x 31.7..810.7 に対し文字 x 36.7..806.2）。
//
// **既存 11 県は 1 本もサブパスが 2 つ以上にならない**ので、割り方を足しても値は変わらない
// ——**が、それは「変わらないはず」ではなく、86 本を前後で突き合わせて確かめる**（下の PR 本文の表）。

/**
 * pdfjs の path バッファの形（`pdf.worker.mjs` の `DrawOPS`）。
 * **公開 API に無いので、ここに実測値を写す**（2026-09-21、pdfjs-dist 6.2.108）:
 *   `moveTo: 0` `lineTo: 1` `curveTo: 2` `quadraticCurveTo: 3` `closePath: 4`
 * 後続の数値の個数は moveTo/lineTo が 2、curveTo が 6、quadraticCurveTo が 4、closePath が 0。
 */
const MOVE = 0, LINE = 1, CURVE = 2, QUAD = 3, CLOSE = 4;

/** **三重だけが渡す切り替え**（既定は `false`。佐賀が壊れるため。`ReadLinesOptions` に実測表がある）。 */
const OPT = { splitBatchedPaths: true } as const;

/** `constructPath` 1 回ぶんの引数を組む（`[pathOps, [buffer], minMax]`）。 */
const path = (buffer: number[], minMax: number[]): unknown[] => [0, [Float32Array.from(buffer)], Float32Array.from(minMax)];

test("#867 1 回の constructPath に縦罫線が 3 本入っていたら 3 本として読む（外接矩形 1 つに潰さない）", () => {
  // x = 10 / 20 / 30 に、y 100..200 の縦線を 3 本。**細長い矩形ではなく「線」として書く**
  // （三重の上下反転 9 本はこの形。1 本ずつ m … l … h で閉じる）。
  const buffer = [
    MOVE, 10, 100, LINE, 10, 200, CLOSE,
    MOVE, 20, 100, LINE, 20, 200, CLOSE,
    MOVE, 30, 100, LINE, 30, 200, CLOSE,
  ];
  // 畳まれた minMax は 3 本全部を囲む矩形（幅 20pt）。**これだけ見ると「細い」に当たらない**
  const { vlines, hlines } = readLines([OPS.constructPath], [path(buffer, [10, 100, 30, 200])], OPT);
  assert.equal(hlines.length, 0);
  assert.deepEqual(vlines.map((v) => Math.round(v.x)), [10, 20, 30]);
  for (const v of vlines) { assert.equal(Math.round(v.y0), 100); assert.equal(Math.round(v.y1), 200); }
});

test("#867 1 回の constructPath に横罫線が 2 本入っていたら 2 本として読む", () => {
  const buffer = [MOVE, 0, 50, LINE, 100, 50, CLOSE, MOVE, 0, 80, LINE, 100, 80, CLOSE];
  const { vlines, hlines } = readLines([OPS.constructPath], [path(buffer, [0, 50, 100, 80])], OPT);
  assert.equal(vlines.length, 0);
  assert.deepEqual(hlines.map((h) => Math.round(h.y)), [50, 80]);
});

test("#867 サブパスにも CTM が掛かる（潰れた線で列を割らない。#693 と同じ実害）", () => {
  // `cm` で x に +500 動かしてから 2 本引く。掛けなければ 10 / 20、掛ければ 510 / 520
  const buffer = [MOVE, 10, 100, LINE, 10, 200, CLOSE, MOVE, 20, 100, LINE, 20, 200, CLOSE];
  const { vlines } = readLines(
    [OPS.save, OPS.transform, OPS.constructPath, OPS.restore],
    [null, [1, 0, 0, 1, 500, 0], path(buffer, [10, 100, 20, 200]), null],
    OPT,
  );
  assert.deepEqual(vlines.map((v) => Math.round(v.x)), [510, 520]);
});

test("#867 サブパスが 1 つだけなら今までと同じ値（既存 11 県の 35,866 回はこの形）", () => {
  // 幅 0.16pt・高さ 119pt の細い矩形（三重の実データの縦罫線の形）
  const buffer = [MOVE, 10, 100, LINE, 10.16, 100, LINE, 10.16, 219, LINE, 10, 219, CLOSE];
  const { vlines, hlines } = readLines([OPS.constructPath], [path(buffer, [10, 100, 10.16, 219])], OPT);
  assert.equal(hlines.length, 0);
  assert.equal(vlines.length, 1);
  assert.equal(Math.round(vlines[0].x * 100) / 100, 10.08);
});

test("#867 曲線を含むサブパスも 4 隅だけでなく制御点まで見る（字の輪郭を線と読み違えない）", () => {
  // curveTo は制御点 2 つ＋終点。**制御点を読み飛ばすと後続のバイト境界がずれ、
  // 座標でない数値を座標として読む**ので、ここで形を固定する。
  const buffer = [MOVE, 0, 0, CURVE, 0, 40, 40, 40, 40, 0, CLOSE, MOVE, 100, 0, LINE, 100, 60, CLOSE];
  const { vlines } = readLines([OPS.constructPath], [path(buffer, [0, 0, 100, 60])], OPT);
  // 1 つ目は 40x40 の塊なので線にならない。2 つ目だけが縦線
  assert.deepEqual(vlines.map((v) => Math.round(v.x)), [100]);
});

test("#867 quadraticCurveTo（制御点 1 つ）でもバイト境界がずれない", () => {
  const buffer = [MOVE, 0, 0, QUAD, 20, 40, 40, 0, CLOSE, MOVE, 100, 0, LINE, 100, 60, CLOSE];
  const { vlines } = readLines([OPS.constructPath], [path(buffer, [0, 0, 100, 60])], OPT);
  assert.deepEqual(vlines.map((v) => Math.round(v.x)), [100]);
});

test("#867 知らない draw op が来たら、その constructPath は minMax で読む（推測でバイトを進めない）", () => {
  // **pdfjs が DrawOPS を足したら、後続の数値の個数が分からない。**
  // 分からないまま進めると **座標でない数値を座標として読む**ので、
  // **サブパスに割るのをやめて、今までどおり minMax 1 つで読む**（読み違えるより拾わないほうが軽い。#569）。
  const buffer = [MOVE, 10, 100, LINE, 10, 200, CLOSE, 99, 1, 2, 3];
  const { vlines } = readLines([OPS.constructPath], [path(buffer, [10, 100, 10.16, 200])], OPT);
  assert.equal(vlines.length, 1);
  assert.equal(Math.round(vlines[0].x * 100) / 100, 10.08); // minMax の中心（サブパスの 10 ではない）
});

test("#867 buffer が無い（古い形の args）なら minMax で読む", () => {
  const { vlines } = readLines([OPS.constructPath], [[0, undefined, Float32Array.from([10, 100, 10.16, 200])]], OPT);
  assert.equal(vlines.length, 1);
});

test("#867 既定（splitBatchedPaths を渡さない）では minMax だけを読む——佐賀の 37 人を守る", () => {
  // **これが既定でないと、佐賀の `3_111805_349057_up_7elgmado.pdf` で
  // 議員の列が 37 → 11、`unknownCells` が 0 → 792 になり、セルのハッシュが変わる**
  // （2026-09-21 に 107 本のフィクスチャを前後で突き合わせて実測）。
  // 佐賀は字の輪郭を `fill` のパスで描いており、割ると字の縦棒が罫線として拾われる。
  const buffer = [
    MOVE, 10, 100, LINE, 10, 200, CLOSE,
    MOVE, 20, 100, LINE, 20, 200, CLOSE,
    MOVE, 30, 100, LINE, 30, 200, CLOSE,
  ];
  const { vlines, hlines } = readLines([OPS.constructPath], [path(buffer, [10, 100, 30, 200])]);
  // 幅 20pt の外接矩形は「細い」に当たらないので 1 本も拾われない（今までどおり）
  assert.equal(vlines.length, 0);
  assert.equal(hlines.length, 0);
});
