import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readGlyphPageOps } from "../src/sources/local/kochi/glyphs.ts";
import { readGlyphPageOps as mieOps } from "../src/sources/local/mie/glyphs.ts";

// Issue #707: kochi/mie の glyphs.ts が `'`（nextLineShowText）と `"`（nextLineSetSpacingShowText）を
// 扱っていない、という報告から始まった。**追試したら、Issue の想定した機序は成り立っていなかった。**
//
// **Issue の想定**: 「`'` が来ても黙って無視されるので、行送りを無視した位置で文字を読む」
// **実測（後述）**: **pdfjs の `getOperatorList()` は `'` / `"` をそのまま出さない。**
//   `'` → `nextLine` + `showText` に、
//   `"` → `nextLine` + `setWordSpacing` + `setCharSpacing` + `showText` に**分解して**出す。
//   （pdfjs 5.x `pdf.worker.mjs` の `getOperatorList`: `case OPS.nextLineShowText:` が
//   `operatorList.addOp(OPS.nextLine)` を積んでから `fn = OPS.showText` に差し替える。）
//   **だから `OPS.nextLineShowText`(46) / `OPS.nextLineSetSpacingShowText`(47) は
//   この実装の入口には一度も届かない。**
//
// **実証**（2026-09-09、手で組んだ最小 PDF `BT /F1 12 Tf 14 TL 100 700 Td (A) Tj (B) ' 1 2 (C) " ET`）:
//   getOperatorList() が出したのは
//     beginText, setFont, setLeading[14], moveText[100,700], showText(A),
//     nextLine, showText(B),                              ← `'` の分解
//     nextLine, setWordSpacing[1], setCharSpacing[2], showText(C),  ← `"` の分解
//     endText
//   **`nextLineShowText` も `nextLineSetSpacingShowText` も 0 回。**
//
// つまり `'` の行送りは、高知では既に `nextLine` の枝が正しく処理しており（#703 で固定済み）、
// 三重では既に `nextLine` の枝が例外にしている。**Issue の言う「行がずれる」穴は塞がっている。**
//
// **残っていた本当の穴は 2 つ**:
//   (1) **`"` の word spacing（`Tw`）を両方とも一切見ていない。**
//       `grep -rn "setWordSpacing\|wordSpacing" packages/etl/src/` → **0 件**（2026-09-09）。
//       `Tw` は空白文字 1 つごとに送り幅へ加算される（PDF 32000-1 9.3.3）。
//       **フィクスチャには空白グリフが実在する**（実測: 高知 62/61、三重 2/2/6/2/2 個）ので、
//       `Tw` が 0 でなくなれば **文字の x が右へずれる**。
//       高知は 1 人 1 列なので、ずれた記号は**別の議員の列**に入りうる（利用者からは検出できない）。
//   (2) **将来 pdfjs が分解をやめたら**、46/47 は今の実装のどの枝にも当たらず
//       **黙って無視される**（Issue の想定どおりの事故になる）。
//
// **どちらも案 B（例外にする）で塞ぐ**——#569「迷ったら出さない側に倒す」。
// **実データに 0 回なので「正しく読む」を検証できない**（#700 の担当者が文字への CTM 適用で
// 同じ判断をしている）。**Tw を正しく足す実装を書いても、それが正しい証拠を実データから出せない。**
//
// **実測（2026-09-09、フィクスチャ 7 本、数え方 2 通り）**。両方とも同じ値になった:
//   (a) pdfjs の `getOperatorList()` を歩いて `OPS.nextLineShowText` /
//       `OPS.nextLineSetSpacingShowText` / `OPS.setWordSpacing` を数える
//   (b) **pdfjs を信じないための独立な実装**: Python の `pypdf` でページの `/Contents` を
//       取り出し、文字列リテラルを潰してから生トークン `'` / `"` / `Tw` を数える
//       （最初は自前の zlib 展開で全ストリームを走査したが、**埋め込みフォントの
//       バイナリを拾って `"` の偽陽性が 4 件出た**。ページの /Contents だけを見るように直した。）
//
//     ファイル              (a)46 (a)47 (a)Tw || (b)' (b)" (b)Tw   空白グリフ
//     kochi/0706.pdf           0     0     0  ||  0    0     0        62
//     kochi/0806.pdf           0     0     0  ||  0    0     0        61
//     mie/001235880.pdf        0     0     0  ||  0    0     0         2
//     mie/001242584.pdf        0     0     0  ||  0    0     0         2
//     mie/001249930.pdf        0     0     0  ||  0    0     0         6
//     mie/001256778.pdf        0     0     0  ||  0    0     0         2
//     mie/001263901.pdf        0     0     0  ||  0    0     0         2
//
// **この段落を消すと、下のテストが「実データに無い形を守る不要なもの」に見えて消される**
// （#703 の担当者の整理に従う。実測が「なぜ守るのか」を、テストが「守り」を担当する）。

