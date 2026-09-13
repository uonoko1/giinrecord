import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  columnOf, findNameBand, fillLatticeGaps, isSingleGlyph, legendOf, parseLegend, parseVotePdf,
  readVoteCells, splitRowItem, trailingVoteSymbols, trimUnevenEnds, unrotate, UNKNOWN_CELL, UNKNOWN_LEGEND,
  type NameBand,
} from "../src/sources/local/aomori/votes-pdf.ts";
import { readPages, type Item } from "../src/sources/local/pdf-table.ts";

const pdf = (name: string) => readFileSync(fileURLToPath(new URL(`fixtures/aomori/${name}.pdf`, import.meta.url)));

/**
 * **フィクスチャ 5 本で、青森の作りの違いを全部覆う**（#743 が 56 本で数えた種類）:
 *   `314teirei_sanpi`        1 文字 1 アイテム型・罫線あり・**`櫛`+IVS**（#749 の機序 ①）
 *   `279_26.9_giketsukekka`  行アイテム型・**`/Rotate 90`**・**`継続審査` の行**
 *   `322teirei_sanpi`        行アイテム型・**罫線が 1 本も無い**・**`噰` に化ける**（機序 ③）・**左端の stray な `議`**
 *   `276_25.11_giketsukekka` **記号帯が 2 アイテムに割れる**（39/46 行）・**凡例に無い `-`**・`/Rotate 90`
 *   `300teirei_sanpi`        **`櫛` が文字層に無く、列が 1 つ欠ける**（機序 ②）
 */
const FIXTURES = ["314teirei_sanpi", "279_26.9_giketsukekka", "322teirei_sanpi", "276_25.11_giketsukekka", "300teirei_sanpi"] as const;

/** 凡例は 56 本すべてで 1 字も変わらない（#743 が 13 年ぶんで確かめた） */
const LEGEND = { "○": "賛成", "×": "反対", "議": "議長", "副": "副議長が議長の職務を代理", "除": "除斥", "欠": "欠席", "退": "退席" };

test("#750 parseVotePdf: 5 本の形が違っても、議員の列・行・記号がそろう", async () => {
  const want = [
    { f: "314teirei_sanpi", members: 48, rows: 21, pages: 1, rot: 0, ruleless: 0, year: 2023, month: 7, round: 314 },
    { f: "279_26.9_giketsukekka", members: 46, rows: 24, pages: 2, rot: 2, ruleless: 0, year: 2014, month: 9, round: 279 },
    { f: "322teirei_sanpi", members: 48, rows: 23, pages: 1, rot: 0, ruleless: 1, year: 2025, month: 6, round: 322 },
    { f: "276_25.11_giketsukekka", members: 47, rows: 46, pages: 2, rot: 2, ruleless: 0, year: 2013, month: 11, round: 276 },
    { f: "300teirei_sanpi", members: 47, rows: 46, pages: 2, rot: 0, ruleless: 0, year: 2019, month: 11, round: 300 },
  ];
  for (const w of want) {
    const p = await parseVotePdf(pdf(w.f));
    assert.equal(p.members.length, w.members, `${w.f}: 議員の列`);
    assert.equal(p.rows.length, w.rows, `${w.f}: 議案の行`);
    assert.equal(p.pages, w.pages, `${w.f}: ページ`);
    assert.equal(p.rotatedPages, w.rot, `${w.f}: /Rotate 90 のページ`);
    assert.equal(p.ruleless, w.ruleless, `${w.f}: 縦罫線の無いページ`);
    assert.equal(p.year, w.year, `${w.f}: 見出しの年`);
    assert.equal(p.month, w.month, `${w.f}: 見出しの月`);
    assert.equal(p.round, w.round, `${w.f}: 見出しの回次`);
    // **不明セルが 0**（推定していない、ではなく「置けている」）
    assert.equal(p.unknownCells, 0, `${w.f}: 不明セル`);
    assert.deepEqual(p.legend.votes, LEGEND, `${w.f}: 凡例`);
    assert.equal(p.legend.notes.length, 3, `${w.f}: 凡例 1 行 + 注記 2 行（**2 行目は \`注\` で始まらない**）`);
    // **氏名が空の列が無い**（#718 の「静かに消える議員」を作っていない）
    assert.deepEqual(p.members.filter((m) => m.nameText === ""), [], `${w.f}: 氏名の空の列`);
  }
});

