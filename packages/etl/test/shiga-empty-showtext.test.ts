import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { CMAP_OPTIONS } from "../src/sources/local/pdf-cmap.ts";
import { parseVotePdf } from "../src/sources/local/shiga/votes-pdf.ts";

// ===========================================================================
// Issue #927 — **CMap を渡しても滋賀の 3 本に空の showText が 21 回残る。その 21 回は何か。**
// ===========================================================================
//
// #922 は「CMap を渡しても空が 21 回残る。グリフ数は変わらないので別の原因。**未調査**」と
// 書き残した。**空の showText は「文字が黙って消える」形で、例外が出ない**（#569 の
// 「別のものが出る」側）ので、**消えてよい空なのか、消えてはいけない文字なのかを測った。**
//
// ---------------------------------------------------------------------------
// **結論: 21 回とも「消えてよい空」である。** PDF が**自分で空の文字列を描いている。**
// ---------------------------------------------------------------------------
//
// **決め手**: 3 本の**ページ内容ストリームを解凍して原文を読むと、`<>Tj`（中身の無い
// 16 進文字列）と `[<>]TJ` が、3 本で 8 / 7 / 6 回＝ちょうど 21 回ある。**
// **pdfjs が数えた空の showText と、ファイル 1 本ずつ・1 回ずつ一致する**（下の 1.）。
// **落ちたグリフは 1 つも無い。描けと言われた文字が最初から 0 文字である。**
//
// **フォントは正常に読めている**（実測: `missingFile:false` / `isType3:false` /
// `fallbackName:"sans-serif"`）。**CMap の話ではない**——#922 の三重・`Kg265` の形
// （フォントが読めずグリフが全部落ちる）とは**別物**である。
//
// **21 回の置かれ方**（実測。`setTextMatrix` の x から前後の間隔を測った）:
//
//   語中（前後とも 1 字ピッチ） 11 回   「会␀派␀名」「※␀本会議の状況」「２␀議案に対する」
//   行頭                         4 回   「␀※会派名「みんな」とは」「␀９月24日議決分」
//   行末                         3 回   「議案等番号␀」「議案等番号件名␀」
//   語間（ピッチ不一致）         3 回   「平成24年4月臨時会␀提出議案等に対する」
//                              ―――――
//                               21 回
//
// **語中 11 回は前後の間隔がフォントサイズとぴったり一致する**（7.19 / 7.67 / 9.12 に対し
// ずれ 0.01 未満）。**つまり「空白 1 文字ぶんの場所取り」である**——
// この PDF の作り手は、見出しの字間を空けるのに**空白文字ではなく「中身の無い Tj」**を置いている。
// **行頭・行末・語間の 10 回も同じ形**（描く文字が無いので位置だけ動かす）。
//
// ---------------------------------------------------------------------------
// **票は 1 つも消えていない**（下の 2. と 3.）
// ---------------------------------------------------------------------------
//
// - **21 回の y 座標は、記号（○×議－）のある行の y と 1 つも重ならない**（下の 2.）。
//   空があるのは見出し・凡例・列見出し・注記の行だけである。
// - **PDF が自分で刷っている賛成数・反対数と、読み取ったセルが 8 行すべてで一致する**（下の 3.）。
//   **これは「消えていない」ことの外からの検算**である（#757 の母数の考え方）。
//   `Kg229` の「請願第５号」は 賛成 28 / 反対 18 で、セル 47 個の内訳と完全に合う。
//
// ---------------------------------------------------------------------------
// **他県にも同じ形は無い**（下の 4.。**母数つき**）
// ---------------------------------------------------------------------------
//
// #922 が測ったのは「CMap の有無での差」で、**「CMap を渡した状態で空が何回あるか」は
// 滋賀以外で数えていなかった**（#927 の宿題）。**数えた**（2026-09-21、フィクスチャ **98 本すべて**）:
//
//   県          本数  空のある本  showText 合計    空  グリフ合計   読めなかった本
//   akita         9        0          16982        0     26770          0
//   aomori        5        0           8979        0     18605          0
//   kochi         6        0          23656        0     23656          0
//   mie          22        0          36700        0     59151          0
//   miyagi        8        0          30664        0     47317          0
//   nara          2        0           8813        0     11736          0
//   saga          8        0          10570        0     17224          0
//   **shiga        7        3           7126       21      8763          0**
//   shimane      14        0          15932        0     51140          0
//   tokushima    11        0          15140        0     22580          0
//   tottori       5        0           9116        0     20454          0
//   districts     1        0             27        0       132          0   （県ではない）
//   ―――――――――――――――――――――――――――――――――――――――――――――――――――――
//   合計         98        3         183705       21    307528          0
//
// **「0 回だった」であって「数えていない」ではない**（#757）。**98 本を 1 本も落とさず数えた**
// （例外で読めなかった本は 0 本）。**空があるのは滋賀の 3 本だけ**である。
//
// **本数は増える**（県を広げる PR がフィクスチャを足す。#945 で akita が 6 → 9 になった）。
// **下のテストは本数を決め打ちせず「95 本以上」で下限だけ見て、
// 「空のある本の一覧」と「空の合計 21 回」を固定する**——**本数が増えても、
// 増えた本に空があれば一覧が変わって落ちる。**
//
// ---------------------------------------------------------------------------
// **やらなかったこと と その理由**
// ---------------------------------------------------------------------------
//
// - **実装は 1 行も変えていない。** `readPages` は `str.trim() === ""` のアイテムを既に落とす。
//   **空の showText は items にならないので、表の組み立てには最初から届かない。**
//   **「消えてよい空」なので、直すものが無い。**
// - **`data/` は 1 行も書き換えていない。**
// - **21 回を「空白」として復元することはしない。** PDF は空白文字を置いていない（空の文字列である）。
//   **原文に無い文字を作らない**（#569）。位置だけ動かす指示を空白に読み替えるのは推定である。

