import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { CMAP_DIR, CMAP_PACKED, readGlyphPages } from "../src/sources/local/mie/glyphs.ts";

// Issue #867 B 群のうち「拡大のみ 15 本」。
//
// **Issue は「`b=0, c=0` で `a`/`d` が 1 でないだけ。いちばん易しいはず」と書いていたが、
// 実測では、この 15 本が読めない本当の原因は text matrix ではなかった。**
//
// **原因は Adobe-Japan1 の「あらかじめ定義された CMap」を pdfjs に渡していないことである。**
// この 15 本のフォントは `Encoding` に `UniJIS-UCS2-H` などの **predefined CMap の名前** を書いており、
// pdfjs はその中身を `cMapUrl` から読む。渡していないと `translateFont` が
// **「Ensure that the `cMapUrl` API parameter is provided.」で失敗し、
// そのフォントの showText は「グリフ 0 個の配列」になる**（例外は投げない）。
//
// **ここが危ない**: pdfjs はこのとき **例外を投げずに、文字を黙って落とす。**
// `readGlyphPageOps` は空の配列を受け取っても何も push しないので、
// **「文字が 1 つも無いページ」として静かに通ってしまう**（#569 の「途中まで読んだ表」と同じ形）。
// 幸い実測では 15 本すべてが「全ページ 0 グリフ」なので後段（表題が無い）で止まるが、
// **1 ページだけ CMap の要るフォントを使う PDF なら、そのページだけ空で通る。**
// だから **CMap を渡す**のと **空を検出して止める**のを両方やる。
//
// ---------------------------------------------------------------------------
// 実測（2026-09-19、三重の index 151 本すべてを取得して数えた。母数を書く = #757）
// ---------------------------------------------------------------------------
//
// B 群 35 本を text matrix の形で 3 群に分けると（#835 / Issue #867 の内訳と一致した）:
//
//   ROT   11 本  Tm = [0,±s,∓s,0]        90 度回転
//   SCALE 15 本  Tm = [a,0,0,d] (a,d>0)  拡大のみ
//   FLIP   9 本  Tm = [1,0,0,-1]         上下反転
//
// **CMap 無しで showText のグリフを数えた（35 本すべて）:**
//
//   SCALE 15 本 … **15 本すべてが「全 showText が空配列」**（グリフ 0、getTextContent の items も 0）
//   ROT   11 本 … 空は 2 本（000073596 / 000073607）のみ。9 本はグリフが取れている
//   FLIP   9 本 … 空は 0 本。9 本ともグリフが取れている
//
// **CMap を渡すと 35 本すべてで空 showText が 0 になる**（グリフが取れる）。
// つまり **SCALE 15 本にとって CMap は必要条件**であり、
// **ROT の 2 本にとっても必要**だった（回転だけの問題ではなかった）。
//
// **`cMapUrl` には file:// URL ではなく「ただのディレクトリパス」を渡す**（実測）。
// Node では pdfjs が `NodeBinaryDataFactory` を使い、`fs.readFile(url)` にそのまま渡すので、
// `file://…` を渡すと `Unable to load CMap data at: file:///…` で失敗する（**ネットワークには出ない**）。
// `new URL(..., import.meta.url)` の `.href` を渡してはいけない、ということ。
// **`.pathname` でもなく、`fileURLToPath` で OS のパスに直す。**

const fixture = (n: string) => readFileSync(new URL(`./fixtures/mie/${n}`, import.meta.url));

/** CMap を渡さずに開いたときの「グリフが 1 つも無い showText」の数を数える（pdfjs が黙って落とす形）。 */
async function countEmptyShowText(bytes: Buffer, opts: { cmap: boolean }): Promise<{ show: number; empty: number; glyphs: number }> {
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    ...(opts.cmap ? { cMapUrl: CMAP_DIR, cMapPacked: CMAP_PACKED } : {}),
  });
  const doc = await loadingTask.promise;
  let show = 0;
  let empty = 0;
  let glyphs = 0;
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const ops = await page.getOperatorList();
      for (let k = 0; k < ops.fnArray.length; k++) {
        if (ops.fnArray[k] !== OPS.showText) continue;
        show++;
        const gs = ((ops.argsArray[k] as unknown[])[0] as unknown[]).filter((g) => typeof g !== "number");
        glyphs += gs.length;
        if (gs.length === 0) empty++;
      }
    }
  } finally {
    await loadingTask.destroy();
  }
  return { show, empty, glyphs };
}

// ---------------------------------------------------------------------------
// 1. CMap を渡さないと pdfjs が黙って文字を落とす（この PBI の出発点。例外は出ない）
// ---------------------------------------------------------------------------