/**
 * **k 番目の記号が k 番目の議員のものか**（#743 が 56 本 113,911 対で測ったのと同じ検算）。
 *
 * **記号の実 x と、その列の氏名文字の中心 x（平均）の差**を見る。**列番号を経由しない**ので、
 * **記号だけを 1 列回せば差は 1 セルぶんになる。**
 *
 * **「記号の個数 ＝ 列の数」や「賛成者数と一致する」は恒真である**（#529 が実測し、#743 が 4 つ潰した）——
 * **1 列ずらしても通る。** だからこの形で測る。
 *
 * **回転にしてある**（端を空ける「ずらし」だと「空の列に落ちた」という安い理由で落ちる。#705）。
 */
const measure = async (rot: number) => {
  let pages = 0, rows = 0, pairs = 0, over = 0, noName = 0;
  let maxRatio = 0;
  for (const f of FIXTURES) {
    const p = await parseVotePdf(pdf(f));
    const raw = (await readPages(pdf(f))).map(unrotate);
    let band: NameBand | undefined;
    for (const page of raw) {
      const b = findNameBand(page);
      if (b && !band) band = b;
      if (!band) continue;
      pages++;
      const n = band.cols.length - 1;
      const cellW = (band.cols[n] - band.cols[0]) / n;
      const nameCx: (number | undefined)[] = [];
      for (let c = 0; c < n; c++) {
        const xs = page.items
          .filter((i) => isSingleGlyph(i.str) && !"○×議副除欠退-".includes(i.str.replace(/[\u{E0100}-\u{E01EF}]/gu, ""))
            && i.cx >= band!.cols[c] && i.cx < band!.cols[c + 1] && i.cy >= band!.bottom - 0.5 && i.cy <= band!.top + 0.5)
          .map((i) => i.cx);
        nameCx.push(xs.length ? xs.reduce((a, b2) => a + b2, 0) / xs.length : undefined);
      }
      const symItems = page.items.filter((i) => trailingVoteSymbols(i.str).length > 0 && i.x + i.w > band!.left && i.cx < band!.right);
      const bands: { cy: number; h: number; items: Item[] }[] = [];
      for (const it of [...symItems].sort((a, b2) => b2.cy - a.cy)) {
        const last = bands[bands.length - 1];
        if (last && Math.abs(last.cy - it.cy) <= Math.max(it.h, last.h, 1) * 0.5) last.items.push(it);
        else bands.push({ cy: it.cy, h: it.h, items: [it] });
      }
      for (const r of bands.filter((b2) => b2.items.reduce((s, i) => s + trailingVoteSymbols(i.str).length, 0) >= 10)) {
        const marks: { cx: number; ch: string }[] = [];
        for (const it of r.items) {
          const cs = trailingVoteSymbols(it.str);
          if (cs.length === 1 && isSingleGlyph(it.str)) marks.push({ cx: it.cx, ch: cs[0] });
          else marks.push(...splitRowItem(it));
        }
        marks.sort((a, b2) => a.cx - b2.cx);
        if (marks.length !== n) continue;
        rows++;
        const xs = marks.map((m) => m.cx);
        for (let k = 0; k < n; k++) {
          const cx = xs[((k - rot) % n + n) % n];
          const nx = nameCx[k];
          if (nx === undefined) { noName++; continue; }
          pairs++;
          const d = Math.abs(cx - nx) / cellW;
          if (d > maxRatio) maxRatio = d;
          if (d >= 0.5) over++;
        }
      }
    }
  }
  return { pages, rows, pairs, over, noName, maxRatio };
};

test("#750 k 番目の記号は k 番目の議員のもの（x で照合。列番号を経由しない）", async () => {
  const r = await measure(0);
  // **母数も判定に入れる**（#705／#718／#748 で 3 回出た罠。`over` が 0 のままでも対が減れば落ちる）
  assert.equal(r.pages, 8, "ページ");
  assert.equal(r.rows, 160, "行");
  assert.equal(r.pairs, 7_540, "(記号, 議員) の対");
  assert.equal(r.noName, 0, "氏名の無い列に落ちた記号");
  assert.equal(r.over, 0, "差が半セル以上の対");
  // **「半セル」という閾値そのものは守られていない**（#748 の変異 14）。守っているのは分布である
  assert.ok(r.maxRatio < 0.29, `差の最大が 0.29 セルを超えた（${r.maxRatio.toFixed(4)}）`);
});

