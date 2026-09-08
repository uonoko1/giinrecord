import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readGlyphPageOps as mieOps, readGlyphPages as mieGlyphPages } from "../src/sources/local/mie/glyphs.ts";
import { readGlyphPageOps as kochiOps, readGlyphPages as kochiGlyphPages } from "../src/sources/local/kochi/glyphs.ts";

// Issue #700: #693 が pdf-table.ts の readPages を直した後も、
// mie/glyphs.ts と kochi/glyphs.ts は OPS.constructPath の minMax を
// 「そのまま」座標として使っていた（CTM を掛けていなかった）。
//
// minMax は **その時点の CTM を掛ける前** のローカル座標である。
// 罫線を `q … cm … 矩形 … Q` で置いている PDF では、掛けないと線が全部同じ位置に潰れる。
// **潰れた線で列を割ると、賛否の記号が別の議員の列に入る**（三重も高知も 1 人 1 列）。
// 利用者からは「別人の票」として見えるだけで、検出できない。
//
// **なぜ三重・高知のフィクスチャでは足りないか**（実測、2026-09-09）:
//   フィクスチャ 7 本の constructPath（minMax つき）を CTM ごと数えた:
//     mie/001235880.pdf   530 本 / 変換あり 0    mie/001242584.pdf   968 本 / 変換あり 0
//     mie/001249930.pdf 13181 本 / 変換あり 0    mie/001256778.pdf   529 本 / 変換あり 0
//     mie/001263901.pdf  3606 本 / 変換あり 0
//     kochi/0706.pdf     2741 本 / 変換あり 0    kochi/0806.pdf     2744 本 / 変換あり 0
//   **1 本も変換の下に無い**。だから掛けても掛けなくても同じ値になり、
//   CTM を掛ける行を消しても県ごとの PDF テストは 1 件も落ちない（＝ data/ も 1 バイトも変わらない）。
//   （対比: 佐賀の PDF は 14071 本中 13864 本が変換の下にある。#693 はそれで実害を見せた）
//
// **だから、この節はオペレータ列を直接組んで固定する。**
// readGlyphPageOps は #700 でそのために切り出した（PDF を作らずに q/Q の入れ子を渡せる）。
//
// **なぜ佐賀の PDF を通せないか**: 三重・高知の読み方は「文字の位置は Tm（＋高知は Td）で明示」を
// 前提にしており、佐賀の PDF は前提を満たさない（実測: 三重は
// `page 1: unsupported text-positioning op (moveText/nextLine)`、
// 高知は `page 1: rotated/scaled text matrix [1,0,0,0.875] not supported` で例外になる）。
// 例外にするのは正しい振る舞いなので、罫線だけをこの PDF で測ることはできない。

/** 縦線 1 本ぶんの constructPath（矩形 [x0,y0,x1,y1] をローカル座標で）。 */
const path = (x0: number, y0: number, x1: number, y1: number) =>
  [OPS.stroke, [new Float32Array()], Float32Array.from([x0, y0, x1, y1])];

/** [fnArray, argsArray] を [op, args] の並びから組み立てる。 */
function opList(pairs: [number, unknown][]): [number[], unknown[]] {
  return [pairs.map((p) => p[0]), pairs.map((p) => p[1])];
}

/** 三重と高知の readGlyphPageOps を同じ入力で回す（同じ穴が 2 ファイルにあったので同じ検査を当てる）。 */
const readers: [string, (fn: ArrayLike<number>, args: ArrayLike<unknown>, page: number) => ReturnType<typeof mieOps>][] = [
  ["mie", mieOps],
  ["kochi", kochiOps],
];

// ---------------------------------------------------------------------------
// 1. 使う演算子が pdfjs 6.2.108 に実在すること（#699: 名前を間違えると両側 undefined で通る）
// ---------------------------------------------------------------------------

test("#700 使う OPS のキーが実在する（存在しない名前を辿ると undefined === undefined で恒真になる）", () => {
  for (const [name, v] of [["save", OPS.save], ["restore", OPS.restore], ["transform", OPS.transform], ["constructPath", OPS.constructPath]] as const) {
    assert.equal(typeof v, "number", `OPS.${name} が number でない（${String(v)}）`);
  }
  // #693 の罠: OPS.setTransform はこのバージョンに無い。辿ると fn === undefined の恒真枝ができる
  assert.equal((OPS as Record<string, number | undefined>).setTransform, undefined);
  // 4 つが互いに別の値（同じ値なら枝の区別になっていない）
  assert.equal(new Set([OPS.save, OPS.restore, OPS.transform, OPS.constructPath]).size, 4);
});

// ---------------------------------------------------------------------------
// 2. 罫線に CTM が掛かる（掛けないと潰れる）
// ---------------------------------------------------------------------------

