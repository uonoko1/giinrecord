import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readGlyphPageOps } from "../src/sources/local/kochi/glyphs.ts";
import { readGlyphPageOps as mieOps } from "../src/sources/local/mie/glyphs.ts";

// Issue #717: **kochi/mie の glyphs.ts には既定の枝（else）が無かった。**
// 知らない演算子が来ると、何の枝にも当たらず**黙って次へ進む**。
// #707（PR #712）が `'` / `"` / `Tw` の 3 つを名指しで塞いだが、**同じ形の穴が演算子の数だけ残っていた。**
//
// **実測（2026-09-09、フィクスチャ 7 本の全ページ。`getOperatorList()` の `fnArray` を全部数え、
// `OPS` の逆引きで名前にした）。実装が見ている 17 種類を除いた残り = 13 種類:**
//
//     16145 setFillRGBColor          7541 endMarkedContent        149 clip
//      7956 eoClip                   7520 beginMarkedContentProps  21 beginMarkedContent
//      7949 setStrokeRGBColor         233 dependency               16 setLineWidth
//        14 setGState                   9 setLineCap                9 setLineJoin
//         7 setTextRenderingMode
//
// **このうち `setTextRenderingMode` が危ない。** PDF 32000-1 9.3.6:
//   `0`=fill（既定） `1`=stroke `2`=fill+stroke **`3`=invisible（不可視）** `4`-`7`=clip 付き
// **`3` の文字は PDF ビューアに表示されない。今の実装はそれを読んで記録にする**——
// **一次資料を開いても、その文字は見えない。** #569 の「別人の記録」とは形が違うが同じ重さで、
// **「出典を確かめられない記録」は、このプロジェクトが最も出してはいけないもの**である。
// OCR 済みスキャン PDF の透明テキスト層はまさに `Tr 3` で置かれる（一般論）。
//
// **実データの `Tr` の値は `2` だけだった**（三重 5 本に 1〜3 回ずつ。高知は 0 回）:
//     mie/001235880.pdf [2]   mie/001242584.pdf [2]   mie/001249930.pdf [2,2,2]
//     mie/001256778.pdf [2]   mie/001263901.pdf [2]
//
// **`setGState` も危ない。**中身を一度も見ていなかったので、PO の表からさらに 1 段掘って
// **14 回ぶんの引数を全部出した**（実測、同日）。出たのは 2 種類だけ:
//     [["BM","source-over"],["ca",1]]   [["BM","source-over"],["CA",1]]
// **どちらも「通常合成・完全不透明」で無害**だが、pdfjs が同じ `setGState` に載せて渡す鍵には
// **文字を読めなくするものが 2 つある**（pdf.worker.mjs の `setGState` が組み立てる `gStateObj` の中身）:
//   - **`Font`**: ExtGState の `/Font` はフォントと**サイズ**を設定する。
//     **このとき pdfjs は `OPS.setFont` を出さない**（実測、下の 1. で固定）。
//     この実装は `fontSize` を `setFont` からしか取らないので、**サイズが 0 のまま**になり
//     グリフ幅が全部 0 になる → **文字の x が 1 点に潰れる**。
//     **潰れた座標で列を割ると、記号が別の議員の列に入る**（#693 と同じ実害。高知も三重も 1 人 1 列）。
//   - **`ca` / `CA` が 0**: 塗り／線が完全に透明 = **その文字は見えない**（`Tr 3` と同じ帰結）。
//
// **`Ts`（setTextRise, OPS 39）** は #707 の担当者が別 Issue 候補として残したもの。
// `Ts` は文字のベースラインを上下にずらす（PDF 32000-1 9.4.3）。見ていないので y がずれる。
//
// **残り 11 種類（色・線の太さ・線端・クリップ・マーク付きコンテンツ・pdfjs 内部の dependency）は
// 文字の位置にも可読性にも影響しない**ので、**明示的に無視する枝**を書いた（理由はソースのコメント）。
// **全部を例外にすると、色を変えただけの PDF で ETL が止まる**（実データに 32,036 回出る）。
//
// **未知の演算子は例外**にした。これが本題——`Ts` を 1 つずつ足しても、次の未知の演算子で同じことが起きる。

/** 「あ」1 文字ぶんの showText 引数（幅 1000 = フォントサイズと同じだけ進む）。 */
const glyph = (u: string) => [[{ unicode: u, width: 1000 }]];

