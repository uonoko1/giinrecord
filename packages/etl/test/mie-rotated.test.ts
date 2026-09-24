import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readGlyphPageOps, readGlyphPages } from "../src/sources/local/mie/glyphs.ts";
import { parseVotePdf } from "../src/sources/local/mie/votes-pdf.ts";

/**
 * # 三重: **回転 90 の 11 本**（Issue #867 B 群の残り。#969 / #994 の続き）
 *
 * ## 母数（**2026-09-24 に index を取り直して数え直した。#757**）
 *
 * index（`/KENGIKAI/07976009017.htm`、53,535 バイト）の `<a>` のうち `.pdf` は **151 本**
 * （重複を除いても 151。`sort -u` と素の行数が一致）。
 * **151 本すべてを `parseVotePdf` に通したベースライン（`ccc53287`）: ok 111 / fail 40。**
 * **そのうち `rotated text matrix … not supported` で止まるのは 11 本**
 * （`000073593` `000073596` `000073607` `000073610` `000073611` `000073612`
 * `000073613` `000073614` `000073615` `000073616` `000073637`）。
 * **PO の「回転 11 本」は実測と一致した。**
 *
 * ## 機序（**#969 と同じ形の「合成」だった**）
 *
 * **実測（2026-09-24、11 本の `Tm` 774 回すべて）**:
 *
 * | | 値 |
 * |---|---|
 * | `Tm` | **`[0, +s, -s, 0, e, f]` の 1 種類**（774 / 774） |
 * | そのときの CTM | **`[1,0,0,1,0,0]`（単位行列）の 1 種類** |
 * | ページの `/Rotate` | **90**（11 本の全 19 ページ） |
 * | ページの `view` | **`[0,0,842,1191]`**（A3 縦）の 1 種類 |
 *
 * **`/Rotate 90` は「時計回りに 90 度回して表示する」意味なので、
 * PDF 座標 `(px, py)` は表示座標 `(py, W − px)`（W = 842）に写る。**
 * **これは行列 `D = [0, −1, 1, 0, 0, W]` である。**
 *
 * **`Tm × CTM` に `D` を掛けると、回転はちょうど打ち消し合って消える**:
 *
 * ```
 * [0, s, −s, 0, e, f] × [0, −1, 1, 0, 0, W] = [s, 0, 0, s, f, W − e]
 * ```
 *
 * **正の等方 s 倍＋平行移動。** **つまりこの 11 本は「回転した本」ではなく
 * 「`/Rotate 90` のページに、そのページの向きに合わせて置かれた本」である**——
 * **#969 が上下反転 9 本で見つけたのと同じ形**（見るべき量は `Tm` でも CTM でもなく、
 * **`Tm × CTM × D`** のほうだった）。
 *
 * ## **それでも票は出さない**（#569。**この PR の結論**）
 *
 * **座標は直る。表の形が直らない。** **佐賀（`saga/votes-pdf.ts:69`）の警告どおりだった。**
 *
 * **実測（2026-09-24、11 本すべて）**: 打ち消したあと、
 * **記号は罫線で決まる議員の列に正しく落ちる**が、**氏名がその列に対応しない。**
 *
 * **`000073610.pdf` の 1 ページ目**（この本がいちばん分かりやすい）:
 *
 * | | 実測 |
 * |---|---|
 * | 議員の列（罫線。幅 15.8pt） | **49 列** |
 * | 1 行ぶんの記号 | **49 個 → 49 列。列の外 0、同じ列への重複 0** |
 * | **氏名帯のグリフ** | **189 個。すべて表示 y が同じ 1 本の帯に、8.75pt 刻みで横一列に並ぶ** |
 * | **うち罫線の右端（表示 x = 1177.5）より外** | **101 個**（表示 x は 2061.2 まで伸びる） |
 *
 * **三重の既存の読み方は「議員の列の中に縦書きの氏名が入っている」を前提にしている**
 * （`votes-pdf.ts` の `readMembers` が列ごとに `joinVertical` する）。
 * **この 11 本では氏名が縦書きではなく、列の境界とも揃っていない**——
 * **列 8 に「長田」、列 9 に「隆尚」が入る。「長田隆尚」は 1 人である。**
 *
 * **ここで列ごとに切って名前を作れば、`長田` と `隆尚` が別々の議員になり、
 * 以降の票がすべて 1 人ぶんずつずれる**——**「記録が出ない」ではなく「別人の記録が出る」側**（#569）。
 * **だから氏名を列に割り当てる規則は作らない。**
 *
 * ## この PR が変えたこと / 変えなかったこと
 *
 * **変えた**: `Tm × CTM` に **ページの `/Rotate` の打ち消し**を合成して、
 * **回転が消えるかどうかを見てから判定する**（`glyphs.ts`）。
 * **打ち消して消えるなら読み進め、消えないなら今までどおり例外**。
 *
 * **変えなかった**: **`votes-pdf.ts` の表の組み立てには 1 行も触っていない。**
 * **11 本は、回転の例外ではなく「氏名が列に入らない」ところで止まるようになっただけで、
 * 票は 1 票も新しく出ない**（読める本数 111 → 111）。
 *
 * **共有層（`pdf-table.ts`）には 1 文字も触っていない**（秋田 #759 / 青森 #750 と同じ判断）。
 */

const fixture = (name: string): Buffer => readFileSync(fileURLToPath(new URL(`./fixtures/mie/${name}`, import.meta.url)));