const FIXTURES = new URL("./fixtures/", import.meta.url);
const fixture = (pref: string, n: string): Buffer => readFileSync(new URL(`${pref}/${n}`, FIXTURES));

/** #927 の対象。CMap を渡しても空の showText が残る 3 本と、その回数（#922 の実測）。 */
const THREE = [
  { name: "Kg220_240424-sanpi.pdf", empty: 8 },
  { name: "Kg229_240711-sanpi.pdf", empty: 7 },
  { name: "Kg280_sanpi-250924.pdf", empty: 6 },
] as const;

/** 1 つの showText が運んだグリフ（kerning の数値は除く）。 */
const glyphsOf = (arg: unknown): unknown[] => (arg as unknown[]).filter((g) => typeof g === "object" && g !== null);

interface Shown { x: number; y: number; size: number; text: string; glyphs: number }

/** ページのオペレータ列から、showText 1 回ぶんの「位置・字の大きさ・読めた文字・グリフ数」を並べる。 */
async function readShownText(bytes: Buffer): Promise<Shown[]> {
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0, ...CMAP_OPTIONS });
  const doc = await task.promise;
  const out: Shown[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const ops = await (await doc.getPage(p)).getOperatorList();
      let x = NaN;
      let y = NaN;
      let size = NaN;
      for (let k = 0; k < ops.fnArray.length; k++) {
        const fn = ops.fnArray[k];
        const args = ops.argsArray[k] as unknown[];
        if (fn === OPS.setFont) { size = args[1] as number; continue; }
        if (fn === OPS.setTextMatrix) {
          // pdfjs は行列を 6 個の引数で渡すことも、配列 1 個で渡すこともある（両方を受ける）
          const m = (typeof args[0] === "object" && args[0] !== null ? args[0] : args) as ArrayLike<number>;
          x = m[4];
          y = m[5];
          continue;
        }
        if (fn !== OPS.showText) continue;
        const gs = glyphsOf(args[0]);
        out.push({ x, y, size, glyphs: gs.length, text: gs.map((g) => (g as { unicode: string }).unicode).join("") });
      }
    }
  } finally {
    await task.destroy();
  }
  return out;
}

/**
 * PDF のページ内容ストリームを解凍して原文（PostScript 風のオペレータ列）を返す。
 *
 * **pdfjs は内容ストリームを公開 API で出さない**ので、`stream …… endstream` を総当たりで
 * 解凍し、**「`BT` と `ET` を含み、ほぼ印字可能な文字でできている」ものだけ**を内容ストリームと見る。
 * **埋め込みフォントのバイナリを拾うと誤判定する**——実際に踏んだ:
 * **鳥取の 1 本で、2 MB のフォントの中の偶然のバイト列を「空の Tj」と数えて 63 回になった**
 * （pdfjs が数えた空は 0 回。**比較が効いていないのに数字が出た**形である。#886）。
 * **印字率で弾き、`<>` がトークンの先頭に来ることも要求して直した**（下の EMPTY_SHOW を参照）。
 */
