import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readGlyphPageOps } from "../src/sources/local/kochi/glyphs.ts";
import { readGlyphPageOps as mieOps } from "../src/sources/local/mie/glyphs.ts";

// Issue #703: kochi/glyphs.ts の `let leading = 0;` を `999` に変えてもテストが落ちない、
// という報告から始まった。追試したところ **落ちない範囲は報告よりも広かった**。
//
// **Issue に書かれていた理由は事実ではなかった。**
//   Issue: 「高知の PDF は `T*` の前に必ず `TD`/`TL` を出すので、初期値が読まれることがない」
//   実測 : **`TD` も `TL` も `T*` も、フィクスチャ 7 本に 1 回も出てこない。**
//   つまり初期値が読まれないのは「`TD`/`TL` が先に上書きするから」ではなく、
//   **`leading` を読む側（`T*`）が一度も来ないから**である。
//   `leading` に関わる 3 つの命令すべてが、実データでは一度も通らない。
//
// **実測（2026-09-09、フィクスチャ 7 本）**。数え方は 2 通りで、どちらも同じ値になった:
//   (a) pdfjs の `getOperatorList()` を歩いて `OPS.nextLine` / `OPS.setLeading` /
//       `OPS.setLeadingMoveText` / `OPS.moveText` を数える
//   (b) (a) を信じないための独立な源: PDF のコンテンツストリームを zlib で解いて
//       生のトークン `T*` / `TD` / `TL` / `Td` を数える
//
//     ファイル              showText   Td     Tm    T*   TD   TL
//     kochi/0706.pdf           2539   1109   1430    0    0    0
//     kochi/0806.pdf           2465   1042   1423    0    0    0
//     mie/001235880.pdf         337      0    337    0    0    0
//     mie/001242584.pdf         502      0    502    0    0    0
//     mie/001249930.pdf        5389      0   5389    0    0    0
//     mie/001256778.pdf         336      0    336    0    0    0
//     mie/001263901.pdf        1502      0   1502    0    0    0
//
//   高知は行送りに `Td` を使う（だから #700 の docblock が「Td も使う」と書いているのは正しい）。
//   使わないのは `T*` のほう。**`Td` は行頭を絶対に近い形で置き直すので `leading` を読まない。**
//
// **三重はそもそも `leading` を持たない**（`moveText`/`setLeadingMoveText`/`nextLine` が来たら
// 例外にする実装なので、変数自体が無い）。同じ状態かを確かめた結果、三重には当てるものが無かった。
//
// **落ちなかった変異（2026-09-09、`scripts/dev/mutate.sh run`、対象 kochi-votes-pdf.test.ts 13 件）**:
//   無改造                                   13 pass / 0 fail
//   `let leading = 0`      → `999`           13 pass / 0 fail   ← Issue の報告どおり
//   `ly -= leading`        → `ly -= 12345`   13 pass / 0 fail   ← T* の枝ごと死んでいる
//   `if (TD) leading = -dy;` を削除          13 pass / 0 fail   ← TD の枝も死んでいる
//   `leading = args[0]`    → `leading = 4321` 13 pass / 0 fail  ← TL の枝も死んでいる
//   **4 つとも生き残る。`leading` は 1 ビットも守られていなかった。**
//
// **なぜ直値（初期値）を変えずにテストを足すのか**（Issue の指示でもある）:
//   **`0` が正しいかは実データでは確かめられない**（読まれないので）。
//   PDF 32000-1 の 9.3.5 は text leading の初期値を **0** と定めている。
//   仕様がそう書いている以上、実装を仕様に合わせて固定するのが筋で、
//   **「0 だと 1 行も進まない」ことを見せる**のがこのテストの役目である。
//   （`T*` の前に `TL` を出さない PDF は仕様上ありうる。そのとき pdfjs 以外の
//   ビューアと同じ位置に読むかどうかが、ここで固定される。）
//
// **このテストの立ち位置**（#640 の担当者の整理に従う）:
//   ここが「守り」を担当し、上の実測（＝ docblock）が「なぜ実データに無い入力を守るのか」を担当する。
//   **片方だけでは成立しない**。実測を消すとこのテストは「実データに無い形」に見えて消されるし、
//   このテストを消すと守りが 0 本に戻る。

/** 「あ」1 文字ぶんの showText 引数（幅 1000 = フォントサイズと同じだけ進む）。 */
const glyph = (u: string) => [[{ unicode: u, width: 1000 }]];

/** [fnArray, argsArray] を [op, args] の並びから組み立てる（local-glyphs-ctm.test.ts と同じ形）。 */
function opList(pairs: [number, unknown][]): [number[], unknown[]] {
  return [pairs.map((p) => p[0]), pairs.map((p) => p[1])];
}

// ---------------------------------------------------------------------------
// 0. 使う演算子が実在すること（#699: 名前を間違えると両側 undefined で恒真になる）
// ---------------------------------------------------------------------------

