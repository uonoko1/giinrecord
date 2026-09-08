import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { applyMatrix, cluster, multiplyMatrix, readLines, readPages, type Matrix } from "../src/sources/local/pdf-table.ts";

// Issue #693: readPages が OPS.constructPath の minMax を「そのまま」座標として使っており、
// CTM（現在の変換行列）を掛けていなかった。
//
// minMax は **その時点の CTM を掛ける前** のローカル座標である。
// 掛けないと、罫線を `q … cm … 矩形 … Q` の形で置いている PDF で、
// 全部の線が「cm の平行移動を無視した位置」——多くは原点付近——に潰れる。
//
// **何が起きるか（実害）**: 潰れた線を「罫線」と信じて列を割ると、列の境界が全部同じ位置になる。
// 列がずれたまま採決記号を置けば、**別の議員の票として出る**。利用者からは検出できない。
//
// 実測（下の佐賀のフィクスチャ、2026-09-09）:
//   直す前: 2 ページ目の縦罫線 958 本が **すべて x=0.0**（|x| < 0.01 が 958/958）。
//           8 ページ合計 5,949 本のうち 5,936 本が x=0.0。
//   直した後: x=0.0 の線は **0 本**。2 ページ目の 958 本は 47 本の列境界に落ち着き、
//           その列に議員名（「弘川貴紀」など）がちょうど 1 人ずつ入る。
//
// **#689 の「本物の罫線が 1 本も無い／958 本は字の輪郭」は誤りだった**（この PBI の実測で判明）。
// #689 は「CTM が単位行列の constructPath」だけを本物と数えたので、この PDF の罫線を全部
// 「輪郭」に分類してしまった。実際には、この PDF は表の罫線を 1 マスずつ
// `q / cm（平行移動）/ 矩形 / Q` で置いている（op は stroke、1 本の高さ 77.5pt ＝ 1 行ぶん）。
// CTM を掛けると、958 本は 47 本の列境界に重なり、その列に議員 37 名が 1 人ずつ収まる。
// **この PDF は「罫線が無い」のではなく「罫線を読めていなかった」。**
//
// **既存 7 県は 1 バイトも変わらない**。フィクスチャ 26 本の constructPath を CTM ごと分類したところ、
// 罫線として拾われる線は **全部 CTM が単位行列**（cm の下に無い）だった:
//   kochi 1196+1196 / mie 191+461+7705+191+2081 / miyagi 1084+1543 / nara 763+256 /
//   tokushima 52+52+468+156 / tottori 90+490+47+269+442 —— **いずれも変換ありは 0 本**。
//   （島根は罫線 0 本で、これも変換あり 0 本）
// だから掛けても掛けなくても同じ値になり、`data/` の再生成は差分 0 だった。

// ---------------------------------------------------------------------------
// 1. 行列そのもの（PDF を読まずに、演算だけを固定する）
// ---------------------------------------------------------------------------

test("#693 multiplyMatrix: cm は「今の CTM の前に」掛かる（平行移動の入れ子が足し算になる）", () => {
  const outer: Matrix = [1, 0, 0, 1, 10, 20];
  // 外側で (10,20) 動いている座標系の中で、さらに (3,4) 動かす
  assert.deepEqual(multiplyMatrix(outer, [1, 0, 0, 1, 3, 4]), [1, 0, 0, 1, 13, 24]);
});

test("#693 multiplyMatrix: 拡大の入れ子では、内側の平行移動が外側の倍率で伸びる（順序を逆にすると合わない）", () => {
  const outer: Matrix = [2, 0, 0, 2, 0, 0];
  // 2 倍の座標系の中で (3,4) 動かすと、ページ上では (6,8)
  assert.deepEqual(multiplyMatrix(outer, [1, 0, 0, 1, 3, 4]), [2, 0, 0, 2, 6, 8]);
  // 逆順（ctm を m の前に掛ける）だと [2,0,0,2,3,4] になってしまう。ここで区別できる
  assert.notDeepEqual(multiplyMatrix(outer, [1, 0, 0, 1, 3, 4]), [2, 0, 0, 2, 3, 4]);
});

test("#693 multiplyMatrix: 単位行列は左右どちらから掛けても変えない", () => {
  const m: Matrix = [2, 3, 4, 5, 6, 7];
  assert.deepEqual(multiplyMatrix([1, 0, 0, 1, 0, 0], m), m);
  assert.deepEqual(multiplyMatrix(m, [1, 0, 0, 1, 0, 0]), m);
});

test("#693 applyMatrix: 平行移動は矩形をそのぶん動かす（掛けないと原点に残る）", () => {
  assert.deepEqual(applyMatrix([1, 0, 0, 1, 88.2, 698.2], [0, -4.5, 0, 5]), [88.2, 693.7, 88.2, 703.2]);
});