/** 「あ」1 文字ぶんの showText 引数（幅 1000 = フォントサイズと同じだけ進む）。 */
const glyph = (u: string) => [[{ unicode: u, width: 1000 }]];

/** [fnArray, argsArray] を [op, args] の並びから組み立てる（local-glyphs-leading.test.ts と同じ形）。 */
function opList(pairs: [number, unknown][]): [number[], unknown[]] {
  return [pairs.map((p) => p[0]), pairs.map((p) => p[1])];
}

const IMPLS = [
  ["kochi", readGlyphPageOps],
  ["mie", mieOps],
] as const;

// ---------------------------------------------------------------------------
// 0. 使う演算子が実在すること（#699: 名前を間違えると両側 undefined で恒真になる）
// ---------------------------------------------------------------------------

test("#707 ' と \" と Tw の OPS キーが実在し、互いに別の値である", () => {
  const keys = ["nextLineShowText", "nextLineSetSpacingShowText", "setWordSpacing", "nextLine", "setCharSpacing", "showText", "setTextMatrix", "beginText", "setFont"] as const;
  const ops = OPS as Record<string, number | undefined>;
  for (const k of keys) {
    assert.equal(typeof ops[k], "number", `OPS.${k} が number でない（キー名を間違えると undefined === undefined で恒真になる）`);
  }
  assert.equal(new Set(keys.map((k) => ops[k])).size, keys.length, "同じ値の枝があると区別になっていない");
  // 上の実測表が指している番号そのもの。pdfjs 側でずれたら気づけるようにしておく。
  assert.equal(ops.nextLineShowText, 46);
  assert.equal(ops.nextLineSetSpacingShowText, 47);
});

// ---------------------------------------------------------------------------
// 1. pdfjs が ' と " を分解することを、実物の PDF で固定する
//    （Issue の想定した機序が成り立たない理由そのもの。ここが変わったら 2. の守りが効く番になる）
// ---------------------------------------------------------------------------

/** `'` と `"` を含む最小の PDF を組み立てる（フィクスチャに 1 本も無いので手で作る）。 */
function quotePdf(): Buffer {
  const content = "BT\n/F1 12 Tf\n14 TL\n100 700 Td\n(A) Tj\n(B) '\n1 2 (C) \"\nET\n";
  const objs: Record<number, string> = {
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    4: `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    5: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  };
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

test("#707 pdfjs の getOperatorList は ' と \" を分解して出す（46/47 は入口に届かない）", async () => {
  const task = getDocument({ data: new Uint8Array(quotePdf()), verbosity: 0 });
  const doc = await task.promise;
  try {
    const ops = await (await doc.getPage(1)).getOperatorList();
    const fns = Array.from(ops.fnArray);
    // 生の 46 / 47 は 1 つも出ない
    assert.equal(fns.filter((f) => f === OPS.nextLineShowText).length, 0, "pdfjs が ' をそのまま出している（分解しなくなった）");
    assert.equal(fns.filter((f) => f === OPS.nextLineSetSpacingShowText).length, 0, "pdfjs が \" をそのまま出している（分解しなくなった）");
    // 代わりに nextLine が 2 回（' と " のぶん）と、" のぶんの Tw/Tc が出る
    assert.equal(fns.filter((f) => f === OPS.nextLine).length, 2, "' と \" の行送りが nextLine に分解されていない");
    assert.equal(fns.filter((f) => f === OPS.showText).length, 3, "Tj と ' と \" の 3 文字ぶん");
    const twAt = fns.indexOf(OPS.setWordSpacing);
    assert.notEqual(twAt, -1, "\" の word spacing が setWordSpacing として出ていない");
    assert.deepEqual(ops.argsArray[twAt], [1], "\" の第 1 引数（aw）が setWordSpacing に渡っていない");
  } finally {
    await task.destroy();
  }
});

test("#707 高知は分解後の ' を行送りとして正しく読む（案 B が読める形まで潰していないことの否定的対照）", () => {
  // pdfjs が出すのと同じ並び（nextLine + showText）。高知の nextLine の枝が受ける。
  const [fn, args] = opList([
    [OPS.setFont, ["F1", 10]],
    [OPS.beginText, null],
    [OPS.setTextMatrix, [1, 0, 0, 1, 50, 700]],
    [OPS.setLeading, [14]],
    [OPS.showText, glyph("あ")],
    [OPS.nextLine, null],
    [OPS.showText, glyph("い")],
  ]);
  const { items } = readGlyphPageOps(fn, args, 1);
  assert.deepEqual(items.map((i) => [i.str, i.x, i.y]), [["あ", 50, 700], ["い", 50, 686]]);
});

// ---------------------------------------------------------------------------
// 2. 案 B: 分解されずに 46 / 47 が届いたら止める（黙って無視しない）
//    pdfjs が分解をやめる・別の入口から呼ばれる、のどちらでも「行がずれた記録」を出さない
// ---------------------------------------------------------------------------

for (const [name, impl] of IMPLS) {
  for (const [op, label, opArgs] of [
    [OPS.nextLineShowText, "'", [[{ unicode: "あ", width: 1000 }]]],
    [OPS.nextLineSetSpacingShowText, '"', [1, 2, [{ unicode: "あ", width: 1000 }]]],
  ] as const) {
    test(`#707 ${name}: ${label}（次行送り＋表示）が生で来たら例外にする`, () => {
      const [fn, args] = opList([
        [OPS.setFont, ["F1", 10]],
        [OPS.beginText, null],
        [OPS.setTextMatrix, [1, 0, 0, 1, 50, 700]],
        [op, opArgs],
      ]);
      assert.throws(() => impl(fn, args, 4), /page 4: unsupported .*next-line show-text op/);
    });
  }
}