/** [fnArray, argsArray] を [op, args] の並びから組み立てる（local-glyphs-quote-ops.test.ts と同じ形）。 */
function opList(pairs: [number, unknown][]): [number[], unknown[]] {
  return [pairs.map((p) => p[0]), pairs.map((p) => p[1])];
}

/** 文字を 1 つ置く最小の前置き（両実装が受け付ける形＝ Tm で位置を明示）。 */
const preamble: [number, unknown][] = [
  [OPS.setFont, ["F1", 10]],
  [OPS.beginText, null],
  [OPS.setTextMatrix, [1, 0, 0, 1, 50, 700]],
];

const IMPLS = [
  ["kochi", readGlyphPageOps],
  ["mie", mieOps],
] as const;

// ---------------------------------------------------------------------------
// 0. 使う演算子が実在すること（#699: 名前を間違えると両側 undefined で恒真になる。#693 で実際に起きた）
// ---------------------------------------------------------------------------

test("#717 この節が使う OPS のキーが実在し、互いに別の値である", () => {
  const keys = [
    "setTextRenderingMode", "setGState", "setTextRise",
    "setFillRGBColor", "setStrokeRGBColor", "eoClip", "clip",
    "beginMarkedContent", "beginMarkedContentProps", "endMarkedContent",
    "dependency", "setLineWidth", "setLineCap", "setLineJoin",
    "showText", "setTextMatrix", "beginText", "endText", "setFont",
  ] as const;
  const ops = OPS as Record<string, number | undefined>;
  for (const k of keys) {
    assert.equal(typeof ops[k], "number", `OPS.${k} が number でない（キー名を間違えると undefined === undefined で恒真になる）`);
  }
  assert.equal(new Set(keys.map((k) => ops[k])).size, keys.length, "同じ値の枝があると区別になっていない");
  // 上の実測表が指している番号そのもの。pdfjs 側でずれたら気づけるようにしておく。
  assert.equal(ops.setTextRenderingMode, 38);
  assert.equal(ops.setTextRise, 39);
  assert.equal(ops.setGState, 9);
  // **存在しないキーもある**（実測: `OPS.paintJpegXObject` は undefined）。
  // 枝に書いていたら `fn === undefined` の恒真になるので、そういう名前を使っていないことを示す。
  assert.equal((ops as Record<string, number | undefined>).paintJpegXObject, undefined);
});

// ---------------------------------------------------------------------------
// 1. pdfjs が実際に何を渡してくるか（機序の実証。手で組んだ PDF）
//    ここが変わったら、下の守りの前提が崩れた合図になる
// ---------------------------------------------------------------------------

