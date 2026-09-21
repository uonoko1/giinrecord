import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { CMAP_DIR, CMAP_PACKED } from "../src/sources/local/pdf-cmap.ts";
import { readPages } from "../src/sources/local/pdf-table.ts";
import { readGlyphPages } from "../src/sources/local/kochi/glyphs.ts";
import { extractPdfText } from "../src/sources/districts/pdf-text.ts";

// Issue #922。**#921 は三重の glyphs.ts にだけ CMap を渡した。`getDocument` は 4 か所ある。**
//
//   src/sources/districts/pdf-text.ts:14      （県ではない。区域 PDF）
//   src/sources/local/pdf-table.ts:121        ← **11 県のうち 9 県がここを通る**
//   src/sources/local/kochi/glyphs.ts:24
//   src/sources/local/mie/glyphs.ts:32        ← #921 で対応済み
//
// **`glyphs.ts` を持つのは高知と三重だけ**（実測。他 9 県は `pdf-table.ts` の `readPages` を通る）。
//
// ---------------------------------------------------------------------------
// 実測（2026-09-19、フィクスチャ 87 本すべて。母数を書く = #757）
// ---------------------------------------------------------------------------
//
// **空の showText が 1 回でもあったのは滋賀だけ**（6 本中 4 本）。
// 他の 10 県と districts は **CMap の有無で showText・空・グリフが 1 つも動かなかった**
// （「0 回だった」であって「数えていない」ではない）:
//
//   県          本数  空の本数 |  空_CMap無し → 空_CMap有り |  グリフ無し → 有り
//   akita         6      0     |      0 →   0             |   29960 → 29960
//   aomori        5      0     |      0 →   0             |   23837 → 23837
//   kochi         4      0     |      0 →   0             |   14736 → 14736
//   mie          20      0     |      0 →   0             |   （#921 で対応済み）
//   miyagi        8      0     |      0 →   0             |   49466 → 49466
//   nara          2      0     |      0 →   0             |   12056 → 12056
//   saga          8      0     |      0 →   0             |   17296 → 17296
//   shiga         6      4     |    732 →  21             |    6775 →  7549
//   shimane      14      0     |      0 →   0             |   60899 → 60899
//   tokushima    10      0     |      0 →   0             |   18935 → 18935
//   tottori       5      0     |      0 →   0             |   23609 → 23609
//   districts     1      0     |      0 →   0             |     236 →   236
//
// **CMap を渡しても空が 21 回残る**（3 本に 8/7/6 回）。**グリフ数は変わらないので別の原因である。**
//
// **その 21 回が何かは #927 で測り終えた**（`test/shiga-empty-showtext.test.ts` に全部書いてある）:
// **21 回とも「消えてよい空」で、PDF が自分で「中身の無い文字列」を描いている**
// （原文に `<>Tj` / `[<>]TJ` が 8/7/6 回＝ちょうど 21 回あり、**pdfjs の数えた空と 1 回ずつ一致する**）。
// **落ちたグリフは 1 つも無く、票は 1 つも消えていない**（3 本 8 行の ○ × の数が、
// PDF の刷っている賛成数・反対数と全行で一致する）。**CMap を渡せば空が 0 になる、とは今も書けない。**
//
// **`Kg265_250424` は画像 PDF ではなかった。** votes-pdf.ts は 3 本を「文字層なし・画像 PDF・
// 読めないのが正しい結果」と書いていたが、**実測では 3 本のうち 2 本に文字層がある**
// （`Kg265` と `Kg274`。CMap 未指定で全部消えていた）。**`Kg337` だけが本当に文字層を持たない**
// （showText が 0 回。中身は `constructPath` 820 個の図形だけ）。
//
// **本番のデータが CMap で変わるわけではない**（`--sessions 2` の既定で 2026 年の 2 会期しか
// 取りに行っておらず、この 3 本はどれもその範囲に無い）。**「読めない」と「取りに行っていない」は別の話。**