test("#750 この検算は順序不変ではない（記号だけを回すと全部落ちる）", async () => {
  for (const rot of [1, -1, 2]) {
    const r = await measure(rot);
    // **対の数は回しても同じ**（回転なので母数が減らない）。**その上で全部落ちる**
    assert.equal(r.pairs, 7_540, `${rot} 列回しても対の数は同じ`);
    assert.equal(r.over, 7_540, `${rot} 列回して落ちない対がある＝この検算は順序不変`);
  }
});

/**
 * **#743 の問題 1**: 議員の帯（x ≈ 335〜780）の**はるか左**（x ≈ 30〜60）に単独の `議` が立つ。
 * **拾うと全員が 1 列ずれる**（56 本で半セル以上 109,482 / 113,408 対、差の中央 2.00 セル）。
 * **しかも「数は合う」**（`○` の個数と「賛成者数」の突き合わせは通る。#529 が実測）。
 */
test("#750 左端の 1 文字 `議` を議員の票として拾わない（拾うと表が丸ごと 1 列ずれる）", async () => {
  const raw = (await readPages(pdf("322teirei_sanpi"))).map(unrotate);
  const band = findNameBand(raw[0])!;
  const stray = raw[0].items.filter((i) => i.str === "議" && i.cx < band.left);
  assert.equal(stray.length, 3, "左端の stray な `議` が 3 個実在する（実測）");
  assert.ok(stray.every((i) => i.cx < 40), `stray は x < 40 に立つ: ${stray.map((i) => i.cx.toFixed(1)).join(",")}`);
  assert.ok(band.left > 300, `議員の帯の左端は 300pt より右: ${band.left.toFixed(1)}`);
  // **拾っていないこと**: 各行の記号の数が議員の列の数と一致し、不明セルが 0
  const p = await parseVotePdf(pdf("322teirei_sanpi"));
  assert.equal(p.unknownCells, 0);
  // 各行に `議` は 1 つだけ（stray を拾えば 2 つになるか、1 列ずれる）
  for (const r of p.rows) assert.equal(r.cells.filter((c) => c === "議").length, 1, `${r.number}: 議 が 1 つでない`);
});

/**
 * **#743 の問題 4**: **行アイテム型を等分すると 8,155 個ずれる**（56 本で実測。
 * 第290回で送り幅 9.155pt 対 実際の列の間隔 9.393pt）。
 * **採るのは「半角（ASCII。数字・空白）は全角の半分の送り幅」**というモデルで、
 * **アイテム自身の文字列と `w` だけから決まる**（氏名の x を使っていないので循環しない）。
 */
test("#750 splitRowItem: 半角は全角の半分の送り幅（等分ではない）", () => {
  // 記号 3 個・空白 2 個・末尾に賛成者数 `45`（＝半角 4 個）
  const it: Item = { str: "○ ○ ○ 45", x: 100, y: 0, w: 100, h: 10, cx: 150, cy: 5 };
  const marks = splitRowItem(it);
  assert.deepEqual(marks.map((m) => m.ch), ["○", "○", "○"]);
  // 8 文字 ＝ 全角 3（○○○）＋ 半角 5（空白 3・数字 2）。単位数 = 3 + 5×0.5 = 5.5 → 1 単位 100/5.5 = 18.1818pt。
  // 中心は 109.09 / 136.36 / 163.64（記号 + 空白 = 1.5 単位 = 27.27pt 間隔）
  assert.deepEqual(marks.map((m) => Math.round(m.cx * 100) / 100), [109.09, 136.36, 163.64]);
  assert.equal(Math.round((marks[1].cx - marks[0].cx) * 100) / 100, 27.27, "記号 + 空白 = 1.5 単位");
  // **等分（全部同じ幅）なら 1 文字 100/8 = 12.5pt で、間隔は 25pt**。同じにならない
  assert.notEqual(Math.round((marks[1].cx - marks[0].cx) * 100) / 100, 25);
});

test("#750 trailingVoteSymbols: 末尾の賛成者数は読み飛ばす・凡例と件名は 0 個", () => {
  assert.deepEqual(trailingVoteSymbols("○ ○ 議 ○ 45"), ["○", "○", "議", "○"]);
  assert.deepEqual(trailingVoteSymbols("○ ○ ○"), ["○", "○", "○"]);
  // **凡例の行**（`…「退」は退席`）は `席` で終わるので 0 個
  assert.deepEqual(trailingVoteSymbols("賛否欄：「○」は賛成、「×」は反対、「議」は議長、「副」は副議長が議長の職務を代理、「除」は除斥、「欠」は欠席、「退」は退席"), []);
  // **議案の件名**（`…特別委員会設置動議`）は `議` で終わるので記号に見える——
  // **落としているのは x の範囲であって、この関数ではない**（ここでは拾う、が正しい）
  assert.deepEqual(trailingVoteSymbols("特別委員会設置動議"), ["議"]);
  // 記号より前の数字は読み飛ばさない（`第1号` が記号に見えない）
  assert.deepEqual(trailingVoteSymbols("第 1 号"), []);
});