/** 指定の内容ストリームを持つ最小の PDF（ExtGState 3 つつき）。 */
function probePdf(content: string): Buffer {
  const objs: Record<number, string> = {
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> /ExtGState << /GT 6 0 R /GF 7 0 R /GO 8 0 R >> >> /Contents 4 0 R >>",
    4: `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    5: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    6: "<< /Type /ExtGState /ca 0 >>", // 完全透明（見えない文字）
    7: "<< /Type /ExtGState /Font [5 0 R 30] >>", // ExtGState からのフォント指定
    8: "<< /Type /ExtGState /CA 1 /ca 1 >>", // 不透明（実データに出る形）
  };
  const n = 8;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i <= n; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${n + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= n; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${n + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** probePdf の 1 ページ目のオペレータ列を [fnArray, argsArray] で返す。 */
async function probeOps(content: string): Promise<[number[], unknown[]]> {
  const task = getDocument({ data: new Uint8Array(probePdf(content)), verbosity: 0 });
  const doc = await task.promise;
  try {
    const ops = await (await doc.getPage(1)).getOperatorList();
    return [Array.from(ops.fnArray), Array.from(ops.argsArray)];
  } finally {
    await task.destroy();
  }
}

test("#717 Tr 3（不可視）は setTextRenderingMode[3] として実装の入口に届く（＝黙って読めてしまう形）", async () => {
  const [fns, args] = await probeOps("BT /F1 12 Tf 100 700 Td 3 Tr (A) Tj ET\n");
  const at = fns.indexOf(OPS.setTextRenderingMode);
  assert.notEqual(at, -1, "pdfjs が Tr を setTextRenderingMode として出していない（前提が変わった）");
  assert.deepEqual(args[at], [3], "Tr の値がそのまま届いていない");
  // **不可視のまま showText が続く。**pdfjs は「見えないから省く」ことをしない。
  assert.ok(fns.indexOf(OPS.showText) > at, "不可視指定のあとに showText が来ない（前提が変わった）");
});

test("#717 Ts（text rise）は setTextRise として届く", async () => {
  const [fns, args] = await probeOps("BT /F1 12 Tf 100 700 Td 5 Ts (A) Tj ET\n");
  const at = fns.indexOf(OPS.setTextRise);
  assert.notEqual(at, -1, "pdfjs が Ts を setTextRise として出していない");
  assert.deepEqual(args[at], [5]);
});

test("#717 ExtGState の /Font は setGState に載り、setFont は出ない（＝ fontSize が 0 のままになる）", async () => {
  const [fns, args] = await probeOps("/GF gs BT 100 700 Td (A) Tj ET\n");
  const at = fns.indexOf(OPS.setGState);
  assert.notEqual(at, -1);
  // 中身は [[鍵, 値], ...] の 1 段包み。**フォント ID（g_dN_f1）は同一プロセスで
  // 何本目の文書かで変わる**ので、鍵の名前とサイズだけ見る（ID を固定すると他のテストの本数で落ちる）。
  const entries = (args[at] as [string, unknown][][])[0];
  assert.deepEqual(entries.map(([k]) => k), ["Font"], "setGState の中身が [鍵, 値] の並びでない（前提が変わった）");
  assert.equal((entries[0][1] as [string, number])[1], 30, "ExtGState の /Font のサイズが渡っていない");
  assert.equal(fns.filter((f) => f === OPS.setFont).length, 0, "pdfjs が ExtGState の Font に対して setFont も出している（なら fontSize は失われない）");
  assert.ok(fns.includes(OPS.showText), "文字が出ていない");
});

test("#717 ExtGState の /ca 0（完全透明）は setGState に載って届く", async () => {
  const [fns, args] = await probeOps("/GT gs BT /F1 12 Tf 100 700 Td (A) Tj ET\n");
  const at = fns.indexOf(OPS.setGState);
  assert.notEqual(at, -1);
  assert.deepEqual(args[at], [[["ca", 0]]]);
});

// ---------------------------------------------------------------------------
// 2. 未知の演算子は例外にする（**これが本題**——既定の枝が無いこと自体）
// ---------------------------------------------------------------------------

for (const [name, impl] of IMPLS) {
  test(`#717 ${name}: 知らない演算子が来たら、番号と名前を出して例外にする`, () => {
    // shadingFill（62）は実装のどの枝にも無く、フィクスチャ 7 本にも 0 回。
    // **今までは黙って無視されていた。**
    const [fn, args] = opList([...preamble, [OPS.shadingFill, ["Sh0"]], [OPS.showText, glyph("あ")]]);
    assert.throws(() => impl(fn, args, 3), /page 3: unsupported operator 62 \(shadingFill\)/);
  });

  test(`#717 ${name}: OPS に名前が無い番号でも例外にする（名前は unknown と出す）`, () => {
    // 逆引きに無い番号（pdfjs が将来足す演算子のつもり）。番号だけでも追える形にしておく。
    const [fn, args] = opList([...preamble, [9999, []], [OPS.showText, glyph("あ")]]);
    assert.throws(() => impl(fn, args, 3), /page 3: unsupported operator 9999 \(unknown\)/);
  });
}

// ---------------------------------------------------------------------------
// 3. 既知で危険: setTextRenderingMode
//    実データの値は 2 だけ。0（既定）と 2 を通し、それ以外は止める。
//    1（stroke のみ）と 4-7（clip つき）は**実データに無いので「正しく読める」ことを検証できない**
//    ——#707 の Tw と同じ状況なので、出さない側に倒す（#569）。
// ---------------------------------------------------------------------------

for (const [name, impl] of IMPLS) {
  for (const mode of [3, 7]) {
    test(`#717 ${name}: Tr ${mode}（${mode === 3 ? "不可視" : "clip つき"}）で例外にする`, () => {
      const [fn, args] = opList([...preamble, [OPS.setTextRenderingMode, [mode]], [OPS.showText, glyph("あ")]]);
      assert.throws(() => impl(fn, args, 2), /page 2: unsupported text rendering mode \(Tr \d\)/);
    });
  }

  test(`#717 ${name}: Tr 3 は、そのあと 0 に戻しても・文字を出さなくても止める`, () => {
    // **見た瞬間に止める**（#707 の Tw と同じ理由）。状態を持って showText のときに判定すると、
    // **たまたまその区間に文字が無かった回だけ通り**、同じ PDF の別の回で不可視の文字を読む。
    const [fn, args] = opList([...preamble, [OPS.setTextRenderingMode, [3]], [OPS.setTextRenderingMode, [0]]]);
    assert.throws(() => impl(fn, args, 2), /page 2: unsupported text rendering mode \(Tr 3\)/);
  });

  for (const mode of [0, 2]) {
    test(`#717 ${name}: Tr ${mode}（${mode === 0 ? "既定の塗り" : "塗り＋線。実データに出る値"}）は通す（上が広すぎないかの否定的対照）`, () => {
      const [fn, args] = opList([...preamble, [OPS.setTextRenderingMode, [mode]], [OPS.showText, glyph("あ")]]);
      const { items } = impl(fn, args, 2);
      assert.equal(items.length, 1);
      assert.deepEqual([items[0].str, items[0].x, items[0].y], ["あ", 50, 700]);
    });
  }
}