for (const [name, read] of readers) {
  test(`#700 ${name}: cm の平行移動が罫線に効く（掛けないと x=0.5 に潰れる）`, () => {
    const [fn, args] = opList([
      [OPS.save, null],
      [OPS.transform, [1, 0, 0, 1, 200, 300]],
      [OPS.constructPath, path(0, 0, 1, 50)],
      [OPS.restore, null],
    ]);
    const { vlines } = read(fn, args, 1);
    assert.equal(vlines.length, 1);
    assert.equal(vlines[0].x, 200.5, "CTM を掛けていなければ 0.5（原点付近に潰れる）");
    assert.equal(vlines[0].y0, 300);
    assert.equal(vlines[0].y1, 350);
  });

  test(`#700 ${name}: 罫線が列ごとに別の x になる（潰れると 1 列になり別人の票になる）`, () => {
    // 表の 1 マスずつを `q / cm / 矩形 / Q` で置く（佐賀の PDF がこの形）
    const pairs: [number, unknown][] = [];
    for (let c = 0; c < 5; c++) {
      pairs.push([OPS.save, null]);
      pairs.push([OPS.transform, [1, 0, 0, 1, 100 + c * 15, 400]]);
      pairs.push([OPS.constructPath, path(0, 0, 0.5, 60)]);
      pairs.push([OPS.restore, null]);
    }
    const [fn, args] = opList(pairs);
    const { vlines } = read(fn, args, 1);
    assert.deepEqual(vlines.map((l) => l.x), [100.25, 115.25, 130.25, 145.25, 160.25]);
    assert.equal(new Set(vlines.map((l) => l.x)).size, 5, "5 本が別の列境界になっていない（潰れている）");
  });

  test(`#700 ${name}: 横罫線の x0/x1 にも CTM が効く（y だけ直して x を直し忘れていないか）`, () => {
    const [fn, args] = opList([
      [OPS.save, null],
      [OPS.transform, [1, 0, 0, 1, 85, 700]],
      [OPS.constructPath, path(0, 0, 900, 0.5)],
      [OPS.restore, null],
    ]);
    const { hlines } = read(fn, args, 1);
    assert.equal(hlines.length, 1);
    assert.equal(hlines[0].x0, 85);
    assert.equal(hlines[0].x1, 985);
    assert.equal(hlines[0].y, 700.25);
  });

  test(`#700 ${name}: q が CTM を積み、Q が積んだものに戻す（深さ 3 の入れ子）`, () => {
    // フィクスチャの q/Q の入れ子は深さ 1〜2 までしか無い（実測。kochi/0806.pdf だけ 2）。
    // 深さ 3 は PDF では作れないのでここで固定する（stack を 1 個の変数で持てば落ちる）
    const [fn, args] = opList([
      [OPS.save, null], [OPS.transform, [1, 0, 0, 1, 1, 0]],
      [OPS.save, null], [OPS.transform, [1, 0, 0, 1, 20, 0]],
      [OPS.save, null], [OPS.transform, [1, 0, 0, 1, 300, 0]],
      [OPS.constructPath, path(0, 0, 1, 50)],
      [OPS.restore, null], [OPS.constructPath, path(0, 0, 1, 50)],
      [OPS.restore, null], [OPS.constructPath, path(0, 0, 1, 50)],
      [OPS.restore, null], [OPS.constructPath, path(0, 0, 1, 50)],
    ]);
    const { vlines } = read(fn, args, 1);
    assert.deepEqual(vlines.map((l) => l.x), [321.5, 21.5, 1.5, 0.5]);
  });

  test(`#700 ${name}: 縦横の判定は CTM を掛けた後の寸法で行う`, () => {
    // ローカルでは幅 1・高さ 1（どちらの条件にも当たらない）。y だけ 20 倍で縦線になる
    const [fn, args] = opList([
      [OPS.transform, [1, 0, 0, 20, 0, 0]],
      [OPS.constructPath, path(0, 0, 1, 1)],
    ]);
    const { vlines, hlines } = read(fn, args, 1);
    assert.equal(vlines.length, 1, "掛けた後の高さ 20 で縦罫線になるはず");
    assert.equal(hlines.length, 0);
    assert.equal(vlines[0].y1, 20);
  });

  test(`#700 ${name}: せん断の入った cm でも 4 隅から外接矩形を取る（対角 2 点では足りない）`, () => {
    const [fn, args] = opList([
      [OPS.transform, [1, 0, -6, 1, 0, 0]],
      [OPS.constructPath, path(0, 0, 40, 1)],
    ]);
    const { hlines } = read(fn, args, 1);
    assert.equal(hlines.length, 1);
    // 4 隅の x は 0, 40, 34, -6 → 外接は [-6, 40]。
    // 対角 (0,0) と (40,1) だけを見る実装なら [0, 40] になり、ここで落ちる
    assert.equal(hlines[0].x0, -6);
    assert.equal(hlines[0].x1, 40);
  });
}