/**
 * **#749 の機序 ①**: **`櫛`+U+E0101 は 2 コードポイント**なので `[...str].length === 1` で落ちる。
 * **56 本中 12 本・29 列で氏名が `引ユキ子` になる**（#749 の対照で 35 → 6 に減ることが測定済み）。
 * **`引ユキ子` は `nonNameCharacters`・`conflictingRosterNames`・`unmatchedReason` の
 * 3 つすべてを素通りする**——**氏名が静かに 1 文字欠ける**、利用者から検出できない壊れ方。
 */
test("#750 isSingleGlyph: 異体字セレクタを除いてから 1 文字か数える（櫛+IVS）", () => {
  assert.equal(isSingleGlyph("櫛"), true);
  assert.equal(isSingleGlyph("櫛\u{E0101}"), true, "IVS 付きも 1 文字");
  assert.equal([..."櫛\u{E0101}"].length, 2, "素朴に数えると 2（＝落ちる）");
  assert.equal(isSingleGlyph("引ユ"), false);
  assert.equal(isSingleGlyph("︀"), false, "セレクタだけなら 0 文字");
});

test("#750 IVS 付きの `櫛` が氏名に残る（機序 ①）", async () => {
  const p = await parseVotePdf(pdf("314teirei_sanpi"));
  const k = p.members.find((m) => m.nameText.includes("ユキ子"));
  assert.ok(k, "ユキ子 の列が無い");
  assert.equal([...k.nameText].map((c) => c.codePointAt(0)!.toString(16)).join(" "), "6adb e0101 20 5f15 20 30e6 30ad 5b50",
    "櫛(U+6ADB)+IVS(U+E0101) が残っている＝1 文字目が落ちていない");
});

/**
 * **#749 の機序 ③**: **`櫛` が `噰`（U+5670）に化ける**（第322〜325回の 4 本）。
 * **幅も位置も正常**なので、列は正しい。**別の字として残す**——
 * **`噰` を `櫛` に戻さない**（推定であり別人の記録を作る側。#569／#674）。
 * **名簿と 1 文字違いなので `sourceConflict` で捕まる**（`aomori-rollcalls.test.ts`）。
 */
test("#750 化けた `噰` を `櫛` に戻さない（機序 ③）", async () => {
  const p = await parseVotePdf(pdf("322teirei_sanpi"));
  const k = p.members.find((m) => m.nameText.includes("ユキ子"));
  assert.ok(k);
  assert.equal(k.nameText, "噰 引 ユキ子", "原文のまま（戻していない）");
  assert.equal("噰".codePointAt(0), 0x5670);
});

/**
 * **#749 の機序 ②**: **`櫛` が文字層に無い**（第300・301回。`w=0` のアイテムすら無い）。
 * **氏名の 1 文字目が 1 列ぶん欠けるので、列を氏名から作ると 46 列**になるが、**記号は 47 個ある。**
 * **数が合わないので全セルが `不明` に落ち、さらに列が 1 つ詰まって右の議員の氏名が隣とまざる**
 * （実測: `山 谷 清ユキ文` `夏 引堀 浩 子一` という、**どちらの議員でもない氏名**ができた）。
 *
 * **戻すのは「列がそこにある」という幾何だけで、氏名は戻さない。**
 */
test("#750 1 列ぶん空いた所に列を戻す（中身は戻さない。機序 ②）", async () => {
  const p = await parseVotePdf(pdf("300teirei_sanpi"));
  assert.equal(p.members.length, 47, "記号の個数と同じ 47 列");
  assert.equal(p.unknownCells, 0, "数が合うので全セルが置ける");
  const k = p.members.find((m) => m.nameText.includes("ユキ子"));
  assert.ok(k);
  // **`櫛` は戻していない**（文字層に無いものを作らない）
  assert.equal(k.nameText, "引 ユキ子");
  // **隣の議員の氏名がまざっていない**（列が詰まっていない証拠）
  assert.ok(p.members.some((m) => m.nameText === "山 谷 清 文"), "山谷清文 が正しく読めている");
  assert.ok(p.members.some((m) => m.nameText === "夏 堀 浩 一"), "夏堀浩一 が正しく読めている");
});