function contentStreams(bytes: Buffer): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const s = bytes.indexOf("stream", i);
    if (s < 0) break;
    let b = s + "stream".length;
    if (bytes[b] === 0x0d) b++;
    if (bytes[b] === 0x0a) b++;
    const e = bytes.indexOf("endstream", b);
    if (e < 0) break;
    i = e + "endstream".length;
    let text: string;
    try { text = inflateSync(bytes.subarray(b, e)).toString("latin1"); } catch { continue; }
    const printable = (text.match(/[\x20-\x7e\r\n\t]/g) ?? []).length / Math.max(1, text.length);
    if (printable > 0.95 && /\bBT\b/.test(text) && /\bET\b/.test(text)) out.push(text);
  }
  return out;
}

/**
 * **中身の無い文字列を描く指示**。`<>Tj`・`[<>]TJ`・`()Tj`。
 *
 * **`<>` の前にトークンの区切りを要求する**——要求しないと、`(…\<>…)Tj` のような
 * **中身のある文字列の内側**を拾う（実測で踏んだ: 青森の 1 本で 8 回、滋賀 `Kg274` で 1 回の
 * 偽陽性。どちらも pdfjs の数えた空は 0 回だった）。
 */
const EMPTY_SHOW = /(?:^|[\s\][])(?:<>\s*Tj|\[<>\]\s*TJ|\(\)\s*Tj)\b/g;

const countEmptyShowInSource = (bytes: Buffer): number =>
  contentStreams(bytes).reduce((n, s) => n + (s.match(EMPTY_SHOW) ?? []).length, 0);

/**
 * 記号（○×議－）だけでできた文字列。
 *
 * **1 文字だけで判定してはいけない**（自分のテストで踏んだ）。この 3 本の本文には
 * **「議案等番号」「本会議の状況」の `議` が 1 文字ずつ**散らばっていて、
 * **この式はそれも「記号」と見なす**。**最初に書いたテストは、その `議` を票の行だと思い込み、
 * 見出しの行（y=553.00）を「票の行」と誤判定して落ちた。**
 * **だから「票の行」は、記号が議員の人数ぶん並んでいる行だけ**とする（下の `voteRowYs`）。
 */
const VOTE_SYMBOL = /^[○×〇✕議－―ー欠退\s　-]+$/u;

/** 票の行の y。**記号が `minRun` 個以上並んでいる行だけ**を票の行と見る。 */
function voteRowYs(shown: readonly Shown[], minRun: number): number[] {
  const perRow = new Map<string, number>();
  for (const s of shown) {
    if (s.glyphs === 0 || s.text.trim().length === 0 || !VOTE_SYMBOL.test(s.text)) continue;
    const key = s.y.toFixed(1);
    perRow.set(key, (perRow.get(key) ?? 0) + s.text.replace(/[\s　]/gu, "").length);
  }
  return [...perRow].filter(([, n]) => n >= minRun).map(([y]) => Number(y));
}

// ---------------------------------------------------------------------------
// 1. **21 回は「グリフが落ちた」のではなく「PDF が空の文字列を描いている」**
//    ——pdfjs が数えた空と、PDF の原文にある空の Tj が 1 本ずつ・1 回ずつ一致する
// ---------------------------------------------------------------------------

test("#927 滋賀 3 本の空の showText は、PDF 原文の「中身の無い Tj」と 1 回ずつ一致する（8/7/6 = 21）", async () => {
  let totalFromPdfjs = 0;
  let totalFromSource = 0;
  for (const { name, empty } of THREE) {
    const bytes = fixture("shiga", name);
    const shown = await readShownText(bytes);
    const fromPdfjs = shown.filter((s) => s.glyphs === 0).length;
    const fromSource = countEmptyShowInSource(bytes);

    assert.ok(shown.length > 400, `${name}: showText が ${shown.length} 回しかない（フィクスチャが違う）`);
    assert.equal(fromPdfjs, empty, `${name}: 空の showText が ${fromPdfjs} 回（#922 の実測は ${empty} 回）`);
    // **ここが結論の芯**: 落ちたグリフではなく、**描けと言われた文字が 0 文字**である
    assert.equal(fromSource, fromPdfjs, `${name}: 原文の空の Tj は ${fromSource} 回だが pdfjs の空は ${fromPdfjs} 回（対応していない＝グリフが落ちている疑い）`);
    totalFromPdfjs += fromPdfjs;
    totalFromSource += fromSource;
  }
  // **母数を検算に入れる**（#757）。3 本で 8 + 7 + 6 = 21
  assert.equal(totalFromPdfjs, 21, `3 本の空の合計が ${totalFromPdfjs} 回（21 回のはず）`);
  assert.equal(totalFromSource, 21, `原文の空の Tj の合計が ${totalFromSource} 回（21 回のはず）`);
});