// ---------------------------------------------------------------------------
// 3. 文字のほうは CTM を掛けていないので、cm の下に来たら例外にする（黙って読み間違えない）
// ---------------------------------------------------------------------------

/** 「あ」1 文字を Tm で (x, y) に置く showText。 */
const glyph = (u: string) => [[{ unicode: u, width: 1000 }]];

test("#700 mie: 単位行列の CTM の下なら文字は Tm の位置に読める（下の例外テストの否定的対照）", () => {
  const [fn, args] = opList([
    [OPS.setFont, ["F1", 10]],
    [OPS.beginText, null],
    [OPS.setTextMatrix, [1, 0, 0, 1, 50, 700]],
    [OPS.showText, glyph("あ")],
  ]);
  const { items } = mieOps(fn, args, 1);
  assert.equal(items.length, 1);
  assert.equal(items[0].str, "あ");
  assert.deepEqual([items[0].x, items[0].y], [50, 700]);
});

test("#700 kochi: 単位行列の CTM の下なら文字は Tm の位置に読める（否定的対照）", () => {
  const [fn, args] = opList([
    [OPS.setFont, ["F1", 10]],
    [OPS.beginText, null],
    [OPS.setTextMatrix, [1, 0, 0, 1, 50, 700]],
    [OPS.showText, glyph("あ")],
  ]);
  const { items } = kochiOps(fn, args, 1);
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].x, items[0].y], [50, 700]);
});

for (const [name, read] of readers) {
  test(`#700 ${name}: cm の下の文字は例外（掛けずに読むと黙って別の位置になる）`, () => {
    const [fn, args] = opList([
      [OPS.setFont, ["F1", 10]],
      [OPS.save, null],
      [OPS.transform, [1, 0, 0, 1, 300, 0]],
      [OPS.beginText, null],
      [OPS.setTextMatrix, [1, 0, 0, 1, 50, 700]],
      [OPS.showText, glyph("あ")],
      [OPS.restore, null],
    ]);
    assert.throws(() => read(fn, args, 2), /page 2: text under non-identity CTM/);
  });

  test(`#700 ${name}: Q で単位行列に戻った後の文字は例外にしない（例外が広すぎないか）`, () => {
    const [fn, args] = opList([
      [OPS.setFont, ["F1", 10]],
      [OPS.save, null],
      [OPS.transform, [1, 0, 0, 1, 300, 0]],
      [OPS.constructPath, path(0, 0, 1, 50)],
      [OPS.restore, null],
      [OPS.beginText, null],
      [OPS.setTextMatrix, [1, 0, 0, 1, 50, 700]],
      [OPS.showText, glyph("い")],
    ]);
    const { items, vlines } = read(fn, args, 1);
    assert.equal(items.length, 1);
    assert.equal(items[0].x, 50);
    assert.equal(vlines[0].x, 300.5, "罫線のほうは cm のぶん動いている");
  });
}

// ---------------------------------------------------------------------------
// 4. 実物のフィクスチャが引き続き読める（切り出しで壊していないこと）
// ---------------------------------------------------------------------------

test("#700 三重の実物 PDF が読める（罫線・文字の本数が変わっていない）", async () => {
  const bytes = readFileSync(new URL("./fixtures/mie/001242584.pdf", import.meta.url));
  const pages = await mieGlyphPages(bytes);
  assert.equal(pages.length, 1);
  // 実測（2026-09-09、origin/main と #700 の枝で同じ値。origin/main を別 worktree に出して同じ probe を回した）
  assert.equal(pages[0].items.length, 445);
  assert.equal(pages[0].vlines.length, 461);
  assert.equal(pages[0].hlines.length, 20);
});

test("#700 高知の実物 PDF が読める（罫線・文字の本数が変わっていない）", async () => {
  const bytes = readFileSync(new URL("./fixtures/kochi/0806.pdf", import.meta.url));
  const pages = await kochiGlyphPages(bytes);
  assert.equal(pages.length, 2);
  // 実測（2026-09-09、origin/main と #700 の枝で同じ値）。
  // このフィクスチャは q/Q の入れ子が深さ 2 まである唯一のもの（それでも外側は単位行列）
  assert.equal(pages.reduce((a, p) => a + p.items.length, 0), 2392);
  assert.equal(pages.reduce((a, p) => a + p.vlines.length, 0), 1196);
  assert.equal(pages.reduce((a, p) => a + p.hlines.length, 0), 1295);
});
