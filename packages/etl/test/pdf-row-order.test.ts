import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { byRowThenColumn, type Item } from "../src/sources/local/pdf-table.ts";
import { parseVotePdf } from "../src/sources/local/mie/votes-pdf.ts";

/**
 * **並べ替えが丸め誤差でひっくり返る問題**（Issue #999）。
 *
 * **`(b.y - a.y || a.x - b.x)` は `b.y - a.y` が 0 でなければ x を見ない。**
 * **同じ行なのに y が最下位ビットだけ違うと、左右の順序が y の丸め誤差で決まる。**
 *
 * **許容差は「文字の高さの 1e-5」**。**その値は実データの空白帯から取った**——
 * **`pdf-table.ts` の `byRowThenColumn` の docblock に測定表がある。**
 *
 * **ここが守らなければならないのは 2 方向である**（片側だけでは守りにならない）:
 *   1. **小さすぎない**——**誤差（`1e-6 h` まで）で順序がひっくり返らない**
 *   2. **大きすぎない**——**本物の差（`1e-4 h` から）を「同じ行」と潰さない**
 */

/** 文字 1 つぶんの Item。`h` は三重の実データの代表値（8.4pt）に寄せてある。 */
const at = (str: string, y: number, x: number, h = 8.4): Item =>
  ({ str, x, y, w: h, h, cx: x + h / 2, cy: y + h / 2 });

const join = (items: Item[]): string => [...items].sort(byRowThenColumn).map((i) => i.str).join("");

test("#999 y がちょうど同じなら x の小さい順（今までと同じ振る舞い）", () => {
  assert.equal(join([at("川", 600, 30), at("石", 600, 10), at("原", 600, 50)]), "石川原");
});

test("#999 y が本当に違えば大きい順（上から下）。x は見ない", () => {
  // 差 8.4pt = h。許容差（h * 1e-5 = 8.4e-5）よりはるかに大きい
  assert.equal(join([at("下", 591.6, 0), at("上", 600, 999)]), "上下");
});

/**
 * **これが #999 そのものである。**
 *
 * **三重の実データ（`000835026.pdf`）から取った値**——
 * **`"対"`(x=336.74, y=653.5) と `"日"`(x=278.78, y=653.4999999999999)。**
 * **差は 1.137e-13 pt で、`h`(8.4) に対して 1.35e-14。**
 * **直す前は `"日"` より `"対"` が先に出ていた**（x を見ないため）。
 */
test("#999 丸め誤差（1e-13 pt）で左右が入れ替わらない——実データの値", () => {
  const items = [at("対", 653.5, 336.74), at("日", 653.4999999999999, 278.78)];
  assert.equal(items[0].y - items[1].y > 0, true, "前提: y は確かに違う（等価な検査になっていないこと）");
  assert.equal(join(items), "日対");
});

/**
 * **単精度で座標を持つ本の誤差**（実データ `000073636.pdf`。**1e-5 pt の桁**）。
 * **`"新"`(x=547.68, y=740.8400292968746) と `"政"`(x=556.32, y=740.8400268554688)。**
 * **差は 2.441e-6 pt、`h`(8.64) に対して 2.8e-7。**
 * **許容差を `1e-13` のような「誤差ぶんだけ」にすると、この本は救えない。**
 */
test("#999 単精度の誤差（1e-6 pt）でも左右が入れ替わらない——実データの値", () => {
  const items = [at("新", 740.8400292968746, 547.68, 8.64), at("政", 740.8400268554688, 556.32, 8.64)];
  assert.equal(items[0].y - items[1].y > 0, true, "前提: y は確かに違う");
  assert.equal(join(items), "新政");
});

/**
 * **許容差が大きすぎないこと**（**こちらが無いと「全部を同じ行にする」実装でも通ってしまう**）。
 *
 * **実データの「本物の差」のいちばん小さいもの**（`000073608.pdf`。`d/h = 2.11e-4`）:
 * **`"公明党"`(x=1096.6) が `"県政みらい"`(x=1017.5) より 1.192e-3 pt だけ上にある。**
 * **x では逆順なので、許容差がここまで届くと `県政みらい公明党` になってしまう。**
 */
