import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { parseVotePdf, UNKNOWN_CELL } from "../src/sources/local/mie/votes-pdf.ts";
import { readGlyphPages, readGlyphPageOps } from "../src/sources/local/mie/glyphs.ts";

/**
 * # 三重: **1 つの showText に複数のセルが入る本**（Issue #982。#867 / #969 の残り）
 *
 * ## 壁は何だったか（**#969 が特定し、ここで全数を測り直した**）
 *
 * **この世代の三重の PDF は、1 行ぶんの文字をまとめて 1 回の showText で置く。**
 * `glyphs.ts` は **showText 1 回 = 1 アイテム**にするので、**1 アイテムが丸ごと 1 つの列に落ち、
 * 残りの列が空になる。** 例外は出ない枝もあり、**見出しが空になって `column 0 header ""` で止まる。**
 *
 * **実測（2026-09-24、`001088734.pdf` の 1 ページ目）——1 行がこの 5 アイテムで出る:**
 *
 * | アイテム | 何列ぶんか |
 * |---|---|
 * | `"議案第1号"` | 1 列 |
 * | `"令和2年度三重県一般会計補正予算（第１０号）"` | 1 列 |
 * | **`"1/155049490"`** | **5 列**（議決月日 `1/15` ＋ 出席 `50` ＋ 表決 `49` ＋ 賛成 `49` ＋ 反対 `0`） |
 * | `"可決"` | 1 列 |
 * | **`"○○○…議○○…"`（50 文字、w=493.4）** | **47 人ぶんの列** |
 *
 * **見出しも `"議案等番号件名"` の 1 アイテム**（2 列ぶん）で出る。
 *
 * ## 母数（**2026-09-24 に index 151 本すべてを取得して測り直した**）
 *
 * | | 本数 |
 * |---|---:|
 * | index の `.pdf`（母数） | **151** |
 * | ベースライン `8a743fc7` で読めた | **99** |
 * | **この枝で読めた** | **111** |
 * | **読めなくなった本** | **0** |
 * | **既に読めていた 99 本でセル・議員・凡例・表題のハッシュが変わった本** | **0** |
 *
 * **「記号だけが 10 文字以上まとまっているアイテム」を持つ本は 27 本**（**Issue 本文の 17 ではない**）。
 * **うち 10 本は回転の本で、回転の例外で先に止まる**（#982 の射程外。`rotated text matrix`）。
 * **残る 17 本が #969 の名指した 17 本と完全に一致する。**
 *
 * ## **「割る規則」を作らなかった**（#569 / #969 への答え）
 *
 * **#969 はここで止まった**——
 * > 表題と凡例は 1 アイテムの `str` を正規表現で見つけているので、全部割ると今読めている 99 本が
 * > 表題も凡例も失う。**選んで割る規則を誤れば別人の列に票が落ちる**（#569）。
 *
 * **この実装は「どのアイテムを割るか」を 1 つも選ばない。**
 * **本ごとに「割らないで読む」を先に試し、それが例外で止まった本だけ「全部割って」読み直す。**
 * **読めている本は 1 段目で返るので、2 段目のコードに触れることすらない**（構造上そうなる）。
 *
 * ## 割った位置が正しいことの実測（**17 本すべて・全 30 ページ**）
 *
 * **記号帯のグリフ 21,197 個**の中心が、罫線で決まる議員の列に対して:
 *
 * | | 個数 |
 * |---|---:|
 * | ちょうど 1 つの列の内側 | **21,197** |
 * | 境界の `EDGE` 以内（どちらの列か決められない） | **0** |
 * | 議員の列の範囲の外 | **0** |
 * | 同じ列に 2 つ以上落ちた | **0** |
 *
 * **#969 は「1 ページの 1 行を等間隔で試算した」だけだった。これは 17 本を全数で測った値である。**
 *
 * ## **中身が「別人の票」でないことの実測**（新しく読めた 12 本 / 245 行）
 *
 * | 検算 | 結果 |
 * |---|---|
 * | 公表された賛成者数・反対者数 ↔ `○` / `×` の数 | **245 / 245 行で一致** |
 * | `議` の列の議員 ↔ 三重県議会「歴代正副議長」 | **242 / 245 行で一致**、**残り 3 行は議長交代月** |
 *
 * **残り 3 行は、どれも「5 月の本で、議長が本の中で代わっている」形である**——
 * **`000073643.pdf` について #867 が既に一次資料で確かめた形と同じである。**
 *
 * **`001088736.pdf`（令和2年5月）**: `議案第100号` `議案第101号`（**議決 5/14**）の `議` は
 * **列 32「中嶋 年規」**（113代、令和元.05 就任）、
 * `議案第102号`「監査委員の選任につき同意を得るについて」（**議決 5/15**）の `議` は
 * **列 17「日沖 正信」**（114代、令和2.05 就任）。
 *
 * **`000072296.pdf`（平成25年5月）**: `議案第103号`（**議決 5/16**）の `議` は
 * **列 41「山本 教和」**（103代、平成23.05 就任）、
 * `議案第104号`「監査委員の選任につき同意を得るについて」（**同じ 5/16**）の `議` は
 * **列 39「山本 勝」**（104代、平成25.05 就任）。
 *
 * **列がずれているなら、出るのは「前任者」でも「後任者」でもない無関係な議員である。**
 * **一次資料の前任者と後任者がちょうど出て、しかも新議長の側が
 * 「監査委員の選任」の行に立っている**——これは **x がずれていない**ことの証拠である。
 * 一次資料: 三重県議会「歴代正副議長」 https://www.pref.mie.lg.jp/KENGIKAI/07681011814.htm
 *
 * ## **読めるようにならなかった 5 本**（#569。理由を測って残す）
 *
 * **`000073595` `000073608` `000073620` `000073621` `000073636` は割っても読めない。**
 * **壁が違う**——**この 5 本は本文の行を区切る全幅の罫線が足りず、全部の行が 1 行に潰れている**
 * （割った後の例外が `date "2/222/222/22…" is not M/D` になるのがその形）。
 * **`000073636` は割る前と後で同じ `column 0 header "案等番号議"` で止まる。**
 * **どれも「途中まで読む」ことはしていない**（例外で止まる。#569）。
 */