const fixture = (pref: string, n: string) => readFileSync(new URL(`./fixtures/${pref}/${n}`, import.meta.url));

/** 「グリフが 1 つも無い showText」を数える（pdfjs が黙って文字を落とす形）。 */
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
// 1. 両方向で固定する（#921 の形）。**片方向だけでは前提が崩れたときに気づけない**
// ---------------------------------------------------------------------------

test("#922 滋賀の Kg265/Kg274 は CMap を渡さないと showText が全部「グリフ 0」になる（例外は出ない）", async () => {
  for (const n of ["Kg265_250424-sanpi.pdf", "Kg274_250628-sanpi.pdf"]) {
    const without = await countEmptyShowText(fixture("shiga", n), { cmap: false });
    assert.ok(without.show > 0, `${n}: showText が 1 回も無い（フィクスチャが違う）`);
    // **この 2 本は「読めなかった」のではなく「空の表が読めた」**（#569）。例外は 1 つも出ない。
    assert.ok(without.empty > 700, `${n}: CMap 無しで空の showText が ${without.empty} 回しかない（前提が崩れている）`);
  }
});

test("#922 CMap を渡すと同じ 2 本の空の showText が 0 になり、グリフが取れる", async () => {
  for (const n of ["Kg265_250424-sanpi.pdf", "Kg274_250628-sanpi.pdf"]) {
    const withCmap = await countEmptyShowText(fixture("shiga", n), { cmap: true });
    assert.equal(withCmap.empty, 0, `${n}: CMap を渡しても空の showText が残っている`);
    assert.ok(withCmap.glyphs > 700, `${n}: グリフ数が少なすぎる（${withCmap.glyphs}）`);
  }
});

// ---------------------------------------------------------------------------
// 2. **公開の入口（readPages）が CMap を渡していること**を固定する。
//    上の 1 は pdfjs を直に叩いているので、**実装が CMap を渡し忘れても落ちない。**
//    ここが落ちなければ「直した」と言えない。
// ---------------------------------------------------------------------------

test("#922 readPages（11 県のうち 9 県が通る）は CMap を渡すので、Kg265 の文字が読める", async () => {
  const pages = await readPages(fixture("shiga", "Kg265_250424-sanpi.pdf"));
  assert.equal(pages.length, 1);
  const items = pages[0].items;
  // CMap を渡していなければ items は 0 個になる（getTextContent が何も返さない）
  assert.ok(items.length > 200, `items が ${items.length} 個しかない（CMap を渡していない？）`);
  const text = items.map((it) => it.str).join("");
  // 一次資料に実在する文字列（議長辞職の件の行と、議員の氏名）
  assert.ok(text.includes("議長辞職の件"), "「議長辞職の件」が読めていない");
  assert.ok(text.includes("佐野高典"), "議員名「佐野高典」が読めていない");
});

test("#922 kochi の readGlyphPages も CMap を渡す（高知のフィクスチャは空 0 だが、渡し忘れを固定する）", async () => {
  // **高知の 4 本は CMap の有無で 1 つも変わらなかった**（空 0、グリフ 14736 で一致）。
  // **だから「出力が変わらないこと」しか assert できない。** 渡していること自体は
  // 下の「3. 渡し忘れの検出」で、CMap を要求する本を使って固定する。
  const pages = await readGlyphPages(fixture("kochi", "0706.pdf"));
  assert.ok(pages.length > 0);
  assert.ok(pages.some((p) => p.items.length > 0), "高知のグリフが 1 つも取れていない");
});

// ---------------------------------------------------------------------------
// 3. **渡し忘れを検出する**: CMap を要求する本を、各入口に通す。
//    `pdf-table.ts` / `kochi/glyphs.ts` / `districts/pdf-text.ts` の 3 か所ぶん。
// ---------------------------------------------------------------------------