test("#927 原文の数え方が汚染されていないこと——偽陽性を出した 2 本で、pdfjs と原文がどちらも 0 回", async () => {
  // **#886 の汚染事故への対処を、テストに置く。** この 2 本は**実際に偽陽性を出した本**である:
  //   - `aomori/279_26.9_giketsukekka.pdf`: `(…\<>…)Tj` という**中身のある文字列の内側**を
  //     「空の Tj」と数えて **8 回**の偽陽性（pdfjs の数えた空は 0 回）
  //   - `shiga/Kg274_250628-sanpi.pdf`: 同じ形で **1 回**
  //   - （さらに、印字率で弾く前は `tottori/R8.2giketsukekka0325.pdf` の
  //      2 MB のフォントのバイナリから **63 回**の偽陽性が出た。こちらも下で 0 を固定する）
  // **数え方を緩めると、ここが 0 でなくなる。**
  const cases = [
    { pref: "aomori", name: "279_26.9_giketsukekka.pdf" },
    { pref: "shiga", name: "Kg274_250628-sanpi.pdf" },
    { pref: "tottori", name: "R8.2giketsukekka0325.pdf" },
  ];
  for (const { pref, name } of cases) {
    const bytes = fixture(pref, name);
    const shown = await readShownText(bytes);
    assert.ok(shown.length > 0, `${pref}/${name}: showText が 1 回も無い（比較が成り立たない）`);
    assert.equal(shown.filter((s) => s.glyphs === 0).length, 0, `${pref}/${name}: pdfjs の数えた空が 0 回ではない`);
    assert.equal(countEmptyShowInSource(bytes), 0, `${pref}/${name}: 原文の数え方が偽陽性を出している（中身のある文字列やフォントのバイナリを拾っている）`);
  }
});

test("#927 空の showText の 11 回は「空白 1 文字ぶんの場所取り」である（前後の間隔が字の大きさと一致）", async () => {
  // **「会␀派␀名」「※␀本会議」「２␀議案」の形**。前後が 1 字ピッチなら、
  // **そこに文字を入れる余地は無い**（隣の字が詰まっていない＝何も落ちていない）。
  let pitched = 0;
  let checked = 0;
  for (const { name } of THREE) {
    const shown = await readShownText(fixture("shiga", name));
    for (let i = 0; i < shown.length; i++) {
      const e = shown[i];
      if (e.glyphs !== 0) continue;
      checked++;
      const line = shown.filter((o) => Math.abs(o.y - e.y) < 0.1).sort((a, b) => a.x - b.x);
      const k = line.indexOf(e);
      const prev = line[k - 1];
      const next = line[k + 1];
      if (!prev || !next) continue; // 行頭・行末（前後どちらかが無いので間隔が測れない）
      if (Math.abs(next.x - e.x - e.size) < 0.2 && Math.abs(e.x - prev.x - e.size) < 0.2) pitched++;
    }
  }
  assert.equal(checked, 21, `空を ${checked} 回しか見ていない（21 回のはず）`);
  assert.equal(pitched, 11, `1 字ピッチの空が ${pitched} 回（実測は 11 回）`);
});

// ---------------------------------------------------------------------------
// 2. **21 回はどれも票の行に無い**（見出し・凡例・列見出し・注記の行だけ）
// ---------------------------------------------------------------------------

test("#927 空の showText の y は、記号（○×議－）のある行の y と 1 つも重ならない", async () => {
  let emptiesSeen = 0;
  let symbolRowsSeen = 0;
  for (const { name } of THREE) {
    const bytes = fixture("shiga", name);
    const shown = await readShownText(bytes);
    // **議員は 46〜47 人**。票の行は記号がその人数ぶん並ぶ（見出しに 1 文字ある `議` は届かない）
    const symbolY = voteRowYs(shown, 40);
    symbolRowsSeen += symbolY.length;
    for (const e of shown) {
      if (e.glyphs !== 0) continue;
      emptiesSeen++;
      const onVoteRow = symbolY.some((y) => Math.abs(y - e.y) < 1.0);
      assert.equal(onVoteRow, false, `${name}: 空の showText が票の行（y=${e.y.toFixed(2)}）にある`);
    }
  }
  // **母数**: 21 回すべてを見たこと、記号の行が実在することの両方を固定する
  assert.equal(emptiesSeen, 21, `空を ${emptiesSeen} 回しか見ていない（21 回のはず）`);
  assert.ok(symbolRowsSeen >= 3, `記号の行が ${symbolRowsSeen} 行しか見つからない（比較が成り立たない）`);
});