test("#750 fillLatticeGaps: 2.00 倍の隙間にだけ戻す（幅 0 の字のずれには戻さない）", () => {
  // 等間隔 10 の並びで、1 つ欠けている（20 の隙間）
  assert.deepEqual(fillLatticeGaps([0, 10, 30, 40, 50]), [0, 10, 20, 30, 40, 50]);
  // **`櫛`+IVS（幅 0）のずれ**は 0.62 / 1.38 倍の対で、合計は 2.00 だが個々は 2.00 ではない。
  // **戻すと列が 1 つ増えて、記号の個数と合わなくなる**
  assert.deepEqual(fillLatticeGaps([0, 10, 16.2, 30, 40]), [0, 10, 16.2, 30, 40]);
  assert.deepEqual(fillLatticeGaps([0, 10, 20]), [0, 10, 20], "3 点以下は触らない");
});

test("#750 trimUnevenEnds: 端の外れた列だけを落とす（途中では切らない）", () => {
  // 右端に間隔の違う列がくっつく（`賛成者数` の見出し）
  assert.deepEqual(trimUnevenEnds([0, 10, 20, 30, 45]), [0, 10, 20, 30]);
  // **途中のずれ（`櫛`+IVS）では切らない**——切ると 46 人が 37 人になる（実測）
  assert.deepEqual(trimUnevenEnds([0, 10, 16.2, 30, 40, 50]), [0, 10, 16.2, 30, 40, 50]);
});

/**
 * **#705 が滋賀で踏んだ形が青森にもある**——**`276_25.11_giketsukekka.pdf` は 46 行中 39 行で
 * 記号帯が 2 アイテムに割れる**（`"○ ○ ○ 議 ○ ○ -"` ＋ `"○ ○ … ○ 42"`。割れ目は 7 人目と 8 人目の間）。
 * **議員の帯を「票の行の x 範囲の中央値」から決めると 404.3 になり、先頭 7 人が帯の外に落ちる**——
 * **40 列の表になり、8 人目以降の票が 1 人目以降に付く。これが「別人の記録」である。**
 * **氏名帯から決めれば、割れ方に依らない。**
 */
test("#750 記号帯が 2 アイテムに割れても、先頭の議員が落ちない（#705 と同じ形）", async () => {
  const raw = (await readPages(pdf("276_25.11_giketsukekka"))).map(unrotate);
  const partial = raw[0].items.filter((i) => { const n = trailingVoteSymbols(i.str).length; return n > 0 && n < 10; });
  // 1 ページ目の「10 個未満の記号アイテム」は 28 個 ＝ **割れた左側 26 行 ＋ 左端の stray な `議` 2 個**
  assert.equal(partial.length, 28, "実測");
  const split = partial.filter((i) => trailingVoteSymbols(i.str).length === 7);
  assert.equal(split.length, 26, "1 ページ目で 26 行が割れている（実測）");
  assert.equal(partial.length - split.length, 2, "残り 2 個は左端の stray な `議`");
  assert.ok(split.every((i) => i.str.endsWith("-")), "割れた左側は 7 人目の `-` で終わる");
  const p = await parseVotePdf(pdf("276_25.11_giketsukekka"));
  assert.equal(p.members.length, 47, "47 人（40 人になっていない）");
  assert.equal(p.members[0].nameText, "成 田 一 憲", "1 人目が落ちていない");
  assert.equal(p.members[6].nameText, "長 尾 忠 行", "割れ目の 7 人目");
  assert.equal(p.unknownCells, 0);
});

/**
 * **凡例に無い記号 `-`（U+002D）が `276` の賛否欄に 40 個ある**（他の 55 本には 1 個も無い。実測）。
 * **落とすと記号の個数が列の数と合わなくなり、その本の 46 行 2,162 セルが丸ごと `不明` になる。**
 * **「欠席だろう」と埋めない**——凡例にそう書いていない。`抽出不能` のまま残す（#569）。
 */