test("#693 applyMatrix: 拡大は幅と高さを伸ばす（線の太さ判定 w<2 / h<2 がこれに依る）", () => {
  // ローカルで幅 1・高さ 10 の細い縦線を 3 倍すると、幅 3 になり「縦罫線」ではなくなる
  assert.deepEqual(applyMatrix([3, 0, 0, 3, 0, 0], [0, 0, 1, 10]), [0, 0, 3, 30]);
});

test("#693 applyMatrix: 90 度回転で縦と横が入れ替わる", () => {
  // ローカルの「横長」[0,0,10,1] を 90 度回すと「縦長」になる
  const [x0, y0, x1, y1] = applyMatrix([0, 1, -1, 0, 0, 0], [0, 0, 10, 1]);
  assert.deepEqual([x0, y0, x1, y1].map((n) => Math.round(n * 1e6) / 1e6), [-1, 0, 0, 10]);
  assert.ok(x1 - x0 < y1 - y0, "回した後は縦長になっていなければならない");
});

test("#693 applyMatrix: 4 隅すべてを見る（対角 2 点だけでは外接矩形にならない）", () => {
  // せん断（c=2）を掛けると、外接矩形の左端・右端を決めるのは
  // 「対角」ではないほうの 2 隅になる。対角 2 点しか見ない実装はここで落ちる。
  //   (0,0)->(0,0)  (4,0)->(4,0)  (4,3)->(10,3)  (0,3)->(6,3)
  //   4 隅の x は 0,4,10,6 → 外接は [0,10]。対角 (0,0) と (4,3) だけなら [0,10] ではなく…
  const [x0, y0, x1, y1] = applyMatrix([1, 0, 2, 1, 0, 0], [0, 0, 4, 3]);
  assert.deepEqual([x0, y0, x1, y1], [0, 0, 10, 3]);
  // 逆向きのせん断では、外接の左端が負になる（対角だけを見ると 0 になってしまう）
  const [nx0, , nx1] = applyMatrix([1, 0, -2, 1, 0, 0], [0, 0, 4, 3]);
  assert.equal(nx0, -6);
  assert.equal(nx1, 4);
});

test("#693 applyMatrix: 左下・右上の順で返す（負の倍率で上下がひっくり返っても入れ替えない）", () => {
  // y を反転（d = -1）すると、ローカルの y0 のほうがページ上では大きくなる
  const [, y0, , y1] = applyMatrix([1, 0, 0, -1, 0, 100], [0, 10, 1, 30]);
  assert.equal(y0, 70);
  assert.equal(y1, 90);
  assert.ok(y0 < y1, "y0 が y1 より小さい（min/max を取り違えていない）");
});

// ---------------------------------------------------------------------------
// 2. オペレータ列を組み立てて、q / Q の入れ子を直接読ませる
// ---------------------------------------------------------------------------
//
// **なぜ実物の PDF では足りないか**（実測、2026-09-09）:
//   リポジトリのフィクスチャ 26 本すべてで、`constructPath` が現れる q/Q の入れ子の深さは **1 か 2**、
//   深さ 2 のもの（kochi/0806.pdf、tottori/R8.2giketsukekka0325.pdf）は外側の CTM が単位行列だった。
//   つまり **どのフィクスチャも、`save` が CTM を積むかどうかを見分けられない**——
//   積まなくても `restore` が単位行列に落ちて同じ値になる。
//   `save` の行を消す変異は、この節を書く前は 11 件中 0 件しか落ちなかった（実測）。
//   だから深い入れ子は、PDF ではなくオペレータ列を組んで固定する。

/** 縦線 1 本ぶんの constructPath（矩形 [x0,y0,x1,y1] をローカル座標で）。 */
const path = (x0: number, y0: number, x1: number, y1: number) =>
  [OPS.stroke, [new Float32Array()], Float32Array.from([x0, y0, x1, y1])];

/** [fnArray, argsArray] を [op, args] の並びから組み立てる。 */
function opList(pairs: [number, unknown][]): [number[], unknown[]] {
  return [pairs.map((p) => p[0]), pairs.map((p) => p[1])];
}

test("#693 readLines: q が CTM を積み、Q が積んだものに戻す（入れ子の外側が残る）", () => {
  // q (10,0) 動かす → q (100,0) さらに動かす → 線 → Q（100 のぶんだけ戻る）→ 線
  const [fn, args] = opList([
    [OPS.save, null],
    [OPS.transform, [1, 0, 0, 1, 10, 0]],
    [OPS.save, null],
    [OPS.transform, [1, 0, 0, 1, 100, 0]],
    [OPS.constructPath, path(0, 0, 1, 50)],
    [OPS.restore, null],
    [OPS.constructPath, path(0, 0, 1, 50)],
    [OPS.restore, null],
  ]);
  const { vlines } = readLines(fn, args);
  assert.equal(vlines.length, 2);
  // 内側は 10 + 100 = 110、外側に戻った 2 本目は 10。
  // save が積んでいなければ Q で単位行列に落ち、2 本目が 0.5 になって落ちる
  assert.equal(vlines[0].x, 110.5);
  assert.equal(vlines[1].x, 10.5);
});