// ---------------------------------------------------------------------------
// 4. 既知で危険: setGState（Font / ca / CA）
// ---------------------------------------------------------------------------

for (const [name, impl] of IMPLS) {
  test(`#717 ${name}: ExtGState の Font（フォントとサイズを差し替える）で例外にする`, () => {
    // 通すと fontSize が 0 のままになり、グリフ幅が全部 0 → x が 1 点に潰れる（#693 と同じ実害）
    const [fn, args] = opList([...preamble, [OPS.setGState, [[["Font", ["g_d0_f1", 30]]]]], [OPS.showText, glyph("あ")]]);
    assert.throws(() => impl(fn, args, 6), /page 6: unsupported graphics state \(Font\)/);
  });

  for (const [key, value] of [["ca", 0], ["CA", 0], ["ca", 0.5]] as const) {
    test(`#717 ${name}: ExtGState の ${key} ${value}（完全に不透明ではない）で例外にする`, () => {
      const [fn, args] = opList([...preamble, [OPS.setGState, [[["BM", "source-over"], [key, value]]]], [OPS.showText, glyph("あ")]]);
      assert.throws(() => impl(fn, args, 6), new RegExp(`page 6: unsupported graphics state \\(${key} ${value}\\)`));
    });
  }

  test(`#717 ${name}: 実データに出る ExtGState（BM source-over ＋ ca/CA 1）は通す（否定的対照）`, () => {
    // **実測（2026-09-09、フィクスチャ 7 本の setGState 14 回すべて）**: 出たのはこの 2 種類だけ。
    // ここが例外になると、三重の 5 本が丸ごと読めなくなる（下の 6. が実物で示す）。
    const [fn, args] = opList([
      ...preamble,
      [OPS.setGState, [[["BM", "source-over"], ["ca", 1]]]],
      [OPS.setGState, [[["BM", "source-over"], ["CA", 1]]]],
      [OPS.showText, glyph("あ")],
    ]);
    const { items } = impl(fn, args, 6);
    assert.equal(items.length, 1);
    assert.deepEqual([items[0].str, items[0].x, items[0].y], ["あ", 50, 700]);
  });

  test(`#717 ${name}: 知らない ExtGState の鍵（SMask）でも例外にする`, () => {
    // ソフトマスクは文字を部分的に消せる。allowlist なので、知らない鍵は止まる側に落ちる。
    const [fn, args] = opList([...preamble, [OPS.setGState, [[["SMask", true]]]], [OPS.showText, glyph("あ")]]);
    assert.throws(() => impl(fn, args, 6), /page 6: unsupported graphics state \(SMask\)/);
  });
}

// ---------------------------------------------------------------------------
// 5. 既知で危険: setTextRise（Ts）。#707 の担当者が残した宿題
// ---------------------------------------------------------------------------

for (const [name, impl] of IMPLS) {
  test(`#717 ${name}: 0 でない Ts（text rise）で例外にする`, () => {
    // Ts はベースラインを上下にずらす（PDF 32000-1 9.4.3）。見ていないので y がずれる。
    const [fn, args] = opList([...preamble, [OPS.setTextRise, [5]], [OPS.showText, glyph("あ")]]);
    assert.throws(() => impl(fn, args, 7), /page 7: non-zero text rise \(Ts 5\)/);
  });

  test(`#717 ${name}: Ts が 0 なら通す（否定的対照）`, () => {
    const [fn, args] = opList([...preamble, [OPS.setTextRise, [0]], [OPS.showText, glyph("あ")]]);
    const { items } = impl(fn, args, 7);
    assert.deepEqual([items[0].str, items[0].x, items[0].y], ["あ", 50, 700]);
  });
}