test("#750 凡例に無い `-` を落とさず、意味も推定しない", async () => {
  const p = await parseVotePdf(pdf("276_25.11_giketsukekka"));
  const dashes = p.rows.flatMap((r) => r.cells).filter((c) => c === "-");
  assert.equal(dashes.length, 40, "`-` が 40 個");
  assert.equal(p.unknownCells, 0, "落としていないので数が合う");
  // **凡例に無いので `抽出不能`**（`mapped` は `rollcalls.ts` が付けない）
  assert.equal(legendOf("-", p.legend.votes), UNKNOWN_LEGEND);
  assert.equal(legendOf("○", p.legend.votes), "賛成");
  assert.equal(legendOf(UNKNOWN_CELL, p.legend.votes), UNKNOWN_LEGEND);
  // **`-` は 7 人目の列に立つ**（割れ目の位置と一致する）
  for (const r of p.rows) {
    const i = r.cells.indexOf("-");
    if (i >= 0) assert.equal(i, 6, `${r.number}: \`-\` が 7 人目以外の列にある`);
  }
});

/**
 * **`副` は凡例にあるが 56 本のどこにも 1 個も出ない**（#743）。
 * **「56 本には無い」であって「出ない」ではない**ので、**未知の記号として落とさない。**
 */
test("#750 `副` を未知の記号として落とさない（凡例にあるが 56 本に 0 個）", async () => {
  const p = await parseVotePdf(pdf("314teirei_sanpi"));
  assert.equal(p.legend.votes["副"], "副議長が議長の職務を代理", "凡例にある");
  assert.deepEqual(trailingVoteSymbols("○ ○ 副 ○"), ["○", "○", "副", "○"], "記号として数える");
  assert.equal(legendOf("副", p.legend.votes), "副議長が議長の職務を代理");
  // 実際には 5 本に 1 個も出ない（＝この守りは今は空回りしている、という事実を残す）
  for (const f of FIXTURES) {
    const q = await parseVotePdf(pdf(f));
    assert.equal(q.rows.flatMap((r) => r.cells).filter((c) => c === "副").length, 0, `${f} に 副 が出た（doc を測り直すこと）`);
  }
});

/**
 * **#743 の問題 5**: **`議` が会期の途中で別の議員に移る**（`306` と `322` の 2 本）。
 * **#529 は「`議` は 1 本で常に同じ 1 人」をアサーションに置けと書いていたが、2 本しか開いていなかった。**
 */
test("#750 `議` が同じ 1 人であることをアサーションにしない（322 で途中で移る）", async () => {
  const p = await parseVotePdf(pdf("322teirei_sanpi"));
  const cols = p.rows.map((r) => r.cells.indexOf("議"));
  assert.equal(new Set(cols).size, 2, "1 本の中で `議` の列が 2 通りある（＝同じ 1 人ではない）");
  // 大半は 8 人目（丸井裕）、最後の 2 行だけ 12 人目（工藤慎康）
  assert.equal(cols.filter((c) => c === 7).length, 21);
  assert.equal(cols.filter((c) => c === 11).length, 2);
  assert.equal(p.members[7].nameText, "丸 井 裕");
  assert.equal(p.members[11].nameText, "工 藤 慎 康");
  // **置いてよいのは「1 行の中で `議` は高々 1 個」まで**（ただしこれは恒真。#743 の検算 B）
  for (const r of p.rows) assert.ok(r.cells.filter((c) => c === "議").length <= 1);
});

/**
 * **`/Rotate 90` を打ち消さないと、縦書きの氏名が横に、行が縦に並ぶ**
 * （#743 の変異 7: 56 本で 行 2,445 → 2,000、対 113,911 → 92,901、氏名なし 20,864）。
 * **共通層（`pdf-table.ts`）は直さない**（既存 8 県の出力が変わる）。
 */