// ---------------------------------------------------------------------------
// 3. **票は 1 つも消えていない**——PDF が自分で刷っている賛否の数と、読み取ったセルが一致する
// ---------------------------------------------------------------------------

test("#927 3 本の全 8 行で、読み取ったセルの ○ × の数が PDF の刷っている賛成数・反対数と一致する", async () => {
  let rowsChecked = 0;
  for (const { name } of THREE) {
    const v = await parseVotePdf(fixture("shiga", name));
    assert.equal(v.unknownCells, 0, `${name}: 置けなかったセルが ${v.unknownCells} 個ある`);
    assert.ok(v.members.length >= 46, `${name}: 議員の列が ${v.members.length} 列しかない`);
    for (const row of v.rows) {
      rowsChecked++;
      assert.equal(row.cells.length, v.members.length, `${name} "${row.title}": セル ${row.cells.length} 個 ≠ 議員 ${v.members.length} 人`);
      assert.ok(row.counts, `${name} "${row.title}": 賛否の数が読めていない`);
      const yes = [...row.cells].filter((c) => c === "○" || c === "〇").length;
      const no = [...row.cells].filter((c) => c === "×" || c === "✕").length;
      assert.equal(yes, row.counts.yes, `${name} "${row.title}": ○ が ${yes} 個だが PDF は賛成 ${row.counts.yes}`);
      assert.equal(no, row.counts.no, `${name} "${row.title}": × が ${no} 個だが PDF は反対 ${row.counts.no}`);
    }
  }
  // **母数**（#757）: 1 + 6 + 1 = 8 行
  assert.equal(rowsChecked, 8, `${rowsChecked} 行しか検算していない（8 行のはず）`);
});

// ---------------------------------------------------------------------------
// 4. **他県は 0 回である**（「0 回だった」と「数えていない」を区別する。#757）
// ---------------------------------------------------------------------------

test("#927 CMap を渡した状態で空の showText があるのは滋賀の 3 本だけ（フィクスチャ全数）", async () => {
  const dirs = readdirSync(FIXTURES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const files: { pref: string; name: string }[] = [];
  for (const pref of dirs) {
    for (const name of readdirSync(new URL(`${pref}/`, FIXTURES)).sort()) {
      if (name.toLowerCase().endsWith(".pdf")) files.push({ pref, name });
    }
  }
  // **母数を検算に入れる**（#757）。本数が変わったらここが落ちて、数え直しを促す
  assert.ok(files.length >= 95, `フィクスチャの PDF が ${files.length} 本しか見つからない（2026-09-21 の実測は 98 本）`);

  const withEmpty: string[] = [];
  let totalShow = 0;
  let totalEmpty = 0;
  let unreadable = 0;
  for (const { pref, name } of files) {
    let shown: Shown[];
    try { shown = await readShownText(fixture(pref, name)); } catch { unreadable++; continue; }
    const empty = shown.filter((s) => s.glyphs === 0).length;
    totalShow += shown.length;
    totalEmpty += empty;
    if (empty > 0) withEmpty.push(`${pref}/${name}:${empty}`);
  }
  // **「読めなかった本」を数えて 0 であることを示す**（数えていない本を隠さない）
  assert.equal(unreadable, 0, `例外で読めなかった本が ${unreadable} 本ある（その本は数えられていない）`);
  assert.ok(totalShow > 150000, `showText の合計が ${totalShow} 回（2026-09-21 の実測は 183705 回。母数が減っている）`);
  assert.deepEqual(withEmpty.sort(), [
    "shiga/Kg220_240424-sanpi.pdf:8",
    "shiga/Kg229_240711-sanpi.pdf:7",
    "shiga/Kg280_sanpi-250924.pdf:6",
  ], "空の showText がある本が、滋賀の 3 本以外にもある（または減っている）");
  assert.equal(totalEmpty, 21, `空の合計が ${totalEmpty} 回（21 回のはず）`);
});