const dir = fileURLToPath(new URL("fixtures/mie/", import.meta.url));

/* -------------------------------------------------------------------------
 * 1. `splitGlyphs` そのもの（オペレータ列を直接渡す。PDF を作らずに主張を固定する）
 * ------------------------------------------------------------------------- */

/** `showText` の引数の形（pdfjs は glyph オブジェクトの配列を渡す）。 */
const glyph = (unicode: string, width: number) => ({ unicode, width });

/** `Tm` で (x, y) に置いて、1 回の showText で `str` を出すだけのオペレータ列。 */
function onePage(str: string, x: number, y: number, size: number, widthPerGlyph = 1000): { fn: number[]; args: unknown[] } {
  return {
    fn: [OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText],
    args: [[], ["F1", size], [1, 0, 0, 1, x, y], [[...str].map((c) => glyph(c, widthPerGlyph))], []],
  };
}

test("#982 既定は showText 1 回 = 1 アイテム（**割らない**）", () => {
  const { fn, args } = onePage("○×議", 100, 500, 10);
  const { items } = readGlyphPageOps(fn, args, 1);
  assert.equal(items.length, 1, "既定で割れてしまっている（読めている 99 本の表題と凡例が壊れる）");
  assert.equal(items[0].str, "○×議");
  assert.equal(items[0].x, 100);
  // 幅 1000/1000 × size 10 の文字が 3 つ。1 アイテムの w は「左端から最後のグリフの右端まで」
  assert.equal(items[0].w, 30);
  assert.equal(items[0].cx, 115);
});

test("#982 splitGlyphs: 1 つの showText がグリフ 1 つずつのアイテムになる", () => {
  const { fn, args } = onePage("○×議", 100, 500, 10);
  const { items } = readGlyphPageOps(fn, args, 1, { splitGlyphs: true });
  assert.equal(items.length, 3, "割れていない（#982 の 12 本はここで 1 アイテムに潰れていた）");
  assert.deepEqual(items.map((i) => i.str), ["○", "×", "議"]);
  // **位置は「既定の枝が x を積算している値」そのもの**（推定を足していない）
  assert.deepEqual(items.map((i) => i.x), [100, 110, 120]);
  assert.deepEqual(items.map((i) => i.cx), [105, 115, 125]);
  // **1 アイテムの左端・右端は、割った先頭のグリフの左端・末尾のグリフの右端と一致する**
  const whole = readGlyphPageOps(fn, args, 1).items[0];
  assert.equal(items[0].x, whole.x);
  assert.equal(items[items.length - 1].x + items[items.length - 1].w, whole.x + whole.w);
});

test("#982 splitGlyphs でも y と h は 1 アイテムのときと同じ（行の割り当てが変わらない）", () => {
  const { fn, args } = onePage("あい", 50, 300, 8);
  const whole = readGlyphPageOps(fn, args, 1).items[0];
  const split = readGlyphPageOps(fn, args, 1, { splitGlyphs: true }).items;
  for (const g of split) {
    assert.equal(g.y, whole.y, "y が変わると行（どの議案か）が変わる（#819）");
    assert.equal(g.h, whole.h);
    assert.equal(g.cy, whole.cy);
  }
});