test("#867 CMap を渡さないと拡大のみの本は showText が全部「グリフ 0」になる（pdfjs は例外を投げない）", async () => {
  for (const n of ["000073620.pdf", "000073609.pdf"]) {
    const without = await countEmptyShowText(fixture(n), { cmap: false });
    assert.ok(without.show > 0, `${n}: showText が 1 回も無い（フィクスチャが違う）`);
    assert.equal(without.empty, without.show, `${n}: CMap 無しで空でない showText があった（前提が崩れている）`);
    assert.equal(without.glyphs, 0, `${n}: CMap 無しでグリフが取れてしまっている`);
  }
});

test("#867 CMap を渡すと同じ本のグリフが取れる（空の showText が 0 になる）", async () => {
  for (const n of ["000073620.pdf", "000073609.pdf"]) {
    const withCmap = await countEmptyShowText(fixture(n), { cmap: true });
    assert.equal(withCmap.empty, 0, `${n}: CMap を渡しても空の showText が残っている`);
    assert.ok(withCmap.glyphs > 400, `${n}: グリフ数が少なすぎる（${withCmap.glyphs}）`);
  }
});

// ---------------------------------------------------------------------------
// 2. CMap ディレクトリの渡し方（file:// URL では読めない。実測で踏んだ罠）
// ---------------------------------------------------------------------------

test("#867 CMAP_DIR は file:// URL ではなく OS のパスで、実際に bcmap が置いてある", () => {
  assert.ok(!CMAP_DIR.startsWith("file:"), `CMAP_DIR が file:// URL になっている（Node の fs.readFile が読めない）: ${CMAP_DIR}`);
  assert.ok(CMAP_DIR.endsWith("/"), `CMAP_DIR は末尾 / が要る（pdfjs が名前を連結する）: ${CMAP_DIR}`);
  assert.equal(CMAP_PACKED, true);
  // この 2 つは三重の 15 本が実際に要求した名前（実測の警告文から取った）
  for (const name of ["Adobe-Japan1-UCS2.bcmap", "UniJIS-UCS2-H.bcmap"]) {
    assert.doesNotThrow(() => readFileSync(CMAP_DIR + name), `${name} が CMAP_DIR に無い`);
  }
});

// ---------------------------------------------------------------------------
// 3. 空のページを黙って通さない（CMap の読み込みが将来また壊れたときの受け皿）
// ---------------------------------------------------------------------------

test("#867 文字が 1 つも取れなかったページは例外にする（黙って空の表を返さない）", async () => {
  // 罫線だけで文字の無い PDF は手元に無いので、CMap を渡さない読み方を再現して当てる。
  // readGlyphPages は CMap を渡すので、ここでは「渡さない場合」の pdfjs の挙動を確かめたうえで、
  // 実装側が空ページを検出することを、オペレータ列を直接渡して固定する。
  const { readGlyphPageOps } = await import("../src/sources/local/mie/glyphs.ts");
  const fn = [OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText];
  const args: unknown[] = [null, ["f1", 8], [1, 0, 0, 1, 100, 700], [[]], null];
  assert.throws(() => readGlyphPageOps(fn, args, 1), /no glyphs/, "グリフ 0 のページが黙って通った");
});

// ---------------------------------------------------------------------------
// 4. 拡大のみの text matrix を読む（Tf のサイズが 1 で、Tm が大きさを持つ）
// ---------------------------------------------------------------------------

test("#867 拡大のみの本が丸ごと読める（readGlyphPages が例外を投げない）", async () => {
  for (const n of ["000073620.pdf", "000073609.pdf"]) {
    const pages = await readGlyphPages(fixture(n));
    assert.ok(pages.length >= 1, `${n}: ページが 0`);
    const items = pages.reduce((a, p) => a + p.items.length, 0);
    assert.ok(items > 100, `${n}: アイテムが少なすぎる（${items}）`);
  }
});

/**
 * **拡大のみの本は `parseVotePdf` が最後まで読めない**（記号が 1 行 1 アイテムで、セルに割れない）ので、
 * **この 2 本の座標は `mie-vote-alignment.test.ts` の検算を 1 つも通らない。**
 * **実測で分かったこと**: `sx` を掛ける行を消しても、県ごとのテストは **1 件も落ちなかった**
 * （分類③「検算が空回り」——座標は変わるのに、誰もこの本の座標を見ていない）。
 * **だから、この本の座標そのものをここで固定する。**
 *
 * **数は実物から取り、1 つずつ意味を書く**（`000073620.pdf`、`Tf` サイズ 1 / `Tm` 8.039999961853027）:
 *   表題は **1 つの showText**（23 文字）で、**幅 294.00pt / 高さ 13.20pt**。
 *   **`sx` を掛けないと幅が 1/8 の 36.6pt に潰れ、`sy` を掛けないと高さが 1.64pt になる。**
 *   **潰れた幅で列を割ると、記号が別の議員の列に入る**（#693 と同じ実害）。
 */
