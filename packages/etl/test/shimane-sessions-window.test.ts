import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseVotePdf, splitJoinedMarks } from "../src/sources/local/shimane/votes-pdf.ts";
import { defaultSessionsFor } from "../src/local-assemblies.ts";

/**
 * **島根の `--sessions` の既定を決めるための実測**（Issue #901）。
 *
 * ## 島根は先行 8 県と形が違う——**止めているのは名簿ではなく「読めるか」である**
 *
 * **先行県（青森・宮城・奈良ほか）で既定を決めたのは、氏名の集合の不連続（一般選挙の境）だった。**
 * **島根ではそれが効かない。** **一次資料の側が、境より手前で先に尽きるからである:**
 *
 * | | |
 * |---|---|
 * | 会期 index（saikin ＋ gikai_kako） | **108** |
 * | **議員別採決結果一覧 PDF を持つ会期** | **14**（**2023-06 〜 2026-06**） |
 * | **15 会期目（2023-05 臨時会）** | **議員別 PDF が無い。会期ページに `h1` も無く `parseSessionPage` が落ちる** |
 * | **一般選挙（2023-04）** | **14 本すべてより手前**。`rosterAsOf` は **2023-05-17** |
 * | **14 本の議決日と `rosterAsOf` の差** | **50 〜 1,142 日**（**#928 の 1,461 日の内側。1 度も鳴らない**） |
 *
 * **つまり島根では、名簿の境と一次資料の尽きる位置がほぼ重なっている。**
 * **`unmatchedNames` / 氏名の集合で止める位置を決める余地が無い**——**14 本より先へは行けない。**
 *
 * ## 実際に止めているもの: **3 会期目（2025-11）で `parseVotePdf` が落ちる**
 *
 * **ETL は会期を新しい順に読み、1 本でも落ちると全体が止まる。**
 * **既定 2 は「2 会期しか読めない」のではなく「3 会期目で落ちる」ことの結果である。**
 */
const fixture = (name: string): Buffer => readFileSync(new URL(`./fixtures/shimane/${name}`, import.meta.url));

/* ==================== 1. 3 会期目が読めること ==================== */

/**
 * **2025-11（`r0711`）は、直す前は `付託委員会 is 4.2pt off the row centre (max 2)` で落ちていた。**
 *
 * **機序（座標で確かめた）**: **この本だけ付託委員会が中央揃えである。**
 * **`leftAlignedBoundary` は「欄の左端が揃う」前提で、左端が一番多く並ぶ x を欄の左端にする。**
 * **中央揃えだと名前の長さで左端が散る**（実測: **左端 6 通り / 中心 2 通り**）ので、
 * **一番多い左端（336.5）より左に書き出される委員会名が 62 個中 37 個**あり、
 * **それが件名の欄に落ちる。**
 */
test("#901 2025-11 は読める（直す前は 付託委員会 が中央揃えで 4.2pt ずれていた）", async () => {
  const pdf = await parseVotePdf(fixture("r0711_giinbetu_kekka.pdf"));
  assert.ok(pdf.rows.length > 0, `行数 ${pdf.rows.length}`);
  // **付託委員会が 1 行も空でない**（母数を書く。#757）
  const withReferred = pdf.rows.filter((r) => r.referredCommittees.length > 0);
  assert.equal(withReferred.length > 0, true, `付託委員会のある行 ${withReferred.length} / ${pdf.rows.length}`);
  // **件名に委員会名が混ざっていない**——件名がそのまま委員会名になっている行が無い
  const bled = pdf.rows.filter((r) => /^[^※]{2,12}(委員会|審査会)$/.test(r.title));
  assert.deepEqual(bled.map((r) => `${r.number}:${r.title}`), [], "件名が委員会名だけになっている行");
});

/* ==================== 2. 既定の値 ==================== */

test("#901 島根の --sessions の既定", () => {
  assert.equal(defaultSessionsFor("shimane"), 5);
});

/* ==================== 3. 繋がった票の記号 ==================== */

/**
 * **1 つの文字アイテムに票の記号が 2 つ入っていることがある**（Issue #901）。
 *
 * **2025-11 の page 3 に `"○ ○"` が 1 個ある**（実測 `x=740.17 w=13.77`）。
 * **割らないと `凡例に無いセル "○○"` で ETL が止まり、隣の列は記号が無いので `不明` になる**
 * （＝**投じられた票が 1 つ消える**）。
 *
 * **どこに置くかは推定していない**——**アイテムの x と幅がまたいでいる列だけに置き、
 * またいだ列の数と記号の数が合わなければ割らない。**
 */