test("#982 splitGlyphs でも、読めない形はそのまま例外で止まる（割って握り潰していない）", () => {
  // 回転した text matrix（#867 B 群の 11 本）。**割る前も後も止まる。**
  const fn = [OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText];
  const args: unknown[] = [[], ["F1", 10], [0, 1, -1, 0, 100, 500], [[glyph("○", 1000)]], []];
  assert.throws(() => readGlyphPageOps(fn, args, 1, { splitGlyphs: true }), /rotated text matrix/);
  // 不可視の文字（Tr 3）
  const fn2 = [OPS.beginText, OPS.setTextRenderingMode, OPS.showText, OPS.endText];
  const args2: unknown[] = [[], [3], [[glyph("○", 1000)]], []];
  assert.throws(() => readGlyphPageOps(fn2, args2, 1, { splitGlyphs: true }), /text rendering mode/);
});

/* -------------------------------------------------------------------------
 * 2. 実物の PDF（**割らないと 1 本も読めない**）
 * ------------------------------------------------------------------------- */

/**
 * **#982 で読めるようになった本**（実物）。
 * - `001088736.pdf`: #969 が名指した「0.75 倍で置かれた 9 本」の 1 本（令和2年5月）。
 * - `000072296.pdf`: 「記号帯が 1 アイテム」の古い世代（平成25年5月）。
 *
 * **どちらも議長が本の中で交代しており、x がずれていないことの証拠を持っている**（上の docblock）。
 */
const NEWLY_READABLE = ["001088736.pdf", "000072296.pdf"] as const;

test("#982 実物: 割らずに読むと 1 アイテムが複数のセルぶんを抱えている（壁が今もそこにある）", async () => {
  for (const f of NEWLY_READABLE) {
    const pages = await readGlyphPages(readFileSync(dir + f));
    // **記号だけのアイテムで 10 文字以上のもの**が実在することを固定する。
    const SYMS = /^[○〇×✕議除－―欠\s　]{10,}$/u;
    const batched = pages.flatMap((p) => p.items).filter((i) => SYMS.test(i.str));
    assert.ok(batched.length > 0, `${f}: 記号がまとまったアイテムが 1 つも無い（この本を置いている理由が消えている）`);
    assert.ok(Math.max(...batched.map((i) => [...i.str].length)) >= 40, `${f}: いちばん長い記号のアイテムが 40 文字未満`);
  }
});

test("#982 実物: 割ると同じ showText がグリフ 1 つずつに分かれ、文字は 1 字も増減しない", async () => {
  for (const f of NEWLY_READABLE) {
    const whole = await readGlyphPages(readFileSync(dir + f));
    const split = await readGlyphPages(readFileSync(dir + f), { splitGlyphs: true });
    assert.equal(whole.length, split.length, `${f}: ページ数が変わった`);
    for (let p = 0; p < whole.length; p++) {
      // **割っても文字の数は同じ**（足しも引きもしていない。#569）
      const a = whole[p].items.reduce((n, i) => n + [...i.str].length, 0);
      const b = split[p].items.reduce((n, i) => n + [...i.str].length, 0);
      assert.equal(b, a, `${f} p${p + 1}: 割ると文字数が変わった（${a} → ${b}）`);
      // **割ったほうがアイテムは必ず多い**（まとまったアイテムがあるので）
      assert.ok(split[p].items.length > whole[p].items.length, `${f} p${p + 1}: 割ってもアイテムが増えていない`);
      // **罫線は 1 本も変わらない**（この直しは文字だけに効く）
      assert.deepEqual(split[p].vlines, whole[p].vlines, `${f} p${p + 1}: 縦罫線が変わった`);
      assert.deepEqual(split[p].hlines, whole[p].hlines, `${f} p${p + 1}: 横罫線が変わった`);
    }
  }
});