test("#703 leading に関わる OPS のキーが実在し、互いに別の値である", () => {
  const keys = ["nextLine", "setLeading", "setLeadingMoveText", "moveText", "beginText", "setTextMatrix", "showText", "setFont"] as const;
  for (const k of keys) {
    assert.equal(typeof (OPS as Record<string, number | undefined>)[k], "number", `OPS.${k} が number でない`);
  }
  assert.equal(new Set(keys.map((k) => (OPS as Record<string, number>)[k])).size, keys.length, "同じ値の枝があると区別になっていない");
});

// ---------------------------------------------------------------------------
// 1. 案A: 初期値が使われる見本を固定する（TL/TD を一度も出さずに T* を出す）
// ---------------------------------------------------------------------------

test("#703 TL も TD も出さずに T* を出すと、初期値の leading = 0 で 1 行も下がらない", () => {
  // 高知のフィクスチャには 1 本も無い形（実測: T*/TD/TL とも 0 回）。
  // だからこそ、ここで直接組んで固定する。
  const [fn, args] = opList([
    [OPS.setFont, ["F1", 10]],
    [OPS.beginText, null],
    [OPS.setTextMatrix, [1, 0, 0, 1, 50, 700]],
    [OPS.showText, glyph("あ")],
    [OPS.nextLine, null], // T*: leading は一度も設定されていない → 初期値が効く
    [OPS.showText, glyph("い")],
  ]);
  const { items } = readGlyphPageOps(fn, args, 1);
  assert.equal(items.length, 2);
  assert.deepEqual([items[0].str, items[0].x, items[0].y], ["あ", 50, 700]);
  // 初期値が 0 なので y は動かない。x は行頭（lx = 50）に戻る。
  // `let leading = 0` を 999 などに変えると、ここの y が 700 - 999 = -299 になって落ちる。
  assert.equal(items[1].str, "い");
  assert.equal(items[1].y, 700, "leading の初期値が 0 でなければ y がずれる");
  assert.equal(items[1].x, 50, "T* は行頭 lx に戻すはず（前の文字の右端ではない）");
});

test("#703 T* を 3 回続けても初期値 0 のままなら y は動かない（積み上がらないこと）", () => {
  const [fn, args] = opList([
    [OPS.setFont, ["F1", 10]],
    [OPS.beginText, null],
    [OPS.setTextMatrix, [1, 0, 0, 1, 20, 500]],
    [OPS.nextLine, null],
    [OPS.nextLine, null],
    [OPS.nextLine, null],
    [OPS.showText, glyph("ろ")],
  ]);
  const { items } = readGlyphPageOps(fn, args, 1);
  assert.equal(items.length, 1);
  // 初期値が n なら y は 500 - 3n になる。0 のときだけ 500。
  assert.equal(items[0].y, 500);
  assert.equal(items[0].x, 20);
});

// ---------------------------------------------------------------------------
// 2. 初期値「以外」も守る（#703 の実測で、TL/TD/T* の枝がすべて死んでいたため）
// ---------------------------------------------------------------------------

test("#703 TL（setLeading）で設定した行送りを T* が使う", () => {
  const [fn, args] = opList([
    [OPS.setFont, ["F1", 10]],
    [OPS.beginText, null],
    [OPS.setTextMatrix, [1, 0, 0, 1, 50, 700]],
    [OPS.setLeading, [14]], // TL 14
    [OPS.showText, glyph("あ")],
    [OPS.nextLine, null],
    [OPS.showText, glyph("い")],
    [OPS.nextLine, null],
    [OPS.showText, glyph("う")],
  ]);
  const { items } = readGlyphPageOps(fn, args, 1);
  assert.deepEqual(items.map((i) => i.str), ["あ", "い", "う"]);
  // T* は ly -= leading。14 ずつ下がる（PDF の y は上が大きい）
  assert.deepEqual(items.map((i) => i.y), [700, 686, 672]);
  assert.deepEqual(items.map((i) => i.x), [50, 50, 50]);
});

test("#703 TD（setLeadingMoveText）は leading を -dy に設定し、同時に行頭を動かす", () => {
  const [fn, args] = opList([
    [OPS.setFont, ["F1", 10]],
    [OPS.beginText, null],
    [OPS.setTextMatrix, [1, 0, 0, 1, 100, 400]],
    [OPS.setLeadingMoveText, [5, -12]], // TD: 行頭を (5, -12) 動かし、leading = 12 にする
    [OPS.showText, glyph("か")],
    [OPS.nextLine, null], // 設定された 12 ぶん下がる
    [OPS.showText, glyph("き")],
  ]);
  const { items } = readGlyphPageOps(fn, args, 1);
  assert.deepEqual(items.map((i) => i.str), ["か", "き"]);
  // TD 自身の移動: (100+5, 400-12) = (105, 388)
  assert.deepEqual([items[0].x, items[0].y], [105, 388]);
  // T*: さらに leading = 12 ぶん下がる。x は行頭 105 のまま
  assert.deepEqual([items[1].x, items[1].y], [105, 376]);
});