test("#901 splitJoinedMarks: またいだ列の数と記号の数が合うときだけ割る", () => {
  const item = (str: string, x: number, w: number) => ({ str, x, y: 100, w, h: 9, cx: x + w / 2, cy: 100 });
  const colX = [740.2, 749.4, 758.6];
  // **2025-11 の実測そのもの**: 740.17 〜 753.94 が 740.2 と 749.4 の 2 列をまたぎ、記号も 2 つ
  const split = splitJoinedMarks([item("○ ○", 740.17, 13.77)], colX);
  assert.deepEqual(split.map((i) => [i.str, Number(i.x.toFixed(1))]), [["○", 740.2], ["○", 749.4]]);
  // **記号が 1 つのアイテムはそのまま**（ほとんど全部がこれ。13 本の出力が変わらない根拠）
  assert.deepEqual(splitJoinedMarks([item("○", 740.2, 6.9)], colX).map((i) => i.str), ["○"]);
  // **列の数と記号の数が合わなければ割らない**——3 列をまたぐのに記号が 2 つ
  assert.deepEqual(splitJoinedMarks([item("○ ○", 740.17, 22.0)], colX).map((i) => i.str), ["○ ○"]);
  // **記号でない文字（結合されたラベル）は触らない**——2024-06 の `除斥除斥` はここでは割らない
  assert.deepEqual(splitJoinedMarks([item("除斥除斥", 740.17, 13.77)], colX).map((i) => i.str), ["除斥除斥"]);
  // **賛成と反対が混ざっていても、またいだ列と合えば割る**（記号の種類では区別しない）
  assert.deepEqual(splitJoinedMarks([item("○ ●", 740.17, 13.77)], colX).map((i) => i.str), ["○", "●"]);
});

/**
 * **公表された賛成者数・反対者数と、`○`/`●` の個数が、既定 5 会期の 231 行すべてで一致する**（母数つき。#757）。
 *
 * **直す前の 2025-11 は、`"○ ○"` の行だけ 公表 32 に対し 数え直し 30 だった**（実測）——
 * **割った後は 55 / 55 で一致する。**
 *
 * **この検算は「PDF が自分自身と整合しているか」しか見ていない**（#874 が変異で確かめた等価変異の話と同じ）。
 * **x の錨にはならない**——**記号帯を列ごと回しても `○` と `●` の個数は変わらないため。**
 * **ここで主張しているのは「割ったせいで票の数が狂っていないこと」だけである。**
 */
test("#901 既定 5 会期の 231 行で、公表の賛成/反対と ○● の個数が一致する（母数 231）", async () => {
  const books = ["r0806_giinbetu_kekka.pdf", "r0802_giinbetu_kekka.pdf", "r0711_giinbetu_kekka.pdf", "r0709_giinbetu_kekka.pdf", "r0706_giinbetu_kekka.pdf"];
  let rows = 0, agree = 0;
  const disagree: string[] = [];
  for (const b of books) {
    const pdf = await parseVotePdf(fixture(b));
    for (const r of pdf.rows) {
      rows++;
      const yes = r.cells.filter((c) => c === "○").length;
      const no = r.cells.filter((c) => c === "●").length;
      if (yes === r.counts.yes && no === r.counts.no) agree++;
      else disagree.push(`${b} ${r.number}: 公表 ${r.counts.yes}/${r.counts.no} 数え直し ${yes}/${no}`);
    }
  }
  assert.equal(rows, 231, "母数（既定 5 会期の行数）");
  assert.deepEqual(disagree, [], "食い違った行を全部並べる");
  assert.equal(agree, 231);
});

/* ==================== 4. 止める位置の根拠 ==================== */

/**
 * **6 会期目（2025-05 臨時会）は読めない。** **これが既定を 5 で止めている理由である。**
 *
 * **機序は #874 の分類 E**——**記号の行が 4 つあるのに議案番号が `第80号` の 1 つしか無い**
 * （`常任委員の選任について` など、番号を持たない議案があるため）。
 * **`anchors` が 1 本しか立たず、4 行ぶんの記号が 1 行に集まる。**
 *
 * **`splitJoinedMarks`（#901）はこれを直さない**——**この本に繋がった記号は 1 つも無い**（実測）。
 * **直すには「番号の無い行」を行として立てる必要があり、それは別の機序である。**
 *
 * **引き継ぎ時点の版は `defaultSessionsFor` を restate するだけだった**——
 * **既定を 6 に変えると落ちるが、それは「6 では読めない」を何も主張していない**
 * （**変異の 4 分類の「テストが何も主張していない」**）。**本そのものを置いて測る形に替えた。**
 */
test("#901 6 会期目（2025-05 臨時会）は読めない——既定を 5 で止めている理由そのもの", async () => {
  // **落ちる位置と文言まで見る**——**黙って飛ばされたのではなく、読めずに止まったことの区別**（#874 の分類 E）。
  await assert.rejects(
    () => parseVotePdf(fixture("r0705rinji_giinbetu_kekka.pdf")),
    /two vote marks in one cell/,
  );
  // **既定は、その「読めない本」の 1 つ手前で止まっている。**
  assert.equal(defaultSessionsFor("shimane"), 5, "6 ではない");
});