/** 1 グリフの showText を組むだけのオペレータ列（`local-glyphs-flip.test.ts` と同じ形）。 */
function ops(tm: number[], cm?: number[]): [number[], unknown[]] {
  const fn: number[] = [];
  const args: unknown[] = [];
  if (cm) { fn.push(OPS.transform); args.push(cm); }
  fn.push(OPS.beginText); args.push([]);
  fn.push(OPS.setFont); args.push(["F1", 1]);
  fn.push(OPS.setTextMatrix); args.push(tm);
  fn.push(OPS.showText); args.push([[{ unicode: "あ", width: 1000 }]]);
  return [fn, args];
}

/* ---------- 1. 合成の計算そのもの ---------- */

test("#867 mie: /Rotate 90 のページでは Tm の回転が打ち消されて読める", () => {
  // 実データと同じ形: Tm = [0, s, -s, 0, e, f]、CTM は単位行列、ページは /Rotate 90 の A3 縦
  const [fn, args] = ops([0, 8.04, -8.04, 0, 149.2, 406.3]);
  const { items } = readGlyphPageOps(fn, args, 1, { pageRotate: 90, pageWidth: 842 });
  assert.equal(items.length, 1);
  // 表示座標: x = f = 406.3、y = W - e = 842 - 149.2 = 692.8
  assert.equal(Math.round(items[0].x * 10) / 10, 406.3);
  assert.equal(Math.round(items[0].y * 10) / 10, 692.8);
  // 幅は グリフ幅(1000/1000) × fontSize(1) × 合成の a(8.04)
  assert.equal(Math.round(items[0].w * 100) / 100, 8.04);
  assert.equal(Math.round(items[0].h * 100) / 100, 8.04);
});

test("#867 mie: /Rotate を渡さなければ同じ Tm は今までどおり例外（既定は 1 バイトも変えない）", () => {
  const [fn, args] = ops([0, 8.04, -8.04, 0, 149.2, 406.3]);
  assert.throws(() => readGlyphPageOps(fn, args, 1), /rotated text matrix/);
});

test("#867 mie: /Rotate 90 でも、打ち消して残る回転は例外（向きが合っていない本を黙って読まない）", () => {
  // Tm が逆向き（-s, +s）の回転だと、D を掛けると 180 度になり a<0 / d<0 が残る
  const [fn, args] = ops([0, -8.04, 8.04, 0, 149.2, 406.3]);
  assert.throws(() => readGlyphPageOps(fn, args, 1, { pageRotate: 90, pageWidth: 842 }), /flipped text matrix/);
});

test("#867 mie: /Rotate 90 のページで回転していない Tm が来たら例外（打ち消しが回転を生む）", () => {
  // 回転していない Tm に D を掛けると回転が生まれるので、b/c が 0 でなくなる
  const [fn, args] = ops([8.04, 0, 0, 8.04, 149.2, 406.3]);
  assert.throws(() => readGlyphPageOps(fn, args, 1, { pageRotate: 90, pageWidth: 842 }), /rotated text matrix/);
});

test("#867 mie: 知らない /Rotate（180 / 270）は例外（黙って間違えた向きで読まない）", () => {
  const [fn, args] = ops([0, 8.04, -8.04, 0, 149.2, 406.3]);
  assert.throws(() => readGlyphPageOps(fn, args, 1, { pageRotate: 180, pageWidth: 842 }), /unsupported page rotation 180/);
  assert.throws(() => readGlyphPageOps(fn, args, 1, { pageRotate: 270, pageWidth: 842 }), /unsupported page rotation 270/);
});

/* ---------- 2. 実物の PDF ---------- */

test("#867 mie: 回転 11 本は回転の例外を抜ける（罫線と記号は表示座標で揃う）", async () => {
  // **`000073610.pdf` は 2 ページ。回転を打ち消すと文字が取れる。**
  const pages = await readGlyphPages(fixture("000073610.pdf"));
  assert.equal(pages.length, 2);
  // 1 ページ目に表題と凡例が、打ち消した向きで並ぶ
  const p1 = pages[0];
  assert.ok(p1.items.length > 2000, `items ${p1.items.length}`);
  // 表題（1 文字ずつ別の showText。#867 A-2 の joinedLines が繋ぐ形）
  const top = Math.max(...p1.items.map((i) => i.y));
  const titleLine = p1.items.filter((i) => Math.abs(i.y - top) < 1).sort((a, b) => a.x - b.x).map((i) => i.str).join("");
  assert.equal(titleLine, "平成２２年第２回定例会（１０月）議案等の審議結果");
  // 罫線も同じ向きに直っている: 議員の列は幅 15.8pt くらいで並ぶ
  assert.ok(p1.vlines.length > 50, `vlines ${p1.vlines.length}`);
  assert.ok(p1.hlines.length > 100, `hlines ${p1.hlines.length}`);
});

test("#867 mie: それでも 11 本は票を出さない——氏名が議員の列に入らないところで止まる（#569）", async () => {
  // **座標は直ったが、表の形が違う**（佐賀 `votes-pdf.ts:69` の警告どおり）。
  // **氏名帯は横一列で、列の境界と揃っていない。**
  // **ここで列ごとに切れば「長田」と「隆尚」が別人になる**ので、切らずに止める。
  await assert.rejects(() => parseVotePdf(fixture("000073610.pdf")), (e: Error) => {
    // **回転の例外ではもう止まらない**（壁を 1 つ越えた）
    assert.doesNotMatch(e.message, /rotated text matrix/, `まだ回転で止まっている: ${e.message}`);
    return true;
  });
});
