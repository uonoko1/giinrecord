import { test } from "node:test";
import assert from "node:assert/strict";
import { joinVertical, type Item } from "../src/sources/local/pdf-table.ts";

// 共通層 pdf-table.ts の joinVertical を、県ごとの votes-pdf.ts を通さずに直接読む（Issue #640）。
//
// なぜ直接テストするか:
//   joinVertical の並べ替え（b.y - a.y || a.x - b.x）は、現在の 7 県のフィクスチャ 22 本・
//   1,650 回の呼び出しすべてで no-op である（呼び出し側が既に順序を整えて渡している）。
//   実測したので、県の PDF を通すテストをいくら足してもこの行は守れない。
//   ＝ここで直接テストしなければ、この行は「守りが 1 本も無い」ままになる。
//   未実装の県（青森・秋田・群馬・大分・沖縄）を足すとき、呼び出し側が順序を整えないなら
//   この行が効き始める。そのとき壊れたことに気づけるようにしておく。

/** y だけ指定して 1 文字ぶんの Item を作る（高さ 10・幅 10 の等幅を仮定）。 */
const at = (str: string, y: number, x = 0): Item => ({ str, x, y, w: 10, h: 10, cx: x + 5, cy: y + 5 });

test("#640 joinVertical: 入力の順序によらず y の大きい順（上から下）に繋ぐ", () => {
  // 上から「山田太郎」。配列にはわざと逆順・ばらばらで入れる
  const shuffled = [at("郎", 70), at("山", 100), at("太", 80), at("田", 90)];
  assert.equal(joinVertical(shuffled), "山田太郎");
});

test("#640 joinVertical: 完全な逆順（下から上）で渡しても上から下に直る", () => {
  const bottomUp = [at("会", 60), at("志", 70), at("立", 80), at("燈", 90), at("一", 100)];
  assert.equal(joinVertical(bottomUp), "一燈立志会");
});

test("#640 joinVertical: y が同じ文字は x の小さい順（左から右）に繋ぐ", () => {
  // 横に並んだ 1 行。x をばらばらの順で渡す
  const sameY = [at("川", 100, 30), at("石", 100, 0), at("原", 100, 60)];
  assert.equal(joinVertical(sameY), "石川原");
});

test("#640 joinVertical: y で並べたうえで、同じ y の中だけ x で並べる（y が x より優先）", () => {
  // 上の行「上」、下の行は同じ y に「左」「右」。x の小さい「左」が先。
  // y の差 10 は step(10) * 1.5 = 15 以下なので空白は入らない（隣の行の判定に引っかからない値を選んである）
  const items = [at("右", 90, 50), at("左", 90, 0), at("上", 100, 99)];
  assert.equal(joinVertical(items), "上左右");
});

test("#640 joinVertical: 1 文字ぶん以上空いていれば半角空白（並べ替えた後の間隔で判定する）", () => {
  // 上から y=100, 90（詰まっている）… y=50（大きく空く）。入力はばらばら
  const items = [at("郎", 50), at("山", 100), at("田", 90)];
  assert.equal(joinVertical(items), "山田 郎");
});

test("#640 joinVertical: 入力の配列を書き換えない（呼び出し側が同じ配列を使い回す）", () => {
  const items = [at("郎", 70), at("山", 100), at("太", 80), at("田", 90)];
  const before = items.map((i) => i.str);
  joinVertical(items);
  assert.deepEqual(items.map((i) => i.str), before);
});