// **高知の入口だけは「CMap を渡していること」をテストで固定できない**（#922 の変異テストで判明）。
//
// **理由**: 高知の `readGlyphPageOps` は **text matrix が単位行列でなければ即座に例外**を投げる
// （`a !== 1 || b !== 0 || c !== 0 || d !== 1`。#707 の「黙って読み間違えない」）。
// **この検査はグリフを 1 つも見ずに済む。**
// 一方、**CMap を要求する本は手元に 4 本あるが、4 本とも text matrix が単位行列ではない**（実測）:
//   mie/000073609 `[5.16,0,0,5.15]`・mie/000073620 `[8.04,0,0,8.04]`（拡大のみ）
//   shiga/Kg265・shiga/Kg274 `[0,6.96,-6.96,0]`（回転）
// **つまり、どの本を高知の入口に通しても、CMap の有無にかかわらず同じ例外で終わる。**
// **「CMap を外しても落ちないテスト」しか書けない**ので、書かない
// （**通るだけのテストを置くと、渡し忘れを見つけたつもりになる**）。
//
// **代わりに、静的に固定する**——4 か所すべてが同じ `CMAP_OPTIONS` を使っていることを、原文で確かめる。
// これは実行時の振る舞いではないが、**渡し忘れ（1 か所だけ直す）は確実に捕まえる**。
test("#922 getDocument を呼ぶ 4 か所すべてが CMAP_OPTIONS を渡している（原文で確かめる）", () => {
  const sites = [
    "../src/sources/districts/pdf-text.ts",
    "../src/sources/local/pdf-table.ts",
    "../src/sources/local/kochi/glyphs.ts",
    "../src/sources/local/mie/glyphs.ts",
  ];
  let seen = 0;
  for (const rel of sites) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    // `getDocument({ ... })` の中身を取り出す（1 ファイルに 1 か所しか無いことも確かめる）
    const calls = [...src.matchAll(/getDocument\(\{([\s\S]*?)\}\)/g)];
    assert.equal(calls.length, 1, `${rel}: getDocument の呼び出しが ${calls.length} か所（1 か所のはず）`);
    assert.match(calls[0][1], /\.\.\.CMAP_OPTIONS/, `${rel}: getDocument に CMAP_OPTIONS を渡していない`);
    seen++;
  }
  // **母数を検算に入れる**（#757）。4 か所を数えたことを固定する
  assert.equal(seen, 4, "getDocument の呼び出し箇所が 4 か所ではない（増えたなら CMap を渡したか確かめる）");
});

test("#922 extractPdfText（districts）に CMap を要求する本を通すと、文字が取れる（渡し忘れなら空になる）", async () => {
  const text = await extractPdfText(fixture("shiga", "Kg265_250424-sanpi.pdf"));
  assert.ok(text.replace(/\s/g, "").length > 500, `districts/pdf-text.ts が CMap を渡していない（${text.replace(/\s/g, "").length} 文字）`);
  assert.ok(text.includes("議長辞職の件"), "「議長辞職の件」が読めていない");
});

// ---------------------------------------------------------------------------
// 4. **本当に文字層が無い本**は、CMap を渡しても読めないままである（推定で埋めない）
// ---------------------------------------------------------------------------

test("#922 Kg337 は showText が 0 回で、CMap を渡しても読めない（本当に文字層が無い唯一の本）", async () => {
  // **フィクスチャには足していない**（showText が 0 回なので CMap では 1 文字も変わらず、
  // 足しても固定できることが無い。実測値だけ残す）。
  // Kg337_sanpi-261127.pdf: showText 0 回 / 空 0 回 / グリフ 0、ops は constructPath 820 個のみ。
  // ここでは「文字層のある 2 本」との対比だけ固定する。
  const on = await countEmptyShowText(fixture("shiga", "Kg265_250424-sanpi.pdf"), { cmap: true });
  assert.ok(on.show > 0, "Kg265 に showText が無い（対比が成り立たない）");
});