test("#703 Td（moveText）は leading を変えない（TD との違い）", () => {
  // Td と TD は引数が同じで、leading を設定するかどうかだけが違う。
  // 実装が両方を同じ枝で処理しているので、取り違えると黙って行送りが変わる。
  const [fn, args] = opList([
    [OPS.setFont, ["F1", 10]],
    [OPS.beginText, null],
    [OPS.setTextMatrix, [1, 0, 0, 1, 100, 400]],
    [OPS.setLeading, [7]], // まず TL で 7 にしておく
    [OPS.moveText, [5, -30]], // Td: 行頭は動くが leading は 7 のまま（-(-30) = 30 にはならない）
    [OPS.showText, glyph("さ")],
    [OPS.nextLine, null],
    [OPS.showText, glyph("し")],
  ]);
  const { items } = readGlyphPageOps(fn, args, 1);
  assert.deepEqual([items[0].x, items[0].y], [105, 370]);
  // Td が leading を書き換えていれば 370 - 30 = 340 になる。正しくは 370 - 7 = 363
  assert.deepEqual([items[1].x, items[1].y], [105, 363], "Td が leading を書き換えている");
});

test("#703 Td/TD の移動は「直前の行頭から」の相対（前の文字の右端からではない）", () => {
  const [fn, args] = opList([
    [OPS.setFont, ["F1", 10]],
    [OPS.beginText, null],
    [OPS.setTextMatrix, [1, 0, 0, 1, 100, 400]],
    [OPS.showText, glyph("あ")], // ここで tx は 110 まで進む（幅 1000/1000 * 10）
    [OPS.moveText, [0, -20]], // 行頭 100 から (0,-20) → (100, 380)。110 からではない
    [OPS.showText, glyph("い")],
  ]);
  const { items } = readGlyphPageOps(fn, args, 1);
  assert.deepEqual([items[0].x, items[0].y], [100, 400]);
  assert.deepEqual([items[1].x, items[1].y], [100, 380], "行頭ではなく前の文字の右端から動かしている");
});

test("#703 BT（beginText）は行頭を原点に戻すが、leading は持ち越す（PDF 32000-1 9.4.1）", () => {
  // leading は text state の一部なので BT/ET では初期化されない。
  // 実装が BT で leading を 0 に戻していたら、ここが落ちる。
  const [fn, args] = opList([
    [OPS.setFont, ["F1", 10]],
    [OPS.beginText, null],
    [OPS.setLeading, [9]],
    [OPS.beginText, null], // 2 つめのテキストオブジェクト
    [OPS.setTextMatrix, [1, 0, 0, 1, 60, 300]],
    [OPS.nextLine, null],
    [OPS.showText, glyph("ぬ")],
  ]);
  const { items } = readGlyphPageOps(fn, args, 1);
  assert.equal(items.length, 1);
  assert.equal(items[0].y, 291, "BT で leading が 0 に戻されている（291 でなく 300 になる）");
});

// ---------------------------------------------------------------------------
// 3. 三重: leading を持たないこと自体を固定する（#703 で「同じ状態か」を確かめた結果）
// ---------------------------------------------------------------------------
//
// 三重の実装は Td/TD/T* が来たら例外にするので leading の変数が無い。
// **黙って読み飛ばすようになると、行送りぶんずれた y で文字を読む**——
// 三重も 1 人 1 列なので、ずれた行は別の議員の欄に入りうる（利用者からは検出できない）。
// この例外は local-glyphs-ctm.test.ts の 32 行目にコメントとして書かれているだけで、
// **assert で固定されていなかった**（#703 で確認）。

for (const [op, name] of [[OPS.nextLine, "T*"], [OPS.moveText, "Td"], [OPS.setLeadingMoveText, "TD"]] as const) {
  test(`#703 mie: ${name}（相対移動）が来たら例外にする（黙って読み飛ばさない）`, () => {
    const [fn, args] = opList([
      [OPS.setFont, ["F1", 10]],
      [OPS.beginText, null],
      [OPS.setTextMatrix, [1, 0, 0, 1, 50, 700]],
      [op, op === OPS.nextLine ? null : [0, -12]],
      [OPS.showText, glyph("あ")],
    ]);
    assert.throws(() => mieOps(fn, args, 3), /page 3: unsupported text-positioning op/);
  });
}

test("#703 mie: 相対移動が無ければ例外にしない（上の 3 件が広すぎないかの否定的対照）", () => {
  const [fn, args] = opList([
    [OPS.setFont, ["F1", 10]],
    [OPS.beginText, null],
    [OPS.setTextMatrix, [1, 0, 0, 1, 50, 700]],
    [OPS.showText, glyph("あ")],
  ]);
  const { items } = mieOps(fn, args, 3);
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].x, items[0].y], [50, 700]);
});