test("#693 readLines: 深さ 3 の入れ子でも 1 段ずつ戻る（stack を配列でなく 1 個の変数で持っていれば落ちる）", () => {
  const [fn, args] = opList([
    [OPS.save, null], [OPS.transform, [1, 0, 0, 1, 1, 0]],
    [OPS.save, null], [OPS.transform, [1, 0, 0, 1, 20, 0]],
    [OPS.save, null], [OPS.transform, [1, 0, 0, 1, 300, 0]],
    [OPS.constructPath, path(0, 0, 1, 50)],
    [OPS.restore, null], [OPS.constructPath, path(0, 0, 1, 50)],
    [OPS.restore, null], [OPS.constructPath, path(0, 0, 1, 50)],
    [OPS.restore, null], [OPS.constructPath, path(0, 0, 1, 50)],
  ]);
  const { vlines } = readLines(fn, args);
  assert.deepEqual(vlines.map((l) => l.x), [321.5, 21.5, 1.5, 0.5]);
});

test("#693 readLines: pdfjs 6.2.108 の OPS に setTransform は無い（存在しない演算子を辿らない）", () => {
  // Issue #693 の本文は OPS.setTransform も辿るよう書いているが、このバージョンには無い。
  // 枝を書くと `fn === undefined` の恒真になりかねないので、無いことをここで固定する。
  // pdfjs が足したら、このテストが落ちて気づける（そのとき readLines に枝を足す）。
  assert.equal((OPS as Record<string, number | undefined>).setTransform, undefined);
  assert.deepEqual(Object.keys(OPS).filter((k) => /ransform/.test(k)), ["transform"]);
  // 知らない演算子は CTM を変えない（無視して読み飛ばす）
  const [fn, args] = opList([
    [OPS.transform, [1, 0, 0, 1, 40, 0]],
    [OPS.setLineWidth, [3]],
    [OPS.constructPath, path(0, 0, 1, 50)],
  ]);
  const { vlines } = readLines(fn, args);
  assert.equal(vlines[0].x, 40.5);
});

test("#693 readLines: 釣り合わない Q（q より多い）で落ちず、単位行列に戻る", () => {
  const [fn, args] = opList([
    [OPS.transform, [1, 0, 0, 1, 40, 0]],
    [OPS.restore, null],
    [OPS.constructPath, path(0, 0, 1, 50)],
  ]);
  const { vlines } = readLines(fn, args);
  assert.equal(vlines[0].x, 0.5);
});

test("#693 readLines: 縦横の判定は CTM を掛けた後の寸法で行う（掛ける前で判定していれば落ちる）", () => {
  // ローカルでは幅 1・高さ 1（どちらの条件にも当たらない）。10 倍すると幅 10・高さ 10 で、
  // 「w<2 && h>5」にも「h<2 && w>5」にも当たらない。20 倍で縦横比を変えて縦線にする
  const [fn, args] = opList([
    [OPS.transform, [1, 0, 0, 20, 0, 0]], // y だけ 20 倍 → 幅 1・高さ 20 の縦線になる
    [OPS.constructPath, path(0, 0, 1, 1)],
  ]);
  const { vlines, hlines } = readLines(fn, args);
  assert.equal(vlines.length, 1, "掛けた後の高さ 20 で縦罫線と判定されるはず");
  assert.equal(hlines.length, 0);
  assert.equal(vlines[0].y1, 20);
});

test("#693 readLines: 掛けた後に細くなる線は罫線として拾わない（縮小で消える）", () => {
  // ローカルでは幅 1・高さ 50 の縦線。y を 1/10 にすると高さ 5 で「h > 5」を満たさなくなる
  const [fn, args] = opList([
    [OPS.transform, [1, 0, 0, 0.1, 0, 0]],
    [OPS.constructPath, path(0, 0, 1, 50)],
  ]);
  const { vlines, hlines } = readLines(fn, args);
  assert.equal(vlines.length, 0);
  assert.equal(hlines.length, 0);
});