test("#750 unrotate: /Rotate 90 のページだけ座標を直す（0 のページは 1 バイトも触らない）", async () => {
  const rotated = await readPages(pdf("279_26.9_giketsukekka"));
  assert.equal(rotated[0].rotate, 90, "フィクスチャが /Rotate 90 である");
  const u = unrotate(rotated[0]);
  // **打ち消すと、縦書きの氏名が「同じ x・違う y」に並ぶ**（打ち消す前は「同じ y・違う x」）。
  // 氏名帯の 1 文字目の帯を見る: 打ち消した後は 46 個が 46 通りの x に並び、y は 1 通りしかない
  const band = findNameBand(u)!;
  const firstRow = u.items.filter((i) => isSingleGlyph(i.str) && Math.abs(i.cy - band.top) < 1 && i.cx >= band.left && i.cx <= band.right);
  assert.equal(firstRow.length, 46, "打ち消した後、氏名の 1 文字目が 46 個そろう");
  assert.equal(new Set(firstRow.map((i) => Math.round(i.cy))).size, 1, "46 個が同じ y（＝横に並ぶ 1 本の帯）");
  assert.equal(new Set(firstRow.map((i) => Math.round(i.cx))).size, 46, "46 個が 46 通りの x（＝列になっている）");
  // **打ち消す前は x と y の役割が入れ替わっている**——同じ 46 個が「同じ x・違う y」に並ぶ。
  // （`unrotate` は x = 元の y、y = 幅 − 元の x − h。並び順を保つので index で対応が取れる）
  const idx = u.items.map((it, i) => ({ it, i })).filter(({ it }) => firstRow.includes(it)).map(({ i }) => i);
  const before = idx.map((i) => rotated[0].items[i]);
  assert.equal(before.length, 46);
  assert.equal(new Set(before.map((i) => Math.round(i.x))).size, 1, "打ち消す前は 46 個が同じ x に並ぶ");
  assert.equal(new Set(before.map((i) => Math.round(i.y))).size, 46, "打ち消す前は 46 個が 46 通りの y");
  // 縦線と横線が入れ替わる
  assert.equal(u.vlines.length, rotated[0].hlines.length);
  assert.equal(u.hlines.length, rotated[0].vlines.length);

  const flat = await readPages(pdf("314teirei_sanpi"));
  assert.equal(flat[0].rotate, 0);
  assert.equal(unrotate(flat[0]), flat[0], "rotate 0 なら同じオブジェクトをそのまま返す");
  assert.throws(() => unrotate({ ...flat[0], rotate: 180 }), /unsupported page rotation 180/, "180/270 は黙って間違えた向きで読まない");
});

/**
 * **最新 4 会期（第322〜325回）には罫線が 1 本も無い**（#743 の実測: 322 は縦 0 / 横 0）。
 * **罫線でセルを作る既存 8 県のやり方は、この 4 本に当たらない。**
 */
test("#750 罫線が 1 本も無い本でも読める（第322回）", async () => {
  const raw = await readPages(pdf("322teirei_sanpi"));
  assert.equal(raw[0].vlines.length, 0, "縦罫線 0 本");
  assert.equal(raw[0].hlines.length, 0, "横罫線 0 本");
  const p = await parseVotePdf(pdf("322teirei_sanpi"));
  assert.equal(p.members.length, 48);
  assert.equal(p.rows.length, 23);
  assert.equal(p.unknownCells, 0);
  // **会派は罫線が無いので空**（推定しない。中央のラベルから「いちばん近い会派」を当てない）
  assert.deepEqual([...new Set(p.members.map((m) => m.group))], [""]);
});

/**
 * **会派のラベルは「中央揃えで 1 アイテム」**で、**アイテムの幅は覆う列の幅ではない**
 * （実測 314: `自由民主党` は 29 人ぶんの上に幅 55pt のアイテムが 1 つ）。
 * **幅から span を作ると、ラベルの真下の 5 人だけが会派を持つ。**
 */