test("#982 実物: parseVotePdf が最後まで読める（unknownCells 0・凡例に無い記号 0）", async () => {
  for (const f of NEWLY_READABLE) {
    const pdf = await parseVotePdf(readFileSync(dir + f));
    assert.ok(pdf.rows.length > 0, `${f}: 行が 0`);
    assert.ok(pdf.members.length >= 49, `${f}: 議員の列が ${pdf.members.length} 列しかない（三重は 50 前後）`);
    assert.equal(pdf.unknownCells, 0, `${f}: 置けなかったセルがある（割った位置が列と合っていない）`);
    // **凡例の記号しか出ていない**（`parseVotePdf` が既に検査しているが、ここでも固定する）
    for (const row of pdf.rows) for (const c of row.cells) assert.notEqual(c, UNKNOWN_CELL, `${f}: ${row.kind}${row.number} に不明なセル`);
    // **全部のセルが「1 文字」である**（割り損ねた塊が混じっていないこと）
    for (const row of pdf.rows) for (const c of row.cells) assert.equal([...c].length, 1, `${f}: セル "${c}" が 1 文字でない`);
  }
});

/**
 * **公表数との突き合わせ**（検算A）。**これは x のずれを 1 件も捕まえない**——
 * **#867 が実測している**（記号帯を 1 列回しても `○` と `×` の個数は変わらない: 0 / 378 行）。
 * **だから「通った」を x の根拠にしない。落ちたら確実に何かがおかしい、という片側だけを使う。**
 */
test("#982 実物: 各行の ○ / × の数が、公表された賛成者数 / 反対者数と一致する", async () => {
  let rows = 0;
  for (const f of NEWLY_READABLE) {
    const pdf = await parseVotePdf(readFileSync(dir + f));
    for (const row of pdf.rows) {
      rows++;
      const yes = row.cells.filter((c) => c === "○" || c === "〇").length;
      const no = row.cells.filter((c) => c === "×" || c === "✕" || c === "╳").length;
      assert.equal(yes, row.counts.yes, `${f} ${row.kind}${row.number}: ○ ${yes} ≠ 公表 ${row.counts.yes}`);
      assert.equal(no, row.counts.no, `${f} ${row.kind}${row.number}: × ${no} ≠ 公表 ${row.counts.no}`);
    }
  }
  // **母数を検算に入れる**（#757。0 行でも「通った」ことになる検査にしない）
  assert.equal(rows, 5, `判定した行が ${rows} 行（この 2 本は合計 5 行のはず。母数が変われば期待値も測り直すこと）`);
});

/**
 * **`議` の列 ↔ 三重県議会「歴代正副議長」**（検算B）。**こちらが x のずれを捕まえる。**
 * 一次資料: https://www.pref.mie.lg.jp/KENGIKAI/07681011814.htm （更新日 令和8年5月19日）
 *
 * **2 本とも「議長が本の中で交代している」5 月の本なので、行ごとに期待値を書く**
 * （**月だけでは 1 人に決まらない**——#867 が `000073643.pdf` で同じ形を確かめている）。
 * **前任者と後任者が、議決月日の順に、しかも「監査委員の選任」が新議長の下で
 * 諮られている形でちょうど出る。** **列がずれていれば無関係な議員が出る。**
 */
const SPEAKER_BY_ROW: { file: string; kind: string; number: string; speaker: string }[] = [
  { file: "001088736.pdf", kind: "議案", number: "第100号", speaker: "中嶋年規" }, // 113代 令和元.05（議決 5/14）
  { file: "001088736.pdf", kind: "議案", number: "第101号", speaker: "中嶋年規" },
  { file: "001088736.pdf", kind: "議案", number: "第102号", speaker: "日沖正信" }, // 114代 令和2.05（議決 5/15）
  { file: "000072296.pdf", kind: "議案", number: "第103号", speaker: "山本教和" }, // 103代 平成23.05（議決 5/16）
  { file: "000072296.pdf", kind: "議案", number: "第104号", speaker: "山本勝" },   // 104代 平成25.05（同じ 5/16）
];

test("#982 実物: 「議」のセルの議員が、一次資料の歴代議長と一致する（x がずれていない）", async () => {
  const bare = (s: string) => s.replace(/[\s　]+/g, "");
  let judged = 0;
  for (const f of NEWLY_READABLE) {
    const pdf = await parseVotePdf(readFileSync(dir + f));
    for (const row of pdf.rows) {
      const hits = row.cells.map((c, i) => [c, i] as const).filter(([c]) => c === "議");
      assert.equal(hits.length, 1, `${f} ${row.kind}${row.number}: 「議」のセルが ${hits.length} 個（1 個のはず）`);
      const want = SPEAKER_BY_ROW.find((e) => e.file === f && e.kind === row.kind && e.number === row.number);
      assert.ok(want, `${f} ${row.kind}${row.number}: 期待値の表に無い行（行が増えたら一次資料で確かめて足すこと）`);
      assert.equal(bare(pdf.members[hits[0][1]].nameText), want.speaker, `${f} ${row.kind}${row.number}: 「議」の列が別人`);
      judged++;
    }
  }
  assert.equal(judged, SPEAKER_BY_ROW.length, `判定した行が ${judged} 行（期待値の表は ${SPEAKER_BY_ROW.length} 行）`);
});