test("#867 拡大のみの本の文字が、拡大後のページ座標に並ぶ（sx/sy を掛けていることを座標で固定する）", async () => {
  const p = (await readGlyphPages(fixture("000073620.pdf")))[0];
  const top = Math.max(...p.items.map((i) => i.cy));
  const line = p.items.filter((i) => Math.abs(i.cy - top) < 3).sort((a, b) => a.x - b.x);
  assert.equal(line.map((i) => i.str).join(""), "平成２３年第１回定例会（２月）議案等の審議結果");
  const title = line[0];
  // **幅**: 23 文字ぶん。**`sx` を掛けないと 36.6pt に潰れる**ので、下限を 200pt に置く
  assert.ok(title.w > 200 && title.w < 400, `表題の幅が拡大後になっていない（w=${title.w.toFixed(2)}。sx を掛けていない可能性）`);
  // **高さ**: `fontSize(1) * sy(8.04) * 1.642…` ではなく `fontSize * sy`。**掛けないと 1.64pt**
  assert.ok(title.h > 7 && title.h < 20, `表題の高さが拡大後になっていない（h=${title.h.toFixed(2)}。sy を掛けていない可能性）`);
  // **中心**: 幅から導くので、幅が潰れると中心も左へ寄る（列の割り当てが狂う経路そのもの）
  assert.ok(Math.abs(title.cx - (title.x + title.w / 2)) < 1e-6);
  // **本文の記号帯まで含めて、ページの右端近くまで文字が広がっている**
  // （`sx` を掛けないと、ページ幅 1190pt の左端 1/8 の帯に全部が固まる）
  const maxX = Math.max(...p.items.map((i) => i.x + i.w));
  assert.ok(maxX > 600, `ページの右半分に文字が 1 つも無い（maxX=${maxX.toFixed(1)}。sx を掛けていない可能性）`);
});

// ---------------------------------------------------------------------------
// 5. **読まないと決めた形は、止まることを検査にする**（#569。黙って読み間違えないため）
// ---------------------------------------------------------------------------

/**
 * **この 3 つの検査が無いと、対応しないと決めた 2 群（回転 11 本・上下反転 9 本）が
 * 「拡大のみ」の枝に落ちて、黙って読まれてしまう。**
 *
 * **実測（2026-09-19、`mutate.sh run`）: 3 つの `throw` をそれぞれ殺しても、
 * 県ごとの PDF テストは 1 件も落ちなかった**（分類④「狙った主張でない」——
 * **committed のフィクスチャに回転も反転も 1 本も無かった**）。
 * **B 群の 35 本はどれもフィクスチャに入れていない**（回転・反転は本 PR で対応しないため）ので、
 * **オペレータ列を直接渡して固定する**（`local-glyphs-ctm.test.ts` と同じやり方）。
 *
 * **行列の値は実物から取った**（2026-09-19、index 151 本の実測）:
 *   回転     `[0,8.039999961853027,-8.039999961853027,0]`（`000073610.pdf` など 11 本）
 *   上下反転 `[1,0,0,-1]`（`001088734.pdf` など 9 本）
 *   異方拡大 実データには無い（**a と d の差は最大でも a の 0.1%**）。
 *            **無いからこそ「来たら止める」を検査で固定する**（読み方を検証できないものは出さない。#707）。
 */
const showOps = (matrix: number[]): [number[], unknown[]] => [
  [OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText],
  [null, ["f1", 1], matrix, [[{ unicode: "○", width: 1000 }]], null],
];

test("#867 回転した text matrix は例外（対応しない 11 本が黙って読まれないこと）", async () => {
  const { readGlyphPageOps } = await import("../src/sources/local/mie/glyphs.ts");
  const [fn, args] = showOps([0, 8.039999961853027, -8.039999961853027, 0, 100, 700]);
  assert.throws(() => readGlyphPageOps(fn, args, 1), /rotated text matrix/);
});

test("#867 上下反転した text matrix は例外（対応しない 9 本が黙って読まれないこと）", async () => {
  const { readGlyphPageOps } = await import("../src/sources/local/mie/glyphs.ts");
  const [fn, args] = showOps([1, 0, 0, -1, 670.88, 98.56]);
  assert.throws(() => readGlyphPageOps(fn, args, 1), /flipped text matrix/);
});

test("#867 縦横で倍率の違う text matrix は例外（実データに無い形を推測で読まない）", async () => {
  const { readGlyphPageOps } = await import("../src/sources/local/mie/glyphs.ts");
  const [fn, args] = showOps([8, 0, 0, 4, 100, 700]);
  assert.throws(() => readGlyphPageOps(fn, args, 1), /anisotropic text matrix/);
  // **実データの揺れ（0.1%）は通る**——ここを厳しくすると拡大のみの 15 本が落ちる
  const [fn2, args2] = showOps([8.039859771728516, 0, 0, 8.032349586486816, 100, 700]);
  assert.doesNotThrow(() => readGlyphPageOps(fn2, args2, 1));
});