test("#750 会派は罫線で切る（ラベルの幅からは決まらない）", async () => {
  const p = await parseVotePdf(pdf("314teirei_sanpi"));
  const groups = new Map<string, number>();
  for (const m of p.members) groups.set(m.group, (groups.get(m.group) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries([...groups].sort()), {
    "オール青森": 5, "公明党": 2, "参政党": 1, "新政未来": 6, "日本共産党": 3, "無所属": 2, "自由民主党": 29,
  });
  // **会派が空の列が 1 つも無い**（幅から決めていたら 29 人中 24 人が空になる）
  assert.deepEqual(p.members.filter((m) => m.group === ""), []);
});

/**
 * **会派の境は「ラベルの上まで届く縦罫線」でなければならない。**
 * **`groupBottom` を跨ぐだけでは足りない**——**議員の列の境も氏名帯の上まで伸びる本がある**。
 *
 * **実装中に実際に踏んだ**: `279`（46 人中 **39 人**）と `276`（47 人中 **40 人**）で
 * **会派のセルが 1 人ずつに割れ、ラベルの真下の 1 人だけが会派を持った。**
 * **`314` では起きない**ので、**314 だけを見ていたら気づけない**
 * （最初この test は 314 しか見ておらず、変異を当てても落ちなかった）。
 */
test("#750 会派の境は「ラベルの上まで届く縦罫線」（罫線のある 4 本すべてで空が 0）", async () => {
  const want: Record<string, Record<string, number>> = {
    "314teirei_sanpi": { "オール青森": 5, "公明党": 2, "参政党": 1, "新政未来": 6, "日本共産党": 3, "無所属": 2, "自由民主党": 29 },
    "279_26.9_giketsukekka": { "公明・健政会": 3, "日本共産党": 2, "民主党": 6, "無所属": 2, "自由民主党": 30, "青和会": 3 },
    "276_25.11_giketsukekka": { "公明・健政会": 3, "日本共産党": 2, "民主党": 6, "無所属": 3, "自由民主党": 30, "青和会": 3 },
    "300teirei_sanpi": { "公明・健政会": 3, "日本共産党": 3, "民主連合": 4, "無所属": 3, "県民主役の県政の会": 2, "自由民主党": 29, "青和会": 3 },
  };
  for (const [f, expect] of Object.entries(want)) {
    const p = await parseVotePdf(pdf(f));
    const groups: Record<string, number> = {};
    for (const m of p.members) groups[m.group] = (groups[m.group] ?? 0) + 1;
    assert.deepEqual(Object.fromEntries(Object.entries(groups).sort()), Object.fromEntries(Object.entries(expect).sort()), f);
    // **会派が空の列が 1 つも無い**（＝境が議員の列ごとに割れていない）
    assert.equal(groups[""], undefined, `${f}: 会派の空の列がある`);
    // 会派の数と人数の和が議員の数と一致する
    assert.equal(Object.values(groups).reduce((a, b) => a + b, 0), p.members.length, f);
  }
});

/**
 * **数が合わない行は丸ごと `不明`**（推定しない）。
 * **押し込むと、ずれた 1 列ぶん全員が別人の票になる**（#689 が滋賀で踏んだ形）。
 */
test("#750 readVoteCells: 記号の数が列の数と合わなければ全セル不明（推定しない）", () => {
  const band: NameBand = { top: 100, bottom: 90, cols: [0, 10, 20, 30], groupBottom: 105, left: 0, right: 30 };
  const at = (str: string, x: number): Item => ({ str, x, y: 0, w: 10, h: 10, cx: x + 5, cy: 5 });
  // 3 個・3 列 → 置ける
  assert.deepEqual(readVoteCells([at("○", 0), at("×", 10), at("議", 20)], band), ["○", "×", "議"]);
  // 2 個・3 列 → 全部不明（**足りない 1 つを推定で埋めない**）
  assert.deepEqual(readVoteCells([at("○", 0), at("×", 10)], band), [UNKNOWN_CELL, UNKNOWN_CELL, UNKNOWN_CELL]);
  // 4 個・3 列 → 全部不明（**余った 1 つを黙って捨てない**）
  assert.deepEqual(readVoteCells([at("○", 0), at("×", 10), at("議", 20), at("欠", 30)], band), [UNKNOWN_CELL, UNKNOWN_CELL, UNKNOWN_CELL]);
  // 同じ列に 2 個入ったら、その列は決められない
  assert.deepEqual(readVoteCells([at("○", 0), at("×", 1), at("議", 20)], band), [UNKNOWN_CELL, UNKNOWN_CELL, "議"]);
});

test("#750 columnOf: 帯の外は undefined（境界は左を含み右を含まない）", () => {
  const cols = [0, 10, 20];
  assert.equal(columnOf(cols, -0.1), undefined);
  assert.equal(columnOf(cols, 0), 0);
  assert.equal(columnOf(cols, 9.9), 0);
  assert.equal(columnOf(cols, 10), 1);
  assert.equal(columnOf(cols, 20), undefined);
});

/**
 * **凡例は PDF ごとに読む**（56 本で 1 字も変わらないが、決め打ちにすると
 * 文言が変わった会期を黙って古い意味で読む）。
 * **凡例が無い本では `votes` が空になり、全セルが `抽出不能` になる**（推定しない。#569）。
 */
test("#750 parseLegend: PDF ごとに読む・無ければ空（決め打ちにしない）", async () => {
  const raw = (await readPages(pdf("314teirei_sanpi"))).map(unrotate);
  assert.deepEqual(parseLegend(raw).votes, LEGEND);
  assert.deepEqual(parseLegend([{ items: [], vlines: [], hlines: [] }]).votes, {}, "凡例が無ければ空");
  assert.equal(legendOf("○", {}), UNKNOWN_LEGEND, "凡例が無ければ意味を決めない");
});

test("#750 parseVotePdf: 文字層の無い PDF は例外（読めないのが正しい結果）", async () => {
  // 1 ページだけの空の PDF（文字層なし）
  const empty = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    + "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n"
    + "trailer<</Root 1 0 R>>\n", "latin1");
  await assert.rejects(() => parseVotePdf(empty), /PDF has no (pages|text layer)/);
});