/**
 * **検算B が恒真でないことを、この場で壊して確かめる**（#823 の「恒真な検算を先に潰す」）。
 * **記号帯を 1 列回すと、`議` は別の議員の列に立つ。** **回転なので、空の列に落ちるという安い理由ではない。**
 */
test("#982 記号帯を 1 列回すと「議」の議員が一致しなくなる（検算B が x を見ている）", async () => {
  const bare = (s: string) => s.replace(/[\s　]+/g, "");
  let broke = 0;
  let total = 0;
  for (const f of NEWLY_READABLE) {
    const pdf = await parseVotePdf(readFileSync(dir + f));
    for (const row of pdf.rows) {
      const rotated = row.cells.map((_, i) => row.cells[(i + 1) % row.cells.length]);
      const hits = rotated.map((c, i) => [c, i] as const).filter(([c]) => c === "議");
      const want = SPEAKER_BY_ROW.find((e) => e.file === f && e.kind === row.kind && e.number === row.number)!;
      total++;
      if (hits.length !== 1 || bare(pdf.members[hits[0][1]].nameText) !== want.speaker) broke++;
    }
  }
  assert.equal(total, SPEAKER_BY_ROW.length);
  assert.equal(broke, total, `1 列回しても ${total - broke} 行が通ってしまう（検算B が x を見ていない）`);
});

/* -------------------------------------------------------------------------
 * 3. **読めるようにならなかった本**（#569。読めないことを検査にする）
 * ------------------------------------------------------------------------- */

/**
 * **`000073620.pdf` は割っても読めない。** **壁が違う**——
 * **この本は本文の行を区切る全幅の罫線が足りず、全部の行が 1 行に潰れている。**
 * **割ると「7 議案ぶんの議決月日が 1 つのセルに連なる」形で止まる**
 * （`date "2/222/222/22…" is not M/D`）。**推測で切り分けない。**
 *
 * **除外リストに黙って足せば検査はすり抜けられる**ので、**止まる理由のほうを固定する。**
 */
test("#982 割っても読めない本は、割る前と後の両方の理由をつけて例外で止まる", async () => {
  await assert.rejects(
    () => parseVotePdf(readFileSync(dir + "000073620.pdf")),
    (e: Error) => {
      assert.match(e.message, /incomplete row/, "割る前の理由が消えている");
      assert.match(e.message, /after splitting glyphs:/, "割った後の理由が付いていない（理由を差し替えている）");
      assert.match(e.message, /is not M\/D/, "割った後の理由が変わった（行を区切る罫線が足りない、という形のはず）");
      return true;
    },
  );
});

/**
 * **2 段目に入るのは 1 段目が止まった本だけである**——**これがこの PR の安全の土台である。**
 * **読めている本は 1 段目で返るので、割った位置が正しいかどうかに一切依存しない。**
 *
 * **実物で確かめる**: 既に読めている本（`001162455.pdf`）を、
 * **`splitGlyphs: true` で読み直すと `parseVotePdf` の中の検査が落ちる**ことを示す。
 * **つまり「全部を割る」を既定にしたら、この本は読めなくなっていた**（#969 の警告どおり）。
 */
test("#982 既に読めている本を全部割ると読めなくなる（既定を true にできない理由）", async () => {
  const bytes = readFileSync(dir + "001162455.pdf");
  // 1 段目（既定）では読める
  const ok = await parseVotePdf(bytes);
  assert.ok(ok.rows.length > 0);
  // **割ったページを直接 parse に通す経路は公開していない**ので、
  // **`readGlyphPages` の出力の形で「表題が 1 アイテムでは見つからなくなる」ことを示す。**
  const whole = await readGlyphPages(bytes);
  const split = await readGlyphPages(bytes, { splitGlyphs: true });
  const TITLE = /^((令和|平成)([０-９0-9]+|元)年(?:第[０-９0-9]+回)?(?:定例会|臨時会))（([０-９0-9]+)月）/;
  const wholeHits = whole[0].items.filter((i) => TITLE.test(i.str.trim())).length;
  const splitHits = split[0].items.filter((i) => TITLE.test(i.str.trim())).length;
  assert.ok(wholeHits > 0, "この本は元から 1 アイテムで表題が当たっていたはず（フィクスチャを確かめること）");
  assert.equal(splitHits, 0, "割っても 1 アイテムで表題が当たってしまう（この検査が何も主張していない）");
});