// ---------------------------------------------------------------------------
// 3. 実物の PDF（佐賀県議会 令和7年2月定例会 議案採決結果一覧表）
// ---------------------------------------------------------------------------
//
// 出どころ: https://www.pref.saga.lg.jp/gikai/kiji003111805/3_111805_349057_up_7elgmado.pdf
//   （2026-09-09 取得。UA を名乗り、1 件のみ・間隔をあけて取得。robots.txt の Disallow は
//     `*/Calendar.aspx` 系 8 行だけで、この経路は当たらない）
// 8 ページ・文字アイテム 2,386。#689 が「罫線 958 本が x=0 に潰れる」と実測した現物。
//
// **なぜ既存 7 県のフィクスチャでは足りないか**: 上の docblock のとおり、
// 7 県の罫線は 1 本残らず CTM が単位行列である。CTM を掛ける行を消しても、
// 掛ける前と後で値が同じなので **1 件も落ちない**。この PDF だけが違いを見せられる。

const saga = readFileSync(new URL("./fixtures/saga/3_111805_349057_up_7elgmado.pdf", import.meta.url));
const pages = await readPages(saga);

test("#693 佐賀 令和7年2月版: 縦罫線が x=0 に潰れない（直す前は 5,949 本中 5,936 本が x=0 だった）", () => {
  const all = pages.flatMap((p) => p.vlines);
  assert.equal(all.length, 5949, "拾う線の本数自体は変わらない（変えたのは座標だけ）");
  const collapsed = all.filter((l) => Math.abs(l.x) < 0.01);
  assert.equal(collapsed.length, 0, `x=0 に潰れた縦罫線が ${collapsed.length} 本ある（CTM を掛けていない）`);
});

test("#693 佐賀 令和7年2月版: 2 ページ目の 958 本は 47 本の列境界になる（潰れていれば 1 本になる）", () => {
  const p2 = pages[1];
  assert.equal(p2.vlines.length, 958);
  const xs = cluster(p2.vlines.map((l) => l.x));
  assert.equal(xs.length, 47, `列の境界が ${xs.length} 本（CTM を掛けないと全部同じ x に重なって 1 本になる）`);
  // 表の右半分は議員 1 人 1 列。等間隔（約 14.8pt）で並ぶ
  const gaps = xs.slice(11, 40).map((x, i) => x - xs[i + 10]);
  for (const g of gaps) assert.ok(g > 14 && g < 16, `列の幅が ${g}（等間隔でない）`);
});

test("#693 佐賀 令和7年2月版: 復元した列に議員が 1 人ずつ入る（列がずれれば別人の票になる）", () => {
  const p2 = pages[1];
  const xs = cluster(p2.vlines.map((l) => l.x));
  const inColumn = (i: number) =>
    p2.items.filter((it) => it.cx > xs[i] && it.cx < xs[i + 1]).sort((a, b) => b.y - a.y).map((it) => it.str).join("");
  // 上から縦書きで 1 人分の氏名がちょうど 1 列に収まる（隣の列の字が混ざらない）。
  // 隣り合う 3 列を並べて見る——1 列ずれれば、この 3 つが 1 つずつずれた形で落ちる
  assert.equal(inColumn(20), "弘川貴紀");
  assert.equal(inColumn(21), "冨田幸樹");
  assert.equal(inColumn(22), "猪村利恵子");
  // 表の左側は集計欄。ここも列として正しく切れている
  assert.equal(inColumn(3), "欠席者数000000000000");
  // 議員の列（x≈556 以降）は 37 人ぶん。#689 の実測「この会期は議員 37 名」と一致する。
  // 「氏名だけが入っている列」を数える（藤木卓一郎の列だけは記号のセルが同じ x に来るので別に見る）
  const nameOnly = xs.slice(9, 46).map((_, k) => inColumn(k + 9)).filter((s) => /^[^\d○×△欠議 ]+$/.test(s));
  assert.equal(nameOnly.length, 34);
  assert.ok(inColumn(27).startsWith("員藤木卓一郎"), "議員の列が 1 つ欠けている");
});

test("#693 佐賀 令和7年2月版: 横罫線も CTM ぶん動く（y だけ直して x0/x1 を直し忘れていないか）", () => {
  const p2 = pages[1];
  assert.equal(p2.hlines.length, 41);
  // 表の横線は左端 85.44（1 本目の縦罫線）から右端 1104.06（最後の縦罫線）まで伸びる。
  // x0/x1 に CTM を掛けていなければ、ここが 0 起点のローカル座標のままになる
  const wide = p2.hlines.filter((l) => l.x1 - l.x0 > 900);
  assert.ok(wide.length > 0, "表の幅いっぱいに伸びる横線が 1 本も無い");
  for (const l of wide) {
    assert.ok(l.x0 > 80 && l.x0 < 90, `横線の左端が ${l.x0}（ページ上の位置になっていない）`);
    assert.ok(l.y > 100 && l.y < 800, `横線の y が ${l.y}（ページの外）`);
  }
});