// ---------------------------------------------------------------------------
// 3. 案 B: 0 でない word spacing（Tw）が来たら止める
//    Tw は空白グリフ 1 つごとに送り幅へ加算される（PDF 32000-1 9.3.3）。
//    両実装とも一切見ていないので、見ないまま読むと x が左へ詰まる。
// ---------------------------------------------------------------------------

for (const [name, impl] of IMPLS) {
  test(`#707 ${name}: 0 でない Tw（word spacing）が来たら例外にする`, () => {
    const [fn, args] = opList([
      [OPS.setFont, ["F1", 10]],
      [OPS.beginText, null],
      [OPS.setTextMatrix, [1, 0, 0, 1, 50, 700]],
      [OPS.setWordSpacing, [3]],
      [OPS.showText, glyph("あ")],
    ]);
    assert.throws(() => impl(fn, args, 5), /page 5: non-zero word spacing/);
  });

  test(`#707 ${name}: Tw が 0 なら例外にしない（上が広すぎないかの否定的対照）`, () => {
    // 実データはこちら（実測: 7 本すべて Tw = 0 回。明示的に 0 を置く PDF もありうる）
    const [fn, args] = opList([
      [OPS.setFont, ["F1", 10]],
      [OPS.beginText, null],
      [OPS.setTextMatrix, [1, 0, 0, 1, 50, 700]],
      [OPS.setWordSpacing, [0]],
      [OPS.showText, glyph("あ")],
    ]);
    const { items } = impl(fn, args, 5);
    assert.equal(items.length, 1);
    assert.deepEqual([items[0].str, items[0].x, items[0].y], ["あ", 50, 700]);
  });

  test(`#707 ${name}: 0 でない Tw は、そのあと 0 に戻しても・文字を出さなくても止める`, () => {
    // **見た瞬間に止める**（状態を持って showText のときに判定する、ではない）。
    // 0 でない Tw を 1 度でも出す PDF は word spacing を使う書き手なので、
    // **たまたまその区間に空白グリフが無かっただけ**という可能性が残る。
    // 「空白のときだけ止める」にすると、**同じ PDF の別の回で黙って詰まった x を出す**。
    const [fn, args] = opList([
      [OPS.setFont, ["F1", 10]],
      [OPS.beginText, null],
      [OPS.setTextMatrix, [1, 0, 0, 1, 50, 700]],
      [OPS.setWordSpacing, [3]],
      [OPS.setWordSpacing, [0]],
      // showText を 1 つも出さない。それでも止まる
    ]);
    assert.throws(() => impl(fn, args, 5), /page 5: non-zero word spacing/);
  });
}

// ---------------------------------------------------------------------------
// 4. 実物のフィクスチャで、上の守りが 1 度も発動しないこと（実測表の (a) 列そのもの）
//    ここが落ちたら「実データに 0 回」という前提が崩れた合図で、実装を見直す番になる
// ---------------------------------------------------------------------------

for (const f of ["kochi/0706.pdf", "kochi/0806.pdf", "mie/001235880.pdf", "mie/001242584.pdf", "mie/001249930.pdf", "mie/001256778.pdf", "mie/001263901.pdf"]) {
  test(`#707 ${f}: 生の 46/47 と 0 でない Tw が 1 度も出ない`, async () => {
    const bytes = readFileSync(new URL(`./fixtures/${f}`, import.meta.url));
    const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
    const doc = await task.promise;
    try {
      let quote = 0;
      let nonZeroTw = 0;
      let tw = 0;
      for (let p = 1; p <= doc.numPages; p++) {
        const ops = await (await doc.getPage(p)).getOperatorList();
        for (let i = 0; i < ops.fnArray.length; i++) {
          const fn = ops.fnArray[i];
          if (fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) quote++;
          if (fn === OPS.setWordSpacing) {
            tw++;
            if ((ops.argsArray[i] as number[])[0] !== 0) nonZeroTw++;
          }
        }
      }
      assert.equal(quote, 0, "' / \" が生で出た（実測表の前提が崩れた）");
      assert.equal(tw, 0, "Tw が出た（実測表の前提が崩れた）");
      assert.equal(nonZeroTw, 0);
    } finally {
      await task.destroy();
    }
  });
}