test("#999 本物の差（d/h = 2.1e-4）は潰さない——x が逆でも y が優先される", () => {
  const items = [at("公明党", 507.240000, 1096.6, 5.64), at("県政みらい", 507.238808, 1017.5, 5.64)];
  const d = items[0].y - items[1].y;
  assert.ok(d > 1.1e-3 && d < 1.3e-3, `前提: 差は 1.192e-3 pt のはず（実際 ${d.toExponential(3)}）`);
  assert.equal(join(items), "公明党県政みらい");
});

test("#999 許容差は h に比例する（同じ差でも、文字が小さければ別の行と見る）", () => {
  const y0 = 600, d = 5e-4; // h=8.4 なら許容差 8.4e-5 < d、h=100 なら 1e-3 > d
  assert.equal(join([at("右", y0, 50, 8.4), at("左", y0 - d, 0, 8.4)]), "右左", "小さい文字では別の行");
  assert.equal(join([at("右", y0, 50, 100), at("左", y0 - d, 0, 100)]), "左右", "大きい文字では同じ行（x で並ぶ）");
});

/**
 * **端から端まで（実物の PDF）。**
 *
 * **`000073636.pdf`（平成25年定例会（6月））は、直す前は読めなかった**——
 * **左 8 列の見出しの照合で `column 0 header "案等番号議" !== 議案等番号` で止まっていた。**
 * **`議案等番号` の 5 文字が、単精度の丸め誤差（2.5e-5 pt）で `案等番号議` に入れ替わっていたためである。**
 *
 * **この検査は「読めること」だけでなく、読めた中身が一次資料と合うことまで見る**
 * （**「読めた」だけなら、中身が壊れていても通ってしまう**）。
 */
test("#999 実物: 000073636.pdf は丸め誤差で見出しがひっくり返り、読めなくなっていた", async () => {
  const pdf = await parseVotePdf(readFileSync(new URL("./fixtures/mie/000073636.pdf", import.meta.url)));
  assert.equal(pdf.title, "平成２５年定例会（６月）");
  assert.equal(pdf.sessionName, "平成２５年定例会");
  assert.equal(pdf.year, 2013);
  assert.equal(pdf.month, 6);
  assert.equal(pdf.pages, 2);
  assert.equal(pdf.members.length, 50);
  assert.equal(pdf.rows.length, 26);
  assert.equal(pdf.unknownCells, 0);
  // **1 行目は一次資料どおり**（議案第105号 平成25年度三重県一般会計補正予算（第１号））
  const r0 = pdf.rows[0];
  assert.equal(r0.kind, "議案");
  assert.equal(r0.number, "第105号");
  assert.equal(r0.title, "平成25年度三重県一般会計補正予算（第１号）");
  assert.equal(r0.dateText, "6/28");
  assert.equal(r0.result, "可決");
  // **賛成者数と `○` の数が合う**（検算。票そのものが壊れていないこと）
  assert.deepEqual(r0.counts, { present: 50, voting: 49, yes: 49, no: 0 });
  assert.equal(r0.cells.filter((c) => c === "○").length, r0.counts.yes);
  assert.equal(r0.cells.filter((c) => c === "×").length, r0.counts.no);
  assert.equal(r0.cells.filter((c) => c === "議").length, 1, "議長が 1 人");
  assert.equal(r0.cells.length, pdf.members.length);
  // **全 26 行で賛成者数 ↔ `○` の数が合う**（1 行だけ見て済ませない）
  for (const r of pdf.rows) {
    assert.equal(r.cells.filter((c) => c === "○").length, r.counts.yes, `${r.kind}${r.number} の ○ の数`);
    assert.equal(r.cells.filter((c) => c === "×").length, r.counts.no, `${r.kind}${r.number} の × の数`);
  }
});

/**
 * **この本の会派名は壊れたまま出る**（**#998 §4-1 の別問題。この PR では直さない**）。
 *
 * **「直っていない」ことを検査で固定しておく**——
 * **そうしないと、次にこの本を見た人が「読めているから大丈夫」と読んでしまう**（#569）。
 * **`えみ政新` は `新政みえ` の、`いらみ民自` は `自民みらい` の、`党明公` は `公明党` の逆順である。**
 */
test("#999 ただし会派名は逆順のまま出る（#998 §4-1。この PR の射程外であることを固定する）", async () => {
  const pdf = await parseVotePdf(readFileSync(new URL("./fixtures/mie/000073636.pdf", import.meta.url)));
  const groups = [...new Set(pdf.members.map((m) => m.group))];
  assert.deepEqual(groups, ["えみ政新", "いらみ民自", "山鷹", "党明公", "みんなの党"]);
});
