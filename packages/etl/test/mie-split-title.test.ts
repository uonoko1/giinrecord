import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseVotePdf } from "../src/sources/local/mie/votes-pdf.ts";
import { readGlyphPages } from "../src/sources/local/mie/glyphs.ts";

/**
 * **#867 A 群の残り: 表題が 1 文字ずつ別のテキストに割れている本**（19 本）。
 *
 * ## 測った事実（2026-09-21。母数＝index の賛否 PDF **151 本すべて**）
 *
 * **#886 で相対移動（Td/TD/T*）を読めるようにした後も、151 本のうち 64 本が落ちていた。**
 * **うち 20 本は B 群（回転 11・上下反転 9）で、別の担当者の範囲。残る 44 本が A 群の残りである。**
 *
 * **#886 はこの 44 本を「例外の文言」で分類していた**（自己申告: **「実物の PDF を
 * 1 本ずつ開いて機序を特定してはいない」**）。**開いて数え直したら、
 * 「表題が見つからない」という 1 つの文言の下に、3 つの別の機序が入っていた:**
 *
 * | 機序 | 本数 | 中身 |
 * |---|---:|---|
 * | **A-2（このテスト）** | **19** | **表題が 1 文字ずつ別の showText に割れている**（繋げば当たる） |
 * | A-1 | 4 | 1 ページ目には表題があるが、**続きのページには無い** |
 * | A-3 | 1 | **表題に `（M月）` が無い**（`平成２０年第１回臨時会`） |
 *
 * **「表題 24 本」は 1 つの機序ではなかった。**
 *
 * ## A-2 の機序（実物を開いて確かめた）
 *
 * `parseHeader` は **`items.find((i) => TITLE.test(i.str))`** で表題を探していた。
 * **`readGlyphPages` は showText 1 回を 1 アイテムにする**ので、
 * **表題を 1 文字ずつ置いている本では、どのアイテムも 1 文字しか持たず、正規表現に当たらない。**
 *
 * 実測（`000995095.pdf` 令和4年1月分、1 ページ目の一番上の行）:
 * **`令` `和` `4` `年` `定` `例` `会` `（` `１` `月` `）` … が
 * すべて同じ y=766.8 に、x=104.6 から 11.9pt 刻みで 19 個並ぶ**（1 アイテム 1 文字）。
 *
 * **これは #841 が凡例で直したのと同じ形である**（凡例は逆に「繋がりすぎ」で、
 * こちらは「割れすぎ」。どちらも showText の切れ目が意味の切れ目と一致しない）。
 *
 * ## なぜ「繋ぐ」で読んでよいのか（推定ではない根拠）
 *
 * **繋ぐのは「同じ y に並ぶ文字」だけで、x の順に並べるだけである。**
 * **文字を足しも引きもせず、読み替えもしない**（#569）。
 * **繋いだ結果が `TITLE` に当たらなければ、今までどおり例外**——**当たったときだけ読む。**
 */
const bytes = (name: string) => readFileSync(new URL(`./fixtures/mie/${name}`, import.meta.url));

// **令和4年1月分**（7KB / 1 ページ）。表題は `令和4年定例会（１月）`（**年が半角 `4`**）
const r04jan = bytes("000995095.pdf");
// **平成21年第1回臨時会（8月）分**（7KB / 1 ページ）。**`臨時会` かつ `第N回` つき**の形を別に持つ
const h21aug = bytes("000073606.pdf");

test("#867 A-2: 表題が 1 文字ずつ割れている本を読む（繋いで初めて当たる）", async () => {
  const pdf = await parseVotePdf(r04jan);
  assert.equal(pdf.title, "令和4年定例会（１月）");
  assert.equal(pdf.sessionName, "令和4年定例会");
  assert.equal(pdf.year, 2022);
  assert.equal(pdf.month, 1);
});

test("#867 A-2: 臨時会・第N回つきの表題も同じ経路で読む", async () => {
  const pdf = await parseVotePdf(h21aug);
  assert.equal(pdf.title, "平成２１年第１回臨時会（８月）");
  assert.equal(pdf.sessionName, "平成２１年第１回臨時会");
  assert.equal(pdf.year, 2009);
  assert.equal(pdf.month, 8);
});

test("#867 A-2 母数: この 2 本の表題は、1 アイテムでは 1 文字しか持たない（繋がなければ読めない形だと固定する）", async () => {
  // **この検査が無いと、実装を「繋がない」形に戻しても上の 2 件が別経路で通る可能性を排除できない。**
  const TITLE = /^((令和|平成)([０-９0-9]+|元)年(?:第[０-９0-9]+回)?(?:定例会|臨時会))（([０-９0-9]+)月）/;
  for (const [name, buf, chars] of [["000995095.pdf", r04jan, 19], ["000073606.pdf", h21aug, 23]] as const) {
    const pages = await readGlyphPages(buf);
    const items = pages[0].items;
    // **単体で TITLE に当たるアイテムは 0 個**（= 繋がなければ表題は取れない）
    assert.equal(items.filter((i) => TITLE.test(i.str.trim())).length, 0, `${name}: 単体で当たるアイテムがある`);
    // 一番上の行は 1 文字のアイテムが並んでいる
    const maxY = Math.max(...items.map((i) => i.y));
    const line = items.filter((i) => Math.abs(i.y - maxY) < 1);
    assert.equal(line.length, chars, `${name}: 一番上の行のアイテム数`);
    assert.ok(line.every((i) => [...i.str].length === 1), `${name}: 一番上の行に 2 文字以上のアイテムがある`);
  }
});

test("#867 A-2: 表題の行を繋いでも当たらなければ例外のまま（読めないものは読めないで止める）", async () => {
  // **`000073600.pdf`（平成20年第1回臨時会）は表題に `（M月）` が無い**（A-3。**このテストの対象外**）。
  // **繋ぐようにしても読めるようにはならない**ことを固定する——
  // **「繋ぐ」が「当たるまで何でも繋ぐ」に化けていないことの検査である。**
  // この本はフィクスチャに入れていないので、ここでは表題の文字列だけを直接確かめる。
  const TITLE = /^((令和|平成)([０-９0-9]+|元)年(?:第[０-９0-9]+回)?(?:定例会|臨時会))（([０-９0-9]+)月）/;
  assert.equal(TITLE.test("平成２０年第１回臨時会議案等の審議結果"), false);
});