// ---------------------------------------------------------------------------
// 6. 既知で無害: 明示的に無視する 11 種類
//    **全部を例外にすると、色を変えただけの PDF で ETL が止まる**（実データに 32,036 回出る）。
//    ここは「無視してよい」ことの否定的対照——広く止めすぎていないかを見る。
// ---------------------------------------------------------------------------

const HARMLESS: [string, number, unknown[]][] = [
  ["setFillRGBColor", OPS.setFillRGBColor, [1, 0, 0]],
  ["setStrokeRGBColor", OPS.setStrokeRGBColor, [0, 0, 1]],
  ["setLineWidth", OPS.setLineWidth, [0.5]],
  ["setLineCap", OPS.setLineCap, [1]],
  ["setLineJoin", OPS.setLineJoin, [1]],
  ["clip", OPS.clip, []],
  ["eoClip", OPS.eoClip, []],
  ["beginMarkedContent", OPS.beginMarkedContent, ["Artifact"]],
  ["beginMarkedContentProps", OPS.beginMarkedContentProps, ["Span", null]],
  ["endMarkedContent", OPS.endMarkedContent, []],
  ["dependency", OPS.dependency, [["g_d0_f1"]]],
];

for (const [name, impl] of IMPLS) {
  for (const [label, op, opArgs] of HARMLESS) {
    test(`#717 ${name}: ${label} は無視して読み進む（止めすぎていないかの否定的対照）`, () => {
      const [fn, args] = opList([...preamble, [op, opArgs], [OPS.showText, glyph("あ")]]);
      const { items } = impl(fn, args, 8);
      assert.equal(items.length, 1, `${label} で文字が読めなくなった`);
      assert.deepEqual([items[0].str, items[0].x, items[0].y], ["あ", 50, 700]);
    });
  }

  test(`#717 ${name}: endText は無視して読み進む（beginText と対になる）`, () => {
    const [fn, args] = opList([...preamble, [OPS.showText, glyph("あ")], [OPS.endText, null]]);
    const { items } = impl(fn, args, 8);
    assert.equal(items.length, 1);
  });
}

// ---------------------------------------------------------------------------
// 7. 実物のフィクスチャで、上の守りが 1 度も発動しないこと
//    **これが無いと、「全部例外にする」実装でも 1.〜5. は全部通る。**
//    ここが落ちたら「実データの Tr は 2 だけ / gs は BM+ca/CA 1 だけ」という前提が崩れた合図。
// ---------------------------------------------------------------------------

const FIXTURES = [
  ["kochi/0706.pdf", readGlyphPageOps],
  ["kochi/0806.pdf", readGlyphPageOps],
  ["mie/001235880.pdf", mieOps],
  ["mie/001242584.pdf", mieOps],
  ["mie/001249930.pdf", mieOps],
  ["mie/001256778.pdf", mieOps],
  ["mie/001263901.pdf", mieOps],
] as const;

for (const [f, impl] of FIXTURES) {
  test(`#717 ${f}: 全ページを実装に通して例外が出ず、文字が読める`, async () => {
    const bytes = readFileSync(new URL(`./fixtures/${f}`, import.meta.url));
    const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
    const doc = await task.promise;
    try {
      let items = 0;
      let trModes: number[] = [];
      let gsKeys = new Set<string>();
      for (let p = 1; p <= doc.numPages; p++) {
        const ops = await (await doc.getPage(p)).getOperatorList();
        for (let i = 0; i < ops.fnArray.length; i++) {
          if (ops.fnArray[i] === OPS.setTextRenderingMode) trModes.push((ops.argsArray[i] as number[])[0]);
          if (ops.fnArray[i] === OPS.setGState) for (const [k] of (ops.argsArray[i] as [string, unknown][][])[0]) gsKeys.add(k);
        }
        // ここが例外を投げたら守りが実データを止めている（＝広すぎる）
        items += impl(ops.fnArray, ops.argsArray, p).items.length;
      }
      assert.ok(items > 0, "文字が 1 つも読めていない（母数が空なら上の「例外が出ない」は何も言っていない）");
      // 実測表の裏取り: Tr の値は 2 だけ、gs の鍵は BM/ca/CA だけ
      assert.deepEqual([...new Set(trModes)].sort(), trModes.length ? [2] : [], `Tr の値が 2 以外になった: ${trModes}`);
      assert.deepEqual([...gsKeys].sort(), gsKeys.size ? ["BM", "CA", "ca"] : [], `gs の鍵が増えた: ${[...gsKeys]}`);
    } finally {
      await task.destroy();
    }
  });
}
